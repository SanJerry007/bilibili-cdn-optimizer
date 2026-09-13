// ==UserScript==
// @name         B站CDN优选 (海外就近 · 实测择优)
// @name:en      Bilibili CDN Optimizer (auto speed-test)
// @namespace    https://github.com/SanJerry007
// @version      3.0
// @description  海外看B站不卡:实测每个CDN镜像的持续吞吐,选最快的用,结果跨页面保存并在下次打开视频时立刻生效。不伪造地址、不需VPN。
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
    // 兜底优先域(没有实测结果时用,按顺序): akamaized.net = 全球就近的Akamai
    PREFER: ['akamaized.net'],

    // --- 测速窗口 ---
    // 前这么多字节(或前这么多毫秒,谁先到算谁)丢掉不计:那一段是 DNS/TCP/TLS 握手加 TCP 慢启动,
    // 量的是 RTT 不是带宽。v2 整个测速只下 256KB,全落在这一段里,所以它测的一直是延迟。
    WARMUP_BYTES: 262144,
    WARMUP_MS: 500,
    // 丢掉热身之后,真正计入速度的测量窗口(ms)
    MEASURE_MS: 1200,
    // 单个镜像最多拉这么多字节就收手(防止在快线路上白下一大堆)
    MAX_BYTES: 8 * 1024 * 1024,
    // 单个镜像整体超时(ms)
    TEST_TIMEOUT: 8000,

    // 实测结果缓存时长(ms)。跨页面保存,期间不重测
    CACHE_TTL: 10 * 60 * 1000,
    // 赢家要比兜底快这么多倍才值得换(避免在噪声上来回横跳)
    MIN_GAIN: 1.25,
    // 测速硬失败(403/CORS/超时)的镜像,暂时不再选中的时长(ms)
    BAN_TTL: 5 * 60 * 1000,
    // 角标提示(用熟后可改 false)
    SHOW_TOAST: true,
  };
  // ================================================

  const STORE_KEY = 'bcdn:winner:v3';
  const LOG_S = 'color:#00a1d6;font-weight:bold';
  function log(...a) { console.log('%c[B站CDN优选]%c', LOG_S, 'color:inherit', ...a); }
  function hostOf(u) { try { return new URL(u, location.href).host; } catch (e) { return ''; } }
  function preferHit(host) { return CFG.PREFER.some(k => host.includes(k)); }
  function mbps(kbps) { return (kbps / 1000).toFixed(1) + ' Mbps'; }

  // ---- 实测赢家: { host, kbps, ts }。必须跨页面保存 ----
  // v2 把它放在闭包变量里,而它是随 document 一起销毁的。于是每打开一个视频页赢家都是 null,
  // 选源永远落到 PREFER 兜底,测速结果一次都没被用上过。存起来,下次打开视频才用得着。
  let winner = loadWinner();
  let testing = false;

  function loadWinner() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const w = JSON.parse(raw);
      if (!w || !w.host || !w.ts) return null;
      if (Date.now() - w.ts >= CFG.CACHE_TTL) return null;
      return w;
    } catch (e) { return null; }
  }
  function saveWinner(w) {
    winner = w;
    try {
      if (w) localStorage.setItem(STORE_KEY, JSON.stringify(w));
      else localStorage.removeItem(STORE_KEY);
    } catch (e) { /* 隐私模式下写不进去,只是失去跨页面能力,不影响本页 */ }
  }
  function cacheValid() { return winner && (Date.now() - winner.ts) < CFG.CACHE_TTL; }

  // ---- 黑名单: 只关"实测硬失败"的镜像 ----
  // v2 的判据是"15 秒内又来了一次 playurl 就说明上一个 CDN 播不动",但正常播放本来就会二次请求
  // (内联 __playinfo__ 之后播放器自己再要一次、切清晰度、分P、站内跳转),所以它在健康播放时就会
  // 把刚选中的好节点拉黑 5 分钟。这个判据没有区分力,整个删掉,只保留有证据的那种失败。
  const banned = new Map();
  function isBanned(host) {
    const until = banned.get(host);
    if (!until) return false;
    if (Date.now() >= until) { banned.delete(host); return false; }
    return true;
  }
  function ban(host, why) {
    if (!host) return;
    banned.set(host, Date.now() + CFG.BAN_TTL);
    if (winner && winner.host === host) saveWinner(null);
    log('%c暂时屏蔽 ' + host + ' (' + why + ')', 'color:#d9534f;font-weight:bold');
  }

  function uniqueByHost(urls) {
    const seen = new Set(), out = [];
    for (const u of urls.filter(Boolean)) {
      const h = hostOf(u);
      if (h && !seen.has(h)) { seen.add(h); out.push({ host: h, url: u }); }
    }
    return out;
  }

  // 测单个镜像的持续吞吐 -> kbps(越大越快),失败 -1
  //
  // 跟 v2 的三处不同,每一处都是它测不准的原因:
  //   1. 不发 Range 头。Range 不在 CORS 安全列表里,会多一次 OPTIONS 预检;而且"没下满就算失败"
  //      会把正常响应误判成 FAIL。直接 GET,读够了就 abort。
  //   2. 不再往地址后面拼 _sp= 时间戳。那个参数会打穿 CDN 边缘缓存,让测速走一条回源路径,
  //      而播放器走的是缓存路径,测的根本不是同一条路。
  //   3. 计时从热身结束才开始,不从 t0 开始。
  function probe(url) {
    return new Promise((resolve) => {
      const ctrl = new AbortController();
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        try { ctrl.abort(); } catch (e) {}
        resolve(v);
      };
      const timer = setTimeout(() => finish(-1), CFG.TEST_TIMEOUT);

      fetch(url, { method: 'GET', signal: ctrl.signal, cache: 'no-store' }).then((r) => {
        if (!r.ok) { clearTimeout(timer); finish(-1); return; }
        // 没有 ReadableStream 就没法边下边计时,这种环境直接放弃测速走兜底,别给一个假数
        if (!r.body || !r.body.getReader) { clearTimeout(timer); finish(-1); return; }
        const reader = r.body.getReader();
        const t0 = performance.now();
        let total = 0, mBytes = 0, mStart = 0;

        const pump = () => reader.read().then(({ done: fin, value }) => {
          const now = performance.now();
          if (!fin && value) {
            total += value.length;
            if (!mStart) {
              // 还在热身段: 攒够字节或到时间就开表,这一块本身不计入
              if (total >= CFG.WARMUP_BYTES || (now - t0) >= CFG.WARMUP_MS) mStart = now;
            } else {
              mBytes += value.length;
            }
          }
          const enough = mStart && ((now - mStart) >= CFG.MEASURE_MS || total >= CFG.MAX_BYTES);
          if (fin || enough) {
            clearTimeout(timer);
            const dt = mStart ? (performance.now() - mStart) : 0;
            // 整个文件还没热身完就结束了,这一次没有可信的吞吐读数
            if (!mStart || dt <= 0 || mBytes <= 0) { finish(-1); return; }
            finish(mBytes * 8 / dt); // bytes*8/ms = kbit/s
            return;
          }
          return pump();
        });

        pump().catch(() => { clearTimeout(timer); finish(-1); });
      }).catch(() => { clearTimeout(timer); finish(-1); });
    });
  }

  // 依次测所有镜像,写入 winner。
  // 必须串行: 并发测速时几个镜像抢的是同一条出口带宽,每个都只量到一部分,既比不出高下,
  // 又跟播放器自己的缓冲抢带宽。
  async function runSpeedTest(urls) {
    if (testing) return;
    const cands = uniqueByHost(urls).filter(c => !isBanned(c.host));
    if (cands.length <= 1) {
      log('只有 ' + cands.length + ' 个可用镜像,无从比较,跳过测速');
      return;
    }
    testing = true;
    log('开始依次测速', cands.length, '个CDN镜像 ...');
    try {
      const results = [];
      for (const c of cands) {
        const kbps = await probe(c.url);
        results.push({ host: c.host, kbps });
        if (kbps < 0) ban(c.host, '测速失败');
      }
      results.sort((a, b) => b.kbps - a.kbps);
      log('测速结果(持续吞吐):\n  ' + results.map(r =>
        `${r.host} : ${r.kbps > 0 ? mbps(r.kbps) : 'FAIL'}`).join('\n  '));

      const valid = results.filter(r => r.kbps > 0);
      if (!valid.length) {
        log('%c所有镜像均测速失败,交回 B站默认顺序', 'color:#d9534f');
        return;
      }
      const top = valid[0];
      // 赢家就是当前在用的那个,只是刷新时间戳,不必吵
      const cur = lastPicked;
      const curRow = valid.find(r => r.host === cur);
      if (curRow && top.host !== cur && top.kbps < curRow.kbps * CFG.MIN_GAIN) {
        log('最快的 ' + top.host + ' 没有明显快过在用的 ' + cur + ',不换');
        saveWinner({ host: cur, kbps: curRow.kbps, ts: Date.now() });
        return;
      }
      saveWinner({ host: top.host, kbps: top.kbps, ts: Date.now() });
      log('%c最快 -> ' + top.host + ' (' + mbps(top.kbps) + ')', 'color:#28a745;font-weight:bold');
      applyWinner();
    } finally {
      testing = false;
    }
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

  // 本次真正交给播放器的视频源 host。只由视频流写,不能被音频流覆盖:
  // v2 在 dash.video 之后还处理 audio/dolby/flac,每个都写一遍 lastPicked,
  // 于是角标和日志报的是最后那条音频流的 host,不是视频的。
  let lastPicked = '';

  // 已经改写过的流对象。测速比选源晚几秒才出结果,而 v2 拿到结果只存了个变量,
  // 没有任何一行回头去改地址,所以那句"🏆 实测最快"说的是测速排名,不是播放器实际在用的源。
  // 留住对象引用,结果出来再改一次:播放器读 __playinfo__ 通常晚于 document-start,能吃到。
  let liveStreams = [];

  function applyStream(s, cands) {
    const best = pickBest(cands);
    if (!best) return '';
    const others = cands.filter(u => u !== best);
    if ('baseUrl' in s) s.baseUrl = best;
    if ('base_url' in s) s.base_url = best;
    if ('backupUrl' in s) s.backupUrl = others;
    if ('backup_url' in s) s.backup_url = others;
    return hostOf(best);
  }

  function optimizeStream(s, sink, isVideo) {
    const cands = [];
    if (s.baseUrl) cands.push(s.baseUrl);
    if (s.base_url) cands.push(s.base_url);
    if (Array.isArray(s.backupUrl)) cands.push(...s.backupUrl);
    if (Array.isArray(s.backup_url)) cands.push(...s.backup_url);
    if (!cands.length) return;
    if (sink) cands.forEach(u => sink.push(u));
    liveStreams.push({ s, cands });
    const host = applyStream(s, cands);
    if (isVideo && host) lastPicked = host;
  }

  // 测速结果出来之后,把之前改过的那批流按新赢家再改一次
  function applyWinner() {
    if (!liveStreams.length) return;
    let changed = '';
    for (const it of liveStreams) {
      const host = applyStream(it.s, it.cands);
      if (host) changed = host;
    }
    if (changed && changed !== lastPicked) {
      log('%c已把播放地址改写为 ' + changed, 'color:#28a745;font-weight:bold');
      lastPicked = changed;
    }
    announce();
  }

  // 角标只说一件事: 播放器现在拿到的是哪个 host。测速排名单独进控制台,不冒充选源结果。
  function announce() {
    if (!CFG.SHOW_TOAST || !lastPicked) return;
    const measured = cacheValid() && winner.host === lastPicked;
    const label = measured
      ? '🏆 实测最快CDN: ' + lastPicked + ' (' + mbps(winner.kbps) + ')'
      : (preferHit(lastPicked) ? '✅ CDN已优选: ' + lastPicked : '⚠️ 用兜底CDN: ' + lastPicked);
    toast(label, measured || preferHit(lastPicked));
  }

  function processData(json) {
    try {
      const d = (json && (json.data || json.result)) ? (json.data || json.result) : json;
      if (!d) return json;
      liveStreams = [];
      lastPicked = '';
      const videoUrls = [];
      if (d.dash) {
        (d.dash.video || []).forEach(s => optimizeStream(s, videoUrls, true));
        (d.dash.audio || []).forEach(s => optimizeStream(s, null, false));
        if (d.dash.dolby && Array.isArray(d.dash.dolby.audio)) d.dash.dolby.audio.forEach(s => optimizeStream(s, null, false));
        if (d.dash.flac && d.dash.flac.audio) optimizeStream(d.dash.flac.audio, null, false);
      }
      if (Array.isArray(d.durl)) {
        d.durl.forEach(seg => {
          const cands = [seg.url, ...((seg.backup_url) || [])].filter(Boolean);
          if (!cands.length) return;
          cands.forEach(u => videoUrls.push(u));
          const wrap = {
            get base_url() { return seg.url; }, set base_url(v) { seg.url = v; },
            get backup_url() { return seg.backup_url; }, set backup_url(v) { seg.backup_url = v; },
          };
          liveStreams.push({ s: wrap, cands });
          const host = applyStream(wrap, cands);
          if (host) lastPicked = host;
        });
      }
      if (lastPicked) {
        const measured = cacheValid() && lastPicked === winner.host;
        log('本次选用 -> ' + lastPicked + (measured ? ' (实测最快 ' + mbps(winner.kbps) + ')' : ' (兜底,尚无实测结果)'));
        announce();
      }
      if (CFG.MODE === 'auto' && !cacheValid() && videoUrls.length > 1) runSpeedTest(videoUrls);
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
          const body = JSON.stringify(json);
          // 改写后长度变了,原样带走 content-length / content-encoding 会和新 body 对不上
          const headers = new Headers(resp.headers);
          headers.delete('content-length');
          headers.delete('content-encoding');
          return new Response(body, { status: resp.status, statusText: resp.statusText, headers });
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

  // 每读一次 responseText/response 就重跑一遍 processData,是 v2 的一个自伤:
  // 同一份响应被读第二次时,选源和角标会整个重来一遍。按原始字符串记一次结果,读多少次都只算一次。
  function transformCached(xhr, raw) {
    if (typeof raw !== 'string' || !raw) return raw;
    if (xhr.__bcdnRaw === raw) return xhr.__bcdnOut;
    let out = raw;
    try { const j = JSON.parse(raw); processData(j); out = JSON.stringify(j); } catch (e) { out = raw; }
    xhr.__bcdnRaw = raw;
    xhr.__bcdnOut = out;
    return out;
  }

  proto.open = function (method, url) {
    if (isPlayurl(url)) {
      Object.defineProperty(this, 'responseText', {
        configurable: true,
        get() { return transformCached(this, rtDesc.get.call(this)); },
      });
      Object.defineProperty(this, 'response', {
        configurable: true,
        get() {
          const raw = rDesc.get.call(this);
          // responseType='json' 时 response 已经是对象,拿不到字符串,直接就地处理
          if (raw && typeof raw === 'object') {
            if (!this.__bcdnObjDone) { this.__bcdnObjDone = true; try { processData(raw); } catch (e) {} }
            return raw;
          }
          return transformCached(this, raw);
        },
      });
    }
    return _open.apply(this, arguments);
  };

  // ---- 拦截 window.__playinfo__ ----
  // 首个视频的播放地址是 B站直接内联在页面 HTML 里的,根本不走 fetch/XHR。
  // 只钩 fetch/XHR 的话,打开一个视频页时这个脚本实际上什么都没做。
  var _playinfo = window.__playinfo__;
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
    // 极少数情况下页面在脚本之前就赋过值了,补处理一次,别把首个视频漏掉
    if (_playinfo) { try { processData(_playinfo); } catch (e) {} }
  } catch (e) { console.warn('[B站CDN优选] 无法拦截 __playinfo__', e); }

  // ---- 角标提示 ----
  let toastEl = null, toastTimer = null;
  function toast(text, ok) {
    try {
      if (!document.body) { document.addEventListener('DOMContentLoaded', () => toast(text, ok)); return; }
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;' +
          'background:rgba(0,161,214,.95);color:#fff;padding:8px 14px;border-radius:8px;' +
          'font-size:12px;font-family:sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.3);' +
          'transition:opacity .4s;pointer-events:none;max-width:340px;line-height:1.5';
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = text;
      toastEl.style.background = ok ? 'rgba(40,167,69,.95)' : 'rgba(0,161,214,.95)';
      toastEl.style.opacity = '1';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { if (toastEl) toastEl.style.opacity = '0'; }, 4500);
    } catch (e) {}
  }

  log('已加载 v3.0 · 模式: ' + CFG.MODE + ' · 兜底优先: ' + CFG.PREFER.join(', ') +
    (cacheValid() ? ' · 沿用上次实测赢家: ' + winner.host + ' (' + mbps(winner.kbps) + ')' : ' · 暂无实测结果'));
})();
