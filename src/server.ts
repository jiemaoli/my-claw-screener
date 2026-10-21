import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { analyzeStock } from "./analyze.js";
import { runCombinedScreening } from "./screening.js";
import { runTechnicalScreening } from "./technicalOnly.js";
import { normalizeMarket } from "./types.js";
import { acquireJobLock } from "./jobLock.js";
import { loadScheduleConfig, saveScheduleConfig } from "./schedule.js";

const port = Number.parseInt(process.env.PORT ?? "5051", 10);
let running = false;

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Claw Screener</title>
  <style>
    :root{color-scheme:dark;--bg:#09111f;--card:#111d31;--line:#283750;--text:#e6edf7;--muted:#93a4bd;--accent:#45d6a7;--danger:#ff718b}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#172744 0,var(--bg) 46%);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}.wrap{max-width:980px;margin:auto;padding:40px 20px 80px}h1{margin:0;font-size:clamp(30px,6vw,54px);letter-spacing:-.04em}header p{color:var(--muted);max-width:620px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;margin:30px 0}.card{background:rgba(17,29,49,.92);border:1px solid var(--line);border-radius:16px;padding:18px}.card h2{font-size:16px;margin:0 0 14px}label{display:block;color:var(--muted);font-size:13px;margin:12px 0 5px}input,select,button{width:100%;border:1px solid var(--line);border-radius:9px;padding:10px 12px;background:#0a1425;color:var(--text)}button{margin-top:16px;background:var(--accent);border:0;color:#06251c;font-weight:750;cursor:pointer}button:disabled{opacity:.5;cursor:wait}.result{min-height:180px;white-space:pre-wrap;overflow:auto;background:#070d18;border:1px solid var(--line);border-radius:14px;padding:18px;color:#cbd7e8}.status{color:var(--muted);margin:12px 2px}.error{color:var(--danger)}
  </style>
</head>
<body><main class="wrap"><header><h1>Claw Screener</h1><p>Williams %R 超卖信号结合 Buffett 基本面评分。支持美股 S&amp;P 500、泰股技术筛选及单股分析。</p></header>
<section class="grid">
  <form class="card" id="screen"><h2>市场筛选</h2><label>模式</label><select name="mode"><option value="combined">技术 + 基本面</option><option value="technical">纯技术筛选</option></select><label>市场</label><select name="market"><option value="us">美股 S&amp;P 500</option><option value="th">泰股 SET</option></select><label>最少 Buffett 得分</label><input name="minScore" type="number" min="0" max="10" value="5"><label>Williams %R 阈值</label><input name="threshold" type="number" min="-100" max="0" value="-80"><label>结果数量</label><input name="topN" type="number" min="1" max="100" value="10"><button>开始筛选</button></form>
  <form class="card" id="analyze"><h2>单股分析</h2><label>股票代码</label><input name="ticker" maxlength="20" placeholder="AAPL 或 PTT.BK" required><button>分析股票</button></form>
  <form class="card" id="schedule"><h2>定时筛选与 TG 推送</h2><label><input name="enabled" type="checkbox" style="width:auto"> 启用定时任务</label><label>执行时间（上海时区）</label><input name="time" type="time" value="06:00"><label>执行日</label><div id="days"><label><input type="checkbox" value="1" style="width:auto"> 周一</label><label><input type="checkbox" value="2" style="width:auto"> 周二</label><label><input type="checkbox" value="3" style="width:auto"> 周三</label><label><input type="checkbox" value="4" style="width:auto"> 周四</label><label><input type="checkbox" value="5" style="width:auto"> 周五</label><label><input type="checkbox" value="6" style="width:auto"> 周六</label><label><input type="checkbox" value="0" style="width:auto"> 周日</label></div><label>市场</label><select name="market"><option value="us">美股 S&amp;P 500</option><option value="th">泰股 SET</option></select><label>最低 Buffett 得分</label><input name="minScore" type="number" min="0" max="10" value="5"><label>推送数量</label><input name="topN" type="number" min="1" max="50" value="10"><button>保存定时任务</button></form>
</section>
<section class="card"><h2>选股逻辑与指标说明</h2><p><b>第一步：技术面超卖筛选</b>。Yahoo Finance 提供最近约 90 个交易日的开、高、低、收盘价。系统计算 21 日 Williams %R，低于 -80 视为超卖；越接近 -100，代表收盘价越靠近近期区间低位，但并不保证反弹。</p><p><b>第二步：基本面质量筛选</b>。美股财务数据来自 SEC EDGAR。每通过一项得 1 分，满分 10 分：现金覆盖债务、负债权益比、净资产收益率、流动比率、营业利润率、资产周转率、利息保障倍数、盈利稳定性、自由现金流、资本配置。</p><p><b>综合评分</b>：Williams %R 超卖强度占 30%，Buffett 基本面得分占 70%，两部分统一换算为 0–100。TG 中 Buffett ≥7 标记为 Buy candidate，5–6 标记为 Don’t buy yet；它是机械筛选信号，不是收益保证。</p><p><b>数据来源</b>：价格与 Williams %R 来自 Yahoo Finance；美国公司基本面来自 SEC EDGAR；泰股目前仅做技术面筛选。</p></section>
<div class="status" id="status">就绪</div><pre class="result" id="result">筛选可能需要数分钟，运行期间请保持页面开启。</pre></main>
<script>
const statusNode=document.querySelector('#status'),resultNode=document.querySelector('#result');
async function request(path,data,button){button.disabled=true;statusNode.className='status';statusNode.textContent='运行中…';resultNode.textContent='正在获取市场数据，请稍候。';try{const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const payload=await response.json();if(!response.ok)throw new Error(payload.error||'请求失败');resultNode.textContent=JSON.stringify(payload.result,null,2);statusNode.textContent='完成';}catch(error){statusNode.className='status error';statusNode.textContent=error.message;resultNode.textContent='';}finally{button.disabled=false;}}
document.querySelector('#screen').addEventListener('submit',event=>{event.preventDefault();const form=new FormData(event.currentTarget);request('/api/screen',Object.fromEntries(form),event.submitter);});
document.querySelector('#analyze').addEventListener('submit',event=>{event.preventDefault();const form=new FormData(event.currentTarget);request('/api/analyze',Object.fromEntries(form),event.submitter);});
const scheduleForm=document.querySelector('#schedule');
fetch('/api/schedule').then(r=>r.json()).then(config=>{scheduleForm.elements.enabled.checked=config.enabled;scheduleForm.elements.time.value=config.time;scheduleForm.elements.market.value=config.market;scheduleForm.elements.minScore.value=config.minScore;scheduleForm.elements.topN.value=config.topN;document.querySelectorAll('#days input').forEach(input=>input.checked=config.days.includes(Number(input.value)));});
scheduleForm.addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;const data={enabled:scheduleForm.elements.enabled.checked,time:scheduleForm.elements.time.value,days:[...document.querySelectorAll('#days input:checked')].map(input=>Number(input.value)),market:scheduleForm.elements.market.value,minScore:Number(scheduleForm.elements.minScore.value),topN:Number(scheduleForm.elements.topN.value)};try{const response=await fetch('/api/schedule',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw new Error(result.error);statusNode.className='status';statusNode.textContent='定时任务已保存';resultNode.textContent=JSON.stringify(result,null,2);}catch(error){statusNode.className='status error';statusNode.textContent=error.message;}finally{button.disabled=false;}});
</script></body></html>`;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

async function handleScreen(body: Record<string, unknown>): Promise<unknown> {
  const market = normalizeMarket(String(body.market ?? "us"));
  const topN = numberValue(body.topN, 10, 1, 100);
  if (body.mode === "technical") {
    const threshold = numberValue(body.threshold, -80, -100, 0);
    return JSON.parse(await runTechnicalScreening(market, threshold, topN, "json")) as unknown;
  }
  const minScore = numberValue(body.minScore, 5, 0, 10);
  const result = await runCombinedScreening(market, minScore, topN, "json");
  return JSON.parse(result.output) as unknown;
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(page);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, running });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/schedule") {
    sendJson(response, 200, loadScheduleConfig());
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/schedule") {
    try {
      sendJson(response, 200, saveScheduleConfig(await readJson(request)));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (request.method !== "POST" || !["/api/screen", "/api/analyze"].includes(url.pathname)) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  if (running) {
    sendJson(response, 409, { error: "A screening job is already running" });
    return;
  }

  running = true;
  let releaseLock: (() => void) | undefined;
  try {
    releaseLock = acquireJobLock();
    const body = await readJson(request);
    const result =
      url.pathname === "/api/screen"
        ? await handleScreen(body)
        : JSON.parse(
            await analyzeStock(
              String(body.ticker ?? "")
                .trim()
                .toUpperCase(),
              "json"
            )
          );
    sendJson(response, 200, { result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);
    sendJson(response, 400, { error: message });
  } finally {
    releaseLock?.();
    running = false;
  }
}

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    console.error(error);
    if (!response.headersSent) sendJson(response, 500, { error: "Internal server error" });
    else response.end();
  });
});

server.listen(port, "0.0.0.0", () => console.log(`Claw Screener listening on ${port}`));

process.on("SIGTERM", () => server.close(() => process.exit(0)));
