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
      --bg: #0d1117;
      --surface: #161b26;
      --surface-subtle: #131722;
      --border: #262d3d;
      --text: #e6edf3;
      --muted: #8d96a7;
      --blue: #3b82f6;
      --blue-glow: rgba(59, 130, 246, 0.25);
      --red: #ef4444;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 20px;
      background: radial-gradient(circle at top, #18233b 0%, var(--bg) 50%);
      color: var(--text);
      font-family: var(--font-sans);
      -webkit-font-smoothing: antialiased;
    }
    .login-card {
      width: 100%;
      max-width: 400px;
      background: rgba(22, 27, 38, 0.96);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 34px 30px;
      box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
    }
    .login-brand {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }
    .login-logo {
      width: 42px;
      height: 42px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      filter: drop-shadow(0 4px 10px rgba(59, 130, 246, 0.3));
    }
    .login-logo svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    h1 {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.2px;
      color: #fff;
    }
    .sub {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
      margin-bottom: 22px;
    }
    label {
      display: block;
      color: #cbd5e1;
      font-size: 12.5px;
      font-weight: 600;
      margin: 14px 0 6px;
    }
    input {
      width: 100%;
      padding: 11px 13px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--surface-subtle);
      color: var(--text);
      font-size: 13.5px;
      outline: none;
      transition: all 0.2s ease;
    }
    input:focus {
      border-color: var(--blue);
      box-shadow: 0 0 0 3px var(--blue-glow);
      background: #090d14;
    }
    button {
      width: 100%;
      margin-top: 22px;
      padding: 11px;
      border: 0;
      border-radius: 8px;
      background: var(--blue);
      color: #fff;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 2px 10px rgba(59, 130, 246, 0.35);
      transition: all 0.15s ease;
    }
    button:hover:not(:disabled) {
      background: #2563eb;
      box-shadow: 0 4px 14px rgba(59, 130, 246, 0.45);
    }
    button:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    .error {
      margin: 14px 0 0;
      color: #fca5a5;
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.25);
      border-radius: 7px;
      padding: 9px 12px;
      font-size: 12.5px;
      display: none;
      text-align: center;
    }
    .error:not(:empty) {
      display: block;
    }
  </style>
