// ==UserScript==
// @name         B站CDN优选 (海外就近 · 实测择优)
// @name:en      Bilibili CDN Optimizer (auto speed-test)
// @namespace    https://github.com/SanJerry007
// @version      2.1
// @description  海外看B站不卡:自动实测所有CDN镜像的真实速度,选最快的用。测速失败时回退到就近Akamai节点。不伪造地址、不需VPN。
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

  // ===================== 配置 =====================
  const CFG = {
    // 模式: 'auto' = 实测所有CDN选最快(推荐) | 'prefer' = 固定优先(省流量,不测速)
    MODE: 'auto',
    // 兜底优先域(测速失败/prefer模式/测速中时用,按顺序): akamaized.net = 全球就近的Akamai
    PREFER: ['akamaized.net'],
    // 测速: 每个镜像下载多少字节(256KB足够区分快慢,流量极小)
    TEST_BYTES: 262144,
    // 测速: 单个镜像超时(ms),超时即淘汰,不拖累播放
    TEST_TIMEOUT: 4000,
    // 测速结果缓存时长(ms),期间不重测。默认10分钟
    CACHE_TTL: 10 * 60 * 1000,
    // 播放器刚拿到地址就重新请求 playurl,视为该 CDN 播不动。判定窗口(ms)
    RETRY_WINDOW: 15000,
    // 判定失败后,该 CDN 暂时不再被选中的时长(ms)
    BAN_TTL: 5 * 60 * 1000,
    // 角标提示(用熟后可改 false)
    SHOW_TOAST: true,
  };
  // ================================================

  const LOG_S = 'color:#00a1d6;font-weight:bold';
  function log(...a) { console.log('%c[B站CDN优选]%c', LOG_S, 'color:inherit', ...a); }
  function hostOf(u) { try { return new URL(u, location.href).host; } catch (e) { return ''; } }
  function preferHit(host) { return CFG.PREFER.some(k => host.includes(k)); }

  // 实测赢家缓存 { host, ts }
  let winner = null;
  let testing = false;
  function cacheValid() { return winner && (Date.now() - winner.ts) < CFG.CACHE_TTL; }

  // 播不动的 CDN 黑名单: host -> 解禁时间戳
  const banned = new Map();
  function isBanned(host) {
    const until = banned.get(host);
    if (!until) return false;
    if (Date.now() >= until) { banned.delete(host); return false; }
    return true;
  }
  function ban(host) {
    if (!host) return;
    banned.set(host, Date.now() + CFG.BAN_TTL);
    if (winner && winner.host === host) winner = null;
    log('%c该 CDN 播不动,暂时屏蔽 ' + host, 'color:#d9534f;font-weight:bold');
  }

  function uniqueByHost(urls) {
    const seen = new Set(), out = [];
    for (const u of urls.filter(Boolean)) {
      const h = hostOf(u);
      if (h && !seen.has(h)) { seen.add(h); out.push({ host: h, url: u }); }
    }
    return out;
  }

  // 测单个镜像速度 -> bytes/ms(越大越快),失败 -1
  function probe(url) {
    return new Promise((resolve) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CFG.TEST_TIMEOUT);
      const t0 = performance.now();
      const sep = url.includes('?') ? '&' : '?';
      fetch(url + sep + '_sp=' + t0.toFixed(0), {
        method: 'GET',
        headers: { 'Range': 'bytes=0-' + (CFG.TEST_BYTES - 1) },
        signal: ctrl.signal, cache: 'no-store',
      }).then(r => {
        // 403/404/5xx 也会正常 resolve,其错误页有长度,不判状态码就会被当成"测到速了"
        if (!r.ok) { clearTimeout(timer); ctrl.abort(); resolve(-1); return null; }
        return r.arrayBuffer();
      }).then(buf => {
        if (buf === null) return;
        clearTimeout(timer);
        const dt = performance.now() - t0;
        // 没下满说明连接被中途掐断,不算成功
        if (buf.byteLength < CFG.TEST_BYTES) { resolve(-1); return; }
        resolve(dt > 0 ? buf.byteLength / dt : -1);
      }).catch(() => { clearTimeout(timer); resolve(-1); });
    });
  }

  // 并发测所有镜像,写入 winner
  function runSpeedTest(urls) {
    if (testing) return;
    const cands = uniqueByHost(urls).filter(c => !isBanned(c.host));
    // 只有一个候选时不设 winner: 没测过就不能声称"实测最快"
    if (cands.length <= 1) return;
    testing = true;
    log('开始测速', cands.length, '个CDN镜像 ...');
    Promise.all(cands.map(c => probe(c.url).then(speed => ({ host: c.host, speed }))))
      .then(results => {
        results.sort((a, b) => b.speed - a.speed);
        const valid = results.filter(r => r.speed > 0);
        log('测速结果:\n  ' + results.map(r =>
          `${r.host} : ${r.speed > 0 ? (r.speed * 1000 / 1024 / 1024 * 8).toFixed(1) + ' Mbps' : 'FAIL'}`).join('\n  '));
        if (valid.length) {
          winner = { host: valid[0].host, ts: Date.now() };
          log('%c最快 -> ' + winner.host, 'color:#28a745;font-weight:bold');
          if (CFG.SHOW_TOAST) toast(winner.host, true, true);
        } else {
          log('%c所有镜像均测速失败,交回 B站默认顺序', 'color:#d9534f');
        }
      })
      .finally(() => { testing = false; });
  }

  // 挑最优: 实测赢家 > PREFER兜底 > 第一个。全程跳过黑名单
  function pickBest(urls) {
    let valid = urls.filter(Boolean);
    if (!valid.length) return null;
    const alive = valid.filter(u => !isBanned(hostOf(u)));
    // 全被屏蔽说明判断过头了,清空重来,别把播放器逼到无路可走
    if (!alive.length) { banned.clear(); } else { valid = alive; }
    if (CFG.MODE === 'auto' && cacheValid()) {
      const hit = valid.find(u => hostOf(u) === winner.host);
      if (hit) return hit;
    }
    for (const key of CFG.PREFER) {
      const hit = valid.find(u => hostOf(u).includes(key));
      if (hit) return hit;
    }
    return valid[0];
  }

  let lastPicked = '';

  function optimizeStream(s, sink) {
    const cands = [];
    if (s.baseUrl) cands.push(s.baseUrl);
    if (s.base_url) cands.push(s.base_url);
    if (Array.isArray(s.backupUrl)) cands.push(...s.backupUrl);
    if (Array.isArray(s.backup_url)) cands.push(...s.backup_url);
    if (!cands.length) return;
    if (sink) cands.forEach(u => sink.push(u));
    const best = pickBest(cands);
    if (!best) return;
    lastPicked = hostOf(best);
    const others = cands.filter(u => u !== best);
    if ('baseUrl' in s) s.baseUrl = best;
    if ('base_url' in s) s.base_url = best;
    if ('backupUrl' in s) s.backupUrl = others;
    if ('backup_url' in s) s.backup_url = others;
  }

  let lastPickTs = 0;

  function processData(json) {
    try {
      // 播放器刚拿到地址就回来重新要,说明上次给它的 CDN 播不动。
      // 不记这一笔,下面每一轮都会把同一个坏 CDN 重新推到首位,变成死循环重试。
      if (lastPicked && (Date.now() - lastPickTs) < CFG.RETRY_WINDOW) ban(lastPicked);
      const d = (json && (json.data || json.result)) ? (json.data || json.result) : json;
      if (!d) return json;
      const videoUrls = [];
      if (d.dash) {
        (d.dash.video || []).forEach(s => optimizeStream(s, videoUrls));
        (d.dash.audio || []).forEach(s => optimizeStream(s, null));
        if (d.dash.dolby && Array.isArray(d.dash.dolby.audio)) d.dash.dolby.audio.forEach(s => optimizeStream(s, null));
        if (d.dash.flac && d.dash.flac.audio) optimizeStream(d.dash.flac.audio, null);
      }
      if (Array.isArray(d.durl)) {
        d.durl.forEach(seg => {
          const cands = [seg.url, ...((seg.backup_url) || [])].filter(Boolean);
          if (!cands.length) return;
          cands.forEach(u => videoUrls.push(u));
          const best = pickBest(cands);
          if (!best) return;
          lastPicked = hostOf(best);
          seg.url = best;
          seg.backup_url = cands.filter(u => u !== best);
        });
      }
      if (CFG.MODE === 'auto' && !cacheValid() && videoUrls.length > 1) runSpeedTest(videoUrls);
      if (lastPicked) {
        const isWinner = cacheValid() && lastPicked === winner.host;
        lastPickTs = Date.now();
        log('本次选用 -> ' + lastPicked + (isWinner ? ' (实测最快)' : ' (兜底/测速中)'));
        if (CFG.SHOW_TOAST) toast(lastPicked, preferHit(lastPicked) || isWinner, false);
      }
    } catch (e) { console.warn('[B站CDN优选] 处理异常', e); }
    return json;
  }

  // 只认接口路径。切勿用子串匹配: 每条媒体分片地址里都带 gen=playurlv3,
  // 子串匹配会命中所有分片请求而漏掉真正的 playurl 接口。
  function isPlayurl(url) {
    if (typeof url !== 'string' || !url) return false;
    try { return /\/playurl(?:\/|$)/.test(new URL(url, location.href).pathname); }
    catch (e) { return false; }
  }

  // ---- hook fetch ----
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    const url = (typeof input === 'string') ? input : (input && input.url);
    if (isPlayurl(url)) {
      return _fetch.apply(this, arguments).then(resp =>
        resp.clone().json().then(json => {
          processData(json);
          return new Response(JSON.stringify(json), { status: resp.status, statusText: resp.statusText, headers: resp.headers });
        }).catch(() => resp)
      );
    }
    return _fetch.apply(this, arguments);
  };

  // ---- hook XHR (惰性getter) ----
  const proto = XMLHttpRequest.prototype;
  const rtDesc = Object.getOwnPropertyDescriptor(proto, 'responseText');
  const rDesc = Object.getOwnPropertyDescriptor(proto, 'response');
  const _open = proto.open;
  function transform(raw) {
    if (typeof raw !== 'string' || !raw) return raw;
    try { const j = JSON.parse(raw); processData(j); return JSON.stringify(j); } catch (e) { return raw; }
  }
  proto.open = function (method, url) {
    if (isPlayurl(url)) {
      Object.defineProperty(this, 'responseText', { configurable: true, get() { return transform(rtDesc.get.call(this)); } });
      Object.defineProperty(this, 'response', { configurable: true, get() { const raw = rDesc.get.call(this); return (typeof raw === 'string') ? transform(raw) : raw; } });
    }
    return _open.apply(this, arguments);
  };

  // ---- 拦截 window.__playinfo__ ----
  // 首个视频的播放地址是 B站直接内联在页面 HTML 里的,根本不走 fetch/XHR。
  // 只钩 fetch/XHR 的话,打开一个视频页时这个脚本实际上什么都没做。
  var _playinfo;
  try {
    Object.defineProperty(window, '__playinfo__', {
      configurable: true,
      enumerable: true,
      get: function () { return _playinfo; },
      set: function (v) {
        try { if (v) processData(v); } catch (e) { console.warn('[B站CDN优选] __playinfo__ 处理异常', e); }
        _playinfo = v;
      },
    });
  } catch (e) { console.warn('[B站CDN优选] 无法拦截 __playinfo__', e); }

  // ---- 角标提示 ----
  let toastEl = null, toastTimer = null;
  function toast(host, ok, isTestResult) {
    try {
      if (!document.body) { document.addEventListener('DOMContentLoaded', () => toast(host, ok, isTestResult)); return; }
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;' +
          'background:rgba(0,161,214,.95);color:#fff;padding:8px 14px;border-radius:8px;' +
          'font-size:12px;font-family:sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.3);' +
          'transition:opacity .4s;pointer-events:none;max-width:340px;line-height:1.5';
        document.body.appendChild(toastEl);
      }
      const prefix = isTestResult ? '🏆 实测最快CDN: ' : (ok ? '✅ CDN已优选: ' : '⚠️ 用兜底CDN: ');
      toastEl.textContent = prefix + host;
      toastEl.style.background = ok ? 'rgba(40,167,69,.95)' : 'rgba(0,161,214,.95)';
      toastEl.style.opacity = '1';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { if (toastEl) toastEl.style.opacity = '0'; }, 4500);
    } catch (e) {}
  }

  log('已加载 v2.1 · 模式: ' + CFG.MODE + ' · 兜底优先: ' + CFG.PREFER.join(', '));
})();
