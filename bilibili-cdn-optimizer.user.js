// ==UserScript==
// @name         B站CDN优选 (海外就近 · Akamai优先)
// @name:en      Bilibili CDN Optimizer (nearest overseas)
// @namespace    dz-bili-cdn-optimizer
// @version      1.1
// @description  强制B站视频/番剧走就近的海外Akamai CDN节点,避免被B站随机调度到慢节点(腾讯云远端/国内)。装一次,之后每个视频自动满速。
// @author       SanJerry007
// @homepageURL  https://github.com/SanJerry007/bilibili-cdn-optimizer
// @supportURL   https://github.com/SanJerry007/bilibili-cdn-optimizer/issues
// @updateURL    https://raw.githubusercontent.com/SanJerry007/bilibili-cdn-optimizer/main/bilibili-cdn-optimizer.user.js
// @downloadURL  https://raw.githubusercontent.com/SanJerry007/bilibili-cdn-optimizer/main/bilibili-cdn-optimizer.user.js
// @license      MIT
// @match        *://*.bilibili.com/*
// @run-at       document-start
// @grant        none
// @noframes     false
// ==/UserScript==

(function () {
  'use strict';

  // ===== 配置 =====
  // 优先域(命中即用,按顺序):akamaized.net = 你本地Edison的Akamai节点(实测185Mbps)
  const PREFER = ['akamaized.net'];
  // 是否在页面角落显示"已优选"提示(方便确认生效,用熟后可改 false)
  const SHOW_TOAST = true;
  // ================

  function hostOf(u) { try { return new URL(u, location.href).host; } catch (e) { return ''; } }

  function pickBest(urls) {
    const valid = urls.filter(Boolean);
    for (const key of PREFER) {
      const hit = valid.find(u => hostOf(u).includes(key));
      if (hit) return hit;
    }
    return valid[0];
  }

  let lastPicked = '';

  function optimizeStream(s) {
    const cands = [];
    if (s.baseUrl) cands.push(s.baseUrl);
    if (s.base_url) cands.push(s.base_url);
    if (Array.isArray(s.backupUrl)) cands.push(...s.backupUrl);
    if (Array.isArray(s.backup_url)) cands.push(...s.backup_url);
    if (!cands.length) return;
    const best = pickBest(cands);
    if (!best) return;
    lastPicked = hostOf(best);
    const others = cands.filter(u => u !== best);
    if ('baseUrl' in s) s.baseUrl = best;
    if ('base_url' in s) s.base_url = best;
    if ('backupUrl' in s) s.backupUrl = others;
    if ('backup_url' in s) s.backup_url = others;
  }

  function processData(json) {
    try {
      const d = (json && (json.data || json.result)) ? (json.data || json.result) : json;
      if (!d) return json;
      if (d.dash) {
        (d.dash.video || []).forEach(optimizeStream);
        (d.dash.audio || []).forEach(optimizeStream);
        if (d.dash.dolby && Array.isArray(d.dash.dolby.audio)) d.dash.dolby.audio.forEach(optimizeStream);
        if (d.dash.flac && d.dash.flac.audio) optimizeStream(d.dash.flac.audio);
      }
      if (Array.isArray(d.durl)) {
        d.durl.forEach(seg => {
          const cands = [seg.url, ...((seg.backup_url) || [])].filter(Boolean);
          if (!cands.length) return;
          const best = pickBest(cands);
          if (!best) return;
          lastPicked = hostOf(best);
          seg.url = best;
          seg.backup_url = cands.filter(u => u !== best);
        });
      }
      if (lastPicked) {
        console.log('%c[B站CDN优选]%c 已选用 -> ' + lastPicked,
          'color:#00a1d6;font-weight:bold', 'color:inherit');
        if (SHOW_TOAST) toast(lastPicked);
      }
    } catch (e) { console.warn('[B站CDN优选] 处理异常', e); }
    return json;
  }

  const isPlayurl = (url) => typeof url === 'string' && url.indexOf('playurl') !== -1;

  // ---- hook fetch ----
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    const url = (typeof input === 'string') ? input : (input && input.url);
    if (isPlayurl(url)) {
      return _fetch.apply(this, arguments).then(resp => {
        return resp.clone().json().then(json => {
          processData(json);
          return new Response(JSON.stringify(json), {
            status: resp.status, statusText: resp.statusText, headers: resp.headers
          });
        }).catch(() => resp);
      });
    }
    return _fetch.apply(this, arguments);
  };

  // ---- hook XHR (惰性getter, 时序无关最稳) ----
  const proto = XMLHttpRequest.prototype;
  const rtDesc = Object.getOwnPropertyDescriptor(proto, 'responseText');
  const rDesc = Object.getOwnPropertyDescriptor(proto, 'response');
  const _open = proto.open;

  function transform(raw) {
    if (typeof raw !== 'string' || !raw) return raw;
    try { const j = JSON.parse(raw); processData(j); return JSON.stringify(j); }
    catch (e) { return raw; }
  }

  proto.open = function (method, url) {
    if (isPlayurl(url)) {
      Object.defineProperty(this, 'responseText', {
        configurable: true,
        get() { return transform(rtDesc.get.call(this)); }
      });
      Object.defineProperty(this, 'response', {
        configurable: true,
        get() { const raw = rDesc.get.call(this); return (typeof raw === 'string') ? transform(raw) : raw; }
      });
    }
    return _open.apply(this, arguments);
  };

  // ---- 角标提示 ----
  let toastEl = null, toastTimer = null;
  function toast(host) {
    try {
      if (!document.body) { document.addEventListener('DOMContentLoaded', () => toast(host)); return; }
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;' +
          'background:rgba(0,161,214,.95);color:#fff;padding:8px 14px;border-radius:8px;' +
          'font-size:12px;font-family:sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.3);' +
          'transition:opacity .4s;pointer-events:none';
        document.body.appendChild(toastEl);
      }
      const ok = PREFER.some(k => host.includes(k));
      toastEl.textContent = (ok ? '✅ CDN已优选: ' : '⚠️ 未命中优选(用兜底): ') + host;
      toastEl.style.background = ok ? 'rgba(0,161,214,.95)' : 'rgba(230,150,0,.95)';
      toastEl.style.opacity = '1';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { if (toastEl) toastEl.style.opacity = '0'; }, 4000);
    } catch (e) {}
  }

  console.log('%c[B站CDN优选]%c 已加载 v1.1 · 优先域: ' + PREFER.join(', '),
    'color:#00a1d6;font-weight:bold', 'color:inherit');
})();