</head>
<body>
  <form class="login-card" id="login">
    <div class="login-brand">
      <span class="login-logo">${faviconSvg}</span>
      <h1>优质回调股票筛选器</h1>
    </div>
    <div class="sub">登录后查看回调信号、单股诊断、定时任务与 TG 推送。</div>
    <label for="usernameInput">账号</label>
    <input id="usernameInput" name="username" autocomplete="username" placeholder="请输入管理员账号" required autofocus>
    <label for="passwordInput">密码</label>
    <input id="passwordInput" name="password" type="password" autocomplete="current-password" placeholder="请输入密码" required>
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
      --bg: #0d1117;
      --surface: #161b26;
      --surface-hover: #1e2433;
      --surface-subtle: #131722;
      --border: #262d3d;
      --border-light: #363f54;
      --text: #e6edf3;
      --text-strong: #ffffff;
      --muted: #8d96a7;
      --muted-light: #b1b9c7;
      --green: #22c55e;
      --green-bg: rgba(34, 197, 94, 0.12);
      --green-border: rgba(34, 197, 94, 0.28);
      --red: #ef4444;
      --red-bg: rgba(239, 68, 68, 0.12);
      --yellow: #eab308;
      --yellow-bg: rgba(234, 179, 8, 0.12);
      --blue: #3b82f6;
      --blue-bg: rgba(59, 130, 246, 0.12);
      --blue-glow: rgba(59, 130, 246, 0.25);
      --purple: #a855f7;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--font-sans);
      background: var(--bg);
      color: var(--text);
      -webkit-font-smoothing: antialiased;
      line-height: 1.5;
      min-height: 100vh;
    }
    .font-mono { font-family: var(--font-mono) !important; }

    .header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 16px 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .header-logo {
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .header-logo svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .header h1 {
      font-size: 19px;
      font-weight: 700;
      letter-spacing: -0.2px;
      color: var(--text-strong);
      margin: 0;
    }
    .header .meta {
      color: var(--muted);
      font-size: 13px;
      margin-top: 2px;
    }
    .header .actions {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }

    .btn {
      padding: 8px 16px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      user-select: none;
    }
    .btn:hover {
      border-color: var(--blue);
      color: #fff;
      background: var(--surface-hover);
    }
    .btn.primary {
      background: var(--blue);
      border-color: var(--blue);
      color: #fff;
      font-weight: 600;
      box-shadow: 0 2px 8px rgba(59, 130, 246, 0.3);
    }
    .btn.primary:hover {
      background: #2563eb;
      border-color: #2563eb;
      box-shadow: 0 4px 14px rgba(59, 130, 246, 0.45);
    }
    .btn.secondary {
      background: var(--surface-subtle);
      border-color: var(--border);
    }
    .btn.secondary:hover {
      border-color: var(--blue);
      color: #60a5fa;
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 24px;
    }

    .tab-nav {
      display: flex;
      gap: 10px;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 2px;
    }
    .tab-btn {
      border: 0;
      border-bottom: 2px solid transparent;
      background: transparent;
      color: var(--muted);
      padding: 12px 18px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      transition: all 0.2s ease;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border-radius: 6px 6px 0 0;
    }
    .tab-btn:hover {
      color: var(--text);
      background: rgba(255, 255, 255, 0.03);
    }
    .tab-btn.active {
      color: #60a5fa;
      border-bottom-color: var(--blue);
      background: rgba(59, 130, 246, 0.06);
    }
    .tab-panel { display: none; }
    .tab-panel.active {
      display: block;
      animation: fadeIn 0.2s ease;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-bottom: 24px;
    }
    @media (max-width: 900px) {
      .grid-2 { grid-template-columns: 1fr; }
    }

    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.18);
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
      display: flex;
      flex-direction: column;
    }
    .card:hover {
      border-color: var(--border-light);
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--border);
    }
    .card-header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .card-icon-badge {
      width: 38px;
      height: 38px;
      border-radius: 10px;
      background: var(--blue-bg);
      color: #60a5fa;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      border: 1px solid rgba(59, 130, 246, 0.2);
    }
    .card-icon-badge.green {
      background: var(--green-bg);
      color: #4ade80;
      border-color: var(--green-border);
    }
    .card-icon-badge.yellow {
      background: var(--yellow-bg);
      color: #facc15;
      border-color: rgba(234, 179, 8, 0.28);
    }
    .card-icon-badge.purple {
      background: rgba(168, 85, 247, 0.12);
      color: #c084fc;
      border-color: rgba(168, 85, 247, 0.25);
    }

    .card-title-group h2 {
      font-size: 16px;
      font-weight: 700;
      color: var(--text-strong);
      letter-spacing: -0.2px;
      margin: 0;
    }
    .card-title-group p {
      font-size: 12px;
      color: var(--muted);
      margin-top: 3px;
    }

    .config-form {
      display: flex;
      flex-direction: column;
      gap: 18px;
      flex: 1;
    }
    .form-row {
      display: grid;
      grid-template-columns: 140px 1fr;
      gap: 16px;
      align-items: flex-start;
    }
    @media (max-width: 600px) {
      .form-row { grid-template-columns: 1fr; gap: 8px; }
    }
    .form-label {
      font-size: 13px;
      font-weight: 600;
      color: #cbd5e1;
      margin-top: 7px;
      line-height: 1.4;
    }
    .form-label-desc {
      display: block;
      font-size: 11px;
      font-weight: 400;
      color: var(--muted);
      margin-top: 2px;
    }

    .form-control {
      width: 100%;
      max-width: 380px;
      color: var(--text);
      background: var(--surface-subtle);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 13px;
      font-family: inherit;
      transition: all 0.2s ease;
    }
    .form-control:focus {
      border-color: var(--blue);
      outline: none;
      box-shadow: 0 0 0 3px var(--blue-glow);
      background: var(--bg);
    }
    .form-control-static {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 14px;
      border-radius: 8px;
      background: var(--surface-subtle);
      border: 1px solid var(--border);
      font-size: 13px;
      color: var(--text);
    }
    .field-hint {
      font-size: 12px;
      color: var(--muted);
      margin-top: 6px;
      line-height: 1.5;
    }
    .field-hint code {
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 2px 5px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.06);
      color: #93c5fd;
    }

    .switch-control {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      cursor: pointer;
      user-select: none;
      padding: 4px 0;
    }
    .switch-control input {
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
    }
    .switch-slider {
      position: relative;
      width: 44px;
      height: 24px;
      background: #202636;
      border: 1px solid #363f54;
      border-radius: 24px;
      transition: all 0.25s ease;
      flex-shrink: 0;
    }
    .switch-slider:before {
      position: absolute;
      content: "";
      height: 18px;
      width: 18px;
      left: 2px;
      bottom: 2px;
      background: #94a3b8;
      border-radius: 50%;
      transition: all 0.25s ease;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.4);
    }
    .switch-control input:checked + .switch-slider {
      background: #2563eb;
      border-color: #3b82f6;
      box-shadow: 0 0 10px rgba(59, 130, 246, 0.35);
    }
    .switch-control input:checked + .switch-slider:before {
      transform: translateX(20px);
      background: #ffffff;
    }
    .switch-text {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
    }

    .weekday-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .weekday-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 7px 15px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      background: var(--surface-subtle);
      border: 1px solid var(--border);
      color: var(--muted);
      cursor: pointer;
      transition: all 0.2s ease;
      user-select: none;
    }
    .weekday-pill input {
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
    }
    .weekday-pill:hover {
      border-color: #4b5563;
      color: var(--text);
    }
    .weekday-pill.active {
      background: rgba(59, 130, 246, 0.16);
      border-color: #3b82f6;
      color: #60a5fa;
      font-weight: 600;
      box-shadow: 0 0 10px rgba(59, 130, 246, 0.2);
    }
    .weekday-quick {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }
    .btn-xs {
      padding: 4px 10px;
      font-size: 11px;
      border-radius: 5px;
      border: 1px dashed var(--border);
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-xs:hover {
      border-color: var(--blue);
      color: #60a5fa;
      background: rgba(59, 130, 246, 0.08);
    }

    .secret-input-wrap {
      display: flex;
      width: 100%;
      max-width: 380px;
    }
    .secret-input-wrap .form-control {
      border-radius: 8px 0 0 8px;
      font-family: var(--font-mono);
      letter-spacing: 0.5px;
      font-size: 13px;
      max-width: none;
    }
    .secret-toggle {
      width: 44px;
      border: 1px solid var(--border);
      border-left: 0;
      border-radius: 0 8px 8px 0;
      background: var(--surface-subtle);
      color: var(--muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }
    .secret-toggle:hover {
      color: var(--text);
      border-color: var(--blue);
      background: rgba(59, 130, 246, 0.08);
    }

    .time-picker-wrap {
      display: inline-flex;
      align-items: center;
      gap: 10px;
    }
    .time-input {
      font-family: var(--font-mono);
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 1.5px;
      width: 140px;
      text-align: center;
      padding: 8px 12px;
    }
    .input-tag {
      font-size: 11px;
      padding: 4px 8px;
      border-radius: 5px;
      background: rgba(234, 179, 8, 0.12);
      color: #facc15;
      border: 1px solid rgba(234, 179, 8, 0.25);
    }

    .input-with-prefix {
      position: relative;
      width: 100%;
      max-width: 380px;
    }
    .input-prefix {
      position: absolute;
      left: 12px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--muted);
      font-family: var(--font-mono);
      font-weight: 700;
      pointer-events: none;
    }
    .input-with-prefix .form-control {
      padding-left: 32px;
      font-family: var(--font-mono);
      max-width: none;
    }

    .status-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: var(--surface-subtle);
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 18px;
    }
    .status-item {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      font-weight: 600;
    }
    .status-sub {
      font-size: 12px;
      color: var(--muted);
      font-family: var(--font-mono);
    }
    .pulse-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      display: inline-block;
    }
    .pulse-dot.green {
      background: #22c55e;
      box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7);
      animation: pulseGreen 2s infinite;
    }
    .pulse-dot.yellow {
      background: #eab308;
      box-shadow: 0 0 0 0 rgba(234, 179, 8, 0.7);
      animation: pulseYellow 1s infinite alternate;
    }
    .pulse-dot.red { background: #ef4444; }
    @keyframes pulseGreen {
      0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
      70% { box-shadow: 0 0 0 6px rgba(34, 197, 94, 0); }
      100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
    }
    @keyframes pulseYellow {
      from { transform: scale(0.9); opacity: 0.6; }
      to { transform: scale(1.15); opacity: 1; }
    }

    .dual-clocks {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin-bottom: 18px;
    }
    @media (max-width: 600px) { .dual-clocks { grid-template-columns: 1fr; } }

    .clock-card {
      background: var(--surface-subtle);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .clock-card.highlight {
      border-color: rgba(59, 130, 246, 0.35);
      background: linear-gradient(135deg, rgba(59, 130, 246, 0.08) 0%, var(--surface-subtle) 100%);
    }
    .clock-label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      font-weight: 600;
      color: var(--muted-light);
    }
    .clock-value {
      font-size: 15px;
      font-weight: 700;
      color: var(--text-strong);
      letter-spacing: 0.2px;
    }
    .clock-desc {
      font-size: 11px;
      color: var(--muted);
      line-height: 1.4;
    }

    .terminal-card {
      background: #090b10;
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      margin-top: 20px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    }
    .terminal-header {
      background: #141822;
      padding: 10px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
    }
    .terminal-dots { display: flex; gap: 6px; align-items: center; }
    .terminal-dots span {
      width: 9px;
      height: 9px;
      border-radius: 50%;
    }
    .terminal-dots span:nth-child(1) { background: #ef4444; }
    .terminal-dots span:nth-child(2) { background: #eab308; }
    .terminal-dots span:nth-child(3) { background: #22c55e; }
    .terminal-label {
      font-size: 12px;
      font-family: var(--font-mono);
      color: var(--muted);
      margin-left: 8px;
      font-weight: 500;
    }
    .terminal-body {
      padding: 14px 18px;
      font-size: 12.5px;
      line-height: 1.6;
      color: #93c5fd;
      background: #06080e;
      white-space: pre-wrap;
      max-height: 500px;
      overflow-y: auto;
      font-family: var(--font-mono);
      margin: 0;
    }

    .card-footer {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: auto;
      padding-top: 18px;
      border-top: 1px solid var(--border);
      flex-wrap: wrap;
    }
    .status-msg {
      font-size: 12px;
      padding: 5px 12px;
      border-radius: 6px;
      display: none;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
    }
    .status-msg.success {
      display: inline-flex;
      background: var(--green-bg);
      color: #4ade80;
      border: 1px solid var(--green-border);
    }
    .status-msg.error {
      display: inline-flex;
      background: var(--red-bg);
      color: #fca5a5;
      border: 1px solid rgba(239, 68, 68, 0.28);
    }

    .feature-notes {
      display: flex;
      flex-direction: column;
      gap: 12px;
      list-style: none;
    }
    .feature-note-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 8px;
      background: var(--surface-subtle);
      border: 1px solid var(--border);
      font-size: 13px;
      color: var(--muted-light);
      line-height: 1.5;
    }
    .feature-note-icon {
      font-size: 15px;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .feature-note-item strong { color: var(--text-strong); }
    .feature-note-item code {
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 2px 5px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.06);
      color: #93c5fd;
    }

    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      line-height: 1.2;
    }
    .badge.green, .badge.good {
      background: var(--green-bg);
      color: var(--green);
      border: 1px solid var(--green-border);
    }
    .badge.yellow {
      background: var(--yellow-bg);
      color: var(--yellow);
      border: 1px solid rgba(234, 179, 8, 0.28);
    }
    .badge.red {
      background: var(--red-bg);
      color: var(--red);
      border: 1px solid rgba(239, 68, 68, 0.28);
    }
    .badge.blue {
      background: var(--blue-bg);
      color: #60a5fa;
      border: 1px solid rgba(59, 130, 246, 0.28);
    }

    .stats-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px 20px;
    }
    .stat-card .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }
    .stat-card .value {
      font-size: 26px;
      font-weight: 700;
    }
    .stat-card .sub {
      color: var(--muted);
      font-size: 12px;
      margin-top: 4px;
    }
    .stat-card.green .value { color: var(--green); }
    .stat-card.blue .value { color: var(--blue); }
    .stat-card.yellow .value { color: var(--yellow); }

    .signal-table {
      width: 100%;
      border-collapse: collapse;
    }
    .signal-table th {
      text-align: left;
      padding: 10px 12px;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid var(--border);
    }
    .signal-table td {
      padding: 12px;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
      vertical-align: middle;
    }
    .signal-table tr:hover {
      background: rgba(59, 130, 246, 0.04);
    }
    .ticker {
      font-weight: 700;
      font-size: 14px;
      color: var(--blue);
    }
    .score-bar {
      height: 6px;
      border-radius: 3px;
      background: var(--border);
      overflow: hidden;
      width: 70px;
      display: inline-block;
      vertical-align: middle;
      margin-left: 6px;
    }
    .score-bar .fill {
      height: 100%;
      border-radius: 3px;
    }
    .score-num {
      font-weight: 600;
      font-size: 13px;
    }

    .notice {
      padding: 12px 14px;
      border-left: 3px solid var(--yellow);
      background: rgba(234, 179, 8, 0.08);
      color: var(--muted);
      border-radius: 4px;
      font-size: 12px;
      line-height: 1.7;
    }
    .notice strong { color: var(--text-strong); }

    details.rule-group {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 12px;
    }
    details.rule-group summary {
      cursor: pointer;
      padding: 16px 20px;
      font-size: 14.5px;
      font-weight: 600;
      color: var(--text-strong);
      user-select: none;
    }
    details.rule-group .detail-content {
      padding: 0 20px 20px;
    }
    .param-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
    }
    .param-table th, .param-table td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      font-size: 12.5px;
      vertical-align: top;
    }
    .param-table th {
      color: var(--muted);
      font-size: 11.5px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    @media (max-width: 760px) {
      .header {
        padding: 14px 16px;
        align-items: flex-start;
        gap: 12px;
        flex-direction: column;
      }
      .container { padding: 16px; }
    }
  </style>
</head>
<body>

<header class="header">
  <div class="header-left">
    <div class="header-logo">${faviconSvg}</div>
    <div>
      <h1>优质回调股票筛选器</h1>
      <div class="meta" id="headerMeta">Williams %R 超卖信号结合 Buffett 基本面评分 · 美股 S&amp;P 500 / 泰股</div>
    </div>
  </div>
  <div class="actions">
    <div class="status-item">
      <span class="pulse-dot green" id="statusDot"></span>
      <span class="scan-status" id="status">就绪</span>
    </div>
    <button class="btn" type="button" id="quickTestBtn">快速测试（10只）</button>
    <button class="btn" type="button" id="logout">退出</button>
  </div>
</header>

<div class="container" id="content">
  <nav class="tab-nav" role="tablist">
    <button type="button" class="tab-btn active" role="tab" id="tab-btn-dashboard" aria-selected="true" data-tab="dashboard">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>
      <span>优质回调股票筛选器</span>
    </button>
    <button type="button" class="tab-btn" role="tab" id="tab-btn-rules" aria-selected="false" data-tab="rules">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
      <span>选股逻辑与指标说明</span>
    </button>
    <button type="button" class="tab-btn" role="tab" id="tab-btn-settings" aria-selected="false" data-tab="settings">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.14.37.36.7.65.97.3.26.68.41 1.08.43H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.6z"/></svg>
      <span>定时任务与 TG 推送</span>
    </button>
  </nav>

  <div class="tab-panel active" id="panel-dashboard" role="tabpanel" aria-labelledby="tab-btn-dashboard">
    <div class="grid-2">
      <form class="card" id="screen">
        <div class="card-header">
          <div class="card-header-left">
            <div class="card-icon-badge">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
            </div>
            <div class="card-title-group">
              <h2>市场筛选</h2>
              <p>技术超卖与价值质量双重因子初筛</p>
            </div>
          </div>
          <span class="badge blue">双重因子</span>
        </div>

        <div class="config-form">
          <div class="form-row">
            <div class="form-label">
              筛选模式
              <span class="form-label-desc">综合或纯技术面</span>
            </div>
            <div>
              <select class="form-control" name="mode">
                <option value="combined">技术 + 基本面（推荐）</option>
                <option value="technical">纯技术筛选（超卖过滤）</option>
              </select>
              <div class="field-hint">综合模式计算 Williams %R + 巴菲特 10 项评分；技术模式仅计算超卖。</div>
            </div>
          </div>

          <div class="form-row">
            <div class="form-label">
              目标市场
              <span class="form-label-desc">标的股票池</span>
            </div>
            <div>
              <select class="form-control" name="market">
                <option value="us">美股 S&amp;P 500（标普500成分股）</option>
                <option value="th">泰股 SET（泰国主流股票）</option>
              </select>
              <div class="field-hint">泰股目前仅支持技术面超卖筛选；美股支持双重全因子筛选。</div>
            </div>
          </div>

          <div class="form-row">
            <div class="form-label">
              最低 Buffett 得分
              <span class="form-label-desc">基本面准入门槛</span>
            </div>
            <div>
              <input class="form-control" name="minScore" type="number" min="0" max="10" value="5">
              <div class="field-hint">满分 10 分。≥7 分为 <code>Buy candidate</code>，5–6 分为 <code>Don't buy yet</code>。</div>
            </div>
          </div>

          <div class="form-row">
            <div class="form-label">
              Williams %R 阈值
              <span class="form-label-desc">超卖深度界限</span>
            </div>
            <div>
              <input class="form-control" name="threshold" type="number" min="-100" max="0" value="-80">
              <div class="field-hint">默认 -80。区间在 -80 至 -100 之间属于超卖区域。</div>
            </div>
          </div>

          <div class="form-row">
            <div class="form-label">
              展示上限 Top N
              <span class="form-label-desc">精选榜单数量</span>
            </div>
            <div>
              <input class="form-control" name="topN" type="number" min="1" max="100" value="10">
              <div class="field-hint">按综合得分从高到低排列的前 N 只回调标的。</div>
            </div>
          </div>
        </div>

        <div class="card-footer">
          <button class="btn primary" type="submit">开始市场筛选</button>
        </div>
      </form>

      <form class="card" id="analyze">
        <div class="card-header">
          <div class="card-header-left">
            <div class="card-icon-badge purple">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
            </div>
            <div class="card-title-group">
              <h2>单股分析</h2>
              <p>指定股票代码即时诊断指标与财报</p>
            </div>
          </div>
          <span class="badge green">即时诊断</span>
        </div>

        <div class="config-form">
          <div class="form-row">
            <div class="form-label">
              股票代码
              <span class="form-label-desc">美股或泰股 Ticker</span>
            </div>
            <div>
              <div class="input-with-prefix">
                <span class="input-prefix">$</span>
                <input class="form-control font-mono" name="ticker" maxlength="20" placeholder="例如 AAPL, MSFT, PTT.BK" required>
              </div>
              <div class="field-hint">美股直接输入代码（如 <code>AAPL</code>）；泰股后缀 <code>.BK</code>（如 <code>PTT.BK</code>）。</div>
            </div>
          </div>
        </div>

        <div class="card-footer">
          <button class="btn primary" type="submit">分析股票</button>
        </div>
      </form>
    </div>

    <div class="stats-row" id="statsRow" style="display:none">
      <div class="stat-card blue">
        <div class="label">扫描标的</div>
        <div class="value font-mono" id="statTotalScanned">-</div>
        <div class="sub">池内标的总量</div>
      </div>
      <div class="stat-card yellow">
        <div class="label">超卖触发数</div>
        <div class="value font-mono" id="statOversold">-</div>
        <div class="sub">Williams %R &le; -80</div>
      </div>
      <div class="stat-card green">
        <div class="label">推荐标的数</div>
        <div class="value font-mono" id="statCandidates">-</div>
        <div class="sub">达到门槛精选标的</div>
      </div>
      <div class="stat-card">
        <div class="label">当前策略模式</div>
        <div class="value" style="font-size:18px" id="statStrategy">-</div>
        <div class="sub">筛选评估机制</div>
      </div>
    </div>

    <div class="card" id="tableCard" style="display:none;margin-bottom:24px">
      <div class="card-header">
        <div class="card-header-left">
          <div class="card-icon-badge green">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          </div>
          <div class="card-title-group">
            <h2 id="tableTitle">精选标的列表</h2>
            <p id="tableSubtitle">按量化评分升序/降序结构化呈现</p>
          </div>
        </div>
        <span class="badge green" id="tableBadge">已完成</span>
      </div>
      <div style="overflow-x:auto" id="tableContent"></div>
    </div>

    <div class="terminal-card">
      <div class="terminal-header">
        <div class="terminal-dots">
          <span></span><span></span><span></span>
          <span class="terminal-label">execution console · 运行控制台</span>
        </div>
        <div class="status-item">
          <span class="status-sub" id="consoleTime">就绪</span>
        </div>
      </div>
      <pre class="terminal-body" id="result">就绪。请点击「开始市场筛选」或「分析股票」运行任务。</pre>
    </div>
  </div>

  <div class="tab-panel" id="panel-rules" role="tabpanel" aria-labelledby="tab-btn-rules">
    <div class="notice" style="margin-bottom:18px">
      <strong>双重因子筛选体系：</strong>结合 Williams %R 技术面超卖因子（捕捉短期价格过度回调）与 SEC EDGAR 巴菲特价值质量因子（排除基本面受损的价值陷阱），挖掘被错杀的优质公司。
    </div>

    <details class="rule-group" open>
      <summary>第一部分：技术面超卖筛选（Williams %R）</summary>
      <div class="detail-content">
        <p style="color:var(--muted-light);font-size:13px;line-height:1.6;margin-bottom:12px">
          Williams %R（威廉指标）用于衡量当前收盘价在近期价格极值区间中的相对位置。数值范围在 0 至 -100 之间。
        </p>
        <table class="param-table">
          <thead>
            <tr>
              <th>参数项</th>
              <th>默认取值</th>
              <th>说明与判定</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>计算周期</strong></td>
              <td><code>21 个交易日</code></td>
              <td>基于约 1 个自然月的交易日，兼顾稳定性与灵敏度</td>
            </tr>
            <tr>
              <td><strong>超卖判定阈值</strong></td>
              <td><code>&le; -80</code></td>
              <td>越接近 -100，收盘价越贴近近期底部区间，代表技术面充分回调</td>
            </tr>
            <tr>
              <td><strong>超卖因子权重</strong></td>
              <td><code>30%</code></td>
              <td>换算为 0–100 强度分，纳入最终综合打分</td>
            </tr>
            <tr>
              <td><strong>行情数据来源</strong></td>
              <td>Yahoo Finance</td>
              <td>获取最近 90 个交易日开、高、低、收盘价并动态复权</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>

    <details class="rule-group" open>
      <summary>第二部分：基本面质量评估（Buffett 10 项财务准则）</summary>
      <div class="detail-content">
        <p style="color:var(--muted-light);font-size:13px;line-height:1.6;margin-bottom:12px">
          从 SEC EDGAR 官方披露的年报/季报中提取过去五年关键财务指标，每符合一项标准得 1 分，满分 10 分：
        </p>
        <table class="param-table">
          <thead>
            <tr>
              <th>#</th>
              <th>评估准则</th>
              <th>达标门槛</th>
              <th>财务含义与考核重点</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>1</td>
              <td><strong>现金覆盖债务</strong></td>
              <td><code>Cash &gt; Total Debt</code></td>
              <td>现金储备完全覆盖全部负债，抗极端风险能力极强</td>
            </tr>
            <tr>
              <td>2</td>
              <td><strong>负债权益比</strong></td>
              <td><code>D/E &lt; 0.5</code></td>
              <td>保守的财务杠杆，股东权益充足，财务安全垫厚</td>
            </tr>
            <tr>
              <td>3</td>
              <td><strong>净资产收益率</strong></td>
              <td><code>ROE &gt; 15%</code></td>
              <td>出色的股东资本回报能力，具有持续商业护城河</td>
            </tr>
            <tr>
              <td>4</td>
              <td><strong>流动比率</strong></td>
              <td><code>Current Ratio &gt; 1.5</code></td>
              <td>短期偿债能力充裕，无流动性挤兑风险</td>
            </tr>
            <tr>
              <td>5</td>
              <td><strong>营业利润率</strong></td>
              <td><code>Operating Margin &gt; 15%</code></td>
              <td>核心业务具备极强定价权与毛利保障</td>
            </tr>
            <tr>
              <td>6</td>
              <td><strong>资产周转率</strong></td>
              <td><code>Asset Turnover &gt; 0.5</code></td>
              <td>资产运营高效，非沉重低效重资产结构</td>
            </tr>
            <tr>
              <td>7</td>
              <td><strong>利息保障倍数</strong></td>
              <td><code>Interest Coverage &gt; 5x</code></td>
              <td>息税前利润充裕覆盖利息支出，还本付息轻松</td>
            </tr>
            <tr>
              <td>8</td>
              <td><strong>盈利稳定性</strong></td>
              <td><code>5年 EPS 正向持续</code></td>
              <td>过去 5 年每股收益稳定向上，避免周期大起大落</td>
            </tr>
            <tr>
              <td>9</td>
              <td><strong>自由现金流</strong></td>
              <td><code>FCF &gt; 0</code></td>
              <td>真实的真金白银造血能力，非应收账款虚增利润</td>
            </tr>
            <tr>
              <td>10</td>
              <td><strong>资本配置效率</strong></td>
              <td><code>ROIC &gt; 12% 或 持续分红回购</code></td>
              <td>管理层卓越的资本再配置能力，厚待长线股东</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>

    <details class="rule-group" open>
      <summary>第三部分：综合打分模型与交易决策判定</summary>
      <div class="detail-content">
        <p style="color:var(--muted-light);font-size:13px;line-height:1.6;margin-bottom:12px">
          综合得分（0–100 分） = <strong>技术超卖强度得分 &times; 30% + 巴菲特基本面得分 &times; 70%</strong>：
        </p>
        <table class="param-table">
          <thead>
            <tr>
              <th>综合评级</th>
              <th>Buffett 得分标准</th>
              <th>决策含义</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span class="badge green">Buy candidate</span></td>
              <td><code>&ge; 7 分</code></td>
              <td>超卖优质标的。基本面极其扎实，短线回调创造潜在击球区。</td>
            </tr>
            <tr>
              <td><span class="badge yellow">Don&rsquo;t buy yet</span></td>
              <td><code>5 &ndash; 6 分</code></td>
              <td>基本面中等偏良，建议加入观察池，等待更清晰的反弹确认。</td>
            </tr>
            <tr>
              <td><span class="badge red">Filter out</span></td>
              <td><code>&lt; 5 分</code></td>
              <td>即使跌幅极深亦直接过滤，防范基本面恶化或退市风险。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>

    <details class="rule-group">
      <summary>第四部分：数据接口合规性与免责声明</summary>
      <div class="detail-content">
        <ul class="feature-notes">
          <li class="feature-note-item">
            <span class="feature-note-icon">🏛️</span>
            <div>
              <strong>SEC EDGAR 规范访问</strong>：美股财务数据来自美国证监会 EDGAR 免费公开接口，系统严格配置了合规的声明 User-Agent 并内置频率节流。
            </div>
          </li>
          <li class="feature-note-item">
            <span class="feature-note-icon">📈</span>
            <div>
              <strong>价格增量缓存策略</strong>：价格历史由 SQLite 本地缓存守护，降低对外请求频率并提高秒级筛选效率。
            </div>
          </li>
          <li class="feature-note-item">
            <span class="feature-note-icon">⚠️</span>
            <div>
              <strong>量化筛选免责声明</strong>：本筛选器为基于既定指标的机械量化选股工具，不构成任何投资建议或收益保证。投资有风险，入市需谨慎。
            </div>
          </li>
        </ul>
      </div>
    </details>
  </div>

  <div class="tab-panel" id="panel-settings" role="tabpanel" aria-labelledby="tab-btn-settings">
    <div class="grid-2">
      <form class="card" id="schedule">
        <div class="card-header">
          <div class="card-header-left">
            <div class="card-icon-badge">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            </div>
            <div class="card-title-group">
              <h2>定时任务配置</h2>
              <p>自动化盘后全市场筛选与推送计划</p>
            </div>
          </div>
          <span class="badge green" id="scheduleBadge">定时任务就绪</span>
        </div>

        <div class="config-form">
          <div class="form-row">
            <div class="form-label">
              任务开关
              <span class="form-label-desc">定时自动化执行</span>
            </div>
            <div>
              <label class="switch-control">
                <input type="checkbox" name="enabled" id="scheduleEnabled">
                <span class="switch-slider"></span>
                <span class="switch-text" id="scheduleEnabledText">定时任务已暂停</span>
              </label>
            </div>
          </div>

          <div class="form-row">
            <div class="form-label">
              基准时区
              <span class="form-label-desc">美股数据归档地</span>
            </div>
            <div>
              <div class="form-control-static">
                <span>🇺🇸</span>
                <strong>America/New_York</strong>
                <span style="color:var(--muted);font-size:12px">（美东时间）</span>
              </div>
            </div>
          </div>

          <div class="form-row">
            <div class="form-label">
              美东执行时间
              <span class="form-label-desc">盘后触发时点</span>
            </div>
            <div>
              <div class="time-picker-wrap">
                <input class="form-control time-input font-mono" name="time" id="scheduleTime" type="time" value="18:15">
                <span class="input-tag">盘后推荐 18:00&ndash;19:00</span>
              </div>
              <div class="field-hint" id="beijingTimeHint">美股于美东 16:00 收盘，建议设置在 18:15 之后等待数据结算。</div>
            </div>
          </div>

          <div class="form-row">
            <div class="form-label">
              执行星期
              <span class="form-label-desc">交易日循环</span>
            </div>
            <div>
              <div class="weekday-pills" id="days">
                <label class="weekday-pill"><input type="checkbox" value="1"><span>周一</span></label>
                <label class="weekday-pill"><input type="checkbox" value="2"><span>周二</span></label>
                <label class="weekday-pill"><input type="checkbox" value="3"><span>周三</span></label>
                <label class="weekday-pill"><input type="checkbox" value="4"><span>周四</span></label>
                <label class="weekday-pill"><input type="checkbox" value="5"><span>周五</span></label>
                <label class="weekday-pill"><input type="checkbox" value="6"><span>周六</span></label>
                <label class="weekday-pill"><input type="checkbox" value="0"><span>周日</span></label>
              </div>
              <div class="weekday-quick">
                <button type="button" class="btn-xs" id="quickWorkdays">常用：工作日（周一至周五）</button>
                <button type="button" class="btn-xs" id="quickAllDays">全选</button>
                <button type="button" class="btn-xs" id="quickClearDays">清空</button>
              </div>
            </div>
          </div>

          <div class="form-row">
            <div class="form-label">
              目标市场
              <span class="form-label-desc">定时筛选范围</span>
            </div>
            <div>
              <select class="form-control" name="market">
                <option value="us">美股 S&amp;P 500</option>
                <option value="th">泰股 SET</option>
              </select>
            </div>
          </div>

          <div class="form-row">
            <div class="form-label">
              最低得分门槛
              <span class="form-label-desc">Buffett 最低分</span>
            </div>
            <div>
              <input class="form-control" name="minScore" type="number" min="0" max="10" value="5">
            </div>
          </div>

          <div class="form-row">
            <div class="form-label">
              推送数量
              <span class="form-label-desc">TG 榜单精选数</span>
            </div>
            <div>
              <input class="form-control" name="topN" type="number" min="1" max="50" value="10">
            </div>
          </div>
        </div>

        <div class="card-footer">
          <button class="btn primary" type="submit">保存定时任务</button>
          <span class="status-msg" id="scheduleStatus"></span>
        </div>
      </form>

      <div class="card">
        <div class="card-header">
          <div class="card-header-left">
            <div class="card-icon-badge purple">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            </div>
            <div class="card-title-group">
              <h2>下次运行与调度看板</h2>
              <p>双时区联动与调度器常驻状态</p>
            </div>
          </div>
        </div>

        <div class="status-banner">
          <div class="status-item">
            <span class="pulse-dot green" id="schedulerDot"></span>
            <span>调度服务状态：<strong id="schedulerStatusText">就绪中</strong></span>
          </div>
          <span class="status-sub">无缝守护中</span>
        </div>

        <div class="dual-clocks">
          <div class="clock-card">
            <div class="clock-label">
              <span>🇺🇸 美东时间 (New York)</span>
              <span class="badge blue">美东基准</span>
            </div>
            <div class="clock-value font-mono" id="clockNewYork">--:--</div>
            <div class="clock-desc">服务器以美东为基准，夏冬令时全自动换算</div>
          </div>

          <div class="clock-card highlight">
            <div class="clock-label">
              <span>🇨🇳 北京时间 (Beijing)</span>
              <span class="badge green">对应本地</span>
            </div>
            <div class="clock-value font-mono" id="clockBeijing">--:--</div>
            <div class="clock-desc" id="clockBeijingDesc">自动随夏令时/冬令时切换更新</div>
          </div>
        </div>

        <div class="notice" style="margin-top:4px">
          <strong>时差说明：</strong>无论美股处于夏令时还是冬令时，定时任务始终锁定在收盘后的指定美东时刻，免除人工重新算时差的困扰。
        </div>

        <div class="terminal-card">
          <div class="terminal-header">
            <div class="terminal-dots"><span></span><span></span><span></span></div>
            <span class="terminal-label">scheduler cron runner</span>
          </div>
          <div class="terminal-body font-mono">npm run schedule:run -- --market us --min-score 5 --top 10</div>
        </div>
      </div>
    </div>

    <div class="grid-2">
      <form class="card" id="telegram">
        <div class="card-header">
          <div class="card-header-left">
            <div class="card-icon-badge" style="background:rgba(14,165,233,0.12);color:#38bdf8;border-color:rgba(14,165,233,0.25)">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </div>
            <div class="card-title-group">
              <h2>Telegram 推送配置</h2>
              <p>筛选完成后即刻推送回调信号到 Telegram</p>
            </div>
          </div>
          <span class="badge green" id="telegramBadge">待配置</span>
        </div>

        <div class="config-form">
          <div class="form-row">
            <div class="form-label">
              Bot Token
              <span class="form-label-desc">机器人访问密钥</span>
            </div>
            <div>
              <div class="secret-input-wrap">
                <input class="form-control" name="botToken" id="botToken" type="password" autocomplete="off" placeholder="输入 Telegram Bot Token" required>
                <button class="secret-toggle" id="toggleBotToken" type="button" aria-label="显示 BOT Token" title="显示 BOT Token">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
              </div>
              <div class="field-hint">从 Telegram <a href="https://t.me/BotFather" target="_blank" rel="noopener" style="color:#60a5fa;text-decoration:none">@BotFather</a> 创建获取；前端已进行安全加密隐藏。</div>
            </div>
          </div>

          <div class="form-row">
            <div class="form-label">
              Chat ID
              <span class="form-label-desc">接收目标频道或群组</span>
            </div>
            <div>
              <div class="input-with-prefix">
                <span class="input-prefix">#</span>
                <input class="form-control" name="chatId" autocomplete="off" placeholder="例如 -1001234567890 或 123456789" required>
              </div>
              <div class="field-hint">接收通知的个人 Chat ID 或群组 ID（群组通常以 <code>-100</code> 开头）。</div>
            </div>
          </div>
        </div>

        <div class="card-footer">
          <button class="btn primary" type="submit">保存 Telegram 配置</button>
          <span class="status-msg" id="telegramStatus"></span>
        </div>
      </form>

      <div class="card">
        <div class="card-header">
          <div class="card-header-left">
            <div class="card-icon-badge green">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            </div>
            <div class="card-title-group">
              <h2>推送说明与最佳实践</h2>
              <p>运行逻辑与参数配置规范</p>
            </div>
          </div>
        </div>

        <ul class="feature-notes">
          <li class="feature-note-item">
            <span class="feature-note-icon">📢</span>
            <div>
              <strong>全量与定时任务统一</strong>：定时筛选完成后自动发送排版精美的卡片消息，突出标普500超卖优质个股。
            </div>
          </li>
          <li class="feature-note-item">
            <span class="feature-note-icon">⚡</span>
            <div>
              <strong>持久化动态热生效</strong>：配置保存在系统数据卷，保存后无需重启服务容器即可立即生效。
            </div>
          </li>
          <li class="feature-note-item">
            <span class="feature-note-icon">🔒</span>
            <div>
              <strong>敏感凭据加密保护</strong>：Bot Token 仅限在当前受限管理员会话内读取，未授权严禁访问。
            </div>
          </li>
          <li class="feature-note-item">
            <span class="feature-note-icon">🤖</span>
            <div>
              <strong>格式结构化排版</strong>：包含标的得分、Williams %R 超卖程度及巴菲特 10 项细则摘要，一目了然。
            </div>
          </li>
        </ul>
      </div>
    </div>
  </div>
</div>

<script>
const statusNode = document.querySelector('#status');
const statusDot = document.querySelector('#statusDot');
const resultNode = document.querySelector('#result');
const consoleTime = document.querySelector('#consoleTime');
const statsRow = document.querySelector('#statsRow');
const tableCard = document.querySelector('#tableCard');
const tableContent = document.querySelector('#tableContent');
const tableTitle = document.querySelector('#tableTitle');
const tableSubtitle = document.querySelector('#tableSubtitle');

const tabBtns = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    tabBtns.forEach(b => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    tabPanels.forEach(panel => {
      const active = panel.id === 'panel-' + target;
      panel.classList.toggle('active', active);
      if (active) {
        panel.removeAttribute('hidden');
      } else {
        panel.setAttribute('hidden', '');
      }
    });
  });
});

