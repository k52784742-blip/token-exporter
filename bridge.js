/**
 * 桥接脚本 —— 隔离世界（默认 content script 环境）
 *
 * 干三件事：
 *   1. 和 page-hook 建立一条 MessageChannel，接收它抓到的 token
 *   2. 收到「重扫」指令时转给 page-hook
 *   3. 补扫 document.cookie（HttpOnly 那部分靠 background 的 chrome.cookies）
 *
 * 为什么用 MessageChannel 而不是 window.postMessage：
 * postMessage 是广播，页面上任何脚本都能监听。token 明文从这里过一遍
 * 等于白送。MessagePort 是点对点的，页面脚本拿不到。
 */

(function () {
  'use strict';

  const GUARD = Symbol.for('__tk_guard_9c2e');
  if (window[GUARD]) return;
  try {
    Object.defineProperty(window, GUARD, {
      value: true, writable: false, configurable: false, enumerable: false,
    });
  } catch (e) { return; }

  let host = '';
  try { host = location.hostname; } catch (e) {}

  function looksJwt(v) {
    if (typeof v !== 'string') return false;
    const s = v.trim();
    if (s.length < 20) return false;
    const p = s.split('.');
    return p.length === 3
      && /^[A-Za-z0-9_-]+$/.test(p[0])
      && /^[A-Za-z0-9_-]+$/.test(p[1])
      && (!p[2] || /^[A-Za-z0-9_-]+$/.test(p[2]));
  }

  /* ---------------- 与 page-hook 建立端口 ---------------- */

  let pagePort = null;
  let disabled = false;

  function handshake() {
    try { window.postMessage({ __tk: 'hs' }, location.origin); } catch (e) {}
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__tk !== 'hs-ack') return;

    const port = ev.ports && ev.ports[0];
    if (!port) return;

    pagePort = port;
    pagePort.onmessage = (e) => {
      const m = e.data;
      if (!m || m.__tk !== 'capture' || !m.token) return;
      forward(m.token, m.kind, m.source);
    };
    pagePort.start();
  });

  // page-hook 可能比 bridge 晚就绪，多握几次
  handshake();
  setTimeout(handshake, 50);
  setTimeout(handshake, 400);

  /* ---------------- 站点开关 ---------------- */

  // 白名单模式下，不在名单里的站点直接不干活
  chrome.runtime.sendMessage({ type: 'should-capture', host }).then((res) => {
    if (res && res.ok && res.enabled === false) {
      disabled = true;
      try { window.postMessage({ __tk: 'disable' }, location.origin); } catch (e) {}
    }
  }).catch(() => {});

  chrome.storage.local.get('site_rules_v1').then((res) => {
    const rules = res?.site_rules_v1 || {};
    const rule = rules[host];
    if (rule && rule.hook === false) disable();
  }).catch(() => {});

  function disable() {
    disabled = true;
    try {
      if (pagePort) pagePort.postMessage({ cmd: 'disable' });
    } catch (e) {}
    try { pagePort = null; } catch (e) {}
  }

  /* ---------------- 抓到提示 ---------------- */

  // 别用固定 id，页面能靠它反查扩展
  const TOAST_ID = 'nt-' + Math.random().toString(36).slice(2, 9);
  let toastCount = 0;
  let toastTimer = null;
  let toastEls = null;

  function ensureToast() {
    if (toastEls) return toastEls;

    const hostEl = document.createElement('div');
    hostEl.id = TOAST_ID;
    // 注意别把 all:initial 写在 host 上：它会把 position/left/bottom 一起重置掉
    hostEl.style.cssText = 'position:fixed;z-index:2147483646;left:16px;bottom:16px;'
      + 'pointer-events:none;width:auto;height:auto;';
    document.documentElement.appendChild(hostEl);

    const root = hostEl.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .t {
        display: flex; align-items: center; gap: 8px;
        padding: 9px 14px 9px 11px;
        background: #181b21; color: #e8ebf2;
        border: 1px solid #2a2f3a; border-left: 2px solid #34d399;
        border-radius: 9px;
        box-shadow: 0 8px 28px rgba(0,0,0,.55);
        font: 500 12px/1.4 -apple-system, "Segoe UI", "PingFang SC", sans-serif;
        white-space: nowrap;
        opacity: 0; transform: translateY(8px);
        transition: opacity .22s ease, transform .22s ease;
        pointer-events: auto;
      }
      .t.show { opacity: 1; transform: translateY(0); }
      .k {
        width: 22px; height: 22px; border-radius: 6px; flex: none;
        background: linear-gradient(135deg, #34d399, #10b981);
        display: flex; align-items: center; justify-content: center;
      }
      .k svg { width: 13px; height: 13px; display: block; }
      .x { display: flex; flex-direction: column; gap: 1px; }
      .a { font-weight: 600; font-size: 12px; }
      .b { font-size: 10.5px; color: #9aa3b5; max-width: 210px;
           overflow: hidden; text-overflow: ellipsis; }
      .n {
        margin-left: 2px; padding: 1px 6px; border-radius: 99px;
        background: #0d1f19; color: #34d399; border: 1px solid #1a4a3a;
        font-size: 10px; font-variant-numeric: tabular-nums;
      }
    `;
    root.appendChild(style);

    const box = document.createElement('div');
    box.className = 't';
    box.innerHTML = `
      <span class="k">
        <svg viewBox="0 0 24 24" fill="none" stroke="#0b1a14" stroke-width="3"
          stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>
      </span>
      <span class="x">
        <span class="a">抓到凭证</span>
        <span class="b" data-el="sub">已存入本地</span>
      </span>
      <span class="n" data-el="count">1</span>
    `;
    root.appendChild(box);

    toastEls = { box, sub: box.querySelector('[data-el="sub"]'), count: box.querySelector('[data-el="count"]') };
    return toastEls;
  }

  function showToast(kindLabel) {
    try {
      if (!document.documentElement) return;
      const t = ensureToast();

      toastCount++;
      t.count.textContent = toastCount > 1 ? '+' + toastCount : '1';
      t.sub.textContent = kindLabel ? String(kindLabel).slice(0, 34) : '已存入本地';

      // 后台标签页里 CSS 过渡会被浏览器冻结，给个兜底样式保证可见
      if (document.hidden) {
        t.box.style.transition = 'none';
        t.box.style.opacity = '1';
        t.box.style.transform = 'none';
      } else {
        void t.box.offsetWidth;
        t.box.classList.add('show');
      }

      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        t.box.classList.remove('show');
        if (document.hidden) t.box.style.opacity = '0';
        toastCount = 0;
      }, 2600);
    } catch (e) {}
  }

  /* ---------------- 转发到 background ---------------- */

  function forward(token, kind, source, silent) {
    if (disabled || !token) return;
    try {
      chrome.runtime.sendMessage({
        type: 'capture',
        token,
        kind,
        source,
        host,
      }).then((r) => {
        // added=false 表示重复，不弹提示
        if (r && r.ok && r.added && !silent) showToast(kind);
      }).catch(() => {});
    } catch (e) {}
  }

  /* ---------------- cookie 补扫 ---------------- */

  function scanCookie() {
    try {
      document.cookie.split(';').forEach((pair) => {
        const i = pair.indexOf('=');
        if (i < 0) return;
        const name = pair.slice(0, i).trim();
        let val = pair.slice(i + 1).trim();
        try { val = decodeURIComponent(val); } catch (e) {}
        if (looksJwt(val)) forward(val, 'cookie:' + name, host, true);
      });
    } catch (e) {}
  }

  /* ---------------- 消息（来自 popup / background） ---------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'rescan-page') {
      try {
        if (pagePort) pagePort.postMessage({ cmd: 'scan' });
      } catch (e) {}
      scanCookie();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  const kick = () => { scanCookie(); };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(kick, 600), { once: true });
  } else {
    setTimeout(kick, 600);
  }
  setTimeout(kick, 3000);
})();
