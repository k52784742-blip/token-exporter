/**
 * 页面浮窗 —— 隔离世界，document_idle 注入。
 *
 * content script 不支持 ESM import，所以这里自带一份轻量工具，
 * 数据全走 chrome.runtime.sendMessage 问 background 要。
 *
 * 功能和弹窗对齐：搜索、状态筛选、排序、详情、批量、导出格式、站点开关。
 * 只有设置里开了「在页面显示浮窗」才挂载。
 */

(function () {
  'use strict';

  const GUARD = Symbol.for('__tk_guard_4b81');
  if (window[GUARD]) return;
  try {
    Object.defineProperty(window, GUARD, {
      value: true, writable: false, configurable: false, enumerable: false,
    });
  } catch (e) { return; }

  const HOST_ID = 'pn-' + Math.random().toString(36).slice(2, 9);

  const els = {};
  const state = {
    pool: [],
    captured: [],
    sessions: {},
    platforms: [],
    settings: {},
    tabView: 'pool',
    query: '',
    filterStatus: 'all',
    sortMode: 'urgency',
    selectMode: false,
    selected: new Set(),
    siteHook: true,
  };
  let activePlatform = null;

  /* ---------------- 工具 ---------------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function highlight(text) {
    const s = String(text == null ? '' : text);
    const q = state.query.trim();
    if (!q) return esc(s);
    const idx = s.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return esc(s);
    return esc(s.slice(0, idx))
      + '<mark>' + esc(s.slice(idx, idx + q.length)) + '</mark>'
      + esc(s.slice(idx + q.length));
  }

  function humanLeftLong(ms) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    if (ms <= 0) {
      const ago = Math.abs(ms);
      const d = Math.floor(ago / 86400000);
      if (d >= 1) return `过期 ${d} 天`;
      const h = Math.floor(ago / 3600000);
      if (h >= 1) return `过期 ${h} 时`;
      return '刚过期';
    }
    const d = Math.floor(ms / 86400000);
    if (d >= 1) {
      const h = Math.floor((ms % 86400000) / 3600000);
      return h > 0 ? `${d}天${h}时` : `${d} 天`;
    }
    const h = Math.floor(ms / 3600000);
    if (h >= 1) {
      const m = Math.floor((ms % 3600000) / 60000);
      return m > 0 ? `${h}时${m}分` : `${h} 小时`;
    }
    const m = Math.floor(ms / 60000);
    return m >= 1 ? `${m} 分钟` : '不到 1 分';
  }

  function expiryLevel(expiresAt, now = Date.now()) {
    if (!expiresAt) return 'none';
    const left = expiresAt - now;
    if (left <= 0) return 'expired';
    if (left < 3600 * 1000) return 'urgent';
    if (left < 3 * 86400000) return 'warning';
    return 'healthy';
  }

  function maskToken(token) {
    const s = String(token || '');
    if (s.length <= 19) return s.slice(0, 6) + '…';
    return s.slice(0, 8) + '…' + s.slice(-4);
  }

  function parseJwt(token) {
    try {
      const p = String(token || '').split('.');
      if (p.length !== 3) return {};
      let seg = p[1].replace(/-/g, '+').replace(/_/g, '/');
      while (seg.length % 4) seg += '=';
      const bin = atob(seg);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return JSON.parse(new TextDecoder('utf-8').decode(bytes)) || {};
    } catch (e) { return {}; }
  }

  function jwtIdentity(token) {
    const c = parseJwt(token);
    return {
      name: c.name || c.nickname || c.preferred_username || '',
      sub: c.sub || '',
      exp: Number(c.exp) || 0,
      scopes: typeof c.scope === 'string' ? c.scope.split(/\s+/).filter(Boolean) : [],
    };
  }

  function timeAgo(ts, now = Date.now()) {
    if (!ts) return '';
    const d = now - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
    if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
    return `${Math.floor(d / 86400000)} 天前`;
  }

  function todayStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function rowKey(row) {
    return (row.platform || '') + '|' + (row.uid || String(row.access_token || '').slice(-16));
  }

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: e.message }));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e2) { return false; }
    }
  }

  function sitePlatform() {
    return {
      id: 'site:' + location.hostname,
      label: location.hostname,
      flag: '',
      mode: 'capture',
    };
  }

  /* ---------------- 样式 ---------------- */

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel {
      position: fixed; z-index: 2147483647; width: 384px;
      background: #181b21; color: #e8ebf2; border: 1px solid #2a2f3a;
      border-radius: 11px; box-shadow: 0 12px 40px rgba(0,0,0,.55);
      font: 13px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      overflow: hidden; user-select: none;
    }
    .panel.collapsed .body { display: none; }
    .head {
      display: flex; align-items: center; gap: 7px;
      padding: 9px 11px; background: linear-gradient(180deg,#1b1f27,#171a21);
      cursor: move; border-bottom: 1px solid #2a2f3a;
    }
    .logo { width: 17px; height: 17px; border-radius: 5px; flex: none;
      background: linear-gradient(135deg,#3b82f6,#8b5cf6); }
    .title { font-weight: 650; font-size: 12px; }
    .ver { font-size: 9px; color: #3f4756; }
    .chip { margin-left: auto; font-size: 10px; color: #93c5fd;
      background: #14202e; border: 1px solid #1e3a5f; padding: 1px 7px;
      border-radius: 99px; max-width: 118px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; }
    .chip.capture { color: #a7b3c7; background: #1f232b; border-color: #2a2f3a; }
    .icon-btn { border: 0; background: transparent; color: #5f6779; cursor: pointer;
      padding: 3px 4px; border-radius: 5px; font-size: 13px; line-height: 1; font-family: inherit; }
    .icon-btn:hover { background: #1f232b; color: #e8ebf2; }
    .body { padding: 9px 11px 11px; }
    .row { display: flex; gap: 6px; }
    .row + .row { margin-top: 6px; }
    .btn {
      flex: 1; display: flex; align-items: center; justify-content: center; gap: 4px;
      border: 1px solid #2a2f3a; background: #181b21; color: #e8ebf2;
      padding: 6px 8px; border-radius: 7px; cursor: pointer; font-size: 11.5px;
      white-space: nowrap; font-family: inherit;
    }
    .btn:hover { background: #1f232b; border-color: #3a4150; }
    .btn.primary { background: linear-gradient(180deg,#3b82f6,#2563eb);
      border-color: #2563eb; color: #fff; font-weight: 600; }
    .btn:disabled { opacity: .45; cursor: not-allowed; }
    .btn.tiny { flex: 0 0 auto; padding: 4px 8px; font-size: 10.5px; border-radius: 5px; }
    .btn.tiny.active { background: #1e3a5f; border-color: #2d5a8f; color: #93c5fd; }
    .btn.tiny.danger { border-color: #3d2020; color: #f87171; }
    select, .search {
      background: #0c0e12; color: #e8ebf2; border: 1px solid #1e222b;
      border-radius: 6px; padding: 5px 7px; font-size: 11px;
      font-family: inherit; outline: none; width: auto;
    }
    select { flex: 1; cursor: pointer; }
    select:focus, .search:focus { border-color: #3b82f6; }
    .search { flex: 1; }
    .search::placeholder { color: #3f4756; }
    .status { margin-top: 6px; padding: 5px 8px; border-radius: 6px;
      background: #0c0e12; border: 1px solid #1e222b; color: #9aa3b5;
      font-size: 10.5px; min-height: 26px; max-height: 54px; overflow-y: auto;
      word-break: break-word; user-select: text; }
    .status.err { color: #fca5a5; border-color: #3b1f1f; background: #1a1010; }
    .status.ok { color: #6ee7b7; border-color: #16362b; background: #0d1a15; }
    .stats { display: flex; align-items: center; gap: 2px; margin-top: 5px;
      padding: 4px 8px; background: #0c0e12; border: 1px solid #1e222b;
      border-radius: 6px; font-size: 9.5px; color: #9aa3b5; flex-wrap: wrap; }
    .stat-item b { font-size: 10.5px; color: #e8ebf2; font-variant-numeric: tabular-nums; }
    .stat-item.bad b { color: #f87171; }
    .stat-item.warn b { color: #fbbf24; }
    .stat-sep { width: 1px; height: 8px; background: #262b35; margin: 0 5px; }
    .toolbar { display: flex; gap: 5px; margin-top: 6px; align-items: center; }
    .list-head { display: flex; align-items: center; margin-top: 6px; gap: 5px; }
    .list-title { font-size: 9.5px; font-weight: 600; color: #5f6779;
      text-transform: uppercase; letter-spacing: .3px; flex: none; }
    .segmented { margin-left: auto; display: flex; gap: 2px; padding: 2px;
      background: #0c0e12; border: 1px solid #1e222b; border-radius: 6px; flex: none; }
    .seg { border: 0; background: transparent; color: #5f6779; font-size: 9.5px;
      font-family: inherit; padding: 2px 6px; border-radius: 4px; cursor: pointer;
      display: flex; align-items: center; gap: 3px; }
    .seg.active { background: #1f232b; color: #e8ebf2; }
    .seg .count { font-size: 8.5px; padding: 0 3px; border-radius: 99px;
      background: #2a3040; color: #93a3bd; min-width: 12px; text-align: center; }
    .seg.active .count { background: #3b82f6; color: #fff; }
    .list { margin-top: 5px; max-height: 216px; overflow-y: auto;
      margin-right: -4px; padding-right: 4px; }
    .list::-webkit-scrollbar { width: 5px; }
    .list::-webkit-scrollbar-thumb { background: #2f3644; border-radius: 3px; }
    .empty { padding: 20px 8px; text-align: center; color: #5f6779;
      font-size: 10.5px; line-height: 1.6; }
    .item { display: flex; align-items: center; gap: 7px; padding: 6px 6px;
      border-radius: 6px; cursor: pointer; }
    .item:hover { background: #171a20; }
    .item.selected { background: #14202e; }
    .item.disabled { opacity: .45; }
    .item.disabled .name { text-decoration: line-through; text-decoration-color: #5f6779; }
    .item.alt { opacity: .82; }
    .item.alt .avatar { filter: saturate(.5); }
    .avatar { width: 24px; height: 24px; border-radius: 7px; flex: none;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: 700; color: #fff; }
    .avatar.cn { background: linear-gradient(135deg,#ef4444,#b91c1c); }
    .avatar.intl { background: linear-gradient(135deg,#3b82f6,#6366f1); }
    .avatar.site { background: linear-gradient(135deg,#64748b,#475569); }
    .avatar.cap { background: linear-gradient(135deg,#8b5cf6,#6d28d9); }
    .meta { min-width: 0; flex: 1; }
    .name { font-size: 11.5px; font-weight: 600; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; }
    .sub { font-size: 9.5px; color: #5f6779;
      font-family: ui-monospace, Consolas, monospace; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; }
    .who-tag { display: inline-block; max-width: 92px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; vertical-align: 1px;
      margin-left: 4px; padding: 0 4px; border-radius: 3px;
      background: #1a2c1f; color: #86efac; font-size: 9px; font-weight: 500; }
    .pill { font-size: 9px; padding: 1px 5px; border-radius: 99px;
      border: 1px solid #2a2f3a; color: #9aa3b5; flex: none;
      font-variant-numeric: tabular-nums; }
    .pill.ok { color: #34d399; border-color: #1a4a3a; background: #0d1f19; }
    .pill.warn { color: #fbbf24; border-color: #4a3a12; background: #1f1a0b; }
    .pill.bad { color: #f87171; border-color: #4a2020; background: #1f1010; }
    .checkbox { width: 18px; height: 18px; border-radius: 5px;
      border: 1.5px solid #353b48; flex: none; display: flex;
      align-items: center; justify-content: center; font-size: 10px; color: #fff; }
    .checkbox.on { background: #3b82f6; border-color: #3b82f6; }
    .dot-refresh { width: 5px; height: 5px; border-radius: 50%;
      background: #34d399; flex: none; opacity: .7; }
    .detail-btn { border: 0; background: transparent; color: #3d4453;
      cursor: pointer; padding: 1px; display: flex; flex: none; }
    .item:hover .detail-btn { color: #7b8497; }
    .bulkbar { display: flex; align-items: center; gap: 4px; margin-top: 6px;
      padding: 5px 7px; background: #14202e; border: 1px solid #1e3a5f;
      border-radius: 6px; }
    .bulkbar[hidden] { display: none; }
    .bulk-count { flex: 1; font-size: 10px; color: #93c5fd; }
    .foot { display: flex; gap: 5px; margin-top: 7px; padding-top: 7px;
      border-top: 1px solid #2a2f3a; }
    .foot-extra { display: flex; align-items: center; gap: 5px; margin-top: 6px; }
    .hint { margin-top: 6px; font-size: 9.5px; color: #5f6779; line-height: 1.45; }
    .link-btn { border: 0; background: transparent; color: #5f6779;
      font-size: 9.5px; font-family: inherit; cursor: pointer; padding: 2px 3px;
      text-decoration: underline; text-underline-offset: 2px;
      text-decoration-color: #353b48; flex: none; }
    .link-btn:hover { color: #9aa3b5; }
    .link-btn.off { color: #fbbf24; text-decoration-color: #fbbf24; }
    mark { background: rgba(251,191,36,.28); color: inherit; border-radius: 2px; padding: 0 1px; }
    .captured-head { display: flex; align-items: center; justify-content: space-between;
      padding: 4px 6px 6px; font-size: 10px; color: #5f6779;
      border-bottom: 1px solid #1e222b; margin-bottom: 3px; }
    .sheet { position: fixed; inset: 0; background: rgba(6,8,11,.8);
      display: flex; align-items: flex-end; justify-content: center;
      z-index: 2147483647; }
    .sheet[hidden] { display: none; }
    .sheet-box { width: 100%; max-height: 84%; background: #181b21;
      border-top: 1px solid #2a2f3a; border-radius: 12px 12px 0 0;
      display: flex; flex-direction: column; }
    .sheet-head { display: flex; align-items: center; padding: 10px 13px 8px;
      border-bottom: 1px solid #2a2f3a; flex: none; }
    .sheet-title { font-size: 12px; font-weight: 650; flex: 1;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sheet-body { padding: 9px 13px; overflow-y: auto; flex: 1; }
    .sheet-body::-webkit-scrollbar { width: 5px; }
    .sheet-body::-webkit-scrollbar-thumb { background: #2f3644; border-radius: 3px; }
    .drow { display: flex; align-items: baseline; gap: 8px; padding: 4px 0;
      font-size: 10.5px; border-bottom: 1px solid #191d24; }
    .drow:last-child { border-bottom: 0; }
    .drow.col { flex-direction: column; gap: 3px; align-items: stretch; }
    .dk { flex: 0 0 56px; color: #5f6779; font-size: 9.5px; text-transform: uppercase; }
    .dv { flex: 1; word-break: break-all; text-align: right; }
    .drow.col .dv { text-align: left; }
    .dv.mono { font-family: ui-monospace, Consolas, monospace; font-size: 10px; }
    .dv.small { font-size: 9.5px; color: #9aa3b5; }
    .dv.bad { color: #f87171; }
    .tok { display: block; background: #0c0e12; border: 1px solid #1e222b;
      border-radius: 5px; padding: 4px 6px; font-family: ui-monospace, Consolas, monospace;
      font-size: 9.5px; color: #93a3bd; word-break: break-all; user-select: text; }
    .copy-mini { border: 1px solid #2a2f3a; background: transparent; color: #7b8497;
      font-size: 9px; font-family: inherit; padding: 1px 5px; border-radius: 4px;
      cursor: pointer; flex: none; margin-left: 5px; }
    .copy-mini:hover { color: #e8ebf2; border-color: #3a4150; }
    .copy-mini.block { align-self: flex-start; margin: 3px 0 0; }
    .sheet-foot { display: flex; gap: 5px; padding: 8px 13px 10px;
      border-top: 1px solid #2a2f3a; flex-wrap: wrap; }
    .sheet-foot .btn { flex: 1 1 calc(33% - 5px); min-width: 64px; }
    .health-head { font-size: 9.5px; font-weight: 700; letter-spacing: .4px;
      text-transform: uppercase; padding: 6px 0 3px; color: #5f6779; }
    .health-head.bad { color: #f87171; }
    .health-head.ok { color: #34d399; }
    .modal { position: fixed; inset: 0; background: rgba(6,8,11,.8);
      display: flex; align-items: center; justify-content: center;
      padding: 12px; z-index: 2147483647; }
    .modal[hidden] { display: none; }
    .modal-box { width: 100%; max-width: 340px; background: #181b21;
      border: 1px solid #2a2f3a; border-radius: 10px; padding: 13px; }
    .modal-box h3 { font-size: 12px; font-weight: 650; margin: 0 0 3px; }
    .modal-box p { font-size: 10px; color: #5f6779; margin: 0 0 7px; line-height: 1.5; }
    .modal-box textarea { width: 100%; height: 120px; resize: vertical;
      background: #0c0e12; border: 1px solid #1e222b; border-radius: 6px;
      color: #c8cfdd; padding: 7px; font-size: 10px;
      font-family: ui-monospace, Consolas, monospace; outline: none; }
    .modal-foot { display: flex; gap: 6px; margin-top: 9px; justify-content: flex-end; }
    .modal-foot .btn { flex: 0 0 auto; padding: 5px 14px; }
  `;

  /* ---------------- 构建 ---------------- */

  function build() {
    if (document.getElementById(HOST_ID)) return;

    const host = document.createElement('div');
    host.id = HOST_ID;
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.top = '76px';
    panel.style.right = '18px';
    panel.innerHTML = `
      <div class="head">
        <span class="logo"></span>
        <span class="title">凭证导出</span>
        <span class="ver" data-el="ver"></span>
        <span class="chip" data-el="chip"></span>
        <button class="icon-btn" data-act="collapse" title="折叠">—</button>
      </div>
      <div class="body">
        <div class="row"><select data-el="platform"></select></div>
        <div class="row" data-el="actions"></div>
        <div class="status" data-el="status"></div>
        <div class="stats" data-el="stats" style="display:none"></div>
        <div class="toolbar">
          <input class="search" data-el="search" placeholder="搜昵称 / UID / 备注…" autocomplete="off">
          <button class="btn tiny" data-act="sort">按到期</button>
          <button class="btn tiny" data-act="bulk" title="批量选择">多选</button>
        </div>
        <div class="list-head">
          <span class="list-title" data-el="listtitle">凭证池</span>
          <select data-el="filter" style="flex:none;width:74px;font-size:10px;padding:3px 5px">
            <option value="all">全部</option>
            <option value="expired">已过期</option>
            <option value="soon">即将到期</option>
            <option value="disabled">已停用</option>
          </select>
          <span class="segmented">
            <button class="seg active" data-tab="pool">池 <span class="count" data-el="poolcount">0</span></button>
            <button class="seg" data-tab="captured">扫 <span class="count" data-el="capcount">0</span></button>
            <button class="seg" data-tab="session">会话 <span class="count" data-el="sesscount">0</span></button>
          </span>
        </div>
        <div class="list" data-el="list"></div>
        <div class="bulkbar" data-el="bulkbar" hidden>
          <span class="bulk-count" data-el="bulkcount">点选</span>
          <button class="btn tiny" data-act="bulkall">全选</button>
          <button class="btn tiny" data-act="bulkcopy">复制</button>
          <button class="btn tiny" data-act="bulkrefresh">续期</button>
          <button class="btn tiny" data-act="bulktoggle">停用</button>
          <button class="btn tiny danger" data-act="bulkremove">移除</button>
        </div>
        <div class="foot">
          <button class="btn" data-act="copy">复制</button>
          <button class="btn" data-act="download">下载</button>
          <button class="btn" data-act="refresh">续期</button>
          <button class="btn" data-act="clear">清空</button>
        </div>
        <div class="foot" data-el="sessfoot" hidden>
          <button class="btn primary" data-act="sesssave">存本站</button>
          <button class="btn" data-act="sessrestore">恢复本站</button>
          <button class="btn" data-act="sessexport">导出</button>
          <button class="btn" data-act="sessimport">导入</button>
        </div>
        <div class="foot-extra">
          <select data-el="format" style="flex:1;font-size:10px;padding:3px 5px">
            <option value="auto">自动</option>
            <option value="device">设备授权</option>
            <option value="generic">通用 JSON</option>
            <option value="raw">纯 token</option>
            <option value="bearer">Bearer</option>
            <option value="curl">curl</option>
            <option value="env">.env</option>
            <option value="postman">Postman</option>
          </select>
          <button class="link-btn" data-act="checkall">体检</button>
          <button class="link-btn" data-act="site">本站</button>
          <button class="link-btn" data-act="settings">设置</button>
        </div>
        <div class="hint" data-el="hint"></div>
      </div>
    `;
    root.appendChild(panel);

    els.panel = panel;
    els.ver = panel.querySelector('[data-el="ver"]');
    els.chip = panel.querySelector('[data-el="chip"]');
    els.platformSel = panel.querySelector('[data-el="platform"]');
    els.actions = panel.querySelector('[data-el="actions"]');
    els.status = panel.querySelector('[data-el="status"]');
    els.stats = panel.querySelector('[data-el="stats"]');
    els.search = panel.querySelector('[data-el="search"]');
    els.filter = panel.querySelector('[data-el="filter"]');
    els.format = panel.querySelector('[data-el="format"]');
    els.listTitle = panel.querySelector('[data-el="listtitle"]');
    els.poolCount = panel.querySelector('[data-el="poolcount"]');
    els.capCount = panel.querySelector('[data-el="capcount"]');
    els.sessCount = panel.querySelector('[data-el="sesscount"]');
    els.sessFoot = panel.querySelector('[data-el="sessfoot"]');
    els.list = panel.querySelector('[data-el="list"]');
    els.bulkbar = panel.querySelector('[data-el="bulkbar"]');
    els.bulkCount = panel.querySelector('[data-el="bulkcount"]');
    els.hint = panel.querySelector('[data-el="hint"]');

    panel.addEventListener('click', onClick);
    els.platformSel.addEventListener('change', onPlatformChange);
    els.search.addEventListener('input', () => {
      state.query = els.search.value;
      renderList();
    });
    els.filter.addEventListener('change', () => {
      state.filterStatus = els.filter.value;
      renderList();
    });
    els.format.addEventListener('change', () => {
      send({ type: 'save-settings', settings: { exportFormat: els.format.value } });
    });

    makeDraggable(panel, panel.querySelector('.head'));
  }

  /* ---------------- 渲染 ---------------- */

  function renderPlatforms() {
    if (!els.platformSel) return;
    const host = location.hostname;
    const opts = state.platforms.map((p) => ({ id: p.id, label: `${p.flag || ''} ${p.label}`.trim() }));
    const known = state.platforms.find((p) => (p.hosts || []).some((h) => h === host));
    if (!known) opts.push({ id: 'site:' + host, label: '本页抓取' });

    els.platformSel.innerHTML = opts.map((o) => (
      `<option value="${esc(o.id)}"${o.id === activePlatform?.id ? ' selected' : ''}>${esc(o.label)}</option>`
    )).join('');
  }

  function renderActions() {
    if (!els.actions) return;
    const isDevice = activePlatform?.mode === 'device';
    els.actions.innerHTML = isDevice
      ? '<button class="btn primary" data-act="auth">授权添加</button>'
        + '<button class="btn" data-act="import">导入</button>'
      : '<button class="btn primary" data-act="scan">扫描本页</button>'
        + '<button class="btn" data-act="import">导入</button>';
  }

  function renderHeader() {
    const p = activePlatform;
    if (els.chip) {
      els.chip.className = 'chip' + (p?.mode === 'device' ? '' : ' capture');
      els.chip.textContent = p?.mode === 'device' ? p.label : '本页抓取';
      els.chip.title = p?.label || location.hostname;
    }
    if (els.hint) {
      els.hint.textContent = p?.mode === 'device'
        ? '明文存在本地，公用电脑记得清空'
        : '只记录本页出现过的 token，扫不到就刷新页面再试';
    }
  }

  function renderStats() {
    if (!els.stats) return;
    const now = Date.now();
    const pool = state.pool;
    if (!pool.length) { els.stats.style.display = 'none'; return; }

    let expired = 0;
    let soon = 0;
    let disabled = 0;
    for (const r of pool) {
      if (r.enabled === false) { disabled++; continue; }
      const left = (r.expiresAt || 0) - now;
      if (r.expiresAt && left <= 0) expired++;
      else if (r.expiresAt && left < 3 * 86400000) soon++;
    }

    const parts = [`<span class="stat-item"><b>${pool.length}</b> 个</span>`];
    if (expired) parts.push(`<span class="stat-item bad"><b>${expired}</b> 过期</span>`);
    if (soon) parts.push(`<span class="stat-item warn"><b>${soon}</b> 将到期</span>`);
    if (disabled) parts.push(`<span class="stat-item"><b>${disabled}</b> 停用</span>`);

    els.stats.innerHTML = parts.join('<span class="stat-sep"></span>');
    els.stats.style.display = 'flex';
  }

  function renderTabs() {
    els.panel.querySelectorAll('.seg').forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === state.tabView);
    });
    if (els.poolCount) els.poolCount.textContent = state.pool.length;
    if (els.capCount) els.capCount.textContent = state.captured.length;
    if (els.sessCount) els.sessCount.textContent = Object.keys(state.sessions || {}).length;

    const titles = { pool: '凭证池', captured: '本页扫到', session: '会话快照' };
    if (els.listTitle) els.listTitle.textContent = titles[state.tabView] || '凭证池';

    const isSess = state.tabView === 'session';
    const foot = els.panel.querySelector('.foot:not([data-el])');
    if (foot) foot.hidden = isSess;
    if (els.sessFoot) els.sessFoot.hidden = !isSess;
  }

  function renderList() {
    if (!els.list) return;
    renderTabs();
    renderStats();
    renderBulk();

    if (state.tabView === 'captured') return renderCaptured();
    if (state.tabView === 'session') return renderSessions();
    return renderPool();
  }

  function filteredRows() {
    const q = state.query.trim().toLowerCase();
    const st = state.filterStatus;
    const now = Date.now();

    let rows = state.pool;
    if (st === 'expired') rows = rows.filter((r) => r.expiresAt && r.expiresAt <= now && r.enabled !== false);
    else if (st === 'soon') rows = rows.filter((r) => {
      if (!r.expiresAt || r.enabled === false) return false;
      const left = r.expiresAt - now;
      return left > 0 && left < 3 * 86400000;
    });
    else if (st === 'disabled') rows = rows.filter((r) => r.enabled === false);

    if (!q) return rows;
    return rows.filter((r) => {
      const hay = [r.nickname, r.uid, r.domain, r.platform, r.note, r.auth_raw?.account?.uin]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  function renderPool() {
    const now = Date.now();
    const rows = filteredRows();

    if (!rows.length) {
      els.list.innerHTML = state.query
        ? `<div class="empty">没找到「${esc(state.query)}」</div>`
        : '<div class="empty">凭证池是空的</div>';
      return;
    }

    const sorted = rows.slice();
    if (state.sortMode === 'urgency') sorted.sort((a, b) => (a.expiresAt || Infinity) - (b.expiresAt || Infinity));
    else if (state.sortMode === 'name') sorted.sort((a, b) => String(a.nickname || '').localeCompare(String(b.nickname || ''), 'zh'));
    else sorted.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

    els.list.innerHTML = sorted.map((row) => {
      const key = rowKey(row);
      const left = (row.expiresAt || 0) - now;
      const lv = expiryLevel(row.expiresAt, now);
      const pillCls = lv === 'expired' ? 'bad' : (lv === 'urgent' || lv === 'warning') ? 'warn' : 'ok';

      let avCls = 'site';
      if (row.platform === 'device-oauth-cn') avCls = 'cn';
      else if (row.platform === 'device-oauth-intl') avCls = 'intl';

      const initial = (row.nickname || row.uid || '?').slice(0, 1).toUpperCase();
      const name = row.nickname || (row.uid ? row.uid.slice(0, 10) : '(未命名)');
      const sub = row.note ? `【${row.note}】` : (row.domain || '');
      const checked = state.selected.has(key);

      return `
        <div class="item${checked ? ' selected' : ''}${row.enabled === false ? ' disabled' : ''}" data-key="${esc(key)}">
          ${state.selectMode
            ? `<span class="checkbox${checked ? ' on' : ''}">${checked ? '✓' : ''}</span>`
            : `<div class="avatar ${avCls}">${esc(initial)}</div>`}
          <div class="meta">
            <div class="name">${highlight(name)}</div>
            <div class="sub">${highlight(String(sub).slice(0, 26))}</div>
          </div>
          ${row.refresh_token ? '<span class="dot-refresh"></span>' : ''}
          <span class="pill ${pillCls}">${esc(row.expiresAt ? humanLeftLong(left) : '到期未知')}</span>
          ${state.selectMode ? '' : '<button class="detail-btn" data-detail="' + esc(key) + '" title="详情">›</button>'}
        </div>`;
    }).join('');

    els.list.querySelectorAll('.item').forEach((it) => {
      it.addEventListener('click', () => {
        if (state.selectMode) {
          const k = it.dataset.key;
          if (state.selected.has(k)) state.selected.delete(k);
          else state.selected.add(k);
          renderList();
        } else {
          openDetail(it.dataset.key);
        }
      });
    });
    els.list.querySelectorAll('[data-detail]').forEach((b) => {
      b.addEventListener('click', (ev) => { ev.stopPropagation(); openDetail(b.dataset.detail); });
    });
  }

  function renderCaptured() {
    if (!state.captured.length) {
      els.list.innerHTML = '<div class="empty">还没扫到 token<br>刷新页面后再点扫描</div>';
      return;
    }

    const rows = state.captured.slice().reverse();

    els.list.innerHTML = `
      <div class="captured-head">
        <span>共 ${rows.length} 个</span>
        <button class="btn tiny primary" data-act="addall">全部加入</button>
      </div>`
      + rows.map((c) => {
        const label = c.kind.startsWith('body:') ? c.kind.slice(5)
          : c.kind.startsWith('localStorage:') ? 'localStorage'
          : c.kind.startsWith('cookie:') ? 'cookie'
          : c.kind;
        return `
          <div class="item">
            <div class="avatar cap">T</div>
            <div class="meta">
              <div class="name">${esc(label)}</div>
              <div class="sub">${esc(String(c.host || '').slice(0, 22))}</div>
            </div>
            <button class="btn tiny" data-add="${esc(c.key)}">加入</button>
          </div>`;
      }).join('');

    els.list.querySelectorAll('[data-add]').forEach((b) => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        addCaptured(b.dataset.add);
      });
    });
  }

  function renderSessions() {
    const now = Date.now();
    const map = state.sessions || {};
    const hosts = Object.keys(map).sort((a, b) => (map[b]?.at || 0) - (map[a]?.at || 0));
    const cur = location.hostname;

    if (!hosts.length) {
      els.list.innerHTML = '<div class="empty">还没有会话快照<br>登录好之后点「存本站」</div>';
      return;
    }

    els.list.innerHTML = `
      <div class="captured-head">
        <span>共 ${hosts.length} 个站点</span>
      </div>`
      + hosts.map((h) => {
        const root = map[h] || {};
        const rows = [root, ...(root.alts || [])];
        return rows.map((s, idx) => {
          const sm = s.summary || {};
          const isAlt = idx > 0;
          const who = sm.who || '';
          const bits = [];
          if (sm.cookies) bits.push(`${sm.cookies} cookie`);
          if (sm.httpOnly) bits.push(`${sm.httpOnly} HttpOnly`);
          if (sm.local) bits.push(`${sm.local} 本地项`);
          if (sm.session) bits.push(`${sm.session} 会话项`);
          if ((s.restoreTries || 0) >= 3) bits.push('已失效，需重新登录后存一份');

          const w = esc(who);
          return `
          <div class="item${h === cur && !isAlt ? ' selected' : ''}${isAlt ? ' alt' : ''}" data-host="${esc(h)}">
            <div class="avatar ${sm.authLike ? 'cn' : 'site'}">${sm.authLike ? '✓' : '·'}</div>
            <div class="meta">
              <div class="name">${highlight(h)}${who ? ` <span class="who-tag">${w}</span>` : ''}</div>
              <div class="sub">${esc(bits.join(' · ') || '空快照')}</div>
            </div>
            <span class="src-tag">${esc(timeAgo(s.at, now))}</span>
            <button class="btn tiny" data-srestore="${esc(h)}" data-who="${w}">恢复</button>
          </div>`;
        }).join('');
      }).join('');

    els.list.querySelectorAll('[data-srestore]').forEach((b) => {
      b.addEventListener('click', (ev) => { ev.stopPropagation(); restoreSession(b.dataset.srestore, b.dataset.who); });
    });
    els.list.querySelectorAll('.item').forEach((it) => {
      it.addEventListener('click', (ev) => {
        if (ev.target.closest('button')) return;
        const btn = it.querySelector('[data-srestore]');
        restoreSession(it.dataset.host, btn?.dataset.who || '');
      });
    });
  }

  async function saveSession() {
    const host = location.hostname;
    const btn = els.panel.querySelector('[data-act="sesssave"]');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }

    const tab = await new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ type: 'session-current' }, (r) => res(r));
      } catch (e) { res(null); }
    });
    const tabId = tab?.tabId;

    const r = await send({ type: 'session-snapshot', tabId, host });

    if (btn) { btn.disabled = false; btn.textContent = '存本站'; }

    if (!r?.ok) return setStatus('保存失败：' + (r?.error || '未知'), 'err');

    await reload();
    renderList();
    const s = r.snap?.summary || {};
    const bits = [`${s.cookies || 0} cookie`];
    if (s.httpOnly) bits.push(`${s.httpOnly} HttpOnly`);
    if (s.local) bits.push(`${s.local} 本地项`);
    if (s.session) bits.push(`${s.session} 会话项`);
    setStatus(`${host} 已保存 · ${bits.join(' · ')}`, 'ok');
  }

  async function restoreSession(host, who) {
    const target = host || location.hostname;
    if (!state.sessions[target]) return setStatus(`${target} 还没有快照`, 'err');

    const same = target === location.hostname;
    const name = who ? ` ${who} 的` : '';
    const tip = same
      ? `用${name}快照覆盖 ${target} 当前的登录态？页面会刷新一次。`
      : `${target} 不在当前页，会跳过去再恢复${who ? ' ' + who : ''}。继续？`;
    if (!confirm(tip)) return;

    const tab = await new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ type: 'session-current' }, (r) => res(r));
      } catch (e) { res(null); }
    });

    const r = await send({ type: 'session-restore', tabId: tab?.tabId, host: target, who: who || '' });
    if (!r?.ok) return setStatus('恢复失败：' + (r?.error || '未知'), 'err');

    const bits = [`${r.cookies || 0} cookie`];
    if (r.storage) bits.push(`${r.storage} 项 storage`);
    if (r.cookieFailed?.length) bits.push(`${r.cookieFailed.length} 条被拒`);
    setStatus(`${target} 已写回 · ${bits.join(' · ')}`, 'ok');
  }

  async function exportSessions() {
    const r = await send({ type: 'session-export' });
    if (!r?.ok) return setStatus('导出失败', 'err');

    const n = Object.keys(r.data?.sessions || {}).length;
    if (!n) return setStatus('没有会话快照可导出', 'err');

    const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sessions-${todayStamp()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);

    setStatus(`已导出 ${n} 个站点的会话`, 'ok');
  }

  function importSessions() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json';
    inp.addEventListener('change', async () => {
      const file = inp.files?.[0];
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) return setStatus('文件太大（上限 8MB）', 'err');
      try {
        const data = JSON.parse(await file.text());
        const r = await send({ type: 'session-import', data });
        if (!r?.ok) return setStatus('导入失败：' + (r?.error || '未知'), 'err');
        await reload();
        renderList();
        setStatus(`已导入：新增 ${r.added}，更新 ${r.updated}`, 'ok');
      } catch (e) {
        setStatus('不是合法 JSON：' + e.message, 'err');
      }
    });
    inp.click();
  }

  function renderBulk() {
    if (!els.bulkbar) return;
    els.bulkbar.hidden = !state.selectMode;
    if (!state.selectMode) return;

    const n = state.selected.size;
    els.bulkCount.textContent = n ? `已选 ${n}` : '点选';
    const bulkBtn = els.panel.querySelector('[data-act="bulk"]');
    if (bulkBtn) bulkBtn.classList.toggle('active', true);
  }

  function setStatus(text, kind) {
    if (!els.status) return;
    els.status.textContent = text;
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  /* ---------------- 详情 ---------------- */

  async function openDetail(key) {
    const res = await send({ type: 'reveal', key });
    if (!res?.ok) return setStatus('读取失败', 'err');

    const row = res.row;
    const id = jwtIdentity(row.access_token);
    const now = Date.now();
    const left = (row.expiresAt || 0) - now;
    const rleft = (row.refreshExpiresAt || 0) - now;
    const platform = state.platforms.find((p) => p.id === row.platform);

    const root = document.getElementById(HOST_ID).shadowRoot;
    const wrap = document.createElement('div');
    wrap.className = 'sheet';
    wrap.innerHTML = `
      <div class="sheet-box">
        <div class="sheet-head">
          <span class="sheet-title">${esc(row.nickname || row.uid || '凭证详情')}</span>
          <button class="icon-btn" data-x="close">✕</button>
        </div>
        <div class="sheet-body">
          <div class="drow"><span class="dk">平台</span><span class="dv">${esc(platform ? platform.label : row.platform || '—')}</span></div>
          <div class="drow"><span class="dk">域名</span><span class="dv mono">${esc(row.domain || '—')}</span></div>
          <div class="drow">
            <span class="dk">UID</span>
            <span class="dv mono">${esc(row.uid || '—')}</span>
            ${row.uid ? '<button class="copy-mini" data-copy-field="uid">复制</button>' : ''}
          </div>
          ${row.auth_raw?.account?.uin ? `<div class="drow">
            <span class="dk">UIN</span>
            <span class="dv mono">${esc(row.auth_raw.account.uin)}</span>
            <button class="copy-mini" data-copy-field="uin">复制</button>
          </div>` : ''}
          <div class="drow"><span class="dk">access</span><span class="dv ${expiryLevel(row.expiresAt, now) === 'expired' ? 'bad' : ''}">${esc(row.expiresAt ? humanLeftLong(left) : '到期未知')}</span></div>
          <div class="drow"><span class="dk">refresh</span><span class="dv ${rleft <= 0 && row.refreshExpiresAt ? 'bad' : ''}">${esc(row.refreshExpiresAt && row.refresh_token ? humanLeftLong(rleft) : '无')}</span></div>
          ${row.note ? `<div class="drow"><span class="dk">备注</span><span class="dv">${esc(row.note)}</span></div>` : ''}
          ${id.scopes.length ? `<div class="drow"><span class="dk">scope</span><span class="dv mono small">${esc(id.scopes.join(' '))}</span></div>` : ''}
          ${row.lastRefreshAt ? `<div class="drow"><span class="dk">上次续期</span><span class="dv">${esc(timeAgo(row.lastRefreshAt, now))}</span></div>` : ''}
          <div class="drow"><span class="dk">状态</span><span class="dv" data-el="check">检查中…</span></div>
          <div class="drow col">
            <span class="dk">access_token</span>
            <code class="tok">${esc(maskToken(row.access_token))}</code>
            <button class="copy-mini block" data-copy-field="access_token">复制完整 access_token</button>
          </div>
          ${row.refresh_token ? `<div class="drow col">
            <span class="dk">refresh_token</span>
            <code class="tok">${esc(maskToken(row.refresh_token))}</code>
            <button class="copy-mini block" data-copy-field="refresh_token">复制完整 refresh_token</button>
          </div>` : ''}
        </div>
        <div class="sheet-foot">
          <button class="btn" data-x="refresh">续期</button>
          <button class="btn" data-x="note">备注</button>
          <button class="btn" data-x="toggle">${row.enabled === false ? '启用' : '停用'}</button>
          <button class="btn danger" data-x="remove">移除</button>
        </div>
      </div>`;
    root.appendChild(wrap);

    send({ type: 'check', key }).then((r) => {
      const el = wrap.querySelector('[data-el="check"]');
      if (!el) return;
      el.textContent = r?.ok ? r.detail : (r?.error || '检查失败');
      el.className = 'dv' + (r?.alive ? '' : ' bad');
    });

    wrap.querySelectorAll('[data-copy-field]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const f = btn.dataset.copyField;
        const val = f === 'uin' ? (row.auth_raw?.account?.uin || '') : (row[f] || '');
        if (!val) return;
        const ok = await copyText(val);
        setStatus(ok ? `已复制 ${f}` : '复制失败', ok ? 'ok' : 'err');
      });
    });

    wrap.addEventListener('click', async (ev) => {
      if (ev.target === wrap || ev.target.dataset.x === 'close') { wrap.remove(); return; }
      const act = ev.target.dataset.x;
      if (!act) return;

      if (act === 'refresh') {
        ev.target.disabled = true;
        ev.target.textContent = '续期中';
        const r = await send({ type: 'refresh-one', key });
        if (r?.ok) {
          wrap.remove();
          await reload();
          setStatus('续期成功', 'ok');
        } else {
          ev.target.disabled = false;
          ev.target.textContent = '续期';
          setStatus('续期失败：' + (r?.reason || ''), 'err');
        }
      } else if (act === 'note') {
        const note = prompt('给这个凭证加个备注（留空清除）：', row.note || '');
        if (note === null) return;
        await send({ type: 'add-note', key, note });
        wrap.remove();
        await reload();
        setStatus(note ? '备注已保存' : '备注已清除', 'ok');
      } else if (act === 'toggle') {
        const next = row.enabled === false;
        const r = await send({ type: 'toggle-enabled', key, enabled: next });
        if (r?.ok) {
          wrap.remove();
          await reload();
          setStatus(next ? '已启用' : '已停用', 'ok');
        }
      } else if (act === 'remove') {
        if (!confirm('确定移除这个凭证？')) return;
        const r = await send({ type: 'remove', key });
        if (r?.ok) {
          wrap.remove();
          await reload();
          setStatus('已移除', 'ok');
        }
      }
    });
  }

  /* ---------------- 交互 ---------------- */

  function onClick(ev) {
    const addBtn = ev.target.closest('[data-add]');
    if (addBtn) return addCaptured(addBtn.dataset.add);

    const tabBtn = ev.target.closest('[data-tab]');
    if (tabBtn) {
      state.tabView = tabBtn.dataset.tab;
      renderList();
      return;
    }

    const btn = ev.target.closest('[data-act]');
    if (!btn) return;

    const act = btn.dataset.act;
    if (act === 'collapse') els.panel.classList.toggle('collapsed');
    else if (act === 'auth') doAuth(btn);
    else if (act === 'scan') doScan();
    else if (act === 'import') openImport();
    else if (act === 'copy') doCopy();
    else if (act === 'download') doDownload();
    else if (act === 'refresh') doRefresh(btn);
    else if (act === 'clear') doClear();
    else if (act === 'checkall') doCheckAll(btn);
    else if (act === 'site') toggleSite();
    else if (act === 'settings') {
      try { chrome.runtime.openOptionsPage(); } catch (e) {}
    }
    else if (act === 'sort') {
      const order = ['urgency', 'name', 'added'];
      const label = { urgency: '按到期', name: '按名称', added: '按添加' };
      const i = order.indexOf(state.sortMode);
      state.sortMode = order[(i + 1) % order.length];
      btn.textContent = label[state.sortMode];
      send({ type: 'save-settings', settings: { sortMode: state.sortMode } });
      renderList();
    }
    else if (act === 'bulk') {
      state.selectMode = !state.selectMode;
      if (!state.selectMode) state.selected.clear();
      btn.classList.toggle('active', state.selectMode);
      renderList();
    }
    else if (act === 'bulkall') {
      const rows = filteredRows();
      if (state.selected.size === rows.length) state.selected.clear();
      else rows.forEach((r) => state.selected.add(rowKey(r)));
      renderList();
    }
    else if (act === 'bulkcopy') doCopy();
    else if (act === 'bulkrefresh') doBulkRefresh(btn);
    else if (act === 'bulktoggle') doBulkToggle();
    else if (act === 'bulkremove') doBulkRemove();
    else if (act === 'addall') doAddAll(btn);
    else if (act === 'sesssave') saveSession();
    else if (act === 'sessrestore') restoreSession('');
    else if (act === 'sessexport') exportSessions();
    else if (act === 'sessimport') importSessions();
  }

  function onPlatformChange() {
    const id = els.platformSel.value;
    activePlatform = state.platforms.find((p) => p.id === id) || sitePlatform();
    send({ type: 'save-settings', settings: { lastPlatform: id } });
    renderActions();
    renderHeader();
    renderList();
  }

  function pickedRows() {
    if (state.selectMode && state.selected.size) {
      return state.pool.filter((r) => state.selected.has(rowKey(r)));
    }
    return null;
  }

  async function addCaptured(key) {
    const r = await send({ type: 'add-captured', key, host: location.hostname });
    if (r?.ok) {
      await reload();
      state.tabView = 'pool';
      renderList();
      setStatus('已加入', 'ok');
    } else {
      setStatus('加入失败：' + (r?.error || '未知'), 'err');
    }
  }

  async function doAddAll(btn) {
    btn.disabled = true;
    btn.textContent = '加入中…';
    const r = await send({ type: 'add-captured-many' });
    if (r?.ok) {
      await reload();
      state.tabView = 'pool';
      renderList();
      setStatus(`已加入 ${r.added} 个`, 'ok');
    } else {
      btn.disabled = false;
      btn.textContent = '全部加入';
      setStatus('加入失败', 'err');
    }
  }

  async function doScan() {
    setStatus('扫描中…');
    try { window.postMessage({ __tk: 'rescan' }, '*'); } catch (e) {}
    await new Promise((r) => setTimeout(r, 700));

    const r = await send({ type: 'scan', host: location.hostname });
    if (r?.ok) {
      state.captured = r.captured || [];
      state.tabView = 'captured';
      renderList();
      setStatus(state.captured.length ? `扫到 ${state.captured.length} 个` : '没扫到，刷新页面再试',
        state.captured.length ? 'ok' : 'err');
    } else {
      setStatus('扫描失败：' + (r?.error || '未知'), 'err');
    }
  }

  async function doAuth(btn) {
    btn.disabled = true;
    btn.textContent = '等待登录…';
    setStatus('申请授权码…');

    const r = await send({ type: 'authorize', platformId: activePlatform.id });
    if (!r?.ok) {
      btn.disabled = false;
      btn.textContent = '授权添加';
      return setStatus('失败：' + (r?.error || '未知'), 'err');
    }

    window.open(r.authUrl, '_blank');
    setStatus('已打开登录页');

    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 2000));
      const p = await send({ type: 'poll-now', platformId: activePlatform.id, state: r.state });
      if (p?.status === 'ok') {
        btn.disabled = false;
        btn.textContent = '授权添加';
        await reload();
        return setStatus('已添加：' + (p.row?.nickname || '账号'), 'ok');
      }
      if (p?.status === 'error') {
        btn.disabled = false;
        btn.textContent = '授权添加';
        return setStatus('失败：' + (p.message || ''), 'err');
      }
      setStatus('等待登录…');
    }
    btn.disabled = false;
    btn.textContent = '授权添加';
    setStatus('超时', 'err');
  }

  function exportPayload() {
    const fmt = els.format?.value || 'auto';
    const picked = pickedRows();
    const payload = { type: 'export', format: fmt, onlyValid: false };
    if (picked) payload.keys = picked.map(rowKey);
    return payload;
  }

  async function doCopy() {
    if (!state.pool.length) return setStatus('池子是空的', 'err');
    const r = await send(exportPayload());
    if (!r?.ok) return setStatus('导出失败', 'err');

    const isPlain = ['raw', 'bearer', 'curl', 'env'].includes(r.format);
    const text = isPlain ? r.rows.join('\n\n') : JSON.stringify(r.rows, null, 2);
    const ok = await copyText(text);
    const scope = pickedRows() ? '（选中）' : '';
    setStatus(ok ? `已复制 ${r.count} 条${scope}` : '复制失败，用下载', ok ? 'ok' : 'err');
  }

  async function doDownload() {
    if (!state.pool.length) return setStatus('池子是空的', 'err');
    const r = await send(exportPayload());
    if (!r?.ok) return setStatus('导出失败', 'err');
    if (!r.count) return setStatus('没有可导出的', 'err');

    const isPlain = ['raw', 'bearer', 'curl', 'env'].includes(r.format);
    const text = isPlain ? r.rows.join('\n\n') : JSON.stringify(r.rows, null, 2);
    const extMap = { curl: 'sh', env: 'env', raw: 'txt', bearer: 'txt', postman: 'postman_collection.json' };
    const ext = extMap[r.format] || 'json';
    const name = r.format === 'device'
      ? `accounts-${todayStamp()}.${ext}`
      : `tokens-${location.hostname}-${todayStamp()}.${ext}`;

    const blob = new Blob([text], { type: isPlain ? 'text/plain;charset=utf-8' : 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    const scope = pickedRows() ? '（选中）' : '';
    setStatus(`已下载 ${r.count} 条${scope}`, 'ok');
  }

  async function doBulkRefresh(btn) {
    if (!state.selected.size) return setStatus('先选几个', 'err');
    btn.disabled = true;
    const keys = [...state.selected];
    let ok = 0;
    const fails = [];

    for (let i = 0; i < keys.length; i++) {
      btn.textContent = `${i + 1}/${keys.length}`;
      setStatus(`续期中 ${i + 1}/${keys.length}…`);
      const r = await send({ type: 'refresh-one', key: keys[i] });
      if (r?.ok) ok++; else fails.push(r?.reason || '失败');
    }

    btn.disabled = false;
    btn.textContent = '续期';
    await reload();
    setStatus(`续期 ${ok} 个${fails.length ? `，${fails.length} 失败` : ''}`, fails.length ? 'err' : 'ok');
  }

  async function doBulkToggle() {
    if (!state.selected.size) return setStatus('先选几个', 'err');
    const rows = state.pool.filter((r) => state.selected.has(rowKey(r)));
    const anyEnabled = rows.some((r) => r.enabled !== false);
    const target = !anyEnabled;

    for (const r of rows) {
      await send({ type: 'toggle-enabled', key: rowKey(r), enabled: target });
    }
    await reload();
    setStatus(target ? `已启用 ${rows.length} 个` : `已停用 ${rows.length} 个`, 'ok');
  }

  async function doBulkRemove() {
    if (!state.selected.size) return setStatus('先选几个', 'err');
    if (!confirm(`移除选中的 ${state.selected.size} 个？`)) return;

    const r = await send({ type: 'remove-many', keys: [...state.selected] });
    if (r?.ok) {
      state.selected.clear();
      state.selectMode = false;
      await reload();
      setStatus(`已移除 ${r.removed} 个`, 'ok');
    }
  }

  async function doClear() {
    if (!state.pool.length && !state.captured.length) return setStatus('本来就是空的');
    if (!confirm(`清空？凭证池 ${state.pool.length} 条，扫到的 ${state.captured.length} 条。`)) return;

    await send({ type: 'clear-pool' });
    await send({ type: 'clear-captured' });
    await reload();
    setStatus('已清空', 'ok');
  }

  async function doRefresh(btn) {
    if (!state.pool.length) return setStatus('池子是空的', 'err');
    btn.disabled = true;
    btn.textContent = '续期中';

    const r = await send({ type: 'refresh-all', force: false });
    btn.disabled = false;
    btn.textContent = '续期';

    if (r?.ok) {
      await reload();
      if (!r.total) return setStatus('都还新鲜');
      setStatus(r.fails?.length ? `续期 ${r.okCount} 成 ${r.fails.length} 败` : `续期 ${r.okCount} 个`,
        r.fails?.length ? 'err' : 'ok');
    } else {
      setStatus('续期失败', 'err');
    }
  }

  async function doCheckAll(btn) {
    if (!state.pool.length) return setStatus('池子是空的', 'err');
    btn.disabled = true;
    btn.textContent = '体检中';

    const r = await send({ type: 'check-all' });
    btn.disabled = false;
    btn.textContent = '体检';

    if (!r?.ok) return setStatus('体检失败', 'err');

    const dead = (r.results || []).filter((x) => !x.alive);
    const alive = (r.results || []).filter((x) => x.alive);
    const unk = r.unknown || 0;
    const methodLabel = (m) => (m === 'remote' ? '服务端' : m === 'unknown' ? '无到期时间' : '本地');

    const rowHtml = (x) => `
      <div class="drow">
        <span class="dk">${x.alive ? '有效' : '失效'}</span>
        <span class="dv${x.alive ? '' : ' bad'}">${esc(x.name)}<br>
          <span class="dv small">${esc(x.detail)} · ${methodLabel(x.method)}</span>
        </span>
      </div>`;

    const root = document.getElementById(HOST_ID).shadowRoot;
    const wrap = document.createElement('div');
    wrap.className = 'sheet';
    wrap.innerHTML = `
      <div class="sheet-box">
        <div class="sheet-head">
          <span class="sheet-title">体检 · ${r.alive} 有效 / ${r.dead} 失效${unk ? ` / ${unk} 无法判断` : ''}</span>
          <button class="icon-btn" data-x="close">✕</button>
        </div>
        <div class="sheet-body">
          ${dead.length ? `<div class="health-head bad">失效 ${dead.length}</div>${dead.map(rowHtml).join('')}` : ''}
          ${alive.length ? `<div class="health-head ok">有效 ${alive.length}</div>${alive.map(rowHtml).join('')}` : ''}
        </div>
      </div>`;
    root.appendChild(wrap);
    wrap.addEventListener('click', (ev) => {
      if (ev.target === wrap || ev.target.dataset.x === 'close') wrap.remove();
    });

    setStatus(`体检完成：${r.alive} 有效，${r.dead} 失效`, r.dead ? 'err' : 'ok');
  }

  async function toggleSite() {
    const next = !state.siteHook;
    const r = await send({ type: 'set-site-rule', host: location.hostname, hook: next });
    if (!r?.ok) return setStatus('切换失败', 'err');
    state.siteHook = next;
    const btn = els.panel.querySelector('[data-act="site"]');
    if (btn) {
      btn.textContent = next ? '本站' : '本站已关';
      btn.classList.toggle('off', !next);
    }
    setStatus(next ? '已开启，刷新生效' : '已关闭，刷新后停用', 'ok');
  }

  function openImport() {
    const root = document.getElementById(HOST_ID).shadowRoot;
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `
      <div class="modal-box">
        <h3>粘贴导入</h3>
        <p>支持完整数组、单个对象、或只贴 token。导入前会先预览。</p>
        <textarea data-el="ta" placeholder='[{ "access_token": "eyJ...", "refresh_token": "eyJ..." }]'></textarea>
        <div class="modal-foot">
          <button class="btn" data-x="close">取消</button>
          <button class="btn primary" data-x="ok">导入</button>
        </div>
      </div>`;
    root.appendChild(wrap);

    const ta = wrap.querySelector('[data-el="ta"]');
    ta.focus();

    wrap.addEventListener('click', async (ev) => {
      if (ev.target === wrap || ev.target.dataset.x === 'close') { wrap.remove(); return; }
      if (ev.target.dataset.x !== 'ok') return;

      const text = ta.value.trim();
      if (!text) { wrap.remove(); return; }

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        const lines = text.split(/[\s,]+/).filter(Boolean);
        if (lines.length >= 1 && lines[0].startsWith('eyJ')) {
          parsed = [{ access_token: lines[0], refresh_token: lines[1] || '' }];
        } else {
          alert('解析失败：不是 JSON，也不是以 eyJ 开头的 token');
          return;
        }
      }

      const items = Array.isArray(parsed) ? parsed : [parsed];
      const platformId = activePlatform?.mode === 'device' ? activePlatform.id : null;

      const pv = await send({ type: 'preview-import', rows: items, platformId });
      if (!pv?.ok) return setStatus('预览失败', 'err');

      const lines = [`共 ${pv.total} 条`];
      if (pv.added.length) lines.push(`新增 ${pv.added.length}`);
      if (pv.updated.length) lines.push(`覆盖 ${pv.updated.length}`);
      if (pv.invalid.length) lines.push(`无法解析 ${pv.invalid.length}`);
      if (!confirm(lines.join('，') + '\n\n继续导入？')) return;

      let ok = 0;
      const errs = [];
      for (const item of items) {
        const r = await send({ type: 'add-token', row: item, platformId });
        if (r?.ok) ok++; else errs.push(r?.error || '失败');
      }
      wrap.remove();
      await reload();
      state.tabView = 'pool';
      setStatus(`导入 ${ok} 条${errs.length ? `，${errs.length} 失败` : ''}`, errs.length ? 'err' : 'ok');
    });
  }

  function makeDraggable(panel, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('[data-act]')) return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      panel.style.right = 'auto';
      panel.style.left = r.left + 'px';
      panel.style.top = r.top + 'px';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = Math.max(0, Math.min(window.innerWidth - 80, ox + e.clientX - sx)) + 'px';
      panel.style.top = Math.max(0, Math.min(window.innerHeight - 40, oy + e.clientY - sy)) + 'px';
    });

    window.addEventListener('mouseup', () => { dragging = false; });
  }

  async function reload() {
    const res = await send({ type: 'get-state' });
    if (res?.ok) {
      state.pool = res.pool || [];
      state.captured = res.captured || [];
      state.platforms = res.platforms || [];
      state.settings = res.settings || {};
    }
    const se = await send({ type: 'session-list' });
    if (se?.ok) state.sessions = se.sessions || {};
    renderList();
  }

  async function loadSiteRule() {
    const r = await send({ type: 'get-site-rule', host: location.hostname });
    state.siteHook = r?.ok ? r.hook !== false : true;
    const btn = els.panel?.querySelector('[data-act="site"]');
    if (btn) {
      btn.textContent = state.siteHook ? '本站' : '本站已关';
      btn.classList.toggle('off', !state.siteHook);
    }
  }

  async function init() {
    const res = await send({ type: 'get-state' });
    if (!res?.ok) return;
    if (!res.settings?.showFloatingPanel) return;

    state.pool = res.pool || [];
    state.captured = res.captured || [];
    state.platforms = res.platforms || [];
    state.settings = res.settings || {};

    const se = await send({ type: 'session-list' });
    if (se?.ok) state.sessions = se.sessions || {};

    if (state.settings.sortMode) state.sortMode = state.settings.sortMode;
    if (state.settings.filterStatus) state.filterStatus = state.settings.filterStatus;

    const host = location.hostname;
    const known = state.platforms.find((p) => (p.hosts || []).some((h) => h === host));
    const savedPlat = state.settings.lastPlatform
      ? state.platforms.find((p) => p.id === state.settings.lastPlatform)
      : null;
    activePlatform = savedPlat || known || sitePlatform();

    build();

    try {
      if (els.ver) els.ver.textContent = 'v' + chrome.runtime.getManifest().version;
    } catch (e) {}

    if (els.filter) els.filter.value = state.filterStatus;
    if (els.format && state.settings.exportFormat) els.format.value = state.settings.exportFormat;

    const sortBtn = els.panel.querySelector('[data-act="sort"]');
    if (sortBtn) {
      sortBtn.textContent = { urgency: '按到期', name: '按名称', added: '按添加' }[state.sortMode] || '按到期';
    }

    renderPlatforms();
    renderActions();
    renderHeader();
    renderList();
    loadSiteRule();
    setStatus(known?.mode === 'device' ? '点「授权添加」开始' : '登录后点「扫描本页」');

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'pool-changed') reload();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();



