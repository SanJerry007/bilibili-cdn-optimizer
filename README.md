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

- **`auto` 实测择优（默认，推荐）**：拦到播放地址后，**等播放器自己缓冲够了**再在后台**依次**对每个 CDN 镜像实测**持续吞吐**，选最快的那个。测速会丢掉开头的 256KB 或 500ms（那一段是握手加 TCP 慢启动，量到的是延迟不是带宽），之后才开表。窗口是「最多 1.2 秒或最多 4MB，谁先到算谁」，而在快线路上先到的总是 4MB 那一条（约 26 Mbps 以上就由字节数说了算，200 Mbps 时实际窗口只有 150ms 左右），这是不愿为了凑满 1.2 秒去下几十 MB 的取舍。结果**跨页面保存** 10 分钟，所以下次打开视频时第一帧就用上了最优源，不用等测速。
- **`prefer` 固定优先（省流量）**：不测速，直接把指定的就近 CDN（默认 Akamai `akamaized.net`）提到第一位。

三层兜底保证视频永远能放：**实测赢家 → PREFER 就近节点 → B 站原始默认**。落选的镜像仍然留在 `backupUrl` 里，播放器自己的故障转移照常可用。只有测速硬失败（403、CORS、超时）的镜像才会被暂时拉黑 5 分钟。

此外还有一层**播放健康看门狗**：它监听 `video` 元素的 `waiting` 事件和缓冲领先量，在视频真的卡起来时重新测一遍。这时会出现两种结论，而两种都有用：要么别的镜像确实更快，它换好并提示你刷新生效；要么**各个镜像一样慢**，那它会明说「不是选错源，是当前线路状况」，省得你以为是 CDN 没选对而白折腾。复测用的流量预算只有常规的四分之一，因为播放器这时本来就在挨饿，不能再抢它带宽。

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
- 按 `F12` 打开控制台，能看到 `[B站CDN优选] 测速结果(持续吞吐):` 列出每个 CDN 的实测 Mbps，以及绿字 `最快 -> ...`。如果赢家跟当前在用的不是同一个，会看到 `测速赢家是 X,但本次播放已在用 Y 且换不掉了。已存下,下个视频或刷新后生效`。播放中途是换不掉源的（见 3.3 那节的实测），**脚本不会在改不动的时候声称自己改了。**

### 验证脚本本身没退化

```bash
node tools/selftest.js
```

它把真实的脚本文件加载进一个桩浏览器（假的 fetch / XHR / localStorage / 时钟），断言的是行为不是结构。80 条断言里，53 条在 2.1 上是红的、23 条在 3.2 上是红的、3 条在 3.3 上是红的，所以这个闸门不会对着坏版本打绿灯。CI 每次 push 都跑。

### 进阶配置

编辑脚本顶部的 `CFG`：

```js
const CFG = {
  MODE: 'auto',                 // 'auto'=实测择优(默认) | 'prefer'=固定优先,不测速省流量
  PREFER: ['akamaized.net'],    // 没有实测结果时的兜底优先域,按顺序回退
  WARMUP_BYTES: 262144,         // 测速丢弃的热身字节数(握手+慢启动,量的是延迟不是带宽)
  WARMUP_MS: 500,               // 热身最长这么久,与上一条谁先到算谁
  MEASURE_MS: 1200,             // 热身之后真正计入速度的测量窗口(ms)
  MAX_BYTES: 4 * 1024 * 1024,   // 单镜像最多拉这么多就收手,快线路上是它决定窗口长度
  MAX_MIRRORS: 3,               // 一轮最多测几个镜像,丢掉的会写进控制台
  TEST_COOLDOWN: 60 * 1000,     // 两轮测速最小间隔,防止全失败时无限重测
  TEST_DELAY_MS: 2000,          // 最早等这么久才开始查播放器缓冲
  TEST_BUFFER_AHEAD_S: 10,      // 缓冲领先这么多秒就认为播放器吃饱了,可以开测
  TEST_DEFER_MAX_MS: 45000,     // 等不到缓冲也别无限等
  HEALTH_WATCH: true,           // 播放卡顿时自动复测,见下文
  HEALTH_STALL_EVENTS: 3,       // 30 秒窗口内攒够几次 waiting 算卡
  HEALTH_MIN_BUFFER_S: 3,       // 播放中缓冲领先低于这么多秒算挨饿
  HEALTH_LOW_SAMPLES: 5,        // 连续挨饿这么多秒才判定
  HEALTH_PROBE_BYTES: 1048576,  // 复测预算,刻意小,别跟挨饿的播放器抢带宽
  HEALTH_MAX_CHECKS: 3,         // 每个视频最多复测几次
  HEALTH_SEEK_GRACE_MS: 4000,   // 拖进度条前后这段时间的卡顿不算(拖动必然触发 waiting)
  HEALTH_FIRST_FILL_MS: 20000,  // 开头这段时间内若还没健康过就不判卡,但保护有期限
  TEST_TIMEOUT: 8000,           // 单镜像整体超时(ms)
  CACHE_TTL: 10 * 60 * 1000,    // 实测结果缓存时长(ms),跨页面保存
  MIN_GAIN: 1.25,               // 要快过在用的这么多倍才换,避免在噪声上横跳
  BAN_TTL: 5 * 60 * 1000,       // 测速硬失败的镜像暂时不选的时长(ms)
  SHOW_TOAST: true,             // 右下角提示,用熟后可关
};
```

