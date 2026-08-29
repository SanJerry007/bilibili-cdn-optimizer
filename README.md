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

- **`auto` 实测择优（默认，推荐）**：拦到播放地址后，**在后台并发对每个 CDN 镜像下载一小块（256KB）实测真实速度，选实测最快的那个**。结果缓存 10 分钟，之后同一会话的视频/拖进度条直接复用，不重复测速。测速不阻塞播放（测速期间先用就近 Akamai 兜底，测完自动切最优）。
- **`prefer` 固定优先（省流量）**：不测速，直接把指定的就近 CDN（默认 Akamai `akamaized.net`）提到第一位。

三层兜底保证视频永远能放：**实测赢家 → PREFER 就近节点 → B 站原始默认**。此外，如果播放器刚拿到某个 CDN 就立刻回头重新要地址，说明那个节点根本播不动，脚本会把它暂时拉黑 5 分钟并改选别的，避免同一个坏节点被反复推到首位、把播放器卡在无限重试里。

- ✅ **不伪造、不篡改地址**：只在 B 站*本来就给你的*合法镜像里择优
- ✅ **不需要 VPN**：直连即可满速
- ✅ **零配置开箱即用**
- ✅ 兼容 Bilibili-Evolved、下载助手等其它脚本，各自独立运行

> 为什么需要它：B 站的 CDN 调度是为「中国大陆用户 + 它自己的带宽成本」优化的，对海外 IP 常常默认给一个较慢的节点，而把最快的就近节点放在备用位；播放器又只用第一个、不会自己比速。这个脚本替播放器补上了「择优」这一步。

### 安装

1. 先装脚本管理器：[Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox 均可）
2. 点这里安装脚本 👉 **[bilibili-cdn-optimizer.user.js](https://raw.githubusercontent.com/SanJerry007/bilibili-cdn-optimizer/main/bilibili-cdn-optimizer.user.js)**
   （Tampermonkey 会自动弹出安装页，点「安装」即可；之后会通过 `@updateURL` 自动更新）
3. 打开任意 B 站视频，右下角出现蓝色提示 `✅ CDN已优选: ...akamaized.net` 即成功。

### 验证生效

- 右下角角标会显示当前选用的 CDN：测速完成后是绿色 `🏆 实测最快CDN: ...`。
- 或按 `F12` 打开控制台，能看到 `[B站CDN优选] 测速结果:` 列出每个 CDN 的实测 Mbps，以及绿字 `最快 -> ...`。

### 进阶配置

编辑脚本顶部的 `CFG`：

```js
const CFG = {
  MODE: 'auto',                 // 'auto'=实测择优(默认) | 'prefer'=固定优先,不测速省流量
  PREFER: ['akamaized.net'],    // 兜底/prefer模式的优先域,按顺序回退
  TEST_BYTES: 262144,           // 每个镜像测速下载的字节数(256KB)
  TEST_TIMEOUT: 4000,           // 单镜像测速超时(ms),超时即淘汰
  CACHE_TTL: 10 * 60 * 1000,    // 实测结果缓存时长(ms),期间不重测
  SHOW_TOAST: true,             // 右下角提示,用熟后可关
};
```

- 想省流量、不想每次测速：把 `MODE` 改成 `'prefer'`，它就只按 `PREFER` 固定优选（Akamai 对绝大多数海外地区已是就近节点）。
- `auto` 模式下 `PREFER` 仍作为测速完成前和测速失败时的兜底。

### 常见问题

- **它和 Bilibili-Evolved 冲突吗？** 不冲突。Bilibili-Evolved 没有 CDN 优选功能，这个脚本是独立补充。
- **会被封号吗？** 不会。脚本只在 B 站合法返回的镜像里换优先级，不涉及任何越权或伪造请求。
- **番剧 / 港澳台限定 / 4K 也生效吗？** 生效。脚本同时处理 `dash`（普通视频/番剧）和 `durl`（老格式）两种响应。

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

It reads the mirror list from both the inline `window.__playinfo__` in the page HTML and the `playurl` API response, then **promotes the nearest overseas CDN (default: Akamai `akamaized.net`) to the top** of the mirror list, so the player uses it.

- ✅ No spoofing; only reorders the *legitimate* mirrors Bilibili already gave you
- ✅ No VPN required
- ✅ Zero-config out of the box
- ✅ Coexists with Bilibili-Evolved and other userscripts

### Install

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/)
2. **[Click to install the script](https://raw.githubusercontent.com/SanJerry007/bilibili-cdn-optimizer/main/bilibili-cdn-optimizer.user.js)**; Tampermonkey opens an install page; click *Install*.
3. Open any Bilibili video; a blue toast `✅ CDN已优选: ...akamaized.net` in the bottom-right confirms it works.

### Customize

Edit the config at the top of the script if a different mirror is faster in your region:

```js
const PREFER = ['akamaized.net'];   // ordered preference; falls back to Bilibili's default if none match
```

### License

[MIT](./LICENSE)
