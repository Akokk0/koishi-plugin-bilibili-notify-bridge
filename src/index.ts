/**
 * **bilibili-notify 桥接** —— 把这台 koishi 里已经配好的 bot 借给 BN 用。
 *
 * 形态一句话:**桥主动连 BN**(协议 §1)。主人在 BN 的拓展页建一条接入、拿到一条长期
 * token,填进这里;连上之后 BN 就能经这台 koishi 往各平台推,用户在群里贴的链接也经这条
 * 路回给 BN 解析。BN 从不反过来连 koishi —— 所以 NAS / 内网 / 家宽都不用开端口。
 *
 * ⚠️ **这个文件是接线,没有单元测试**:它把 koishi 的运行时(`ctx.http` / `ctx.bots` /
 * `ctx.on('message')`)接到几个纯函数上,而那几个各自都有测试(`src/__tests__/`)。
 * 接线对不对只有真机验得了 —— 装上、看 BN 拓展页那条卡变不变绿。
 */

import { Context, Schema } from "koishi";
import { botsOf } from "./bots";
import { createBridgeClient } from "./client";
import { deliverSend } from "./deliver";
import { inboundOf } from "./inbound";
import type { BridgeInboundSubscription } from "./protocol";
import { VERSION } from "./version";

export const name = "bilibili-notify-bridge";

/** `ctx.http` 要声明才拿得到 —— 这条 WS 与取图都走它。 */
export const inject = ["http"];

export { VERSION } from "./version";

export interface Config {
	url: string;
	token: string;
}

export const Config: Schema<Config> = Schema.object({
	url: Schema.string()
		.required()
		.description("BN 的桥地址,形如 `ws://192.168.1.5:8787/ext/bridge`(BN 拓展页上有得抄)。"),
	token: Schema.string()
		.role("secret")
		.required()
		.description("BN 拓展页里那条桥接入的接入 token。"),
});

export function apply(ctx: Context, config: Config) {
	const log = ctx.logger(name);
	/**
	 * BN 要什么入站消息 —— **握手前一条都不驮**。默认就该是「什么都不要」:连上之前把
	 * 群消息传出去,等于在用户还没同意时就上传了他的聊天。
	 */
	let subscription: BridgeInboundSubscription = { private: false, group: "none" };

	const client = createBridgeClient({
		// token 走 upgrade 的请求头,不进 URL —— URL 会落进反代的访问日志。
		open: () =>
			ctx.http.ws(config.url, { headers: { Authorization: `Bearer ${config.token}` } }),
		// 现取:重连时报的是**那一刻**的名单,不是插件启动时的。
		bots: () => botsOf([...ctx.bots]),
		version: VERSION,
		onWelcome: (next) => {
			subscription = next;
			log.info("已连上 bilibili-notify");
		},
		deliver: (frame) =>
			deliverSend(frame, {
				botOf: (botId) => ctx.bots.find((bot) => `${bot.platform}:${bot.selfId}` === botId),
				async fetchImage(url) {
					// 🔴 图必须**桥自己下载**(协议 §9):那条 URL 只保证桥自己可达,BN 常跑在
					// NAS 上,交给平台去拉是静默失败。
					const file = await ctx.http.file(url);
					return { data: new Uint8Array(file.data), mime: file.type };
				},
			}),
		log: { info: (message) => log.info(message), warn: (message) => log.warn(message) },
		later: (fn, ms) => ctx.setTimeout(fn, ms),
	});
	ctx.on("dispose", () => client.dispose());

	// bot 名单是**全量快照**:koishi 这三个事件任一发生就整份重推。
	const pushBots = () => client.pushBots(botsOf([...ctx.bots]));
	ctx.on("login-added", pushBots);
	ctx.on("login-removed", pushBots);
	ctx.on("login-updated", pushBots);

	ctx.on("message", (session) => {
		// 过滤在这一侧做(协议 §8),省的是带宽与隐私;群白名单那种策略仍归 BN 判。
		const message = inboundOf(
			{
				selfId: session.selfId,
				userId: session.userId,
				channelId: session.channelId,
				isDirect: session.isDirect,
				content: session.content ?? "",
			},
			subscription,
		);
		if (!message) return;
		client.pushInbound(`${session.platform}:${session.selfId}`, session.platform, message);
	});
}
