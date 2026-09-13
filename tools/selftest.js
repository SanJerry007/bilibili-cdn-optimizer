// Headless harness for bilibili-cdn-optimizer.
// Every assertion here is written so that the OLD (v2) behaviour fails it.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC = process.argv[2] || path.join(__dirname, '..', 'bilibili-cdn-optimizer.user.js');
const code = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  <- ' + detail : '')); }
}

// ---- a virtual clock so throughput maths is deterministic ----
let vclock = 0;

function makeStore() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    _dump: () => Object.fromEntries(m),
  };
}

// chunks: [{bytes, dtMs}, ...] repeated until the reader is cancelled
function makeBody(chunks) {
  let i = 0;
  return {
    getReader() {
      return {
        read() {
          const c = chunks[Math.min(i, chunks.length - 1)];
          i++;
          if (i > 400) return Promise.resolve({ done: true, value: undefined });
          vclock += c.dtMs;
          return Promise.resolve({ done: false, value: new Uint8Array(c.bytes) });
        },
        cancel() { return Promise.resolve(); },
      };
    },
  };
}

function newCtx(store, profiles) {
  const logs = [];
  const ctx = {
    console: { log: (...a) => logs.push(a.map(String).join(' ')), warn: () => {}, error: () => {} },
    location: { href: 'https://www.bilibili.com/video/BV1xx411c7mD/' },
    localStorage: store,
    performance: { now: () => vclock },
    setTimeout, clearTimeout, Promise, URL, Headers, Response, AbortController, Uint8Array, Date, Math, JSON, Set, Map, Array, Object, String, Number,
    document: {
      body: null,
      addEventListener() {},
      createElement: () => ({ style: { cssText: '' }, textContent: '' }),
    },
    fetchCalls: [],
    __logs: logs,
  };
  ctx.fetch = function (url) {
    ctx.fetchCalls.push(url);
    const host = new URL(url).host;
    const p = profiles[host];
    if (!p) return Promise.resolve({ ok: false });
    if (p === 'fail') return Promise.reject(new Error('net'));
    return Promise.resolve({ ok: true, body: makeBody(p) });
  };
  // a minimal XHR whose responseText/response live on the prototype, like the real one
  function XHR() { this.__raw = ''; }
  Object.defineProperty(XHR.prototype, 'responseText', { configurable: true, get() { return this.__raw; } });
  Object.defineProperty(XHR.prototype, 'response', { configurable: true, get() { return this.__raw; } });
  XHR.prototype.open = function () {};
  ctx.XMLHttpRequest = XHR;
  vm.createContext(ctx);
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.runInContext(code, ctx, { filename: 'userscript.js' });
  return ctx;
}

const HOST_FAST = 'upos-fast.example.net';
const HOST_PREFER = 'upos-hz-mirrorakam.akamaized.net';

function payload() {
  return {
    code: 0,
    data: {
      dash: {
        video: [{
          baseUrl: `https://${HOST_PREFER}/v.m4s?x=1`,
          backupUrl: [`https://${HOST_FAST}/v.m4s?x=1`],
        }],
        audio: [{
          baseUrl: `https://${HOST_PREFER}/a.m4s?x=1`,
          backupUrl: [`https://${HOST_FAST}/a.m4s?x=1`],
        }],
      },
    },
  };
}

