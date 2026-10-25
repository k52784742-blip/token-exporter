/**
 * 页面钩子 —— 运行在 MAIN world（页面上下文）
 *
 * content script 默认在隔离世界，那里的 window.fetch 是隔离世界的 fetch，
 * 钩不到页面自己的请求。必须 world: "MAIN" 才能真的拦到。
 *
 * 这里只做一件事：把请求头 / 响应体 / 页面存储里像 token 的串，
 * 通过 postMessage 扔给 bridge.js（隔离世界）。
 * 不改页面行为 —— 原对象原样返回。
 */

(function () {
  'use strict';

  // 防重复注入：用 Symbol 挂在 window 上。
  // 字符串属性名会被 Object.keys / for-in 扫到，Symbol 不会，
  // 而且从外面也猜不到这个 key。
  const GUARD = Symbol.for('__tk_guard_7f3a');
  if (window[GUARD]) return;

  try {
    Object.defineProperty(window, GUARD, {
      value: true, writable: false, configurable: false, enumerable: false,
    });
  } catch (e) { return; }

  const TOKEN_KEYS = [
    'accesstoken', 'access_token', 'access-token', 'refreshtoken', 'refresh_token',
    'refresh-token', 'idtoken', 'id_token', 'token', 'jwt', 'auth_token', 'authtoken',
    'accesskey', 'secretkey', 'session_token', 'sessiontoken', 'id_token_hint',
    'authorization', 'bearer', 'credential',
  ];

  // 这些是「明确叫 token」的字段名，值不必是 JWT 也值得收
  const STRONG_KEYS = [
    'accesstoken', 'access_token', 'refreshtoken', 'refresh_token',
    'idtoken', 'id_token', 'auth_token', 'authtoken', 'session_token', 'bearer',
  ];

  function looksJwt(v) {
    if (typeof v !== 'string') return false;
    const s = v.trim();
    if (s.length < 20) return false;
    const p = s.split('.');
    if (p.length !== 3) return false;
    if (!/^[A-Za-z0-9_-]+$/.test(p[0]) || !/^[A-Za-z0-9_-]+$/.test(p[1])) return false;
    if (p[2] && !/^[A-Za-z0-9_-]+$/.test(p[2])) return false;
    try {
      let seg = p[1].replace(/-/g, '+').replace(/_/g, '/');
      while (seg.length % 4) seg += '=';
      const bin = atob(seg);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const claims = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      return Boolean(claims && (claims.exp || claims.sub || claims.iss || claims.iat
        || claims.name || claims.email || claims.user_id || claims.uid));
    } catch (e) { return false; }
  }

  /**
   * 收一个候选。
   * strong = 字段名明确是 token 时放宽长度限制 —— 很多平台的 token 是
   * 32 位以内的随机串，不是 JWT，按 JWT 规则会全部漏掉。
   */
  function post(token, kind, source, strong) {
    if (!token || typeof token !== 'string') return;
    const t = token.trim();
    if (t.length < 16) return;

    const isJwt = looksJwt(t);
    const minLen = strong ? 16 : 32;
    if (!isJwt && t.length < minLen) return;

    // 明显不是凭证的东西排掉
    if (/^(true|false|null|undefined|\d+)$/i.test(t)) return;
    if (/^https?:\/\//i.test(t)) return;
    if (disabled) return;

    // 走 MessagePort，不进 window 的 message 事件，页面脚本看不到
    deliver({
      __tk: 'capture',
      token: t,
      kind: String(kind || 'body').slice(0, 60),
      source: String(source || '').slice(0, 200),
    });
  }

  function keyIsTokenKey(lk) {
    return TOKEN_KEYS.some((t) => lk === t || lk.endsWith(t) || lk.includes(t));
  }

  function keyIsStrong(lk) {
    return STRONG_KEYS.some((t) => lk === t || lk.endsWith(t));
  }

  function scanJson(node, url, depth) {
    if (!node || depth > 7) return;
    if (typeof node === 'string') {
      if (looksJwt(node)) post(node, 'body', url);
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node.slice(0, 60)) scanJson(v, url, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;

    for (const [k, v] of Object.entries(node)) {
      const lk = String(k).toLowerCase();
      if (typeof v === 'string') {
        if (v.length < 16) continue;
        if (keyIsTokenKey(lk)) post(v, 'body:' + k, url, keyIsStrong(lk));
        else if (looksJwt(v)) post(v, 'body:' + k, url);
      } else if (v && typeof v === 'object') {
        scanJson(v, url, depth + 1);
      }
    }
  }

  // 有些站点（DeepSeek 之类）把 token 包在 {"value":"<jwt>","__version":"0"} 里。
  // 这种包装层很常见（zustand persist / pinia 持久化），单独处理一下，
  // 免得导出时把整个 JSON 当成 token。
  const WRAPPER_KEYS = ['value', 'v', 'data', 'token', 'access_token', 'accessToken', 'jwt', 'content', 'val'];

  function unwrapValue(str) {
    if (!str || str.length < 16 || str.length > 100000) return null;
    const t = str.trim();
    if (t[0] !== '{') return null;
    let obj;
    try { obj = JSON.parse(t); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

    for (const k of WRAPPER_KEYS) {
      const v = obj[k];
      if (typeof v === 'string' && v.length >= 16 && (looksJwt(v) || /^[A-Za-z0-9_\-.]{20,}$/.test(v))) {
        return v;
      }
    }
    return null;
  }

  function scanHeaders(headers, url) {
    if (!headers) return;
    try {
      const pairs = [];
      if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
        headers.forEach((v, k) => pairs.push([k, v]));
      } else if (Array.isArray(headers)) {
        headers.forEach(([k, v]) => pairs.push([k, v]));
      } else {
        Object.entries(headers).forEach(([k, v]) => pairs.push([k, v]));
      }
      for (const [k, v] of pairs) {
        if (!v || typeof v !== 'string') continue;
        const lk = String(k).toLowerCase();
        if (lk === 'authorization' || lk.includes('token') || lk.includes('api-key') || lk === 'cookie') {
          const m = v.match(/^Bearer\s+(.+)$/i);
          post(m ? m[1] : v, 'header', url, true);
        }
      }
    } catch (e) {}
  }

  /** URL 查询串里的 token（OAuth 回调常见 ?access_token=xxx） */
  function scanUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return;
    const qIdx = rawUrl.indexOf('?');
    if (qIdx < 0) return;
    try {
      const params = new URLSearchParams(rawUrl.slice(qIdx + 1).split('#')[0]);
      for (const [k, v] of params) {
        const lk = k.toLowerCase();
        if (keyIsTokenKey(lk)) post(v, 'query:' + k, rawUrl.slice(0, 120), keyIsStrong(lk));
      }
    } catch (e) {}
  }

  /* ---------------- 与 bridge 的安全通道 ---------------- */

  // 早先的版本用 window.postMessage 传 token 明文，而且 targetOrigin 是 '*'。
  // 这意味着页面上任何脚本（目标站自己的、广告、被注入的第三方）都能监听
  // message 事件，把抓到的 token 原样读走。这是个真漏洞，现在改掉：
  //
  //   1. 页面侧建一个 MessageChannel，把 port2 通过一次性握手交给 bridge
  //   2. 之后 token 只走 port，不经过 window 的 message 事件
  //   3. 握手消息本身不带任何凭证，被看到也无所谓
  let bridgePort = null;
  const pending = [];   // 端口没建立前先排队

  function deliver(payload) {
    if (bridgePort) {
      try { bridgePort.postMessage(payload); } catch (e) {}
    } else if (pending.length < 200) {
      pending.push(payload);
    }
  }

  function flushPending() {
    if (!bridgePort) return;
    while (pending.length) {
      const p = pending.shift();
      try { bridgePort.postMessage(p); } catch (e) { break; }
    }
  }

  // bridge 会发一个握手请求，我们回一个 port
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__tk !== 'hs') return;

    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => {
        // bridge 发来的控制指令
        const cmd = e.data;
        if (!cmd) return;
        if (cmd.cmd === 'scan') { scanStorage(); scanIndexedDB(); }
        if (cmd.cmd === 'disable') doDisable();
      };
      bridgePort = ch.port1;
      ch.port1.start();
      flushPending();

      // 把另一个端口交出去。用 ev.ports 走不了（bridge 用 addEventListener 收不到 ports），
      // 所以这里用 postMessage 的 transfer 形式，且 targetOrigin 用当前 origin。
      ev.source.postMessage({ __tk: 'hs-ack' }, ev.origin || location.origin, [ch.port2]);
    } catch (e) {}
  });

  let disabled = false;
  function doDisable() {
    disabled = true;
    for (const restore of originals) {
      try { restore(); } catch (e) {}
    }
    originals.length = 0;
    pending.length = 0;
    try { bridgePort = null; } catch (e) {}
  }



  // 页面只要 fetch.toString() 里看不到 [native code]，就知道被动过。
  // 但光改 toString 还不够 —— 细心的检测还会看：
  //   fn.hasOwnProperty('prototype')  → 原生 fetch 没有
  //   Object.getOwnPropertyNames(fn)  → 原生只有 length / name
  //   fn.toString 是不是自有属性      → 原生是继承的
  // 下面逐条处理。
  const fakeNativeStrings = new WeakMap();
  const originals = [];   // 停用时还原用

  function disguise(fn, original, name) {
    try {
      const finalName = name || original.name || '';
      const nativeStr = 'function ' + finalName + '() { [native code] }';
      fakeNativeStrings.set(fn, nativeStr);

      // 1) prototype
      //    普通函数声明的 prototype 是不可配置的，delete 会静默失败。
      //    所以下面所有包装函数都写成箭头函数（天生没有 prototype），
      //    这里只是兜一层：万一还是普通函数，尽量把它抹掉。
      if (!Object.prototype.hasOwnProperty.call(original, 'prototype')) {
        try {
          delete fn.prototype;
        } catch (e) {}
        // delete 不掉就重定义成不可枚举、值为 undefined，
        // 这样 hasOwnProperty('prototype') 仍然是 true —— 但至少不能当构造器用。
        if (Object.prototype.hasOwnProperty.call(fn, 'prototype')) {
          try {
            Object.defineProperty(fn, 'prototype', {
              value: undefined, writable: false, configurable: true, enumerable: false,
            });
          } catch (e) {}
        }
      }

      // 2) toString 不能是自有属性。原生函数的 toString 继承自 Function.prototype，
      //    我们靠上面改的 Function.prototype.toString 来返回假字符串。
      try { delete fn.toString; } catch (e) {}
      if (Object.prototype.hasOwnProperty.call(fn, 'toString')) {
        // delete 不掉（被定义成不可配置）时退回自有属性方案
        Object.defineProperty(fn, 'toString', {
          value: function toString() { return nativeStr; },
          writable: true, configurable: true, enumerable: false,
        });
      }

      // 3) name / length 对齐
      if (finalName) {
        try {
          Object.defineProperty(fn, 'name', {
            value: finalName, writable: false, configurable: true, enumerable: false,
          });
        } catch (e) {}
      }
      try {
        Object.defineProperty(fn, 'length', {
          value: original.length, writable: false, configurable: true, enumerable: false,
        });
      } catch (e) {}

      // 4) 原型链对齐（instanceof / constructor 检查）
      try { Object.setPrototypeOf(fn, Object.getPrototypeOf(original)); } catch (e) {}

      // 5) own props 收敛到和原生一致：只剩 length / name
      try {
        const allow = new Set(['length', 'name', 'prototype']);
        for (const k of Object.getOwnPropertyNames(fn)) {
          if (!allow.has(k)) {
            try { delete fn[k]; } catch (e) {}
          }
        }
        // 原生没有 prototype 的，这里也要没有
        if (!Object.prototype.hasOwnProperty.call(original, 'prototype')) {
          try { delete fn.prototype; } catch (e) {}
        }
      } catch (e) {}
    } catch (e) {}
    return fn;
  }

  // 全局的 Function.prototype.toString 也要照顾到：
  // 有的检测直接调 Function.prototype.toString.call(window.fetch)
  try {
    const origFpToString = Function.prototype.toString;
    const patched = function toString() {
      const fake = fakeNativeStrings.get(this);
      if (fake) return fake;
      return origFpToString.call(this);
    };
    // 这条 toString 自己也别露馅
    fakeNativeStrings.set(patched, 'function toString() { [native code] }');
    Object.defineProperty(Function.prototype, 'toString', {
      value: patched, writable: true, configurable: true, enumerable: false,
    });
  } catch (e) {}

  /* ---------------- fetch ---------------- */

  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      // 用箭头函数：天生没有 prototype，和原生 fetch 的 own props 一致。
      // 注意箭头函数不绑 arguments，所以用 rest 参数把真实参数收下来。
      const wrappedFetch = (...args) => {
        const promise = origFetch.apply(window, args);
        const input = args[0];
        const init = args[1];
        try {
          const url = typeof input === 'string'
            ? input
            : (input && input.url) || (typeof Request !== 'undefined' && input instanceof Request ? input.url : '');

          if (init && init.headers) scanHeaders(init.headers, url);
          if (input && typeof input === 'object' && input.headers) scanHeaders(input.headers, url);
          scanUrl(url);

          promise.then((res) => {
            try {
              if (!res || typeof res.clone !== 'function') return;
              const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';

              // SSE / 流式响应不要读：.text() 会一直挂着等流结束
              if (/event-stream|multipart\/|octet-stream|image\/|audio\/|video\/|font\//i.test(ct)) return;
              if (ct && !/json|text|javascript|plain|\/x-www-form-urlencoded/i.test(ct)) return;

              res.clone().text().then((txt) => {
                if (!txt || txt.length > 2_000_000) return;
                const t = txt.trim();
                if (!t) return;
                if (t[0] !== '{' && t[0] !== '[') {
                  if (looksJwt(t)) post(t, 'body', url);
                  return;
                }
                try { scanJson(JSON.parse(t), url, 0); } catch (e) {}
              }).catch(() => {});
            } catch (e) {}
          }).catch(() => {});
        } catch (e) {}
        return promise;
      };

      disguise(wrappedFetch, origFetch, 'fetch');
      window.fetch = wrappedFetch;
      originals.push(() => { window.fetch = origFetch; });
    }
  } catch (e) {}

  /* ---------------- XMLHttpRequest ---------------- */

  try {
    const XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XP && !XP.__tkHooked) {
      // 用不可枚举属性打标记，避免被 for-in 扫到
      try {
        Object.defineProperty(XP, '__tkHooked', { value: true, enumerable: false });
      } catch (e) { XP.__tkHooked = true; }

      const origOpen = XP.open;
      const origSet = XP.setRequestHeader;
      const origSend = XP.send;

      XP.open = function (method, url) {
        this.__tkUrl = url;
        scanUrl(url);
        return origOpen.apply(this, arguments);
      };

      XP.setRequestHeader = function (k, v) {
        try {
          const lk = String(k).toLowerCase();
          if (lk === 'authorization' || lk.includes('token')) {
            const m = String(v).match(/^Bearer\s+(.+)$/i);
            post(m ? m[1] : v, 'header', this.__tkUrl || '', true);
          }
        } catch (e) {}
        return origSet.apply(this, arguments);
      };

      XP.send = function () {
        try {
          this.addEventListener('load', () => {
            try {
              // responseType 不是 '' 或 'text' 时访问 responseText 会抛 InvalidStateError
              const rt = this.responseType;
              let body = null;

              if (rt === '' || rt === 'text') {
                body = this.responseText;
              } else if (rt === 'json') {
                scanJson(this.response, this.__tkUrl || '', 0);
                return;
              }

              if (!body || body.length > 2_000_000) return;
              const ct = this.getResponseHeader('content-type') || '';
              if (ct && !/json|text|javascript|plain/i.test(ct)) return;

              const t = body.trim();
              if (!t) return;
              if (t[0] === '{' || t[0] === '[') {
                try { scanJson(JSON.parse(t), this.__tkUrl || '', 0); } catch (e) {}
              } else if (looksJwt(t)) {
                post(t, 'body', this.__tkUrl || '');
              }
            } catch (e) {}
          });
        } catch (e) {}
        return origSend.apply(this, arguments);
      };

      // 三个方法都伪装回原生形态
      disguise(XP.open, origOpen, 'open');
      disguise(XP.setRequestHeader, origSet, 'setRequestHeader');
      disguise(XP.send, origSend, 'send');
      originals.push(() => {
        XP.open = origOpen;
        XP.setRequestHeader = origSet;
        XP.send = origSend;
      });
    }
  } catch (e) {}

  /* ---------------- WebSocket ---------------- */

  // 有些平台握手之后用 WS 推 token，或者 URL 上就带着
  try {
    const OrigWS = window.WebSocket;
    if (typeof OrigWS === 'function') {
      const Wrapped = function (url, protocols) {
        scanUrl(String(url));
        const ws = arguments.length > 1
          ? new OrigWS(url, protocols)
          : new OrigWS(url);

        try {
          ws.addEventListener('message', (ev) => {
            try {
              const d = ev.data;
              if (typeof d !== 'string' || d.length > 500_000) return;
              const t = d.trim();
              if (!t) return;
              if (t[0] === '{' || t[0] === '[') {
                try { scanJson(JSON.parse(t), 'ws', 0); } catch (e) {}
              } else if (looksJwt(t)) {
                post(t, 'ws', String(url).slice(0, 100));
              }
            } catch (e) {}
          });
        } catch (e) {}

        return ws;
      };

      Wrapped.prototype = OrigWS.prototype;
      Wrapped.CONNECTING = OrigWS.CONNECTING;
      Wrapped.OPEN = OrigWS.OPEN;
      Wrapped.CLOSING = OrigWS.CLOSING;
      Wrapped.CLOSED = OrigWS.CLOSED;

      disguise(Wrapped, OrigWS, 'WebSocket');
      window.WebSocket = Wrapped;
      originals.push(() => { window.WebSocket = OrigWS; });
    }
  } catch (e) {}

  /* ---------------- sendBeacon ---------------- */

  try {
    const origBeacon = navigator.sendBeacon;
    if (typeof origBeacon === 'function') {
      const wrapped = function (url, data) {
        try {
          scanUrl(String(url));
          if (typeof data === 'string' && data.length < 500_000) {
            const t = data.trim();
            if (t[0] === '{' || t[0] === '[') {
              try { scanJson(JSON.parse(t), 'beacon', 0); } catch (e) {}
            }
          } else if (data && typeof data === 'object' && typeof data.get === 'function') {
            // FormData
            try {
              for (const [k, v] of data.entries()) {
                if (typeof v === 'string' && keyIsTokenKey(String(k).toLowerCase())) post(v, 'beacon:' + k, '', true);
              }
            } catch (e) {}
          }
        } catch (e) {}
        return origBeacon.apply(this, arguments);
      };
      disguise(wrapped, origBeacon, 'sendBeacon');
      navigator.sendBeacon = wrapped;
      originals.push(() => { navigator.sendBeacon = origBeacon; });
    }
  } catch (e) {}

  /* ---------------- 页面存储 ---------------- */

  function scanStorage() {
    const visit = (store, label) => {
      try {
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          const v = store.getItem(k);
          if (!v || v.length < 16) continue;

          const lk = String(k).toLowerCase();

          // 先看是不是 JSON。很多应用（DeepSeek、各种 zustand/pinia 持久化）
          // 存的是 {"value":"<token>","__version":"0"} 这种包装对象。
          // 如果先按 key 名匹配，会把整串 JSON 当成 token 交上去，
          // 后面导出就全废了。所以 JSON 一定要先拆。
          if (v[0] === '{' || v[0] === '[') {
            // 先试包装层
            const inner = unwrapValue(v);
            if (inner) {
              post(inner, label + ':' + k, location.hostname, true);
              continue;
            }

            let parsed = null;
            try { parsed = JSON.parse(v); } catch (e) {}
            if (parsed && typeof parsed === 'object') {
              if (v.length < 2_000_000) scanJson(parsed, label + ':' + k, 0);
              continue;
            }
          }

          if (looksJwt(v)) { post(v, label + ':' + k, location.hostname); continue; }
          if (keyIsTokenKey(lk)) { post(v, label + ':' + k, location.hostname, keyIsStrong(lk)); continue; }
        }
      } catch (e) {}
    };
    visit(localStorage, 'localStorage');
    visit(sessionStorage, 'sessionStorage');
  }

  /** IndexedDB：有些应用（Firebase 之类）把 token 放这里 */
  function scanIndexedDB() {
    if (!window.indexedDB || !indexedDB.databases) return;

    const timer = setTimeout(() => { finished = true; }, 4000);
    let finished = false;

    const walk = (db, done) => {
      let names;
      try {
        names = db.objectStoreNames;
      } catch (e) { return done(); }

      const list = Array.from(names).slice(0, 8);
      if (!list.length) return done();

      let left = list.length;
      const step = () => { if (--left <= 0) done(); };

      for (const storeName of list) {
        try {
          const tx = db.transaction(storeName, 'readonly');
          const req = tx.objectStore(storeName).getAll();
          req.onsuccess = () => {
            try {
              if (!finished) scanJson(req.result, 'idb:' + storeName, 0);
            } catch (e) {}
            step();
          };
          req.onerror = step;
        } catch (e) { step(); }
      }
    };

    indexedDB.databases().then((dbs) => {
      const use = (dbs || []).slice(0, 5);
      let i = 0;
      const next = () => {
        if (finished || i >= use.length) { clearTimeout(timer); return; }
        const info = use[i++];
        if (!info.name) return next();

        let req;
        try { req = indexedDB.open(info.name); } catch (e) { return next(); }
        req.onsuccess = () => {
          const db = req.result;
          walk(db, () => { try { db.close(); } catch (e) {} next(); });
        };
        req.onerror = next;
        req.onblocked = next;
      };
      next();
    }).catch(() => clearTimeout(timer));
  }

  // 重扫 / 停用指令现在走 MessagePort（见上面的安全通道），
  // 不再监听 window 的 message 事件，页面脚本没法伪造指令。

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(scanStorage, 800), { once: true });
  } else {
    setTimeout(scanStorage, 800);
  }

  // SPA 常常异步写 token，晚一点补一次
  setTimeout(scanStorage, 3500);
  setTimeout(scanStorage, 9000);

  // 登录后 token 才写进 storage 的情况很常见（DeepSeek 就是）。
  // 光靠定时扫会漏，所以监听 storage 变化。
  // storage 事件只在「其他同源窗口」触发，本窗口改自己不会触发 —— 所以还要
  // 在 Storage.prototype.setItem 上挂一层，捕获本窗口的写入。
  window.addEventListener('storage', () => {
    if (disabled) return;
    setTimeout(scanStorage, 60);
  }, { passive: true });

  try {
    const origSetItem = Storage.prototype.setItem;

    // 普通函数的 prototype 是不可配置的，delete / defineProperty 都抹不掉，
    // 一测就露。所以用箭头函数（天生没有 prototype）。
    //
    // 箭头函数没有自己的 this，但 Proxy 可以保留调用者：用 apply 陷阱拿到
    // thisArg，再原样转发给原生方法。这样 localStorage 和 sessionStorage
    // 都能正确写入自己的存储。
    const handler = {
      apply(target, thisArg, args) {
        const r = Reflect.apply(origSetItem, thisArg, args);
        if (!disabled) {
          const lk = String(args[0] || '').toLowerCase();
          const v = args[1];
          if (keyIsTokenKey(lk) || (typeof v === 'string' && v.length >= 16 && v.includes('.'))) {
            setTimeout(scanStorage, 80);
          }
        }
        return r;
      },
    };

    // Proxy 的 target 用箭头函数，这样 getOwnPropertyDescriptor('prototype')
    // 查不到 —— 和原生一致。Proxy 会把这个「没有 prototype」如实反映出来。
    const proxy = new Proxy((..._args) => {}, handler);
    disguise(proxy, origSetItem, 'setItem');
    Storage.prototype.setItem = proxy;

    originals.push(() => {
      try { Storage.prototype.setItem = origSetItem; } catch (e) {}
    });
  } catch (e) {}
})();
