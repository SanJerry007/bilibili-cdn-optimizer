# B站 CDN 优选 · Bilibili CDN Optimizer

> 让海外用户看 B 站不再卡 —— 一个油猴脚本，强制视频走**就近的海外 CDN 节点**，告别 B 站的随机慢调度。
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

脚本拦截 B 站的 `playurl` 播放接口响应，在它返回的镜像列表里，**把就近的海外 CDN（默认 Akamai `akamaized.net`）提到第一位**，让播放器优先用它。

- ✅ **不伪造、不篡改地址** —— 只是在 B 站*本来就给你的*几个合法镜像里换个优先级
- ✅ **不需要 VPN** —— 直连即可满速
- ✅ **零配置开箱即用**（默认优选 Akamai，全球自动就近）
- ✅ 兼容 Bilibili-Evolved、下载助手等其它脚本，各自独立运行

Akamai 是全球最大的 CDN 之一，在世界各地都有边缘节点并自动就近路由，所以 `akamaized.net` 作为默认优选，对绝大多数海外地区都适用。

### 安装

1. 先装脚本管理器：[Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox 均可）
2. 点这里安装脚本 👉 **[bilibili-cdn-optimizer.user.js](https://raw.githubusercontent.com/SanJerry007/bilibili-cdn-optimizer/main/bilibili-cdn-optimizer.user.js)**
   （Tampermonkey 会自动弹出安装页，点「安装」即可；之后会通过 `@updateURL` 自动更新）
3. 打开任意 B 站视频，右下角出现蓝色提示 `✅ CDN已优选: ...akamaized.net` 即成功。

### 验证生效

- 右下角蓝色角标会显示当前选用的 CDN 主机名。
- 或按 `F12` 打开控制台，看到蓝字 `[B站CDN优选] 已选用 -> ...akamaized.net`。

### 进阶：换个优选 CDN

如果你所在地区连别的镜像更快（少数情况），可以编辑脚本顶部的配置：

```js
// 优先域(命中即用,按顺序)
const PREFER = ['akamaized.net'];
```

改成你想优先的域，例如同时优选多个、按顺序回退：

```js
const PREFER = ['akamaized.net', 'mirrorcosov'];
```

脚本会按数组顺序找第一个命中的镜像；都没命中时用 B 站原本的默认值兜底（所以永远不会让视频播不出来）。

想找出你本地最快的镜像，可以在直连状态下多打开几个视频，看控制台里 B 站给了哪些镜像域名，分别测测速。

### 常见问题

- **它和 Bilibili-Evolved 冲突吗？** 不冲突。Bilibili-Evolved 没有 CDN 优选功能，这个脚本是独立补充。
- **会被封号吗？** 不会。脚本只在 B 站合法返回的镜像里换优先级，不涉及任何越权或伪造请求。
- **番剧 / 港澳台限定 / 4K 也生效吗？** 生效。脚本同时处理 `dash`（普通视频/番剧）和 `durl`（老格式）两种响应。

---

## English

### The problem

Watching Bilibili from overseas, everything loads fast **except the video itself**, which buffers endlessly. The bottleneck isn't your bandwidth — it's Bilibili's **CDN routing**.

For each playback, Bilibili hands your player one CDN mirror out of several. For overseas IPs the choice is effectively **random**, and you may land on:

- 🟢 a **nearby overseas edge** (e.g. Akamai, globally distributed, auto-routed) → hundreds of Mbps
- 🟡 a farther overseas relay → mediocre
- 🔴 a **mainland-China node** (data crosses the Pacific, sometimes via Europe) → 200ms+ latency, constant buffering

The key fact: **the fast nearby mirror is already in the list Bilibili returns** — it just isn't picked first.

### What this script does

It intercepts Bilibili's `playurl` API response and **promotes the nearest overseas CDN (default: Akamai `akamaized.net`) to the top** of the mirror list, so the player uses it.

- ✅ No spoofing — only reorders the *legitimate* mirrors Bilibili already gave you
- ✅ No VPN required
- ✅ Zero-config out of the box
- ✅ Coexists with Bilibili-Evolved and other userscripts

### Install

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/)
2. **[Click to install the script](https://raw.githubusercontent.com/SanJerry007/bilibili-cdn-optimizer/main/bilibili-cdn-optimizer.user.js)** — Tampermonkey opens an install page; click *Install*.
3. Open any Bilibili video; a blue toast `✅ CDN已优选: ...akamaized.net` in the bottom-right confirms it works.

### Customize

Edit the config at the top of the script if a different mirror is faster in your region:

```js
const PREFER = ['akamaized.net'];   // ordered preference; falls back to Bilibili's default if none match
```

### License

[MIT](./LICENSE)