const KB = 1024;
// bursts 256KB instantly, then crawls at 64KB/100ms (= 5.24 Mbps sustained)
const BURST_THEN_CRAWL = [
  { bytes: 64 * KB, dtMs: 0.25 }, { bytes: 64 * KB, dtMs: 0.25 },
  { bytes: 64 * KB, dtMs: 0.25 }, { bytes: 64 * KB, dtMs: 0.25 },
  { bytes: 64 * KB, dtMs: 100 },
];
// uniformly fast: 64KB per 0.5ms  (= ~1000 Mbps)
const UNIFORM_FAST = [{ bytes: 64 * KB, dtMs: 0.5 }];

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('\n== T1: the probe must measure SUSTAINED throughput, not the opening burst ==');
  {
    vclock = 0;
    const store = makeStore();
    const ctx = newCtx(store, { [HOST_PREFER]: BURST_THEN_CRAWL, [HOST_FAST]: UNIFORM_FAST });
    const p = payload();
    ctx.window.__playinfo__ = p;
    await sleep(400);
    const line = ctx.__logs.find(l => l.includes('测速结果'));
    ok('speed test ran', !!line, ctx.__logs.join(' | ').slice(0, 300));
    if (line) {
      const m = [...line.matchAll(/([\w.-]+) : ([\d.]+) Mbps/g)].reduce((a, x) => (a[x[1]] = parseFloat(x[2]), a), {});
      // v2 measured only the first 256KB, i.e. exactly the burst, and would report a huge number here
      ok('burst-then-crawl host measured as SLOW (<10 Mbps)', m[HOST_PREFER] > 0 && m[HOST_PREFER] < 10, 'got ' + m[HOST_PREFER]);
      ok('uniformly fast host measured as FAST (>100 Mbps)', m[HOST_FAST] > 100, 'got ' + m[HOST_FAST]);
      ok('the instrument separates them (>10x)', m[HOST_FAST] / m[HOST_PREFER] > 10, `${m[HOST_FAST]} vs ${m[HOST_PREFER]}`);
    }

    console.log('\n== T3: when the test resolves it must REWRITE the live payload, not just log ==');
    ok('video baseUrl now points at the measured winner', p.data.dash.video[0].baseUrl.includes(HOST_FAST), p.data.dash.video[0].baseUrl);
    ok('audio baseUrl moved too', p.data.dash.audio[0].baseUrl.includes(HOST_FAST), p.data.dash.audio[0].baseUrl);
    ok('loser kept as backup (player can still fail over)', JSON.stringify(p.data.dash.video[0].backupUrl).includes(HOST_PREFER), '');

    console.log('\n== T2: the winner must survive a page load ==');
    ok('winner persisted to storage', !!store.getItem('bcdn:winner:v3'), JSON.stringify(store._dump()));
    const ctx2 = newCtx(store, { [HOST_PREFER]: BURST_THEN_CRAWL, [HOST_FAST]: UNIFORM_FAST });
    const p2 = payload();
    ctx2.window.__playinfo__ = p2;
    // no await: this must be the SYNCHRONOUS first pick, before any probe could finish
    ok('FIRST pick on a fresh page already uses the winner', p2.data.dash.video[0].baseUrl.includes(HOST_FAST), p2.data.dash.video[0].baseUrl);
    ok('no speed test re-run while the cache is fresh', ctx2.fetchCalls.length === 0, 'fetches: ' + ctx2.fetchCalls.length);
  }

  console.log('\n== T5: two playurl payloads close together must NOT ban the chosen host ==');
  {
    vclock = 0;
    const store = makeStore();
    store.setItem('bcdn:winner:v3', JSON.stringify({ host: HOST_FAST, kbps: 900000, ts: Date.now() }));
    const ctx = newCtx(store, { [HOST_PREFER]: BURST_THEN_CRAWL, [HOST_FAST]: UNIFORM_FAST });
    const a = payload(), b = payload();
    ctx.window.__playinfo__ = a;
    ctx.window.__playinfo__ = b;
    await sleep(100);
    const banned = ctx.__logs.some(l => l.includes('暂时屏蔽'));
    ok('no ban fired on a normal second payload', !banned, ctx.__logs.filter(l => l.includes('屏蔽')).join(' | '));
    ok('second payload still served by the winner', b.data.dash.video[0].baseUrl.includes(HOST_FAST), b.data.dash.video[0].baseUrl);
    ok('winner still in storage', (store.getItem('bcdn:winner:v3') || '').includes(HOST_FAST), '');
  }

  console.log('\n== T6: the reported host must be the VIDEO stream, not the last audio stream ==');
  {
    vclock = 0;
    const store = makeStore();
    store.setItem('bcdn:winner:v3', JSON.stringify({ host: HOST_FAST, kbps: 900000, ts: Date.now() }));
    const ctx = newCtx(store, { [HOST_PREFER]: BURST_THEN_CRAWL, [HOST_FAST]: UNIFORM_FAST });
    const p = payload();
    // give audio a DIFFERENT single candidate so a leak from audio is visible
    p.data.dash.audio = [{ baseUrl: `https://audio-only.example.net/a.m4s`, backupUrl: [] }];
    ctx.window.__playinfo__ = p;
    await sleep(50);
    const line = ctx.__logs.find(l => l.includes('本次选用'));
    ok('log line exists', !!line, ctx.__logs.join(' | ').slice(0, 200));
    ok('reports the video host', !!line && line.includes(HOST_FAST), line);
    ok('does NOT report the audio host', !!line && !line.includes('audio-only'), line);
  }

  console.log('\n== T4: reading the XHR response twice must process it once ==');
  {
    vclock = 0;
    const store = makeStore();
    store.setItem('bcdn:winner:v3', JSON.stringify({ host: HOST_FAST, kbps: 900000, ts: Date.now() }));
    const ctx = newCtx(store, { [HOST_PREFER]: BURST_THEN_CRAWL, [HOST_FAST]: UNIFORM_FAST });
    const xhr = new ctx.XMLHttpRequest();
    xhr.open('GET', 'https://api.bilibili.com/x/player/playurl?avid=1');
    xhr.__raw = JSON.stringify(payload());
    const before = ctx.__logs.length;
    const r1 = xhr.responseText;
    const mid = ctx.__logs.length;
    const r2 = xhr.responseText;
    const r3 = xhr.response;
    const after = ctx.__logs.length;
    ok('first read produced output', typeof r1 === 'string' && r1.includes(HOST_FAST), '');
    ok('first read logged once', mid > before, `${before} -> ${mid}`);
    ok('repeat reads log nothing more', after === mid, `${mid} -> ${after}`);
    ok('repeat reads return the identical string', r1 === r2 && r2 === r3, '');
  }

  console.log('\n== T7: a host whose probe hard-fails is banned and not chosen ==');
  {
    vclock = 0;
    const store = makeStore();
    const ctx = newCtx(store, { [HOST_PREFER]: UNIFORM_FAST, [HOST_FAST]: 'fail' });
    const p = payload();
    ctx.window.__playinfo__ = p;
    await sleep(400);
    ok('failing host was banned', ctx.__logs.some(l => l.includes('暂时屏蔽') && l.includes(HOST_FAST)), ctx.__logs.filter(l => l.includes('屏蔽')).join('|'));
    ok('winner is the surviving host', (store.getItem('bcdn:winner:v3') || '').includes(HOST_PREFER), store.getItem('bcdn:winner:v3'));
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
