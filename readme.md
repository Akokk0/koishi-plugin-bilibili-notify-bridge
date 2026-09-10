# koishi-plugin-bilibili-notify-bridge

[![npm](https://img.shields.io/npm/v/koishi-plugin-bilibili-notify-bridge?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-bilibili-notify-bridge)

把这台 koishi 里**已经配好的 bot 借给 [bilibili-notify](https://github.com/Akokk0/bilibili-notify) 用**。

BN 负责订阅 UP 主、渲染卡片、决定什么时候推；这个插件只负责把消息交给你的 bot 发出去，
再把用户在群里贴的链接回传给 BN 解析。于是 telegram / discord / kook 这些平台不用 BN 各写一份适配 ——
koishi 早就有人写好了。

## 怎么用

1. 在 BN 的**拓展页**装上「机器人框架桥接」，建一条接入，它会生成一条长期 token；
2. 把 BN 的地址与那条 token 填进这个插件的配置；
3. 保存。连上之后 BN 拓展页上那条卡会变绿，并列出这台 koishi 借出去的 bot。

| 配置项 | 说明 |
| --- | --- |
| `url` | BN 的桥地址，形如 `ws://192.168.1.5:8787/ext/bridge`（拓展页上有得抄）|
| `token` | 那条接入的接入 token |

**桥主动连 BN，BN 从不反过来连 koishi** —— 所以 koishi 跑在内网 / NAS / 家宽后面都不用开端口。
断线自己退避重连；token 不对、协议版本不兼容、接入被删这几种会停下来并在日志里说明白，不会拿同一条
token 一直捶 BN。

## 这一版能做什么

- 文字、图片、图文、多图推送；@全体成员、合并转发、QQ 小程序卡（平台支持时）
- 私聊指令与群里的链接解析；群里转的 B 站**分享卡**也解得出链接
- bot 名单变了自动重报

**还做不到**：markdown 排版 —— 报的是「不支持」，BN 会在它那侧剥成纯文本（QQ 本来就不渲染
markdown，报支持只会让群里收到一堆星号）。

## 能力表

**按平台报，而且只报查过的**——去翻那个平台适配器的消息编码器，翻过才写进表里：

| | onebot | discord | kook | telegram | qq | 其余 |
| --- | --- | --- | --- | --- | --- | --- |
| @全体成员 | ✅ | ✅ | ✅ | ❌ | ❌ | 还不知道 |
| 合并转发 | ✅ | ❌ | ❌ | ❌ | ❌ | 还不知道 |
| 分享卡链接 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 小程序卡 | **探** | ❌ | ❌ | ❌ | ❌ | ❌ |

两处判据值得说明：

- **合并转发**看的是「那家的 `<figure>` **是不是真的合并转发卡**」。onebot 走
  `send_group_forward_msg`（真·聊天记录卡）；discord / telegram 虽然也有 `figure`，那是
  **换个头像分条发**——报支持的话你以为收到一张卡，实际是刷屏。
- **小程序卡是六项里唯一探得出来的**，因为它是个 API 调用（`get_mini_app_ark`，失败带
  retcode）。所以它**不写死**：每个 bot 上线时空参探一次，`1404`/`404` = 这个实现没有它，
  `1400`（参数错）或直接成功 = 它在；别的错什么都不说明，保持「还不知道」下次再探。
  其余五项是**消息元素**，适配器碰到不认识的**静默丢弃、不抛错**，连 try/catch 都探不出来
  ——只能硬编。

## 开发

```bash
vp run test        # tsx --test，纯逻辑那几块
vp run typecheck
```

`src/index.ts` 是接线（跑在 koishi 运行时上，没有单元测试）；协议、能力表、消息投影、入站过滤、
长连接各自在 `src/__tests__/` 里有测试。协议规范见 BN 仓里的 `extensions/bridge/PROTOCOL.md`。

> ⚠️ **真机还没验过。** 这一版对着 BN 的协议写完、单测全绿，但还没有真的连上一台 BN 推过一条消息。
