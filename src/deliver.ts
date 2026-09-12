/**
 * 一条 `send` 从帧到「真的发出去了」。
 *
 * 🔴 **每一条失败都要变成一句回执**:BN 那头等着它决定这条推送算成还是算败,而干等到
 * 超时的那 30 秒里,主人看到的是「推送卡着不动」—— 比一条明确的失败难查得多。
 * 所以这个函数**永远不抛**,只回 `{ ok, err }`。
 */

import h from "@satorijs/element";
import { imageUrlsIn, renderMessage, type RenderedImage } from "./message";
import type { BridgeCapabilityReport, BridgeSendFrame } from "./protocol";

/** koishi 的 `Bot` 上我们真用到的那几格。 */
export interface SendableBot {
	sendMessage(channelId: string, content: unknown, referrer?: string): Promise<string[]>;
	sendPrivateMessage?(userId: string, content: unknown): Promise<string[]>;
	/**
	 * 🔴 **判「这个平台有没有私聊」要看这一格,不是 `sendPrivateMessage`。** satori 的 `Bot`
	 * 基类**永远**定义 `sendPrivateMessage`(实现就是 `createDirectChannel()` 之后再
	 * `sendMessage()`),拿它当闸是**死代码**、一次都拦不下什么。没有私聊那回事的适配器
	 * 缺的是这一格 —— 症状是一句 `this.createDirectChannel is not a function`。
	 */
	createDirectChannel?(userId: string, guildId?: string): Promise<{ id: string }>;
}

export interface DeliverDeps {
	botOf(botId: string): SendableBot | undefined;
	/**
	 * 这个 bot 的能力表。**必须是握手时报给 BN 的那一份**(`bots.ts`)——这一层自己再算一遍
	 * 的话就有了两个来源:面板上写着「能 @全体」,而真发时按的是另一份表。适配器碰到不认识
	 * 的元素是**静默丢弃**的,所以两份漂开了谁也不会收到报错。
	 */
	capabilitiesOf(botId: string, platform: string): BridgeCapabilityReport;
	/** 把 BN 那条一次性 URL 取回来。取不到就抛,这一层接住。 */
	fetchImage(url: string): Promise<RenderedImage>;
	/**
	 * 向腾讯签一张小程序卡,回能塞进 `json` 段的那一串;**签不了回 `null`**(这个实现没有
	 * 那个接口、或者腾讯拒了)。没接这个口的平台压根不给。
	 */
	signMiniApp?(botId: string, card: Extract<BridgeSendFrame["message"], { kind: "miniapp-card" }>): Promise<string | null>;
}

export async function deliverSend(
	frame: BridgeSendFrame,
	deps: DeliverDeps,
): Promise<{ ok: boolean; err?: string }> {
	const bot = deps.botOf(frame.botId);
	// 名单是我们自己报上去的,所以这条通常意味着 bot 刚掉线。说清是哪个 —— BN 那头的
	// 推送目标就是按这个 id 配的。
	if (!bot) return { ok: false, err: `名单里没有 ${frame.botId} 这个 bot(掉线了?)` };

	/**
	 * 取图。两处都不是可选的:
	 *
	 * 🔴 **去重**:取图口**取过即焚**(协议 §9)。同一条 URL 在一条消息里出现两次(BN 的
	 * 复合消息里同一张卡贴两处)时取第二遍必定落空 —— 然后整条推送算失败,而图其实是好的。
	 *
	 * 🔴 **并行**:BN 最多等 30 秒(协议 §5.4)。一条 `forward-images` 十几张图排着队取,
	 * 是拿这条推送去撞那个窗口;撞上了主人看到的是「推送失败」,查不出慢在哪一步。
	 *
	 * `Promise.all` 对每一条都挂了处理器,所以第一条炸掉之后,晚到的那几条失败也有人接着 ——
	 * 没人接的话就是一条 unhandledRejection,在 koishi 里能把整个进程带走。
	 */
	const images = new Map<string, RenderedImage>();
	try {
		const fetched = await Promise.all(
			[...new Set(imageUrlsIn(frame.message))].map(async (url) => {
				try {
					return [url, await deps.fetchImage(url)] as const;
				} catch (err) {
					// 取不到就**别发**。发一条缺了图的推送,主人只会以为是 BN 出图坏了。
					throw new Error(`取图失败(${(err as Error).message}):${url}`);
				}
			}),
		);
		for (const [url, image] of fetched) images.set(url, image);
	} catch (err) {
		return { ok: false, err: (err as Error).message };
	}

	try {
		// 小程序卡要先向腾讯签一张 ark,签得下来才发真卡;签不下来落到下面的降级(文字)。
		if (frame.message.kind === "miniapp-card" && deps.signMiniApp) {
			const data = await deps.signMiniApp(frame.botId, frame.message);
			if (data !== null) {
				await sendTo(bot, frame, [h("onebot:json", { data })]);
				return { ok: true };
			}
		}
		const capabilities = deps.capabilitiesOf(frame.botId, frame.platform);
		const content = renderMessage(frame.message, {
			images,
			atAll: capabilities.atAll === "supported",
			forward: capabilities.forward === "supported",
		});
		await sendTo(bot, frame, content);
		return { ok: true };
	} catch (err) {
		return { ok: false, err: (err as Error).message };
	}
}

/** 私聊走私聊那条口,别的走频道那条。`parentAddress` 是论坛话题 / 子频道的上级。 */
async function sendTo(bot: SendableBot, frame: BridgeSendFrame, content: unknown): Promise<void> {
	if (frame.target.scope === "private") {
		// 🔴 闸判的是 `createDirectChannel`,**不是** `sendPrivateMessage`:后者 satori 的 `Bot`
		// 基类永远给,判它等于没判。没有私聊的平台缺的是前者,而它缺席时 koishi 抛的是
		// `this.createDirectChannel is not a function` —— 那句原样回给 BN,主人在推送历史里
		// 看到的是一条看不懂的 TypeError。
		if (
			typeof bot.sendPrivateMessage !== "function" ||
			typeof bot.createDirectChannel !== "function"
		) {
			throw new Error(`${frame.platform} 发不了私聊(这个适配器没有「建私聊会话」这一格)`);
		}
		await bot.sendPrivateMessage(frame.target.address, content);
		return;
	}
	await bot.sendMessage(frame.target.address, content, frame.target.parentAddress);
}
