#!/usr/bin/env node
/**
 * 自检脚本
 *
 * 用法：
 *   node scripts/check.js          基础检查（语法、引用、绑定、消息路由）
 *   node scripts/check.js --strict 额外检查（安全、规范、文件完整性）
 *
 * 退出码：0 通过，1 有问题
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = process.argv.includes('--strict');

let fail = 0;
let warn = 0;

const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const bad = (m, e) => { console.log('  \x1b[31m✗\x1b[0m ' + m + (e ? ' — ' + e : '')); fail++; };
const note = (m) => { console.log('  \x1b[33m!\x1b[0m ' + m); warn++; };
const head = (m) => console.log('\n\x1b[1m' + m + '\x1b[0m');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(ROOT, f));

/* ==========================================================================
 * 1. manifest
 * ========================================================================*/

head('manifest.json');

let mf;
try {
  mf = JSON.parse(read('manifest.json'));
  ok('JSON 合法，v' + mf.version);
} catch (e) {
  bad('JSON 解析失败', e.message);
  process.exit(1);
}

if (mf.manifest_version !== 3) bad('manifest_version 必须是 3');

const refs = [];
if (mf.background?.service_worker) refs.push(mf.background.service_worker);
if (mf.action?.default_popup) refs.push(mf.action.default_popup);
if (mf.options_page) refs.push(mf.options_page);
(mf.content_scripts || []).forEach((cs) => (cs.js || []).forEach((j) => refs.push(j)));
Object.values(mf.icons || {}).forEach((i) => refs.push(i));

for (const r of [...new Set(refs)]) {
  exists(r) ? ok(r) : bad(r, '文件不存在');
}

/* ==========================================================================
 * 2. content script world
 * ========================================================================*/

head('content script world');

for (const cs of mf.content_scripts || []) {
  const files = (cs.js || []).join(',');
  const world = cs.world || 'ISOLATED';

  if (files.includes('page-hook') && world !== 'MAIN') {
    bad(files, '必须 world=MAIN，否则钩不到页面 fetch');
  } else if (files.includes('bridge') && world === 'MAIN') {
    bad(files, '不能 world=MAIN，用不了 chrome.runtime');
  } else {
    ok(files + ' = ' + world);
  }
}

/* ==========================================================================
 * 3. JS 语法
 * ========================================================================*/

head('JS 语法');

const jsFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.js') && !f.startsWith('_'));

for (const f of jsFiles) {
  try {
    new vm.SourceTextModule(read(f), { identifier: f });
    ok(f);
  } catch (e) {
    bad(f, e.message);
  }
}

/* ==========================================================================
 * 4. import 路径
 * ========================================================================*/

head('import 路径');

for (const f of jsFiles) {
  const src = read(f);
  let m;
  const re = /from\s+['"](\.[^'"]+)['"]/g;
  while ((m = re.exec(src))) {
    exists(path.relative(ROOT, path.resolve(ROOT, m[1])))
      ? ok(`${f} → ${m[1]}`)
      : bad(`${f} → ${m[1]}`, '目标不存在');
  }
}

/* ==========================================================================
 * 5. 按钮绑定
 * ========================================================================*/

head('按钮绑定');

for (const page of ['popup', 'options']) {
  if (!exists(page + '.html')) continue;
  const html = read(page + '.html');
  const js = read(page + '.js');
  const ids = [...html.matchAll(/<button[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  const bound = new Set([...js.matchAll(/\$\('([^']+)'\)\.addEventListener/g)].map((m) => m[1]));
  for (const id of ids) {
    bound.has(id) ? ok(`${page}: #${id}`) : bad(`${page}: #${id}`, '未绑定监听');
  }
}

/* ==========================================================================
 * 6. 消息路由
 * ========================================================================*/

head('消息路由');

const bgSrc = read('background.js');
const handled = new Set([...bgSrc.matchAll(/case '([^']+)':/g)].map((m) => m[1]));

for (const f of ['popup.js', 'panel.js', 'bridge.js', 'options.js']) {
  if (!exists(f)) continue;
  const src = read(f);
  const sent = new Set([...src.matchAll(/send\(\{\s*type:\s*'([^']+)'/g)].map((m) => m[1]));
  for (const t of sent) {
    handled.has(t) ? ok(`${f} → ${t}`) : bad(`${f} → ${t}`, 'background 未处理');
  }
}

/* ==========================================================================
 * 7. 严格检查
 * ========================================================================*/

if (STRICT) {
  head('安全');

  for (const f of jsFiles) {
    const src = read(f);
    const lines = src.split('\n');

    lines.forEach((l, i) => {
      if (/\beval\s*\(/.test(l)) bad(`${f}:${i + 1}`, 'eval 使用');
      if (/new\s+Function\s*\(/.test(l)) bad(`${f}:${i + 1}`, 'new Function 使用');
      if (/document\.write/.test(l)) note(`${f}:${i + 1} document.write`);
      if (/eyJ[A-Za-z0-9_-]{40,}\./.test(l)) bad(`${f}:${i + 1}`, '疑似硬编码 JWT');
      if (/console\.(log|debug)\(/.test(l)) note(`${f}:${i + 1} 残留 console`);
    });
  }
  ok('无 eval / new Function / 硬编码凭证');

  head('权限');

  const needPerm = {
    storage: '存凭证',
    cookies: '读 HttpOnly cookie',
    tabs: '查当前标签、开授权页',
    clipboardWrite: '写剪贴板',
    webRequest: '读请求头',
    contextMenus: '右键菜单',
  };
  const allJs = jsFiles.map(read).join('\n');

  for (const p of mf.permissions || []) {
    if (!needPerm[p]) {
      note(`权限 "${p}" 用途不明`);
    } else if (p === 'scripting' && !/chrome\.scripting/.test(allJs)) {
      bad(`权限 "${p}" 声明了但没用到，应删除`);
    } else {
      ok(`${p} — ${needPerm[p]}`);
    }
  }

  head('开源文件');

  for (const f of ['README.md', 'LICENSE', '.gitignore', 'package.json']) {
    exists(f) ? ok(f) : bad(f, '缺失');
  }

  head('代码规范');

  for (const f of jsFiles) {
    const src = read(f);
    const lines = src.split('\n');
    const trailing = lines.filter((l) => /\s+$/.test(l)).length;
    if (trailing > 0) note(`${f}: ${trailing} 行行尾空格`);
    if (/\t/.test(src)) note(`${f}: 含 tab 缩进`);
  }
  ok('规范检查完成');
}

/* ==========================================================================
 * 汇总
 * ========================================================================*/

console.log('');
if (fail) {
  console.log(`\x1b[31m✗ ${fail} 项失败\x1b[0m${warn ? `，${warn} 项提示` : ''}`);
  process.exit(1);
} else {
  console.log(`\x1b[32m✓ 全部通过\x1b[0m${warn ? `（${warn} 项提示）` : ''}`);
}
