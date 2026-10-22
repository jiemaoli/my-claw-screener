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

const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs><linearGradient id="bg" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#14233c"/><stop offset="100%" stop-color="#080f1a"/></linearGradient><linearGradient id="curve" x1="10" y1="31" x2="37" y2="13" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#38bdf8"/><stop offset="50%" stop-color="#34d399"/><stop offset="100%" stop-color="#45d6a7"/></linearGradient><linearGradient id="barGrad" x1="0" y1="14" x2="0" y2="38" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#45d6a7" stop-opacity="0.3"/><stop offset="100%" stop-color="#38bdf8" stop-opacity="0.06"/></linearGradient></defs><rect width="48" height="48" rx="12" fill="url(#bg)" stroke="#45d6a7" stroke-opacity="0.4" stroke-width="1.5"/><rect x="11" y="24" width="3.5" height="13" rx="1.75" fill="url(#barGrad)"/><rect x="19" y="29" width="3.5" height="8" rx="1.75" fill="url(#barGrad)"/><rect x="27" y="21" width="3.5" height="16" rx="1.75" fill="url(#barGrad)"/><rect x="35" y="15" width="3.5" height="22" rx="1.75" fill="url(#barGrad)"/><path d="M 10 19 C 14 20 16 31 20 31 C 26 31 31 22 37 13" fill="none" stroke="url(#curve)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M 30 13 H 37 V 20" fill="none" stroke="#45d6a7" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20" cy="31" r="3.2" fill="#fbbf24"/><circle cx="20" cy="31" r="5.2" fill="none" stroke="#fbbf24" stroke-opacity="0.35" stroke-width="1.2"/><path d="M 38 4 Q 38 7 35 7 Q 38 7 38 10 Q 38 7 41 7 Q 38 7 38 4 Z" fill="#fbbf24"/></svg>`;

