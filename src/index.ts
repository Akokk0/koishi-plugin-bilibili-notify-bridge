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
import { arkRequestOf, arkToSegmentData, readMiniAppProbe } from "./onebot";
import type { BridgeCapabilityReport, BridgeInboundSubscription } from "./protocol";
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
	/**
	 * 探出来的能力,按 bot 记。今天只有一格:能不能签小程序卡 —— 六项里**唯一探得出来的**
	 * (它是个 API 调用,失败带 retcode;@全体那些是消息元素,适配器静默丢弃,探不出)。
	 */
	const probed = new Map<string, Partial<BridgeCapabilityReport>>();

	/** onebot 的 `internal` 能调任意 action,失败抛 `SenderError` 并带 retcode。 */
	function onebotInternalOf(bot: {
		platform?: string;
		internal?: { _get?: (action: string, params?: unknown) => Promise<unknown> };
	}): ((action: string, params?: unknown) => Promise<unknown>) | undefined {
		if (bot.platform !== "onebot") return undefined;
		const get = bot.internal?._get;
		return get ? (action, params) => get.call(bot.internal, action, params) : undefined;
	}

	/** 记一格探测结果;真变了才重推名单 —— 名单是全量快照,推空的只是白费带宽。 */
	function remember(botId: string, patch: Partial<BridgeCapabilityReport>): void {
		const before = probed.get(botId) ?? {};
		if (before.miniAppCard === patch.miniAppCard) return;
		probed.set(botId, { ...before, ...patch });
		pushBots();
	}

	/**
	 * 空参探一次签卡口。`1404`/`404` = 这个实现没有它;`1400`(参数错)或直接成功 = 它在;
	 * 别的错(超时、限流)什么都证明不了 —— 保持「还不知道」,下次上线再探。
	 */
	async function probeMiniApp(bot: { platform?: string; selfId?: string }): Promise<void> {
		const call = onebotInternalOf(bot);
		if (!call || !bot.selfId) return;
		const botId = `${bot.platform}:${bot.selfId}`;
		let state: BridgeCapabilityReport["miniAppCard"];
		try {
			await call("get_mini_app_ark", {});
			state = "supported";
		} catch (err) {
			state = readMiniAppProbe({ retcode: (err as { code?: number }).code });
		}
		if (state !== "unknown") remember(botId, { miniAppCard: state });
	}

	/** bot 名单是**全量快照**:变了就整份重推。 */
	const pushBots = () => client.pushBots(botsOf([...ctx.bots], (botId) => probed.get(botId)));

	const client = createBridgeClient({
		url: config.url,
		// token 走 upgrade 的请求头,不进 URL —— URL 会落进反代的访问日志。
		open: () =>
			ctx.http.ws(config.url, { headers: { Authorization: `Bearer ${config.token}` } }),
		// 现取:重连时报的是**那一刻**的名单,不是插件启动时的。
		bots: () => botsOf([...ctx.bots], (botId) => probed.get(botId)),
		version: VERSION,
		// 「已连上」那一行由 client 打(它手里有 BN 的版本号),这里不再重复一遍。
		onWelcome: (next) => {
			subscription = next;
		},
		deliver: (frame) =>
			deliverSend(frame, {
				botOf: (botId) => ctx.bots.find((bot) => `${bot.platform}:${bot.selfId}` === botId),
				/**
				 * 向腾讯签一张小程序卡。签不下来回 `null`,上层会退成文字 —— **别抛**:
				 * 抛了整条推送就成了失败,而其实退成文字是发得出去的。
				 */
				async signMiniApp(botId, card) {
					const bot = ctx.bots.find((b) => `${b.platform}:${b.selfId}` === botId);
					const call = bot ? onebotInternalOf(bot) : undefined;
					if (!call) return null;
					try {
						const data = arkToSegmentData(await call("get_mini_app_ark", arkRequestOf(card)));
						if (data !== null) remember(botId, { miniAppCard: "supported" });
						return data;
					} catch (err) {
						// 真发时收到 1404 也是一种证据 —— 把这个 bot 记成签不了,名单跟着更新。
						const state = readMiniAppProbe({ retcode: (err as { code?: number }).code });
						if (state === "unsupported") remember(botId, { miniAppCard: "unsupported" });
						log.warn(`签小程序卡失败:${(err as Error).message}`);
						return null;
					}
				},
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

	ctx.on("login-added", (login) => {
		pushBots();
		// 上线就探一次:探之前那一格是「还不知道」,探完了名单会再推一次带上真答案。
		void probeMiniApp(login.bot ?? {});
	});
	ctx.on("login-removed", () => pushBots());
	ctx.on("login-updated", () => pushBots());
	// 插件后装、bot 已经在线的那一路 —— 事件不会补发。
	for (const bot of ctx.bots) void probeMiniApp(bot);

	ctx.on("message", (session) => {
		// 过滤在这一侧做(协议 §8),省的是带宽与隐私;群白名单那种策略仍归 BN 判。
		const message = inboundOf(
			{
				selfId: session.selfId,
				userId: session.userId,
				channelId: session.channelId,
				isDirect: session.isDirect,
				content: session.content ?? "",
				// 分享卡(`json` / `xml` 段)只在元素里看得见,正文里没有。
				elements: session.elements ?? [],
			},
			subscription,
		);
		if (!message) return;
		client.pushInbound(`${session.platform}:${session.selfId}`, session.platform, message);
	});
}