function renderScreenResults(result, mode) {
  if (!result || typeof result !== 'object') return;
  statsRow.style.display = 'grid';
  document.querySelector('#statTotalScanned').textContent = result.totalScanned ?? '-';
  document.querySelector('#statOversold').textContent = result.oversoldCount ?? '-';
  const stocks = result.topStocks || result.candidates || [];
  document.querySelector('#statCandidates').textContent = stocks.length;
  document.querySelector('#statStrategy').textContent = mode === 'technical' ? '纯技术面超卖' : '超卖 + 巴菲特基本面';

  tableCard.style.display = 'block';
  tableTitle.textContent = mode === 'technical' ? '超卖标的列表（纯技术面）' : '双重因子精选标的榜单';
  tableSubtitle.textContent = '共发现 ' + stocks.length + ' 只符合门槛标的';

  if (!stocks.length) {
    tableContent.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted)">当前筛选条件下未发现超卖标的。</div>';
    return;
  }

  if (result.topStocks) {
    let rows = '';
    result.topStocks.forEach((item, idx) => {
      const bColor = item.buffettScore >= 7 ? 'var(--green)' : item.buffettScore >= 5 ? 'var(--yellow)' : 'var(--red)';
      const cColor = item.combinedScore >= 70 ? 'var(--green)' : item.combinedScore >= 50 ? 'var(--yellow)' : 'var(--blue)';
      const ratingBadge = item.buffettScore >= 7 
        ? '<span class="badge green">优质候选</span>' 
        : '<span class="badge yellow">加入观察</span>';
      rows += '<tr>' +
        '<td class="font-mono" style="color:var(--muted);width:36px">' + (idx + 1) + '</td>' +
        '<td><span class="ticker font-mono">' + item.ticker + '</span></td>' +
        '<td style="color:var(--muted-light)">' + (item.companyName || '-') + '</td>' +
        '<td class="font-mono">$' + (Number(item.currentPrice) ? Number(item.currentPrice).toFixed(2) : '-') + '</td>' +
        '<td><span class="badge green font-mono">' + item.williamsR + '</span></td>' +
        '<td><span class="score-num font-mono" style="color:' + bColor + '">' + item.buffettScore + '/10</span><div class="score-bar"><div class="fill" style="width:' + (item.buffettScore * 10) + '%;background:' + bColor + '"></div></div></td>' +
        '<td><span class="score-num font-mono" style="color:' + cColor + '">' + item.combinedScore + '</span><div class="score-bar"><div class="fill" style="width:' + Math.min(item.combinedScore, 100) + '%;background:' + cColor + '"></div></div></td>' +
        '<td>' + ratingBadge + '</td>' +
        '</tr>';
    });
    tableContent.innerHTML = '<table class="signal-table"><thead><tr><th>#</th><th>代码</th><th>公司名称</th><th>现价</th><th>Williams %R</th><th>Buffett 评分</th><th>综合得分</th><th>评级</th></tr></thead><tbody>' + rows + '</tbody></table>';
  } else if (result.candidates) {
    let rows = '';
    result.candidates.forEach((item, idx) => {
      rows += '<tr>' +
        '<td class="font-mono" style="color:var(--muted);width:36px">' + (idx + 1) + '</td>' +
        '<td><span class="ticker font-mono">' + item.ticker + '</span></td>' +
        '<td class="font-mono">' + (item.currentPrice != null ? '$' + Number(item.currentPrice).toFixed(2) : '-') + '</td>' +
        '<td><span class="badge green font-mono">' + item.williamsR + '</span></td>' +
        '<td><span class="badge green">技术超卖</span></td>' +
        '</tr>';
    });
    tableContent.innerHTML = '<table class="signal-table"><thead><tr><th>#</th><th>代码</th><th>现价</th><th>Williams %R</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }
}

