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
import { botsOf, sidOf } from "./bots";
import { capabilitiesFor } from "./capabilities";
import { createBridgeClient } from "./client";
import { deliverSend } from "./deliver";
import { DIRECT, fetchImage } from "./fetch-image";
import { inboundOf } from "./inbound";
import { arkRequestOf, arkToSegmentData, readMiniAppProbe } from "./onebot";
import { shouldProbe } from "./probe";
import { type BridgeCapabilityState, type BridgeInboundSubscription, reasonOf } from "./protocol";
import { VERSION } from "./version";

export const name = "bilibili-notify-bridge";

/** `ctx.http` 要声明才拿得到 —— 这条 WS 与取图都走它。 */
export const inject = ["http"];

/**
 * BN 还没说它要什么之前的那份订阅:**什么都不要**。握手前是它,断连之后也退回它 ——
 * 连都没连着还照着上一次的订阅把每条群消息解一遍,白烧的是主人的 CPU。
 */
const NO_INBOUND: BridgeInboundSubscription = { private: false, group: "none" };

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
	let subscription: BridgeInboundSubscription = NO_INBOUND;
	/**
	 * 探出来的能力,按 bot 记。今天只有一格:能不能签小程序卡 —— 六项里**唯一探得出来的**
	 * (它是个 API 调用,失败带 retcode;@全体那些是消息元素,适配器静默丢弃,探不出)。
	 */
	const probed = new Map<string, BridgeCapabilityState>();
	/** 手上那几发探还没回来。冷启动那几秒里三个口会挨个叫到同一个 bot。 */
	const probing = new Set<string>();

	/** onebot 的 `internal` 能调任意 action,失败抛 `SenderError` 并带 retcode。 */
	function onebotInternalOf(bot: {
		platform?: string;
		internal?: { _get?: (action: string, params?: unknown) => Promise<unknown> };
	}): ((action: string, params?: unknown) => Promise<unknown>) | undefined {
		if (bot.platform !== "onebot") return undefined;
		const get = bot.internal?._get;
		return get ? (action, params) => get.call(bot.internal, action, params) : undefined;
	}

	/**
	 * 一个抛出来的错 → 签卡口那一格的证据。`1404`/`404` = 这个实现没有它;`1400`(参数错)
	 * 或直接成功 = 它在;别的错(超时、限流)什么都证明不了。onebot 的 `SenderError` 把
	 * retcode 放在 `code` 上。
	 */
	const probeOf = (err: unknown): BridgeCapabilityState =>
		readMiniAppProbe({ retcode: (err as { code?: number }).code });

	/** 记下探到的那一格;真变了才重推名单 —— 名单是全量快照,推一份一模一样的只是白费带宽。 */
	function remember(botId: string, miniAppCard: BridgeCapabilityState): void {
		if (probed.get(botId) === miniAppCard) return;
		probed.set(botId, miniAppCard);
		pushBots();
	}

	/**
	 * 空参探一次签卡口。探不出结论的什么都不记 —— 下一个事件再探(见 `probe.ts`:冷启动
	 * 那一发必然探不出来)。
	 */
	async function probeMiniApp(bot: {
		platform?: string;
		selfId?: string;
		internal?: { _get?: (action: string, params?: unknown) => Promise<unknown> };
	}): Promise<void> {
		const botId = sidOf(bot);
		if (!shouldProbe(bot, probed.get(botId), probing.has(botId))) return;
		const call = onebotInternalOf(bot);
		// ⚠️ adapter-onebot 要等自己那条 WS 连上才给 `internal._request`(断开时还会删掉)——
		// 没有就等下一次 `login-updated`,别在这儿硬探一个必然失败的调用。
		if (!call) return;
		probing.add(botId);
		try {
			await call("get_mini_app_ark", {});
			remember(botId, "supported");
		} catch (err) {
			const state = probeOf(err);
			if (state !== "unknown") remember(botId, state);
		} finally {
			probing.delete(botId);
		}
	}

	/** 报给 BN 的那份 bot 名单,**现取**:握手、重连、名单变了,拿的都是这一刻的。 */
	const snapshot = () => botsOf([...ctx.bots], (botId) => probed.get(botId));

	/** bot 名单是**全量快照**:变了就整份重推。 */
	const pushBots = () => client.pushBots(snapshot());

	/**
	 * 按 `botId` 回查那个 bot。`ctx.bots` 本身就是一张按 `sid`(= 我们的 `botId`)索引的表,
	 * 用 koishi 自己那套查,省得我们再手拼一遍 id —— 拼歪了的症状是「配好的推送目标忽然
	 * 发不出去」。查不到通常意味着它刚掉线。
	 */
	const botBySid = (botId: string) => ctx.bots[botId];

	const client = createBridgeClient({
		url: config.url,
		// token 走 upgrade 的请求头,不进 URL —— URL 会落进反代的访问日志。
		// 🔴 **直连**(`DIRECT`):koishi 的全局代理会套到这条 WebSocket 上 —— 内网的 BN 被送进
		// 代理就连不上,token 还跟着 upgrade 头进了代理。BN 的地址是用户直接填的,怎么连到它由
		// 这个地址说了算。
		open: () =>
			ctx.http.ws(config.url, {
				headers: { Authorization: `Bearer ${config.token}` },
				...DIRECT,
			}),
		// 现取:重连时报的是**那一刻**的名单,不是插件启动时的。
		bots: snapshot,
		version: VERSION,
		// 「已连上」那一行由 client 打(它手里有 BN 的版本号),这里不再重复一遍。
		onWelcome: (next) => {
			subscription = next;
		},
		/**
		 * 🔴 断了就**退回「什么都不要」**。订阅是 BN 在 `welcome` 里下发的,断线之后它不再
		 * 代表任何人的意思 —— 留着的话每一条群消息照旧解一遍元素树,而解出来的东西没地方送
		 * (协议不补发)。重连握手会重新下发。
		 */
		onDisconnect: () => {
			subscription = NO_INBOUND;
		},
		deliver: (frame, whyUnwanted) =>
			deliverSend(frame, {
				// 往群里发之前最后问一次 BN 还要不要 —— 下图、签卡回来时它可能早判了失败。
				whyUnwanted,
				botOf: botBySid,
				// 报给 BN 的那份能力表(`bots.ts` 拼名单时用的是同一个表达式),不让投递那一层
				// 自己再算一遍 —— 两份漂开了,面板说的和真发时按的就是两回事。
				capabilitiesOf: (botId, platform) => capabilitiesFor(platform, probed.get(botId)),
				/**
				 * 向腾讯签一张小程序卡。签不下来回 `null`,上层会退成文字 —— **别抛**:
				 * 抛了整条推送就成了失败,而其实退成文字是发得出去的。
				 */
				async signMiniApp(botId, card) {
					const bot = botBySid(botId);
					const call = bot ? onebotInternalOf(bot) : undefined;
					if (!call) return null;
					try {
						const data = arkToSegmentData(await call("get_mini_app_ark", arkRequestOf(card)));
						if (data !== null) remember(botId, "supported");
						return data;
					} catch (err) {
						// 真发时收到 1404 也是一种证据 —— 把这个 bot 记成签不了,名单跟着更新。
						if (probeOf(err) === "unsupported") remember(botId, "unsupported");
						log.warn(`签小程序卡失败:${reasonOf(err)}`);
						return null;
					}
				},
				// 🔴 图必须**桥自己下载**(协议 §9):那条 URL 只保证桥自己可达,BN 常跑在
				// NAS 上,交给平台去拉是静默失败。
				fetchImage: (url) => fetchImage(ctx.http, url),
			}),
		log: { info: (message) => log.info(message), warn: (message) => log.warn(message) },
		later: (fn, ms) => ctx.setTimeout(fn, ms),
	});
	ctx.on("dispose", () => client.dispose());

	ctx.on("login-added", (login) => {
		pushBots();
		void probeMiniApp(login.bot ?? {});
	});
	ctx.on("login-removed", () => pushBots());
	ctx.on("login-updated", (login) => {
		pushBots();
		// 🔴 探也挂在这儿,而且是**唯一真探得成的那一路**:satori 派 `login-added` 在
		// `bot.start()` **之前**,那时 adapter-onebot 还没给出 `internal._request`。bot 真正
		// 上线时派的是 `login-updated` —— 漏了它那一格永远停在「还不知道」(`probe.ts`)。
		void probeMiniApp(login.bot ?? {});
	});
	// 插件后装、bot 已经在线的那一路 —— 事件不会补发。
	for (const bot of ctx.bots) void probeMiniApp(bot);

	ctx.on("message", (session) => {
		// 过滤在这一侧做(协议 §8),省的是带宽与隐私;群白名单那种策略仍归 BN 判。
		const message = inboundOf(
			{
				platform: session.platform,
				selfId: session.selfId,
				userId: session.userId,
				channelId: session.channelId,
				isDirect: session.isDirect,
				content: session.content ?? "",
				// 分享卡(`json` / `xml` 段)只在元素里看得见,正文里没有。
				elements: session.elements ?? [],
			},
			subscription,
			// 「发这条的是不是我们借出去的某个 bot」—— 查 koishi 自己那张按 `botId` 索引的表,
			// 现查不缓存:主人随时会在 koishi 里加一个 bot。
			(platform, userId) => ctx.bots[sidOf({ platform, selfId: userId })] !== undefined,
		);
		if (!message) return;
		client.pushInbound(session.sid, session.platform, message);
	});
}
