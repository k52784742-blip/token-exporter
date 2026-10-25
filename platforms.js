/**
 * 平台定义（背景页 / 弹窗 / 浮窗共用）
 *
 * mode = 'device'  : 走该平台自己的设备码授权接口
 * mode = 'capture' : 抓取模式，不需要知道接口
 */

export const DEVICE_PATH = {
  state: '/v2/plugin/auth/state',
  token: '/v2/plugin/auth/token',
  account: '/v2/plugin/login/account',
  refresh: '/v2/plugin/auth/token/refresh',
};

export const LOGIN_PENDING = 11217;

export const PRESETS = [
  {
    id: 'workbuddy-cn',
    label: 'WorkBuddy 国内版',
    flag: '🇨🇳',
    mode: 'device',
    hosts: ['www.codebuddy.cn', 'codebuddy.cn'],
    origin: 'https://www.codebuddy.cn',
    domain: 'www.codebuddy.cn',
    markers: ['copilot.tencent.com', 'codebuddy.cn', 'workbuddy.cn'],
    refreshSource: 'workbuddy',
    acceptLanguage: 'zh-CN',
  },
  {
    id: 'workbuddy-intl',
    label: 'WorkBuddy 国际版',
    flag: '🌐',
    mode: 'device',
    hosts: ['www.workbuddy.ai', 'workbuddy.ai'],
    origin: 'https://www.workbuddy.ai',
    domain: 'www.workbuddy.ai',
    markers: ['workbuddy.ai', 'codebuddy.ai'],
    refreshSource: 'plugin',
    acceptLanguage: 'en-US',
  },
];

export function hostMatches(host, pattern) {
  if (!pattern) return false;
  const h = String(host).toLowerCase();
  const p = String(pattern).toLowerCase();
  if (p === h) return true;
  if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1));
  return false;
}

export function detectPlatform(host, extra = []) {
  const all = PRESETS.concat(extra);
  return all.find((p) => (p.hosts || []).some((h) => hostMatches(host, h))) || null;
}

export function platformById(id, extra = []) {
  return PRESETS.concat(extra).find((p) => p.id === id) || null;
}