**这个探针能分辨什么、不能分辨什么**（在一条海外直连线路上，对同一对镜像连测两轮的实测结果）：两个都很快的源之间，读数会抖，一轮 289.5 Mbps 下一轮 139.1 Mbps 都有，`MIN_GAIN` 压不住这种两倍级的抖动，所以它在两个快源之间选谁带一定随机性。这不要紧，因为两个都快。它真正要认出来的是**快源和慢源之间那种量级差**（比如就近节点几百 Mbps 对上境内节点的几百 KB/s），那个差距是几十上百倍，任何一轮都分得清。旧探针连前一种都分不清：同一个源两轮读到 17.3 和 40.1 Mbps，而真值在 139 以上。

流量代价：每 10 分钟最多测一轮，一轮最多 3 个镜像，每个最多 4MB，所以上限是每 10 分钟 12MB。嫌费流量就调小 `MAX_BYTES` 或 `MAX_MIRRORS`（调 `MEASURE_MS` 在快线路上没用，那里先到的是字节数上限），或者干脆切 `prefer` 模式。

- 想省流量、不想每次测速：把 `MODE` 改成 `'prefer'`，它就只按 `PREFER` 固定优选（Akamai 对绝大多数海外地区已是就近节点）。
- `auto` 模式下 `PREFER` 仍作为测速完成前和测速失败时的兜底。

### 常见问题

- **它和 Bilibili-Evolved 冲突吗？** 不冲突。Bilibili-Evolved 没有 CDN 优选功能，这个脚本是独立补充。
- **会被封号吗？** 不会。脚本只在 B 站合法返回的镜像里换优先级，不涉及任何越权或伪造请求。
- **番剧 / 港澳台限定 / 4K 也生效吗？** 生效。脚本同时处理 `dash`（普通视频/番剧）和 `durl`（老格式）两种响应。

### 3.3.1 修了什么

3.3 那道「首屏保护」只修了一半。`armed` 这个标志只在缓冲采样那条路上查了，**`waiting` 事件那条路根本没查**，而后者恰恰更容易触发。实测在 3.3 上：视频刚开始填缓冲、缓冲只有 0.4 秒时，三次 `waiting` 就能让它去测速、**拉黑一个健康的源**、并弹出刷新提示。等于 3.2 修掉的「抢首屏带宽」被我自己从后门放了回来。

顺带把保护写法也改对了。原来是「没健康过就不判卡」，那会留一个更糟的盲区：一个从第一秒就坏的播放永远也健康不了，看门狗对最该管的那种情况反而完全失灵。现在改成**有期限的窗口**（`HEALTH_FIRST_FILL_MS`）：窗口内不判，过了窗口即使从没健康过也要查一次。

还有一处：`armed` 是全局的，换 `video` 元素时不清零。一个健康的贴片广告播放器会替正片的首屏把看门狗提前武装好，然后在正片最需要带宽的几秒里开测。现在换元素等于换一次播放，健康证据清零重来。

### 3.3 加了什么

**一条来自真实播放的反馈。** 在这之前，脚本选完源就撒手不管了：视频卡成幻灯片它也不知道，就那么钉着等 10 分钟缓存过期。而实测同一个镜像的吞吐能在二十分钟内从 24 Mbps 变到 196 Mbps，链路的变化比 `CACHE_TTL` 快得多，所以「测一次，钉十分钟」这个前提本身就不成立。

现在它监听 `video` 的 `waiting` 事件和缓冲领先量，卡了就用小预算复测，然后分两种情况处理，**两种都会明确告诉你**：别的镜像更快，就换好并提示刷新；各源一样慢，就说清楚问题不在选源。后一种同样重要，不然你会一直以为是 CDN 没挑对。

**判定「卡了」这件事，误判的代价比漏判高**，因为误判会在播放器最饿的时候去抢它的带宽。所以设了四道闸：开头 20 秒内若还没见过一次健康缓冲就一概不判卡（否则视频刚开始填缓冲的那几秒缓冲天然就少，会被当成卡，等于把 3.2 刚修掉的问题从后门放回来），两条判定路径都要过这一关；拖进度条前后 4 秒内的卡顿一律不算（拖动必然触发 `waiting`）；缓冲领先量要取**包含播放位置的那一段**，不能一律取最后一段，否则往回拖之后算出来是个大数；视频快播完时缓冲领先本来就接近 0，那不是挨饿。最后两条都是真浏览器实测撞出来的，不是想出来的。

