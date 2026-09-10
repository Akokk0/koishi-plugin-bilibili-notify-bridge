/**
 * 一条 `send` 从帧到「真的发出去了」。
 *
 * 🔴 **每一条失败都要变成一句回执**:BN 那头等着它决定这条推送算成还是算败,而干等到
 * 超时的那 30 秒里,主人看到的是「推送卡着不动」—— 比一条明确的失败难查得多。
 * 所以这个函数**永远不抛**,只回 `{ ok, err }`。
 */

import h from "@satorijs/element";
import { capabilitiesFor } from "./capabilities";
import { imageUrlsIn, renderMessage, type RenderedImage } from "./message";
import type { BridgeSendFrame } from "./protocol";

/** koishi 的 `Bot` 上我们真用到的那两格。 */
export interface SendableBot {
	sendMessage(channelId: string, content: unknown, referrer?: string): Promise<string[]>;
	sendPrivateMessage?(userId: string, content: unknown): Promise<string[]>;
}

export interface DeliverDeps {
	botOf(botId: string): SendableBot | undefined;
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

	const images = new Map<string, RenderedImage>();
	for (const url of imageUrlsIn(frame.message)) {
		try {
			images.set(url, await deps.fetchImage(url));
		} catch (err) {
			// 取不到就**别发**。发一条缺了图的推送,主人只会以为是 BN 出图坏了。
			return { ok: false, err: `取图失败(${(err as Error).message}):${url}` };
		}
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
		const capabilities = capabilitiesFor(frame.platform);
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
		// 平台没有私聊这回事时 koishi 也没有这个方法 —— 回一句人话,别抛 TypeError。
		if (!bot.sendPrivateMessage) throw new Error(`${frame.platform} 发不了私聊`);
		await bot.sendPrivateMessage(frame.target.address, content);
		return;
	}
	await bot.sendMessage(frame.target.address, content, frame.target.parentAddress);
}