function renderAnalyzeResults(result) {
  if (!result || typeof result !== 'object') return;
  statsRow.style.display = 'grid';
  document.querySelector('#statTotalScanned').textContent = result.ticker || '-';
  document.querySelector('#statOversold').textContent = (result.score != null ? result.score + '/10' : '-');
  document.querySelector('#statCandidates').textContent = (result.results ? result.results.filter(r => r.status).length : '-');
  document.querySelector('#statStrategy').textContent = '单股基本面诊断';

  tableCard.style.display = 'block';
  tableTitle.textContent = (result.ticker || '') + ' 巴菲特 10 项准则诊断详情';
  tableSubtitle.textContent = '总分：' + (result.score != null ? result.score : '-') + ' / 10 分';

  if (Array.isArray(result.results)) {
    let rows = '';
    result.results.forEach((item, idx) => {
      const badge = item.status 
        ? '<span class="badge green">通过 (Pass)</span>' 
        : '<span class="badge red">未达标 (Fail)</span>';
      rows += '<tr>' +
        '<td class="font-mono" style="color:var(--muted);width:36px">' + (idx + 1) + '</td>' +
        '<td style="font-weight:600;color:var(--text-strong)">' + item.name + '</td>' +
        '<td>' + badge + '</td>' +
        '<td class="font-mono" style="color:var(--muted-light)">' + (item.value || '-') + '</td>' +
        '<td style="font-size:12px;color:var(--muted)">' + (item.detail || '-') + '</td>' +
        '</tr>';
    });
    tableContent.innerHTML = '<table class="signal-table"><thead><tr><th>#</th><th>准则名称</th><th>检测状态</th><th>财报数值</th><th>判定说明</th></tr></thead><tbody>' + rows + '</tbody></table>';
  } else if (result.metrics) {
    let rows = '';
    Object.entries(result.metrics).forEach(([k, v], idx) => {
      rows += '<tr><td class="font-mono" style="color:var(--muted);width:36px">' + (idx + 1) + '</td><td style="font-weight:600">' + k + '</td><td class="font-mono">' + String(v) + '</td></tr>';
    });
    tableContent.innerHTML = '<table class="signal-table"><thead><tr><th>#</th><th>指标</th><th>数值</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }
}

async function request(path, data, button, mode = 'combined') {
  button.disabled = true;
  statusNode.textContent = '运行中…';
  if (statusDot) statusDot.className = 'pulse-dot yellow';
  if (consoleTime) consoleTime.textContent = '运行中…';
  resultNode.textContent = '正在获取市场数据并执行量化计算，请稍候…';

  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '请求失败');

    resultNode.textContent = JSON.stringify(payload.result, null, 2);
    statusNode.textContent = '完成';
    if (statusDot) statusDot.className = 'pulse-dot green';
    if (consoleTime) consoleTime.textContent = '耗时完成 · ' + new Date().toLocaleTimeString();

    if (path.includes('screen')) {
      renderScreenResults(payload.result, mode);
    } else if (path.includes('analyze')) {
      renderAnalyzeResults(payload.result);
    }
  } catch (error) {
    statusNode.textContent = error.message;
    if (statusDot) statusDot.className = 'pulse-dot red';
    if (consoleTime) consoleTime.textContent = '失败';
    resultNode.textContent = '执行出错：' + error.message;
  } finally {
    button.disabled = false;
  }
}

