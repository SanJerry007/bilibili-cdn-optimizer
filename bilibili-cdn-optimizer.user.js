// ==UserScript==
// @name         B站CDN优选 (海外就近 · 实测择优)
// @name:en      Bilibili CDN Optimizer (auto speed-test)
// @namespace    https://github.com/SanJerry007
// @version      3.2
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
    // 丢掉热身之后,真正计入速度的测量窗口(ms)。
    // 注意它和 MAX_BYTES 是「谁先到算谁」,而在快线路上先到的总是 MAX_BYTES:
    // 4MB 上限意味着 MEASURE_MS 只在约 26 Mbps 以下才真正生效,200 Mbps 时窗口其实只有约 150ms。
    // 这是刻意的取舍(不愿为了凑满 1.2 秒去下几十 MB),但别把 MEASURE_MS 当成实际窗口长度。
    MEASURE_MS: 1200,
    // 单个镜像最多拉这么多字节就收手。快线路上真正决定窗口长度的是这一条
    MAX_BYTES: 4 * 1024 * 1024,
    // 一轮最多测这么多个镜像(候选更多时只测前几个,并在控制台写明丢掉了谁)
    MAX_MIRRORS: 3,
    // 单个镜像整体超时(ms)
    TEST_TIMEOUT: 8000,
    // 两轮测速之间的最小间隔(ms)。没有它的话,「所有镜像都失败」会和 pickBest 里的
    // banned.clear() 组成一个死循环: 清空黑名单 -> 重测 -> 全失败 -> 再清空,每个载荷来一遍。
    TEST_COOLDOWN: 60 * 1000,

    // --- 什么时候开测 ---
    // 绝对不能在 document-start 就开测。实测同一个 akamai 镜像: 页面加载中测出 5.8 Mbps,
    // 视频暂停且缓冲满之后再测是 195 到 281 Mbps,差四十倍。测速和播放器的首屏缓冲抢的是
    // 同一条管子,开在那一刻既量不准,又恰好在最需要带宽的几秒里把带宽抢走。
    // 所以: 等播放器自己缓冲够了再测。赢家反正是跨页面保存的,晚一点测不影响下个视频。
    TEST_DELAY_MS: 2000,        // 最早也要等这么久才开始查缓冲
    TEST_BUFFER_AHEAD_S: 10,    // 缓冲领先播放位置这么多秒,就认为播放器吃饱了
    TEST_DEFER_MAX_MS: 45000,   // 等不到就别等了,免得永远不测

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
      if (!w || typeof w.host !== 'string' || !w.host) return null;
      // kbps 缺了会让角标显示 "NaN Mbps";ts 是未来时间会把赢家永久钉死
      if (typeof w.kbps !== 'number' || !(w.kbps > 0)) return null;
      if (typeof w.ts !== 'number' || w.ts > Date.now() + 60000) return null;
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

  // 测单个镜像的持续吞吐。返回值三态,调用方必须区分:
  //    >0  实测 kbps
  //    -1  硬失败(非 2xx、CORS 被拒、超时、连接断) -> 这个镜像真的有问题,可以拉黑
  //     0  测不出来(文件在热身结束前就读完了、环境没有 ReadableStream) -> 没有证据,不许拉黑
  // v2 把这两类都返回 -1,于是一段很短的片源会让每个健康镜像都被拉黑 5 分钟。
  //
  // 跟 v2 的三处不同,每一处都是它测不准的原因:
  //   1. 不发 Range 头。Range 不在 CORS 安全列表里,会多一次 OPTIONS 预检;而且"没下满就算失败"
  //      会把正常响应误判成 FAIL。直接 GET,读够了就 abort。
  //   2. 不再往地址后面拼 _sp= 时间戳。那个参数让每次测速都是一个 CDN 没见过的 URL,必然回源,
  //      而播放器走的是边缘缓存,测的根本不是同一条路。(仍然保留 cache:'no-store',那是为了
  //      绕开浏览器本地磁盘缓存 —— 播放器可能已经下过这个文件的一段,读本地缓存会量出一个
  //      荒唐的大数。它作用于本地缓存,和 URL 层的缓存穿透不是一回事。)
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
        // 没有 ReadableStream 就没法边下边计时。这是环境限制不是镜像的问题,记 0 不记失败
        if (!r.body || !r.body.getReader) { clearTimeout(timer); finish(0); return; }
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
            // 整个文件还没热身完就结束了,这一次没有可信的吞吐读数。不是镜像的错,记 0
            if (!mStart || dt <= 0 || mBytes <= 0) { finish(0); return; }
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
  let lastTestTs = 0;
  let deferPending = false;

  // 等播放器吃饱了再测。判据是 video 元素的缓冲领先量,不是固定睡一觉:
  // 4K 和 360P 填满缓冲要的时间差着数量级,写死一个秒数必然对一头不对另一头。
  function whenPlayerSettled(run) {
    if (deferPending) return;
    deferPending = true;
    const t0 = Date.now();
    const tick = () => {
      let ahead = -1;
      try {
        const v = document.querySelector('video');
        if (v && v.buffered && v.buffered.length) ahead = v.buffered.end(v.buffered.length - 1) - v.currentTime;
      } catch (e) { /* 没有 video 元素就只靠下面的上限兜底 */ }
      if (ahead >= CFG.TEST_BUFFER_AHEAD_S) {
        deferPending = false;
        log('播放器已缓冲 ' + ahead.toFixed(1) + ' 秒,现在测速');
        run();
        return;
      }
      if (Date.now() - t0 >= CFG.TEST_DEFER_MAX_MS) {
        deferPending = false;
        log('等了 ' + Math.round((Date.now() - t0) / 1000) + ' 秒仍未缓冲到位(当前领先 ' +
          (ahead < 0 ? '未知' : ahead.toFixed(1) + ' 秒') + '),不再等,开始测速');
        run();
        return;
      }
      setTimeout(tick, 1000);
    };
    setTimeout(tick, CFG.TEST_DELAY_MS);
  }

  async function runSpeedTest(urls) {
    if (testing) return;
    // 冷却。没有它的话「全部镜像测速失败」会无限重测: 见 CFG.TEST_COOLDOWN 的注释
    const since = Date.now() - lastTestTs;
    if (lastTestTs && since < CFG.TEST_COOLDOWN) {
      log('距上次测速仅 ' + Math.round(since / 1000) + ' 秒,冷却中,跳过');
      return;
    }
    let cands = uniqueByHost(urls).filter(c => !isBanned(c.host));
    if (cands.length <= 1) {
      log('只有 ' + cands.length + ' 个可用镜像,无从比较,跳过测速');
      return;
    }
    // 上限要说出丢了谁。悄悄截断的话,日志读起来跟"全测过了"一模一样
    if (cands.length > CFG.MAX_MIRRORS) {
      const dropped = cands.slice(CFG.MAX_MIRRORS).map(c => c.host);
      log('候选 ' + cands.length + ' 个,只测前 ' + CFG.MAX_MIRRORS + ' 个,本轮不测: ' + dropped.join(', '));
      cands = cands.slice(0, CFG.MAX_MIRRORS);
    }
    testing = true;
    lastTestTs = Date.now();
    log('开始依次测速', cands.length, '个CDN镜像 ...');
    try {
      const results = [];
      for (const c of cands) {
        const kbps = await probe(c.url);
        results.push({ host: c.host, kbps });
        // 只有硬失败才拉黑。kbps === 0 是"这次测不出来",没有证据说明镜像有问题
        if (kbps < 0) ban(c.host, '测速硬失败');
      }
      results.sort((a, b) => b.kbps - a.kbps);
      log('测速结果(持续吞吐):\n  ' + results.map(r =>
        `${r.host} : ${r.kbps > 0 ? mbps(r.kbps) : (r.kbps === 0 ? '测不出(文件太短)' : 'FAIL')}`).join('\n  '));

      const valid = results.filter(r => r.kbps > 0);
      if (!valid.length) {
        log('%c没有一个镜像给出可用读数,交回 B站默认顺序', 'color:#d9534f');
        return;
      }
      const top = valid[0];
      // 在用的那个也测出数了,而且新冠军没有明显更快,就别换,免得在噪声上来回横跳
      const curRow = lastPicked ? valid.find(r => r.host === lastPicked) : null;
      if (curRow && top.host !== curRow.host && top.kbps < curRow.kbps * CFG.MIN_GAIN) {
        log('最快的 ' + top.host + ' (' + mbps(top.kbps) + ') 没有明显快过在用的 ' +
          curRow.host + ' (' + mbps(curRow.kbps) + '),不换');
        saveWinner({ host: curRow.host, kbps: curRow.kbps, ts: Date.now() });
        announce();
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
  // 这批流对象播放器还会不会再读一次。只有内联 __playinfo__ 是 true,见 applyWinner
  let liveReachable = false;

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
    liveStreams.push({ s, cands, isVideo });
    const host = applyStream(s, cands);
    if (isVideo && host) lastPicked = host;
  }

  // 测速结果出来之后,把之前改过的那批流按新赢家再改一次。
  //
  // 只有 __playinfo__ 这条路改得动。fetch 和 XHR 两条路在 processData 返回之后立刻把对象
  // JSON.stringify 成了字符串交给播放器,之后再改那个对象,播放器一个字都看不见。
  // 所以这里必须按 liveReachable 分开处理,不能一律打印"已改写"——那就是 v2 那个
  // "只报告自己的意图、从不报告实际结果"的毛病换个地方再犯一次。
  function applyWinner() {
    if (!liveStreams.length) return;
    if (!liveReachable) {
      log('测速结果已保存。本次播放地址已经交给播放器、改不动了,从下一个视频起生效');
      return;
    }
    let videoHost = '';
    for (const it of liveStreams) {
      const host = applyStream(it.s, it.cands);
      // 只认视频流。v2 的角标报成音频流 host 就是因为这里让最后一个流说了算
      if (it.isVideo && host) videoHost = host;
    }
    if (videoHost && videoHost !== lastPicked) {
      log('%c已改写播放地址对象 -> ' + videoHost +
        ' (播放器若已取走,则从下个视频起生效)', 'color:#28a745;font-weight:bold');
      lastPicked = videoHost;
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

  function processData(json, reachable) {
    try {
      const d = (json && (json.data || json.result)) ? (json.data || json.result) : json;
      // 错误响应(data 为 null)不该把上一份还能改写的引用清掉
      if (!d) return json;
      liveStreams = [];
      liveReachable = !!reachable;
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
          liveStreams.push({ s: wrap, cands, isVideo: true });
          const host = applyStream(wrap, cands);
          if (host) lastPicked = host;
        });
      }
      if (lastPicked) {
        const measured = cacheValid() && lastPicked === winner.host;
        log('本次选用 -> ' + lastPicked + (measured ? ' (实测最快 ' + mbps(winner.kbps) + ')' : ' (兜底,尚无实测结果)'));
        announce();
      }
      // 缓存里的赢家不在这个视频给出的镜像里,等于没有结论,照样要测。
      // 只看 cacheValid() 的话,一个存着别处赢家的缓存会把测速压制整整 10 分钟。
      const winnerUsable = cacheValid() && videoUrls.some(u => hostOf(u) === winner.host);
      if (CFG.MODE === 'auto' && !winnerUsable && videoUrls.length > 1) {
        // 注意是 whenPlayerSettled 而不是直接跑,理由见 CFG.TEST_DELAY_MS 那段
        whenPlayerSettled(() => runSpeedTest(videoUrls));
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
          // reachable=false: 下一行就把它序列化成字符串了,之后再改这个对象播放器看不见
          processData(json, false);
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
    // reachable=false: 下面立刻序列化,之后改这个对象播放器看不见
    try { const j = JSON.parse(raw); processData(j, false); out = JSON.stringify(j); } catch (e) { out = raw; }
    xhr.__bcdnRaw = raw;
    xhr.__bcdnOut = out;
    return out;
  }

  // 原型上的 responseText/response 描述符拿不到就整个不挂钩。
  // 别的脚本(Bilibili-Evolved 之类)可能已经把 XMLHttpRequest 换成了子类,那时这两个描述符是
  // undefined,再往下走就会在每次读属性时抛 TypeError,把播放整个打死。README 承诺了兼容,
  // 那就必须真的兼容,而不是"通常没事"。
  const canHookXhr = !!(rtDesc && rtDesc.get && rDesc && rDesc.get);
  if (!canHookXhr) log('%c未能挂钩 XMLHttpRequest(原型描述符不可用),仅 fetch 与 __playinfo__ 生效', 'color:#d9534f');

  proto.open = function (method, url) {
    if (canHookXhr) {
      // 同一个 XHR 对象是可以复用的: open() 一次 playurl、再 open() 一次别的接口。
      // 实例 getter 不摘掉的话,后面那个毫不相干的响应也会被 JSON.parse + stringify 转一圈,
      // 而 B站的 aid/mid 是超出 double 精度的大整数,转一圈就被改值了。
      try { delete this.responseText; } catch (e) {}
      try { delete this.response; } catch (e) {}
      this.__bcdnRaw = undefined;
      this.__bcdnOut = undefined;
      this.__bcdnObjDone = false;

      if (isPlayurl(url)) {
        Object.defineProperty(this, 'responseText', {
          configurable: true,
          get() { return transformCached(this, rtDesc.get.call(this)); },
        });
        Object.defineProperty(this, 'response', {
          configurable: true,
          get() {
            const raw = rDesc.get.call(this);
            // responseType='json' 时 response 已经是对象。这里交回去的就是那个活对象,
            // 播放器之后再读还是同一个,所以 reachable=true
            if (raw && typeof raw === 'object') {
              if (!this.__bcdnObjDone) { this.__bcdnObjDone = true; try { processData(raw, true); } catch (e) {} }
              return raw;
            }
            return transformCached(this, raw);
          },
        });
      }
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
        // reachable=true: 交回去的是同一个活对象,测速结果出来还能改得动
        try { if (v) processData(v, true); } catch (e) { console.warn('[B站CDN优选] __playinfo__ 处理异常', e); }
        _playinfo = v;
      },
    });
    // 极少数情况下页面在脚本之前就赋过值了,补处理一次,别把首个视频漏掉
    if (_playinfo) { try { processData(_playinfo, true); } catch (e) {} }
  } catch (e) {
    console.warn('[B站CDN优选] 无法拦截 __playinfo__', e);
    // 拦不住不代表改不了。已经在那儿的那份照样能就地改写,别连它一起放弃
    if (_playinfo) { try { processData(_playinfo, true); } catch (e2) {} }
  }

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

  log('已加载 v3.2 · 模式: ' + CFG.MODE + ' · 兜底优先: ' + CFG.PREFER.join(', ') +
    (cacheValid() ? ' · 沿用上次实测赢家: ' + winner.host + ' (' + mbps(winner.kbps) + ')' : ' · 暂无实测结果'));
})();
