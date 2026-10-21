import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { analyzeStock } from "./analyze.js";
import { runCombinedScreening } from "./screening.js";
import { runTechnicalScreening } from "./technicalOnly.js";
import { normalizeMarket } from "./types.js";
import { buildScreeningEnvelope } from "./screenerApi.js";
import { acquireJobLock } from "./jobLock.js";
import { loadScheduleConfig, saveScheduleConfig } from "./schedule.js";
import { loadTelegramConfig, saveTelegramConfig } from "./telegramConfig.js";
import { isFinTwtAuthenticated } from "./integrationAuth.js";
import {
  assertAuthConfigured,
  createSessionToken,
  expiredSessionCookie,
  isAuthenticated,
  sessionCookie,
  verifyCredentials,
} from "./auth.js";

const port = Number.parseInt(process.env.PORT ?? "5051", 10);
let running = false;

const loginPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · Claw 股票筛选器</title><style>:root{color-scheme:dark;--bg:#09111f;--card:#111d31;--line:#283750;--text:#e6edf7;--muted:#93a4bd;--accent:#45d6a7;--danger:#ff718b}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at top,#172744 0,var(--bg) 55%);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}.login{width:min(400px,calc(100% - 32px));padding:28px;background:rgba(17,29,49,.96);border:1px solid var(--line);border-radius:20px;box-shadow:0 24px 80px #0008}h1{margin:0;font-size:30px}p{color:var(--muted)}label{display:block;color:var(--muted);font-size:13px;margin:15px 0 6px}input,button{width:100%;border:1px solid var(--line);border-radius:10px;padding:12px;background:#0a1425;color:var(--text)}button{margin-top:20px;border:0;background:var(--accent);color:#06251c;font-weight:750;cursor:pointer}.error{min-height:22px;color:var(--danger);margin-top:12px}</style></head><body><form class="login" id="login"><h1>Claw 股票筛选器</h1><p>登录后管理筛选、定时任务和 Telegram 推送。</p><label>账号</label><input name="username" autocomplete="username" required autofocus><label>密码</label><input name="password" type="password" autocomplete="current-password" required><button>登录</button><div class="error" id="error"></div></form><script>document.querySelector('#login').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter,error=document.querySelector('#error');button.disabled=true;error.textContent='';const data=Object.fromEntries(new FormData(event.currentTarget));try{const response=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw new Error(result.error||'登录失败');location.href='/';}catch(reason){error.textContent=reason.message;}finally{button.disabled=false;}});</script></body></html>`;

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Claw 股票筛选器</title>
  <style>
    :root{color-scheme:dark;--bg:#09111f;--card:#111d31;--line:#283750;--text:#e6edf7;--muted:#93a4bd;--accent:#45d6a7;--danger:#ff718b}
    *{box-sizing:border-box}
    body{margin:0;background:radial-gradient(circle at top,#172744 0,var(--bg) 46%);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
    .wrap{max-width:980px;margin:auto;padding:40px 20px 80px}
    .top{display:flex;align-items:center;justify-content:space-between;gap:16px}
    h1{margin:0;font-size:clamp(26px,4.5vw,40px);letter-spacing:-.03em;font-weight:800}
    .subtitle{margin:10px 0 0;color:var(--muted);font-size:14.5px;line-height:1.6;max-width:none;text-wrap:balance}
    .logout{width:auto;margin:0;padding:8px 16px;background:#1e2c42;color:var(--text);border:1px solid var(--line);border-radius:9px;font-size:13.5px;font-weight:600;cursor:pointer;transition:all .15s ease}
    .logout:hover{background:#2a3c5a;border-color:#3b5075}
    .tabs{display:flex;gap:8px;margin:28px 0 0;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none}
    .tabs::-webkit-scrollbar{display:none}
    .tab-btn{display:inline-flex;align-items:center;gap:8px;width:auto;white-space:nowrap;padding:10px 18px;background:transparent;color:var(--muted);border:1px solid transparent;border-bottom:2px solid transparent;border-top-left-radius:10px;border-top-right-radius:10px;font-size:14.5px;font-weight:600;cursor:pointer;margin-bottom:-1px;transition:all .15s ease}
    .tab-btn:hover{color:var(--text);background:rgba(255,255,255,.04)}
    .tab-btn.active{color:var(--accent);background:rgba(69,214,167,.08);border-color:var(--line) var(--line) transparent;border-bottom:2px solid var(--accent)}
    .tab-icon{flex-shrink:0}
    .tab-panel{display:block}
    .tab-panel[hidden]{display:none!important}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;margin:22px 0}
    .card{background:rgba(17,29,49,.92);border:1px solid var(--line);border-radius:16px;padding:18px}
    .card h2{font-size:16px;margin:0 0 14px}
    label{display:block;color:var(--muted);font-size:13px;margin:12px 0 5px}
    input,select,button{width:100%;border:1px solid var(--line);border-radius:9px;padding:10px 12px;background:#0a1425;color:var(--text)}
    button{margin-top:16px;background:var(--accent);border:0;color:#06251c;font-weight:750;cursor:pointer}
    button:disabled{opacity:.5;cursor:wait}
    .hint{color:var(--accent);font-size:13px;margin-top:8px}
    .result{min-height:180px;white-space:pre-wrap;overflow:auto;background:#070d18;border:1px solid var(--line);border-radius:14px;padding:18px;color:#cbd7e8}
    .status{color:var(--muted);margin:12px 2px}
    .error{color:var(--danger)}
    .rules-card{margin:22px 0 0;padding:22px}
    .rules-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;padding-bottom:12px;border-bottom:1px solid var(--line)}
    .rules-header h2{font-size:17px;margin:0;color:var(--text)}
    .rules-badge{font-size:12px;color:var(--accent);background:rgba(69,214,167,.12);border:1px solid rgba(69,214,167,.25);border-radius:6px;padding:3px 10px;font-weight:600}
    .rule-block{padding:14px 16px;margin-bottom:12px;background:rgba(10,20,37,.6);border:1px solid var(--line);border-radius:12px}
    .rule-block:last-child{margin-bottom:0}
    .rule-block h3{font-size:14.5px;margin:0 0 6px;color:var(--accent);font-weight:600}
    .rule-block p{margin:0;font-size:14px;line-height:1.65;color:#c0d0e6}
    .settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin:22px 0}
    .days{display:grid;grid-template-columns:repeat(auto-fit,minmax(72px,1fr));gap:7px;margin-top:7px}
    .days label{margin:0;padding:8px 9px;background:#0a1425;border:1px solid var(--line);border-radius:8px;color:#cbd7e8}
    .secret-field{position:relative}
    .secret-field input{padding-right:46px}
    .secret-toggle{position:absolute;right:5px;top:50%;transform:translateY(-50%);display:grid;place-items:center;width:36px;height:34px;margin:0;padding:0;border:0;background:transparent;color:var(--muted)}
    .secret-toggle:hover{color:var(--text);background:#1e2c42}
    .form-status{min-height:22px;margin:12px 0 0;color:var(--muted);font-size:13px}
    .form-status.success{color:var(--accent)}
    .form-status.error{color:var(--danger)}
  </style>
</head>
<body>
<main class="wrap">
  <header>
    <div class="top">
      <h1>Claw 股票筛选器</h1>
      <button class="logout" id="logout">退出登录</button>
    </div>
    <p class="subtitle">Williams %R 超卖信号结合 Buffett 基本面评分。支持美股 S&amp;P 500、泰股技术筛选及单股分析。</p>
  </header>
  <nav class="tabs" role="tablist">
    <button type="button" class="tab-btn active" role="tab" id="tab-btn-dashboard" aria-selected="true" data-tab="dashboard">
      <svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>
      <span>股票筛选</span>
    </button>
    <button type="button" class="tab-btn" role="tab" id="tab-btn-rules" aria-selected="false" data-tab="rules">
      <svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
      <span>选股逻辑与指标说明</span>
    </button>
    <button type="button" class="tab-btn" role="tab" id="tab-btn-settings" aria-selected="false" data-tab="settings">
      <svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.14.37.36.7.65.97.3.26.68.41 1.08.43H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.6z"/></svg>
      <span>定时任务与 TG 推送</span>
    </button>
  </nav>
  <div class="tab-panel active" id="panel-dashboard" role="tabpanel" aria-labelledby="tab-btn-dashboard">
    <section class="grid">
      <form class="card" id="screen"><h2>市场筛选</h2><label>模式</label><select name="mode"><option value="combined">技术 + 基本面</option><option value="technical">纯技术筛选</option></select><label>市场</label><select name="market"><option value="us">美股 S&amp;P 500</option><option value="th">泰股 SET</option></select><label>最少 Buffett 得分</label><input name="minScore" type="number" min="0" max="10" value="5"><label>Williams %R 阈值</label><input name="threshold" type="number" min="-100" max="0" value="-80"><label>结果数量</label><input name="topN" type="number" min="1" max="100" value="10"><button>开始筛选</button></form>
      <form class="card" id="analyze"><h2>单股分析</h2><label>股票代码</label><input name="ticker" maxlength="20" placeholder="AAPL 或 PTT.BK" required><button>分析股票</button></form>
    </section>
    <div class="status" id="status">就绪</div>
    <pre class="result" id="result">筛选可能需要数分钟，运行期间请保持页面开启。</pre>
  </div>
  <div class="tab-panel" id="panel-rules" role="tabpanel" aria-labelledby="tab-btn-rules" hidden>
    <section class="card rules-card">
      <div class="rules-header">
        <h2>选股逻辑与指标说明</h2>
        <span class="rules-badge">双重因子筛选体系</span>
      </div>
      <div class="rule-block">
        <h3>第一步：技术面超卖筛选</h3>
        <p>Yahoo Finance 提供最近约 90 个交易日的开、高、低、收盘价。系统计算 21 日 Williams %R，低于 -80 视为超卖；越接近 -100，代表收盘价越靠近近期区间低位，但并不保证反弹。</p>
      </div>
      <div class="rule-block">
        <h3>第二步：基本面质量筛选</h3>
        <p>美股财务数据来自 SEC EDGAR。每通过一项得 1 分，满分 10 分：现金覆盖债务、负债权益比、净资产收益率、流动比率、营业利润率、资产周转率、利息保障倍数、盈利稳定性、自由现金流、资本配置。</p>
      </div>
      <div class="rule-block">
        <h3>综合评分机制</h3>
        <p>Williams %R 超卖强度占 30%，Buffett 基本面得分占 70%，两部分统一换算为 0–100。TG 中 Buffett ≥7 标记为 Buy candidate，5–6 标记为 Don’t buy yet；它是机械筛选信号，不是收益保证。</p>
      </div>
      <div class="rule-block">
        <h3>数据来源与合规说明</h3>
        <p>价格与 Williams %R 通过 yahoo-finance2 获取，无需 API Key，但属于非官方 Yahoo Finance 接口，可能受限流或接口变化影响。美国公司基本面来自 SEC EDGAR 的免费公开接口，无需 API Key，但必须提供可识别的 User-Agent 并遵守访问频率要求。泰股目前仅做技术面筛选。</p>
      </div>
    </section>
  </div>
  <div class="tab-panel" id="panel-settings" role="tabpanel" aria-labelledby="tab-btn-settings" hidden>
    <section class="settings-grid">
      <form class="card" id="schedule"><h2>定时筛选</h2><label><input name="enabled" type="checkbox" style="width:auto"> 启用定时任务</label><label>执行时间（美东时间）</label><input name="time" type="time" value="18:15"><div class="hint" id="beijingTime"></div><label>执行日（按美东日期）</label><div class="days" id="days"><label><input type="checkbox" value="1" style="width:auto"> 周一</label><label><input type="checkbox" value="2" style="width:auto"> 周二</label><label><input type="checkbox" value="3" style="width:auto"> 周三</label><label><input type="checkbox" value="4" style="width:auto"> 周四</label><label><input type="checkbox" value="5" style="width:auto"> 周五</label><label><input type="checkbox" value="6" style="width:auto"> 周六</label><label><input type="checkbox" value="0" style="width:auto"> 周日</label></div><label>市场</label><select name="market"><option value="us">美股 S&amp;P 500</option><option value="th">泰股 SET</option></select><label>最低 Buffett 得分</label><input name="minScore" type="number" min="0" max="10" value="5"><label>推送数量</label><input name="topN" type="number" min="1" max="50" value="10"><button>保存定时任务</button><div class="form-status" id="scheduleStatus"></div></form>
      <form class="card" id="telegram"><h2>Telegram 推送配置</h2><label>BOT Token</label><div class="secret-field"><input name="botToken" id="botToken" type="password" autocomplete="off" spellcheck="false" required><button class="secret-toggle" id="toggleBotToken" type="button" aria-label="显示 BOT Token" title="显示 BOT Token"><svg class="eye-open" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg></button></div><div class="hint">Token 默认隐藏，点击小眼睛可查看完整信息。</div><label>Chat ID</label><input name="chatId" autocomplete="off" placeholder="例如 -1001234567890" required><button>保存 Telegram 配置</button><div class="form-status" id="telegramStatus"></div></form>
    </section>
  </div>
</main>
<script>
const statusNode=document.querySelector('#status'),resultNode=document.querySelector('#result');
const tabBtns=document.querySelectorAll('.tab-btn'),tabPanels=document.querySelectorAll('.tab-panel');
tabBtns.forEach(btn=>{btn.addEventListener('click',()=>{const target=btn.dataset.tab;tabBtns.forEach(b=>{const active=b===btn;b.classList.toggle('active',active);b.setAttribute('aria-selected',active?'true':'false');});tabPanels.forEach(panel=>{const active=panel.id==='panel-'+target;panel.classList.toggle('active',active);if(active){panel.removeAttribute('hidden');}else{panel.setAttribute('hidden','');}});});});
async function request(path,data,button){button.disabled=true;statusNode.className='status';statusNode.textContent='运行中…';resultNode.textContent='正在获取市场数据，请稍候。';try{const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const payload=await response.json();if(!response.ok)throw new Error(payload.error||'请求失败');resultNode.textContent=JSON.stringify(payload.result,null,2);statusNode.textContent='完成';}catch(error){statusNode.className='status error';statusNode.textContent=error.message;resultNode.textContent='';}finally{button.disabled=false;}}
document.querySelector('#screen').addEventListener('submit',event=>{event.preventDefault();const form=new FormData(event.currentTarget);request('/api/screen',Object.fromEntries(form),event.submitter);});
document.querySelector('#analyze').addEventListener('submit',event=>{event.preventDefault();const form=new FormData(event.currentTarget);request('/api/analyze',Object.fromEntries(form),event.submitter);});
const scheduleForm=document.querySelector('#schedule');
function updateBeijingTime(){const [hour,minute]=scheduleForm.elements.time.value.split(':').map(Number),now=new Date(),parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric',hourCycle:'h23'}).formatToParts(now).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)])),easternAsUtc=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second),offsetMinutes=Math.round((easternAsUtc-now.getTime())/60000),beijingTotal=hour*60+minute-offsetMinutes+480,dayOffset=Math.floor(beijingTotal/1440),normalized=(beijingTotal%1440+1440)%1440,beijingHour=String(Math.floor(normalized/60)).padStart(2,'0'),beijingMinute=String(normalized%60).padStart(2,'0');document.querySelector('#beijingTime').textContent='按当前美东时差，对应北京时间：'+(dayOffset>0?'次日 ':dayOffset<0?'前一日 ':'')+beijingHour+':'+beijingMinute+'（夏令时切换后会自动变化）';}
fetch('/api/schedule').then(r=>{if(r.status===401){location.href='/login';throw new Error('unauthorized');}return r.json();}).then(config=>{scheduleForm.elements.enabled.checked=config.enabled;scheduleForm.elements.time.value=config.time;scheduleForm.elements.market.value=config.market;scheduleForm.elements.minScore.value=config.minScore;scheduleForm.elements.topN.value=config.topN;document.querySelectorAll('#days input').forEach(input=>input.checked=config.days.includes(Number(input.value)));updateBeijingTime();});
scheduleForm.elements.time.addEventListener('input',updateBeijingTime);
scheduleForm.addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter,node=document.querySelector('#scheduleStatus');button.disabled=true;node.className='form-status';node.textContent='保存中…';const data={enabled:scheduleForm.elements.enabled.checked,time:scheduleForm.elements.time.value,days:[...document.querySelectorAll('#days input:checked')].map(input=>Number(input.value)),market:scheduleForm.elements.market.value,minScore:Number(scheduleForm.elements.minScore.value),topN:Number(scheduleForm.elements.topN.value)};try{const response=await fetch('/api/schedule',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw new Error(result.error);node.className='form-status success';node.textContent='定时任务已保存';}catch(error){node.className='form-status error';node.textContent=error.message;}finally{button.disabled=false;}});
const telegramForm=document.querySelector('#telegram'),botTokenInput=document.querySelector('#botToken'),tokenToggle=document.querySelector('#toggleBotToken');
fetch('/api/telegram').then(r=>r.json().then(data=>{if(!r.ok)throw new Error(data.error||'读取 Telegram 配置失败');return data;})).then(config=>{telegramForm.elements.botToken.value=config.botToken;telegramForm.elements.chatId.value=config.chatId;}).catch(error=>{const node=document.querySelector('#telegramStatus');node.className='form-status error';node.textContent=error.message;});
tokenToggle.addEventListener('click',()=>{const showing=botTokenInput.type==='text';botTokenInput.type=showing?'password':'text';tokenToggle.setAttribute('aria-label',showing?'显示 BOT Token':'隐藏 BOT Token');tokenToggle.setAttribute('title',showing?'显示 BOT Token':'隐藏 BOT Token');});
telegramForm.addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter,node=document.querySelector('#telegramStatus');button.disabled=true;node.className='form-status';node.textContent='保存中…';const data={botToken:telegramForm.elements.botToken.value,chatId:telegramForm.elements.chatId.value};try{const response=await fetch('/api/telegram',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw new Error(result.error);node.className='form-status success';node.textContent='Telegram 配置已保存，后续推送立即生效';botTokenInput.type='password';}catch(error){node.className='form-status error';node.textContent=error.message;}finally{button.disabled=false;}});
document.querySelector('#logout').addEventListener('click',async()=>{await fetch('/api/logout',{method:'POST'});location.href='/login';});
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

function standardScreenRequest(body: Record<string, unknown>): Record<string, unknown> {
  const strategy = String(body.strategy ?? "quality_oversold");
  const parameters =
    body.parameters && typeof body.parameters === "object"
      ? (body.parameters as Record<string, unknown>)
      : {};
  if (!["quality_oversold", "technical_oversold"].includes(strategy)) {
    throw new Error("strategy must be quality_oversold or technical_oversold");
  }
  return {
    mode: strategy === "technical_oversold" ? "technical" : "combined",
    market: body.market ?? "us",
    topN: body.limit ?? parameters.top_n ?? 10,
    minScore: parameters.min_score ?? parameters.min_buffett_score ?? 5,
    threshold: parameters.threshold ?? -80,
    strategy,
  };
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, running });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/capabilities") {
    if (!isFinTwtAuthenticated(request)) {
      sendJson(response, 401, { error: "Invalid API token" });
      return;
    }
    sendJson(response, 200, {
      schema_versions: ["1.0"],
      provider: "claw-screener",
      markets: ["US", "TH"],
      strategies: ["quality_oversold", "technical_oversold"],
      execution: "synchronous",
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/login") {
    if (isAuthenticated(request)) {
      response.writeHead(302, { Location: "/" });
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(loginPage);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/login") {
    const body = await readJson(request);
    const username = String(body.username ?? "");
    const password = String(body.password ?? "");
    if (!verifyCredentials(username, password)) {
      sendJson(response, 401, { error: "账号或密码错误" });
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": sessionCookie(createSessionToken(username)),
    });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (
    request.method === "POST" &&
    ["/api/v1/screen", "/api/v1/fin-twt/screen"].includes(url.pathname)
  ) {
    if (!isFinTwtAuthenticated(request)) {
      sendJson(response, 401, { error: "Invalid API token" });
      return;
    }
    if (running) {
      sendJson(response, 409, { error: "A screening job is already running" });
      return;
    }

    running = true;
    let releaseLock: (() => void) | undefined;
    const startedAt = Date.now();
    try {
      releaseLock = acquireJobLock();
      const body = await readJson(request);
      if (url.pathname === "/api/v1/fin-twt/screen") {
        const result = await handleScreen(body);
        sendJson(response, 200, {
          ok: true,
          source: "Claw Screener",
          telegramSent: false,
          generatedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          result,
        });
        return;
      }
      const standardRequest = standardScreenRequest(body);
      const result = (await handleScreen(standardRequest)) as Record<string, unknown>;
      const generatedAt = new Date().toISOString();
      sendJson(response, 200, {
        ...buildScreeningEnvelope(result, {
          strategy: String(standardRequest.strategy),
          market: normalizeMarket(String(standardRequest.market)),
          runId: randomUUID().replaceAll("-", ""),
          generatedAt,
          durationMs: Date.now() - startedAt,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(error);
      sendJson(response, 400, { error: message });
    } finally {
      releaseLock?.();
      running = false;
    }
    return;
  }

  if (!isAuthenticated(request)) {
    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 401, { error: "请先登录" });
    } else {
      response.writeHead(302, { Location: "/login" });
      response.end();
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/logout") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": expiredSessionCookie(),
    });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(page);
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
  if (request.method === "GET" && url.pathname === "/api/telegram") {
    sendJson(response, 200, loadTelegramConfig());
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/telegram") {
    try {
      sendJson(response, 200, saveTelegramConfig(await readJson(request)));
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

assertAuthConfigured();

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    console.error(error);
    if (!response.headersSent) sendJson(response, 500, { error: "Internal server error" });
    else response.end();
  });
});

server.listen(port, "0.0.0.0", () => console.log(`Claw Screener listening on ${port}`));

process.on("SIGTERM", () => server.close(() => process.exit(0)));
