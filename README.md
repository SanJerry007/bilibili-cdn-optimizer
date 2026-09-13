# B站 CDN 优选 · Bilibili CDN Optimizer

> 让海外用户看 B 站不再卡：一个油猴脚本，强制视频走**就近的海外 CDN 节点**，告别 B 站的随机慢调度。
>
> A userscript that forces Bilibili videos onto the **nearest overseas CDN**, fixing slow/buffering playback for viewers outside mainland China.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Userscript](https://img.shields.io/badge/type-userscript-00a1d6.svg)](./bilibili-cdn-optimizer.user.js)

---

## 中文说明

### 这是什么问题？

在海外看 B 站，网页、封面、评论都很快，唯独**视频卡成幻灯片**。原因不在你的网速，而在 B 站的 **CDN 调度**：

B 站每次播放会从多个 CDN 镜像里给你分配一个。对海外 IP，它的分配是**随机**的，可能落到：

- 🟢 **就近的海外节点**（如 Akamai，遍布全球，自动就近）→ 飞快，上百 Mbps
- 🟡 较远的海外节点（如某地区腾讯云中转）→ 一般，几十 Mbps
- 🔴 **中国境内节点**（数据要跨太平洋甚至绕道欧洲进中国）→ 灾难，200ms+ 延迟，反复缓冲

抽中红色档，视频就卡。而关键事实是：**那个飞快的就近节点，其实一直都在 B 站返回的镜像列表里**，只是没被优先选中。

### 这个脚本怎么解决？

脚本从两处拿到 B 站给的播放地址列表，在它返回的多个 CDN 镜像里**选一个最快的**给播放器用：一是页面 HTML 里内联的 `window.__playinfo__`（打开视频页时首个视频走这条路），二是 `playurl` 接口的响应（切清晰度、站内跳转时走这条路）。有两种工作模式：

- **`auto` 实测择优（默认，推荐）**：拦到播放地址后，在后台**依次**对每个 CDN 镜像实测**持续吞吐**，选最快的那个。测速会丢掉开头的 256KB 或 500ms（那一段是握手加 TCP 慢启动，量到的是延迟不是带宽），只统计之后 1.2 秒窗口里的字节数。结果**跨页面保存** 10 分钟，所以下次打开视频时第一帧就用上了最优源，不用等测速。
- **`prefer` 固定优先（省流量）**：不测速，直接把指定的就近 CDN（默认 Akamai `akamaized.net`）提到第一位。

三层兜底保证视频永远能放：**实测赢家 → PREFER 就近节点 → B 站原始默认**。落选的镜像仍然留在 `backupUrl` 里，播放器自己的故障转移照常可用。只有测速硬失败（403、CORS、超时）的镜像才会被暂时拉黑 5 分钟。

- ✅ **不伪造、不篡改地址**：只在 B 站*本来就给你的*合法镜像里择优
- ✅ **不需要 VPN**：直连即可满速
- ✅ **零配置开箱即用**
- ✅ 兼容 Bilibili-Evolved、下载助手等其它脚本，各自独立运行

> 为什么需要它：B 站的 CDN 调度是为「中国大陆用户 + 它自己的带宽成本」优化的，对海外 IP 常常默认给一个较慢的节点，而把最快的就近节点放在备用位；播放器又只用第一个、不会自己比速。这个脚本替播放器补上了「择优」这一步。

### 安装

1. 先装脚本管理器：[Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox 均可）
2. 点这里安装脚本 👉 **[bilibili-cdn-optimizer.user.js](https://raw.githubusercontent.com/SanJerry007/bilibili-cdn-optimizer/main/bilibili-cdn-optimizer.user.js)**
   （Tampermonkey 会自动弹出安装页，点「安装」即可；之后会通过 `@updateURL` 自动更新）
3. 打开任意 B 站视频，右下角出现提示 `✅ CDN已优选: ...` 即成功。第一次打开时还没有实测结果，用的是兜底源；等它测完一轮，之后打开的视频就会直接是绿色的 `🏆 实测最快CDN: ...`。

### 验证生效

- 右下角角标显示的是**播放器此刻真正在用的那个 host**。绿色 `🏆 实测最快CDN: xxx (123.4 Mbps)` 表示这个源是实测选出来的，并且带宽数字可以对；蓝色 `⚠️ 用兜底CDN: ...` 表示还没有实测结果，正在用 PREFER 兜底。
- 按 `F12` 打开控制台，能看到 `[B站CDN优选] 测速结果(持续吞吐):` 列出每个 CDN 的实测 Mbps，以及绿字 `最快 -> ...`。如果赢家跟当前在用的不是同一个，还会看到 `已把播放地址改写为 ...`。

### 验证脚本本身没退化

```bash
node tools/selftest.js
```

它把真实的脚本文件加载进一个桩浏览器（假的 fetch / XHR / localStorage / 时钟），断言的是行为不是结构。22 条断言里有 16 条在 3.0 之前的版本上是红的，所以这个闸门不会对着坏版本打绿灯。CI 每次 push 都跑。

### 进阶配置

编辑脚本顶部的 `CFG`：

```js
const CFG = {
  MODE: 'auto',                 // 'auto'=实测择优(默认) | 'prefer'=固定优先,不测速省流量
  PREFER: ['akamaized.net'],    // 没有实测结果时的兜底优先域,按顺序回退
  WARMUP_BYTES: 262144,         // 测速丢弃的热身字节数(握手+慢启动,量的是延迟不是带宽)
  WARMUP_MS: 500,               // 热身最长这么久,与上一条谁先到算谁
  MEASURE_MS: 1200,             // 热身之后真正计入速度的测量窗口(ms)
  MAX_BYTES: 8 * 1024 * 1024,   // 单镜像最多拉这么多就收手
  TEST_TIMEOUT: 8000,           // 单镜像整体超时(ms)
  CACHE_TTL: 10 * 60 * 1000,    // 实测结果缓存时长(ms),跨页面保存
  MIN_GAIN: 1.25,               // 要快过在用的这么多倍才换,避免在噪声上横跳
  BAN_TTL: 5 * 60 * 1000,       // 测速硬失败的镜像暂时不选的时长(ms)
  SHOW_TOAST: true,             // 右下角提示,用熟后可关
};
```

流量代价：每 10 分钟最多测一轮，每个镜像最多拉 8MB。嫌费流量就调小 `MAX_BYTES` 和 `MEASURE_MS`，或者干脆切 `prefer` 模式。

- 想省流量、不想每次测速：把 `MODE` 改成 `'prefer'`，它就只按 `PREFER` 固定优选（Akamai 对绝大多数海外地区已是就近节点）。
- `auto` 模式下 `PREFER` 仍作为测速完成前和测速失败时的兜底。

### 常见问题

- **它和 Bilibili-Evolved 冲突吗？** 不冲突。Bilibili-Evolved 没有 CDN 优选功能，这个脚本是独立补充。
- **会被封号吗？** 不会。脚本只在 B 站合法返回的镜像里换优先级，不涉及任何越权或伪造请求。
- **番剧 / 港澳台限定 / 4K 也生效吗？** 生效。脚本同时处理 `dash`（普通视频/番剧）和 `durl`（老格式）两种响应。

### 3.0 修了什么

2.x 在实测中被发现「提示说选了最优源，但播放器拿到的一直是兜底源」。根子有四处：

**测速结果从来没被用上。** 选源是同步做完的，测速是之后才异步跑的，而拿到结果只写了个变量，没有任何一行回头改地址。更要命的是那个变量随页面销毁，所以每打开一个视频页它都是空的，选源永远落到兜底。现在赢家存进 `localStorage` 跨页面复用，并且测速一出结果就把当前这批地址再改写一次。

**探针量的是延迟不是带宽。** 只下 256KB，整个落在握手和 TCP 慢启动里。实测两个源读数分别是 3.1 和 16.4 Mbps，同一个源换一轮又变成 5.5 和 36.3，十倍级噪声，分不出高下。改成丢弃热身段、只统计稳定段之后，同样两个源读到 148 和 266 Mbps，与持续下载量到的数量级一致。

**正常播放会误封好节点。** 旧判据是「15 秒内又来了一次 playurl 就说明上个 CDN 播不动」，但内联 `__playinfo__` 之后播放器本来就会再要一次，切清晰度、分P、站内跳转也都在这个窗口里。这条判据整个删掉，只保留有证据的那种失败。

**角标报的是音频流。** `dash.video` 之后还要处理 `audio` / `dolby` / `flac`，每个都覆盖一次记录，所以提示和日志报的是最后那条音频流的 host。

另外，同一份 XHR 响应被读第二次时会把整套逻辑重跑一遍，现在按原始字符串记一次结果；`fetch` 钩子重建响应时会带走对不上的 `content-length`，现在删掉。

---

## English

### The problem

Watching Bilibili from overseas, everything loads fast **except the video itself**, which buffers endlessly. The bottleneck isn't your bandwidth; it's Bilibili's **CDN routing**.

For each playback, Bilibili hands your player one CDN mirror out of several. For overseas IPs the choice is effectively **random**, and you may land on:

- 🟢 a **nearby overseas edge** (e.g. Akamai, globally distributed, auto-routed) → hundreds of Mbps
- 🟡 a farther overseas relay → mediocre
- 🔴 a **mainland-China node** (data crosses the Pacific, sometimes via Europe) → 200ms+ latency, constant buffering

The key fact: **the fast nearby mirror is already in the list Bilibili returns**; it just isn't picked first.

### What this script does

It reads the mirror list from both the inline `window.__playinfo__` in the page HTML and the `playurl` API response, then **measures each mirror's sustained throughput and promotes the fastest one** to the top of the list, so the player uses it.

The measurement discards the first 256KB or 500ms of each transfer, because that window is handshake plus TCP slow start and reflects round-trip time rather than bandwidth. Only the bytes in the following 1.2 second window are counted. Mirrors are probed one at a time, since concurrent probes share the same uplink and would each measure only a fraction of it.

The winner is **persisted across page loads** for 10 minutes, so the next video you open uses it from the very first frame instead of waiting for a fresh measurement.

- ✅ No spoofing; only reorders the *legitimate* mirrors Bilibili already gave you
- ✅ No VPN required
- ✅ Zero-config out of the box
- ✅ Coexists with Bilibili-Evolved and other userscripts

### Install

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/)
2. **[Click to install the script](https://raw.githubusercontent.com/SanJerry007/bilibili-cdn-optimizer/main/bilibili-cdn-optimizer.user.js)**; Tampermonkey opens an install page; click *Install*.
3. Open any Bilibili video; a toast in the bottom-right confirms it works. The toast always names the host the player is **actually** using, so a green `🏆 实测最快CDN: host (123.4 Mbps)` means that host was measured and selected, while a blue `⚠️ 用兜底CDN: host` means no measurement exists yet and the fallback is in use.

### Customize

Edit the `CFG` block at the top of the script. The two you are most likely to touch:

```js
MODE: 'auto',                 // 'auto' = measure and pick | 'prefer' = fixed order, no measuring
PREFER: ['akamaized.net'],    // ordered fallback used until a measurement exists
```

### Run the tests

```bash
node tools/selftest.js
```

Loads the real userscript into a stubbed browser and asserts behaviour. 16 of the 22 assertions fail on pre-3.0 builds, which is what makes the gate meaningful.

### License

[MIT](./LICENSE)