const loginPage = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>登录 · 优质回调股票筛选器</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>
    :root {
      color-scheme: dark;
      --bg: #070d18;
      --card: rgba(16, 27, 47, 0.78);
      --line: rgba(56, 80, 115, 0.5);
      --text: #f1f5f9;
      --muted: #94a3b8;
      --accent: #45d6a7;
      --danger: #ff6b81;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(800px circle at 50% 10%, rgba(69, 214, 167, 0.12), transparent 45%),
        radial-gradient(600px circle at 80% 80%, rgba(56, 189, 248, 0.08), transparent 40%),
        #070d18;
      color: var(--text);
      font: 14.5px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 20px;
      -webkit-font-smoothing: antialiased;
    }
    .login {
      width: min(420px, 100%);
      padding: 38px 32px;
      background: var(--card);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(69, 214, 167, 0.22);
      border-radius: 22px;
      box-shadow: 0 24px 60px -12px rgba(0, 0, 0, 0.65), 0 0 35px -8px rgba(69, 214, 167, 0.12);
    }
    .login-brand {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }
    .login-logo {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      flex-shrink: 0;
      filter: drop-shadow(0 4px 10px rgba(69, 214, 167, 0.3));
    }
    .login-logo svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    h1 {
      font-size: 22px;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: #f8fafc;
    }
    .login-desc {
      color: var(--muted);
      font-size: 13.5px;
      line-height: 1.5;
      margin-bottom: 24px;
    }
    .form-group {
      margin-bottom: 16px;
    }
    label {
      display: block;
      color: #cbd5e1;
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 7px;
    }
    input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 11px;
      padding: 12px 14px;
      background: rgba(8, 15, 27, 0.85);
      color: var(--text);
      font-size: 14.5px;
      outline: none;
      transition: all 0.2s ease;
    }
    input:focus {
      border-color: var(--accent);
      background: rgba(12, 22, 38, 0.95);
      box-shadow: 0 0 0 3px rgba(69, 214, 167, 0.18);
    }
    button {
      width: 100%;
      margin-top: 10px;
      border: 0;
      border-radius: 11px;
      padding: 13px;
      background: linear-gradient(135deg, #45d6a7 0%, #20b885 100%);
      color: #04241a;
      font-size: 15px;
      font-weight: 750;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(69, 214, 167, 0.32);
      transition: all 0.18s ease;
    }
    button:hover:not(:disabled) {
      box-shadow: 0 6px 22px rgba(69, 214, 167, 0.45);
      transform: translateY(-1px);
    }
    button:active:not(:disabled) {
      transform: translateY(0);
    }
    button:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    .error {
      min-height: 20px;
      color: var(--danger);
      font-size: 13px;
      margin-top: 14px;
      text-align: center;
    }
  </style>
</head>
<body>
  <form class="login" id="login">
    <div class="login-brand">
      <span class="login-logo">${faviconSvg}</span>
      <h1>优质回调股票筛选器</h1>
    </div>
    <p class="login-desc">登录后管理市场筛选、定时任务和 Telegram 推送。</p>
    <div class="form-group">
      <label for="usernameInput">账号</label>
      <input id="usernameInput" name="username" autocomplete="username" placeholder="请输入管理员账号" required autofocus>
    </div>
    <div class="form-group">
      <label for="passwordInput">密码</label>
      <input id="passwordInput" name="password" type="password" autocomplete="current-password" placeholder="请输入密码" required>
    </div>
    <button type="submit">立即登录</button>
    <div class="error" id="error"></div>
  </form>
<script>
document.querySelector('#login').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter,error=document.querySelector('#error');button.disabled=true;error.textContent='';const data=Object.fromEntries(new FormData(event.currentTarget));try{const response=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw new Error(result.error||'登录失败');location.href='/';}catch(reason){error.textContent=reason.message;}finally{button.disabled=false;}});
</script>
</body>
</html>`;

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>优质回调股票筛选器</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>
    :root {
      color-scheme: dark;
      --bg: #070d18;
      --card: rgba(17, 28, 48, 0.75);
      --card-border: rgba(48, 70, 102, 0.55);
      --line: rgba(45, 65, 95, 0.5);
      --text: #f1f5f9;
      --muted: #94a3b8;
      --accent: #45d6a7;
      --danger: #ff6b81;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        radial-gradient(1000px circle at 50% -120px, rgba(30, 58, 95, 0.5), transparent 65%),
        radial-gradient(700px circle at 90% 15%, rgba(69, 214, 167, 0.07), transparent 45%),
        #070d18;
      color: var(--text);
      font: 14.5px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }
    .wrap {
      max-width: 1000px;
      margin: auto;
      padding: 36px 22px 80px;
    }
    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .brand-logo {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      flex-shrink: 0;
      filter: drop-shadow(0 4px 12px rgba(69, 214, 167, 0.28));
    }
    .brand-logo svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    h1 {
      margin: 0;
      font-size: clamp(22px, 3.8vw, 32px);
      letter-spacing: -0.03em;
      font-weight: 800;
      color: #f8fafc;
    }
    .subtitle {
      margin: 10px 0 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.6;
      max-width: none;
      text-wrap: balance;
    }
    .logout {
      width: auto;
      margin: 0;
      padding: 8px 16px;
      background: rgba(255, 255, 255, 0.05);
      color: #cbd5e1;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.18s ease;
      backdrop-filter: blur(8px);
    }
    .logout:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.22);
      color: #fff;
    }
    .tabs {
      display: flex;
      gap: 6px;
      margin: 28px 0 0;
      border-bottom: 1px solid var(--line);
      overflow-x: auto;
      scrollbar-width: none;
    }
    .tabs::-webkit-scrollbar { display: none; }
    .tab-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      width: auto;
      white-space: nowrap;
      padding: 11px 18px;
      background: transparent;
      color: var(--muted);
      border: 1px solid transparent;
      border-bottom: 2px solid transparent;
      border-top-left-radius: 11px;
      border-top-right-radius: 11px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      margin-bottom: -1px;
      transition: all 0.18s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .tab-btn:hover {
      color: #f8fafc;
      background: rgba(255, 255, 255, 0.035);
    }
    .tab-btn.active {
      color: var(--accent);
      background: rgba(20, 35, 58, 0.6);
      border-color: var(--card-border) var(--card-border) transparent;
      border-bottom: 2px solid var(--accent);
    }
    .tab-icon { flex-shrink: 0; }
    .tab-panel { display: block; }
    .tab-panel[hidden] { display: none !important; }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 16px;
      margin: 24px 0;
    }
    .card {
      background: linear-gradient(150deg, rgba(18, 31, 52, 0.75) 0%, rgba(11, 20, 35, 0.85) 100%);
      border: 1px solid var(--card-border);
      border-radius: 18px;
      padding: 22px;
      box-shadow: 0 12px 32px -10px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .card:hover {
      border-color: rgba(69, 214, 167, 0.35);
      box-shadow: 0 14px 38px -10px rgba(0, 0, 0, 0.6), 0 0 24px -6px rgba(69, 214, 167, 0.1);
    }
    .card h2 {
      font-size: 16px;
      font-weight: 700;
      margin: 0 0 14px;
      color: #f8fafc;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    label {
      display: block;
      color: #cbd5e1;
      font-size: 12.5px;
      font-weight: 500;
      margin: 12px 0 5px;
    }
    input, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px 12px;
      background: rgba(8, 15, 27, 0.85);
      color: var(--text);
      font-size: 14px;
      outline: none;
      transition: all 0.18s ease;
    }
    input:focus, select:focus {
      border-color: var(--accent);
      background: rgba(12, 22, 38, 0.95);
      box-shadow: 0 0 0 3px rgba(69, 214, 167, 0.18);
    }
    button {
      margin-top: 18px;
      background: linear-gradient(135deg, #45d6a7 0%, #20b885 100%);
      border: 0;
      border-radius: 10px;
      padding: 11px 16px;
      color: #04241a;
      font-weight: 750;
      font-size: 14px;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(69, 214, 167, 0.3);
      transition: all 0.18s ease;
    }
    button:hover:not(:disabled) {
      box-shadow: 0 6px 20px rgba(69, 214, 167, 0.45);
      transform: translateY(-1px);
    }
    button:active:not(:disabled) {
      transform: translateY(0);
    }
    button:disabled {
      opacity: 0.55;
      cursor: wait;
      box-shadow: none;
    }
    .hint {
      color: var(--accent);
      font-size: 12.5px;
      margin-top: 8px;
      line-height: 1.5;
    }

    .console-box {
      margin-top: 24px;
      background: rgba(7, 13, 23, 0.92);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 14px 40px -10px rgba(0, 0, 0, 0.6);
    }
    .console-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 11px 16px;
      background: rgba(14, 23, 38, 0.9);
      border-bottom: 1px solid var(--line);
    }
    .console-dots {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .console-dots span {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      display: inline-block;
    }
    .dot-red { background: #ff5f56; }
    .dot-yellow { background: #ffbd2e; }
    .dot-green { background: #27c93f; }
    .console-title {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--muted);
      font-size: 12.5px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .status-indicator {
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 8px var(--accent);
      display: inline-block;
    }
    .status-dot.running {
      background: #ffbd2e;
      box-shadow: 0 0 10px #ffbd2e;
      animation: pulse 1s infinite alternate;
    }
    .status-dot.error {
      background: var(--danger);
      box-shadow: 0 0 8px var(--danger);
    }
    @keyframes pulse {
      from { opacity: 0.5; transform: scale(0.9); }
      to { opacity: 1; transform: scale(1.15); }
    }
    .status {
      color: var(--muted);
      font-size: 12.5px;
      font-weight: 500;
    }
    .status.error {
      color: var(--danger);
    }
    .result {
      min-height: 200px;
      max-height: 520px;
      white-space: pre-wrap;
      overflow: auto;
      background: #060b14;
      border: 0;
      padding: 16px 18px;
      color: #cbd5e1;
      font: 13.5px/1.6 ui-monospace, "Cascadia Code", "Fira Code", Consolas, monospace;
      margin: 0;
    }
    .result::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    .result::-webkit-scrollbar-track {
      background: #060b14;
    }
    .result::-webkit-scrollbar-thumb {
      background: #1e293b;
      border-radius: 4px;
    }
    .result::-webkit-scrollbar-thumb:hover {
      background: #334155;
    }

    .rules-card {
      margin: 24px 0 0;
      padding: 26px;
    }
    .rules-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--line);
    }
    .rules-header h2 {
      font-size: 18px;
      font-weight: 700;
      margin: 0;
      color: #f8fafc;
    }
    .rules-badge {
      font-size: 12px;
      color: var(--accent);
      background: rgba(69, 214, 167, 0.12);
      border: 1px solid rgba(69, 214, 167, 0.28);
      border-radius: 6px;
      padding: 4px 10px;
      font-weight: 600;
    }
    .rule-block {
      padding: 16px 18px;
      margin-bottom: 14px;
      background: rgba(8, 15, 27, 0.7);
      border: 1px solid var(--line);
      border-radius: 14px;
      transition: border-color 0.2s;
    }
    .rule-block:hover {
      border-color: rgba(69, 214, 167, 0.3);
    }
    .rule-block:last-child {
      margin-bottom: 0;
    }
    .rule-block h3 {
      font-size: 14.5px;
      margin: 0 0 6px;
      color: var(--accent);
      font-weight: 650;
    }
    .rule-block p {
      margin: 0;
      font-size: 13.5px;
      line-height: 1.65;
      color: #cbd5e1;
    }

    .settings-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 16px;
      margin: 24px 0;
    }
    .days {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(68px, 1fr));
      gap: 6px;
      margin-top: 8px;
    }
    .days label {
      margin: 0;
      padding: 8px 6px;
      background: rgba(8, 15, 27, 0.85);
      border: 1px solid var(--line);
      border-radius: 8px;
      color: #cbd5e1;
      font-size: 12.5px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .days label:hover {
      border-color: var(--accent);
    }
    .secret-field {
      position: relative;
    }
    .secret-field input {
      padding-right: 46px;
    }
    .secret-toggle {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      display: grid;
      place-items: center;
      width: 34px;
      height: 32px;
      margin: 0;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--muted);
      border-radius: 6px;
      box-shadow: none;
    }
    .secret-toggle:hover {
      color: var(--text);
      background: rgba(255, 255, 255, 0.08);
      box-shadow: none;
      transform: translateY(-50%);
    }
    .form-status {
      min-height: 22px;
      margin: 12px 0 0;
      color: var(--muted);
      font-size: 13px;
    }
    .form-status.success { color: var(--accent); }
    .form-status.error { color: var(--danger); }
  </style>
</head>
<body>
<main class="wrap">
  <header>
    <div class="top">
      <div class="brand">
        <span class="brand-logo">${faviconSvg}</span>
        <h1>优质回调股票筛选器</h1>
      </div>
      <button class="logout" id="logout">退出登录</button>
    </div>
    <p class="subtitle">Williams %R 超卖信号结合 Buffett 基本面评分。支持美股 S&amp;P 500、泰股技术筛选及单股分析。</p>
  </header>
  <nav class="tabs" role="tablist">
    <button type="button" class="tab-btn active" role="tab" id="tab-btn-dashboard" aria-selected="true" data-tab="dashboard">
      <svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>
      <span>优质回调股票筛选器</span>
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
      <form class="card" id="screen">
        <h2>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
          <span>市场筛选</span>
        </h2>
        <label>模式</label>
        <select name="mode">
          <option value="combined">技术 + 基本面</option>
          <option value="technical">纯技术筛选</option>
        </select>
        <label>市场</label>
        <select name="market">
          <option value="us">美股 S&amp;P 500</option>
          <option value="th">泰股 SET</option>
        </select>
        <label>最少 Buffett 得分</label>
        <input name="minScore" type="number" min="0" max="10" value="5">
        <label>Williams %R 阈值</label>
        <input name="threshold" type="number" min="-100" max="0" value="-80">
        <label>结果数量</label>
        <input name="topN" type="number" min="1" max="100" value="10">
        <button type="submit">开始筛选</button>
      </form>
      <form class="card" id="analyze">
        <h2>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
          <span>单股分析</span>
        </h2>
        <label>股票代码</label>
        <input name="ticker" maxlength="20" placeholder="例如 AAPL 或 PTT.BK" required>
        <button type="submit">分析股票</button>
      </form>
    </section>
    <div class="console-box">
      <div class="console-header">
        <div class="console-dots">
          <span class="dot-red"></span>
          <span class="dot-yellow"></span>
          <span class="dot-green"></span>
        </div>
        <div class="console-title">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          <span>运行控制台</span>
        </div>
        <div class="status-indicator">
          <span class="status-dot" id="statusDot"></span>
          <span class="status" id="status">就绪</span>
        </div>
      </div>
      <pre class="result" id="result">筛选可能需要数分钟，运行期间请保持页面开启。</pre>
    </div>
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
      <form class="card" id="schedule">
        <h2>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span>定时筛选</span>
        </h2>
        <label><input name="enabled" type="checkbox" style="width:auto"> 启用定时任务</label>
        <label>执行时间（美东时间）</label>
        <input name="time" type="time" value="18:15">
        <div class="hint" id="beijingTime"></div>
        <label>执行日（按美东日期）</label>
        <div class="days" id="days">
          <label><input type="checkbox" value="1" style="width:auto"> 周一</label>
          <label><input type="checkbox" value="2" style="width:auto"> 周二</label>
          <label><input type="checkbox" value="3" style="width:auto"> 周三</label>
          <label><input type="checkbox" value="4" style="width:auto"> 周四</label>
          <label><input type="checkbox" value="5" style="width:auto"> 周五</label>
          <label><input type="checkbox" value="6" style="width:auto"> 周六</label>
          <label><input type="checkbox" value="0" style="width:auto"> 周日</label>
        </div>
        <label>市场</label>
        <select name="market"><option value="us">美股 S&amp;P 500</option><option value="th">泰股 SET</option></select>
        <label>最低 Buffett 得分</label>
        <input name="minScore" type="number" min="0" max="10" value="5">
        <label>推送数量</label>
        <input name="topN" type="number" min="1" max="50" value="10">
        <button type="submit">保存定时任务</button>
        <div class="form-status" id="scheduleStatus"></div>
      </form>
      <form class="card" id="telegram">
        <h2>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          <span>Telegram 推送配置</span>
        </h2>
        <label>BOT Token</label>
        <div class="secret-field">
          <input name="botToken" id="botToken" type="password" autocomplete="off" spellcheck="false" placeholder="输入 Telegram Bot Token" required>
          <button class="secret-toggle" id="toggleBotToken" type="button" aria-label="显示 BOT Token" title="显示 BOT Token">
            <svg class="eye-open" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </div>
        <div class="hint">Token 默认隐藏，点击小眼睛可查看完整信息。</div>
        <label>Chat ID</label>
        <input name="chatId" autocomplete="off" placeholder="例如 -1001234567890" required>
        <button type="submit">保存 Telegram 配置</button>
        <div class="form-status" id="telegramStatus"></div>
      </form>
    </section>
  </div>
</main>
<script>
const statusNode=document.querySelector('#status'),statusDot=document.querySelector('#statusDot'),resultNode=document.querySelector('#result');
const tabBtns=document.querySelectorAll('.tab-btn'),tabPanels=document.querySelectorAll('.tab-panel');
tabBtns.forEach(btn=>{btn.addEventListener('click',()=>{const target=btn.dataset.tab;tabBtns.forEach(b=>{const active=b===btn;b.classList.toggle('active',active);b.setAttribute('aria-selected',active?'true':'false');});tabPanels.forEach(panel=>{const active=panel.id==='panel-'+target;panel.classList.toggle('active',active);if(active){panel.removeAttribute('hidden');}else{panel.setAttribute('hidden','');}});});});
async function request(path,data,button){button.disabled=true;statusNode.className='status';statusNode.textContent='运行中…';if(statusDot)statusDot.className='status-dot running';resultNode.textContent='正在获取市场数据，请稍候。';try{const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const payload=await response.json();if(!response.ok)throw new Error(payload.error||'请求失败');resultNode.textContent=JSON.stringify(payload.result,null,2);statusNode.textContent='完成';if(statusDot)statusDot.className='status-dot';}catch(error){statusNode.className='status error';statusNode.textContent=error.message;if(statusDot)statusDot.className='status-dot error';resultNode.textContent='';}finally{button.disabled=false;}}
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
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    (url.pathname === "/favicon.ico" || url.pathname === "/favicon.svg")
  ) {
    response.writeHead(200, {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    response.end(faviconSvg);
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