脚本在 iframe 里也会各跑一份，实测一个视频页跑出了 5 份实例。改写地址每个 frame 都该做，但测速和看门狗只在顶层做一次，否则就是 5 套测速抢同一条带宽。

**同时修正了一句之前的过度承诺。** 3.1 和 3.2 在测速出结果后会打印「已改写播放地址对象」。对象确实改了，但实测表明**播放器根本不看**：把 21 个流对象全部改写成另一个主机、再强制跳转，之后 20 秒里 14 个分片仍然全部来自旧主机。播放器一开始就把主机解析定了。所以那句话虽然字面为真，却暗示了做不到的事，现在改成「已存下，下个视频或刷新后生效」，并且角标那一档是**可以点的**，点了就刷新。

### 3.2 修了什么

**测速不再开在 `document-start`。** 3.1 一拦到播放地址就立刻开测，而那正是播放器拼命填首屏缓冲的时刻，两边抢同一条出口带宽。真浏览器实测：同一个 akamai 镜像，页面加载中测出 **5.8 Mbps**，把视频暂停、缓冲满之后再测是 **195 到 281 Mbps**，差四十倍。也就是说它既量不准，又恰好在最需要带宽的那几秒里把带宽抢走。现在改成等 `video` 元素的缓冲领先播放位置 10 秒以上再测，等不到就按 45 秒上限兜底。判据用缓冲领先量而不是固定睡一觉，是因为 4K 和 360P 填满缓冲要的时间差着数量级。

晚测不影响效果：赢家本来就是跨页面保存的，这一轮测出来的结果是给下一个视频用的。

### 3.1 修了什么

3.0 发出去之前又做了一轮对抗性复核，结果它自己犯了两个跟 2.x 同类的错，还带出几个新的。

**刚修好的音频覆盖，在 `applyWinner()` 里原样又犯了一遍。** 它遍历所有改写过的流、让最后一个说了算，而最后一个是音频。于是角标又变成报音频的 host。现在只认视频流。

**它在改不动的时候声称自己改了。** `fetch` 和 XHR 两条路在 `processData` 返回后立刻把对象序列化成字符串交给播放器，之后再改那个对象播放器一个字都看不见，可代码照样打印「已把播放地址改写为」。这正是 2.x 那个「只报告意图、不报告结果」的毛病换个地方重演。现在按「这份数据播放器还会不会再读」分开处理，改不动就明说改不动。

**复用同一个 XHR 对象时，无关接口的响应被改了值。** 实例 getter 在 `open()` 到别的地址时不会被摘掉，于是那个响应也被 `JSON.parse` + `JSON.stringify` 转一圈，而 B站的 aid/mid 超出 double 精度，转一圈就变了：测试里 `9007199254740993` 变成 `...992`。现在每次 `open()` 都先摘掉。

**一段很短的片源会让所有健康镜像被拉黑。** 探针把「测不出来」和「硬失败」都返回 -1。现在分成三态，只有硬失败才拉黑。

**全部镜像失败时会无限重测。** `pickBest` 在全员被拉黑时会清空黑名单，清完下一个载荷又重测一轮，每个载荷来一遍。加了 `TEST_COOLDOWN`。

**缓存里存着别处的赢家会把测速压制 10 分钟。** 之前只看缓存新不新，不看那个 host 这个视频到底提不提供。

还有两处小的：坏掉或缺字段的缓存会让角标显示 `NaN Mbps`，现在校验后丢弃；别的脚本若把 `XMLHttpRequest` 换成子类，原型描述符会是 `undefined`，之后每次读属性都抛异常把播放打死，现在拿不到就整个不挂钩 XHR。

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

The measurement discards the first 256KB or 500ms of each transfer, because that window is handshake plus TCP slow start and reflects round-trip time rather than bandwidth. The window that follows is whichever comes first, 1.2 seconds or 4MB, and on fast links it is always the byte cap: above roughly 26 Mbps the window length is set by MAX_BYTES, so at 200 Mbps it is about 150ms. That is a deliberate trade, since honouring 1.2 seconds at those rates would mean downloading tens of megabytes per mirror. Mirrors are probed one at a time, since concurrent probes share the same uplink and would each measure only a fraction of it.

The probe does not start at document-start. It waits until the `video` element has buffered at least 10 seconds ahead, because a probe running while the player fills its first buffer competes for the same uplink: measured in a real browser, the same Akamai mirror read 5.8 Mbps during page load and 195 to 281 Mbps once the video was paused and buffered.

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

Loads the real userscript into a stubbed browser and asserts behaviour. Of the 80 assertions, 53 fail on 2.1, 23 on 3.2 and 3 on 3.3, which is what makes the gate meaningful.

### License

[MIT](./LICENSE)
