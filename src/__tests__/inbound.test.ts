/**
 * koishi 收到的一条消息 → 要不要驮给 BN、驮成什么样(协议 §8)。
 *
 * 过滤放在**桥这一侧**,省的是带宽与隐私。三条闸各自都有「漏了会怎样」:
 * bot 自己发的漏过去 → BN 解析自己刚发的链接、无限回卡;订阅不管 → 主人的每一条群聊
 * 都上传到 BN;不含链接的群消息漏过去 → 同上,而且量大得多。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import h from "@satorijs/element";
import { type SessionLike, inboundOf } from "../inbound";
import { jsonElement, miniAppCardJson, structMsgCardJson } from "./cards";

const ALL = { private: true, group: "with-links" } as const;

/**
 * 这台 koishi 借给 BN 的那份 bot 名单(`botId` = 平台:账号)。默认两个:收消息的那个
 * 自己(`onebot:10000`),和一个兄弟 bot(`onebot:20000`)—— 同一台 koishi 借出去两个
 * QQ 号、两个都在同一个群里,是真会发生的配置。
 */
const OURS = new Set(["onebot:10000", "onebot:20000"]);
/** 生产里这一格查的是 koishi 自己那张按 `botId` 索引的表(`ctx.bots[botId]`)。 */
const isOurs = (platform: string, userId: string) => OURS.has(`${platform}:${userId}`);

function session(over: Partial<SessionLike> = {}): SessionLike {
	return {
		platform: "onebot",
		selfId: "10000",
		userId: "10086",
		channelId: "g-42",
		isDirect: false,
		content: "看看这个 https://b23.tv/x",
		...over,
	};
}

describe("排掉 bot 自己", () => {
	/** 🔴 漏了它,BN 会解析自己刚发出去的那条链接,然后再发一张卡 —— 无限回卡。 */
	it("发信人就是这个 bot → 不驮", () => {
		assert.equal(inboundOf(session({ userId: "10000" }), ALL, isOurs), null);
	});

	/**
	 * 🔴 **兄弟 bot 发的也不驮。** 同一台 koishi 借出去两个号、都在同一个群里时,A 推出去的
	 * 那条卡(里面有 B 站链接)在 B 眼里是「别人发的消息」—— 驮上去 BN 就对着自己刚发的
	 * 链接再回一张卡;链接解析的冷却配成 0 就是死循环。
	 *
	 * ⚠️ 代价是**另一个借出去的 bot 真·手动发的链接也会被丢掉**。这一头是「重复回卡 /
	 * 死循环」,那一头是「少解析一条链接」,不对称得很明显。
	 */
	it("兄弟 bot(同一台 koishi 借出去的另一个号)发的也不驮", () => {
		assert.equal(inboundOf(session({ userId: "20000" }), ALL, isOurs), null);
	});

	/** 只挡自己人:普通用户照驮,不然这条桥就白搭了。 */
	it("普通用户发的照驮", () => {
		assert.ok(inboundOf(session({ userId: "10086" }), ALL, isOurs));
	});

	/** 名单按**平台**分:别的平台上那个同号数字与我们无关。 */
	it("同号但不同平台的不算自己人", () => {
		assert.ok(inboundOf(session({ platform: "kook", userId: "20000" }), ALL, isOurs));
	});
});

/**
 * 🔴 **回传的群号 / 发送者 id 必须是非空字符串。** BN 那头这两格是 `z.string().min(1)`:
 * 缺一格(JSON 里 `undefined` 那一格直接消失)、空串、数字,都是畸形帧 → close 4003 →
 * 插件把 4003 当终局,**永不重连**。一条消息就能把整条桥打死。
 *
 * koishi 的类型说 `userId` 是 string,可运行时它就是 `event.user?.id` —— Telegram 频道帖
 * 没有发送者,那一格是 `undefined`;第三方适配器塞个数字进来也照收。
 */