document.querySelector('#screen').addEventListener('submit', event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const data = Object.fromEntries(form);
  request('/api/screen', data, event.submitter, data.mode);
});

document.querySelector('#quickTestBtn').addEventListener('click', event => {
  const formEl = document.querySelector('#screen');
  formEl.elements.market.value = 'us';
  formEl.elements.mode.value = 'combined';
  formEl.elements.topN.value = '10';
  const data = Object.fromEntries(new FormData(formEl));
  request('/api/screen', data, event.currentTarget, 'combined');
});

document.querySelector('#analyze').addEventListener('submit', event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  request('/api/analyze', Object.fromEntries(form), event.submitter);
});

const scheduleForm = document.querySelector('#schedule');
const scheduleEnabled = document.querySelector('#scheduleEnabled');
const scheduleEnabledText = document.querySelector('#scheduleEnabledText');
const scheduleBadge = document.querySelector('#scheduleBadge');

function updateSwitchLabel(checkbox) {
  const on = checkbox.checked;
  scheduleEnabledText.textContent = on ? '定时任务已启用' : '定时任务已暂停';
  if (scheduleBadge) {
    scheduleBadge.textContent = on ? '自动扫描生效中' : '自动扫描已暂停';
    scheduleBadge.className = 'badge ' + (on ? 'green' : 'yellow');
  }
}
scheduleEnabled.addEventListener('change', () => updateSwitchLabel(scheduleEnabled));

