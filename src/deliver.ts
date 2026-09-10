/**
 * 一条 `send` 从帧到「真的发出去了」。
 *
 * 🔴 **每一条失败都要变成一句回执**:BN 那头等着它决定这条推送算成还是算败,而干等到
 * 超时的那 30 秒里,主人看到的是「推送卡着不动」—— 比一条明确的失败难查得多。
 * 所以这个函数**永远不抛**,只回 `{ ok, err }`。
 */

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
		const capabilities = capabilitiesFor(frame.platform);
		const content = renderMessage(frame.message, {
			images,
			atAll: capabilities.atAll === "supported",
			forward: capabilities.forward === "supported",
		});
		if (frame.target.scope === "private") {
			// 平台没有私聊这回事时 koishi 也没有这个方法 —— 回一句人话,别抛 TypeError。
			if (!bot.sendPrivateMessage) return { ok: false, err: `${frame.platform} 发不了私聊` };
			await bot.sendPrivateMessage(frame.target.address, content);
		} else {
			// `parentAddress` 是论坛话题 / 子频道的上级,koishi 拿它定位;没有就不传。
			await bot.sendMessage(frame.target.address, content, frame.target.parentAddress);
		}
		return { ok: true };
	} catch (err) {
		return { ok: false, err: (err as Error).message };
	}
}