describe("id 必须是 BN 收得下的字符串", () => {
	it("频道帖(没有发送者)→ 不驮,不是驮一条缺了 userId 的上去", () => {
		assert.equal(inboundOf(session({ userId: undefined }), ALL, isOurs), null);
		assert.equal(
			inboundOf(session({ isDirect: true, userId: undefined, content: "/help" }), ALL, isOurs),
			null,
		);
	});

	it("发送者是空串 → 不驮", () => {
		assert.equal(inboundOf(session({ userId: "" }), ALL, isOurs), null);
	});

	it("群号拿不到 / 是空串 → 不驮", () => {
		assert.equal(inboundOf(session({ channelId: undefined }), ALL, isOurs), null);
		assert.equal(inboundOf(session({ channelId: "" }), ALL, isOurs), null);
	});

	/** 数字的意思是清楚的 —— 转成字符串照发,别为这个把一条正常的链接丢掉。 */
	it("数字的发送者 / 群号转成字符串照发", () => {
		assert.deepEqual(inboundOf(session({ userId: 10086, channelId: 42 }), ALL, isOurs), {
			scope: "group",
			groupId: "42",
			userId: "10086",
			text: "看看这个 https://b23.tv/x",
		});
		assert.deepEqual(
			inboundOf(session({ isDirect: true, userId: 10086, content: "/help" }), ALL, isOurs),
			{ scope: "private", userId: "10086", text: "/help" },
		);
	});

	/** 布尔、对象、小数这些意思说不清的一律不回传 —— 转出来的 `"true"`、`"1.5"` 谁都不认得。 */
	it("布尔 / 对象 / 小数的 id → 不驮", () => {
		assert.equal(inboundOf(session({ userId: true }), ALL, isOurs), null);
		assert.equal(inboundOf(session({ channelId: false }), ALL, isOurs), null);
		assert.equal(inboundOf(session({ userId: { id: "1" } }), ALL, isOurs), null);
		assert.equal(inboundOf(session({ userId: 1.5 }), ALL, isOurs), null);
		assert.equal(inboundOf(session({ userId: 1e21 }), ALL, isOurs), null);
	});

	/**
	 * 🔴 「是不是自己发的」那道自检两边**过同一道归一**:bot 的账号是数字、发送者是字符串
	 * (或者反过来)时,`10000 !== "10000"`,bot 认不出自己 —— 无限回卡。
	 */
	it("bot 自己的账号与发送者类型不同 → 照样认得出是自己", () => {
		// 兄弟 bot 那道闸关掉:默认名单里就有 `onebot:10000`,留着它的话这条会被那道闸
		// 顺手挡下,钉不住自检本身。
		const nobody = () => false;
		assert.equal(inboundOf(session({ selfId: 10000, userId: "10000" }), ALL, nobody), null);
		assert.equal(inboundOf(session({ selfId: "10000", userId: 10000 }), ALL, nobody), null);
	});

	/** 兄弟 bot 那道闸拿到的也是归一之后的那个串 —— 名单上的 `botId` 是字符串拼的。 */
	it("数字的发送者照样认得出是兄弟 bot", () => {
		assert.equal(inboundOf(session({ userId: 20000 }), ALL, isOurs), null);
	});
});

describe("私聊", () => {
	it("订阅要私聊就驮上去", () => {
		assert.deepEqual(inboundOf(session({ isDirect: true, content: "/help" }), ALL, isOurs), {
			scope: "private",
			userId: "10086",
			text: "/help",
		});
	});

	it("订阅不要私聊就不驮", () => {
		assert.equal(
			inboundOf(session({ isDirect: true }), { private: false, group: "none" }, isOurs),
			null,
		);
	});
});

describe("群消息", () => {
	it("含链接的驮上去,群号用消息所在的那个频道", () => {
		assert.deepEqual(inboundOf(session(), ALL, isOurs), {
			scope: "group",
			groupId: "g-42",
			userId: "10086",
			text: "看看这个 https://b23.tv/x",
		});
	});

	/** BN 今天群里**没有指令入口**,群消息唯一的用途就是链接解析。 */
	it("不含链接的不驮 —— 不然主人的每一条群聊都上传给 BN", () => {
		assert.equal(inboundOf(session({ content: "今天天气不错" }), ALL, isOurs), null);
	});

	it("订阅说群消息一条都不要,含链接的也不驮", () => {
		assert.equal(inboundOf(session(), { private: true, group: "none" }, isOurs), null);
	});
});