function updateBeijingTime() {
  const val = scheduleForm.elements.time.value || '18:15';
  const [hour, minute] = val.split(':').map(Number);
  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23'
    }).formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)])
  );
  const easternAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offsetMinutes = Math.round((easternAsUtc - now.getTime()) / 60000);
  const beijingTotal = hour * 60 + minute - offsetMinutes + 480;
  const dayOffset = Math.floor(beijingTotal / 1440);
  const normalized = (beijingTotal % 1440 + 1440) % 1440;
  const beijingHour = String(Math.floor(normalized / 60)).padStart(2, '0');
  const beijingMinute = String(normalized % 60).padStart(2, '0');

  const beijingStr = (dayOffset > 0 ? '次日 ' : dayOffset < 0 ? '前一日 ' : '') + beijingHour + ':' + beijingMinute;
  document.querySelector('#clockNewYork').textContent = val;
  document.querySelector('#clockBeijing').textContent = beijingStr;
  document.querySelector('#beijingTimeHint').textContent = '美东 ' + val + ' 对应北京时间：' + beijingStr + '（夏令时切换后自动联动计算）';
}

fetch('/api/schedule')
  .then(r => {
    if (r.status === 401) {
      location.href = '/login';
      throw new Error('unauthorized');
    }
    return r.json();
  })
  .then(config => {
    scheduleEnabled.checked = Boolean(config.enabled);
    updateSwitchLabel(scheduleEnabled);
    scheduleForm.elements.time.value = config.time || '18:15';
    scheduleForm.elements.market.value = config.market || 'us';
    scheduleForm.elements.minScore.value = config.minScore ?? 5;
    scheduleForm.elements.topN.value = config.topN ?? 10;
    const daysArr = config.days || [];
    document.querySelectorAll('#days label').forEach(label => {
      const input = label.querySelector('input');
      const checked = daysArr.includes(Number(input.value));
      input.checked = checked;
      label.classList.toggle('active', checked);
    });
    updateBeijingTime();
  });