describe("正文", () => {
	/** koishi 的 content 里带着元素标记,原样驮上去 BN 会把 `<img …/>` 当正文解析。 */
	it("元素标记剥掉,只留人说的那些字", () => {
		const out = inboundOf(
			session({ content: '看看 <img src="http://x/y.png"/> https://b23.tv/x' }),
			ALL,
			isOurs,
		);
		assert.ok(out && !out.text.includes("<img"));
		assert.ok(out?.text.includes("https://b23.tv/x"));
	});

	it("剥完只剩空白就不驮(一张图配一条链接才算数)", () => {
		assert.equal(inboundOf(session({ content: '<img src="http://x/y.png"/>' }), ALL, isOurs), null);
	});

	/**
	 * 🔴 **引用的那段不是用户敲的**(协议 §5.3:`text` 只是用户敲的那句话)。koishi 把被回复的
	 * 那条整个放进 `<quote>` 的子元素里,深选 text 会把它一起捞出来 —— 症状是主人回复一条
	 * 三天前的视频链接说「这个我看过」,BN 对着那条老链接又回一张卡。
	 */
	it("回复引用的那段不算正文", () => {
		const quoted = h("quote", { id: "9" }, "老链接 https://b23.tv/old").toString();
		const out = inboundOf(
			session({ content: `${quoted}这个我看过 https://b23.tv/new` }),
			ALL,
			isOurs,
		);
		assert.equal(out?.text, "这个我看过 https://b23.tv/new");
	});

	it("链接只在引用里、自己没敲 → 不驮", () => {
		const quoted = h("quote", { id: "9" }, "老链接 https://b23.tv/old").toString();
		assert.equal(inboundOf(session({ content: `${quoted}这个我看过` }), ALL, isOurs), null);
	});
});

describe("分享卡", () => {
	const card = (url: string) => jsonElement(structMsgCardJson(url));
	const miniApp = (url: string) => jsonElement(miniAppCardJson(url));

	/**
	 * 🔴 **卡里的链接放 `cardLinks`,不拼进正文**(协议 1.4)。拼进正文就等于告诉 BN
	 * 「这是用户敲的一条普通链接」—— 正文那一格从此不再是用户敲的那句话,而小程序卡更糟:
	 * BN 会对着一张已经能点开播放的卡再回一张。
	 */
	it("卡里的链接单独一格,正文不被污染(正文本来是空的也驮)", () => {
		const out = inboundOf(
			session({ content: "", elements: [card("https://b23.tv/aaa")] }),
			ALL,
			isOurs,
		);
		assert.deepEqual(out, {
			scope: "group",
			groupId: "g-42",
			userId: "10086",
			text: "",
			cardLinks: ["https://b23.tv/aaa"],
		});
	});

	it("正文里本来有话 → 正文照旧只有那句话", () => {
		assert.deepEqual(
			inboundOf(
				session({ content: "看这个", elements: [card("https://b23.tv/bbb")] }),
				ALL,
				isOurs,
			),
			{
				scope: "group",
				groupId: "g-42",
				userId: "10086",
				text: "看这个",
				cardLinks: ["https://b23.tv/bbb"],
			},
		);
	});

	/** 群里已经有一张能点开播放的卡了 —— BN 读得出这一格就不会再回一张。 */
	it("小程序卡的链接进 miniAppCardLinks,不进 cardLinks、也不进正文", () => {
		const out = inboundOf(
			session({ content: "", elements: [miniApp("https://b23.tv/ccc")] }),
			ALL,
			isOurs,
		);
		assert.deepEqual(out, {
			scope: "group",
			groupId: "g-42",
			userId: "10086",
			text: "",
			miniAppCardLinks: ["https://b23.tv/ccc"],
		});
	});

	/**
	 * 群消息那道「含链接才驮」的闸要把两格算进去。漏了它,一张正文为空的分享卡就被挡在
	 * 桥这一侧 —— 症状是「群里转 B 站卡片 BN 一声不吭」,而 BN 那头什么日志都没有。
	 */
	it("正文没链接、只有小程序卡 → 照样驮(闸要看两格)", () => {
		assert.ok(
			inboundOf(
				session({ content: "看这个", elements: [miniApp("https://b23.tv/e")] }),
				ALL,
				isOurs,
			),
		);
	});

	/** 没卡的消息不多带两格空数组上去 —— 群消息是这条桥最大的一股流量。 */
	it("没有卡就一格都不带", () => {
		assert.deepEqual(inboundOf(session(), ALL, isOurs), {
			scope: "group",
			groupId: "g-42",
			userId: "10086",
			text: "看看这个 https://b23.tv/x",
		});
	});

	/** 私聊只有指令,指令不认链接 —— 协议私聊那一支没有这两格,别顺手拼进正文。 */
	it("私聊里的卡不拼进正文;剥完没话就不驮", () => {
		assert.equal(
			inboundOf(
				session({ isDirect: true, content: "", elements: [card("https://b23.tv/f")] }),
				ALL,
				isOurs,
			),
			null,
		);
		assert.deepEqual(
			inboundOf(
				session({ isDirect: true, content: "/help", elements: [card("https://b23.tv/f")] }),
				ALL,
				isOurs,
			),
			{ scope: "private", userId: "10086", text: "/help" },
		);
	});
});