scheduleForm.elements.time.addEventListener('input', updateBeijingTime);

document.querySelectorAll('#days label').forEach(label => {
  const input = label.querySelector('input');
  input.addEventListener('change', () => {
    label.classList.toggle('active', input.checked);
  });
});

document.querySelector('#quickWorkdays').addEventListener('click', () => {
  document.querySelectorAll('#days label').forEach(label => {
    const input = label.querySelector('input');
    const v = Number(input.value);
    const checked = v >= 1 && v <= 5;
    input.checked = checked;
    label.classList.toggle('active', checked);
  });
});

document.querySelector('#quickAllDays').addEventListener('click', () => {
  document.querySelectorAll('#days label').forEach(label => {
    const input = label.querySelector('input');
    input.checked = true;
    label.classList.add('active');
  });
});

document.querySelector('#quickClearDays').addEventListener('click', () => {
  document.querySelectorAll('#days label').forEach(label => {
    const input = label.querySelector('input');
    input.checked = false;
    label.classList.remove('active');
  });
});

scheduleForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  const node = document.querySelector('#scheduleStatus');
  button.disabled = true;
  node.className = 'status-msg';
  node.textContent = '保存中…';
  node.style.display = 'inline-flex';

  const data = {
    enabled: scheduleEnabled.checked,
    time: scheduleForm.elements.time.value,
    days: [...document.querySelectorAll('#days input:checked')].map(i => Number(i.value)),
    market: scheduleForm.elements.market.value,
    minScore: Number(scheduleForm.elements.minScore.value),
    topN: Number(scheduleForm.elements.topN.value)
  };

  try {
    const response = await fetch('/api/schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    node.className = 'status-msg success';
    node.textContent = '定时任务已保存生效';
  } catch (error) {
    node.className = 'status-msg error';
    node.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

const telegramForm = document.querySelector('#telegram');
const botTokenInput = document.querySelector('#botToken');
const tokenToggle = document.querySelector('#toggleBotToken');
const telegramBadge = document.querySelector('#telegramBadge');

fetch('/api/telegram')
  .then(r => r.json().then(data => {
    if (!r.ok) throw new Error(data.error || '读取 Telegram 配置失败');
    return data;
  }))
  .then(config => {
    telegramForm.elements.botToken.value = config.botToken || '';
    telegramForm.elements.chatId.value = config.chatId || '';
    const ready = Boolean(config.botToken && config.chatId);
    if (telegramBadge) {
      telegramBadge.textContent = ready ? '配置已就绪' : '待完善';
      telegramBadge.className = 'badge ' + (ready ? 'green' : 'yellow');
    }
  })
  .catch(error => {
    const node = document.querySelector('#telegramStatus');
    node.className = 'status-msg error';
    node.textContent = error.message;
  });

tokenToggle.addEventListener('click', () => {
  const showing = botTokenInput.type === 'text';
  botTokenInput.type = showing ? 'password' : 'text';
  tokenToggle.setAttribute('aria-label', showing ? '显示 BOT Token' : '隐藏 BOT Token');
  tokenToggle.setAttribute('title', showing ? '显示 BOT Token' : '隐藏 BOT Token');
});

telegramForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  const node = document.querySelector('#telegramStatus');
  button.disabled = true;
  node.className = 'status-msg';
  node.textContent = '保存中…';
  node.style.display = 'inline-flex';

  const data = {
    botToken: telegramForm.elements.botToken.value,
    chatId: telegramForm.elements.chatId.value
  };

  try {
    const response = await fetch('/api/telegram', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    node.className = 'status-msg success';
    node.textContent = 'Telegram 配置已保存，后续推送立即生效';
    botTokenInput.type = 'password';
    if (telegramBadge) {
      telegramBadge.textContent = '配置已就绪';
      telegramBadge.className = 'badge green';
    }
  } catch (error) {
    node.className = 'status-msg error';
    node.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
});
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
