/**
 * 那条长连接的行为 —— 协议 §12「最小实现清单」里除了「真的连得上」之外的每一条。
 *
 * socket 是**注入口**(生产里是 koishi 的 `ctx.http.ws`),这里给一个记账的替身:要钉的是
 * 「什么时候发什么帧、断了要不要回去」,而不是 TCP。真的连得上由真机验。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
	BRIDGE_SILENCE_LIMIT_MS,
	createBridgeClient,
	MAX_CONCURRENT_SENDS,
	type SocketLike,
	STABLE_SESSION_MS,
} from "../client";
import { BRIDGE_PROTOCOL_VERSION, MAX_ERR_CHARS, SEND_RESULT_WINDOW_MS } from "../protocol";

class FakeSocket implements SocketLike {
	sent: Record<string, unknown>[] = [];
	closed?: { code?: number };
	private handlers: Record<string, ((ev: never) => void)[]> = {};

	send(data: string): void {
		this.sent.push(JSON.parse(data) as Record<string, unknown>);
	}
	close(code?: number): void {
		this.closed = { code };
	}
	addEventListener(type: string, fn: (ev: never) => void): void {
		(this.handlers[type] ??= []).push(fn);
	}
	fire(type: string, ev?: unknown): void {
		for (const fn of this.handlers[type] ?? []) fn(ev as never);
	}
	/** BN 说了一句话。 */
	say(frame: unknown): void {
		this.fire("message", { data: JSON.stringify(frame) });
	}
	last(type: string): Record<string, unknown> | undefined {
		return [...this.sent].reverse().find((f) => f.type === type);
	}
	count(type: string): number {
		return this.sent.filter((f) => f.type === type).length;
	}
}

const SILENT = { info() {}, warn() {} };
const BOTS = [{ botId: "discord:1", platform: "discord" }];
const WELCOME = {
	type: "welcome",
	protocol: { major: 1, minor: 1 },
	server: { version: "9.9.9" },
	inbound: { private: true, group: "with-links" },
};
const SEND = {
	type: "send",
	id: "s-1",
	botId: "discord:1",
	platform: "discord",
	target: { scope: "group", address: "g-1" },
	message: { kind: "text", text: "开播啦" },
};

let sockets: FakeSocket[];
let timers: Array<{ fn: () => void; ms: number }>;

function client(over: Partial<Parameters<typeof createBridgeClient>[0]> = {}) {
	return createBridgeClient({
		open: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		url: "ws://bn/ext/bridge",
		bots: () => BOTS,
		version: "0.0.1",
		deliver: async () => ({ ok: true }),
		onWelcome: () => {},
		log: SILENT,
		backoff: () => 10,
		// 撤销要**真的**把它摘掉 —— `timers` 是「眼下还排着什么」的账本,撤了还留着的话
		// 「断了之后该不该重连」那几条就只能数到一堆早就作废的定时器。
		later: (fn, ms) => {
			const entry = { fn, ms };
			timers.push(entry);
			return () => {
				const at = timers.indexOf(entry);
				if (at >= 0) timers.splice(at, 1);
			};
		},
		...over,
	});
}

/** 把 warn 说过的每一句记下来 —— 「失败的原因不许吞」那几条全靠对着它断言。 */
function recording(): { said: string[]; log: { info(m: string): void; warn(m: string): void } } {
	const said: string[] = [];
	return { said, log: { info: () => {}, warn: (m: string) => said.push(m) } };
}

/** 让投递那条 async 链跑完。用 `setTimeout` 而不是 `setImmediate`:排在 promise 队列后面。 */
const settle = () => new Promise((r) => setTimeout(r, 5));

/** 排在最后的那个定时器 = 刚安排的重连。 */
function fireTimer(): void {
	const timer = timers.pop();
	assert.ok(timer, "没安排重连");
	timer.fn();
}

/** 眼下排着的那只看门狗(没有就是 undefined)。 */
function watchdog(): { fn: () => void; ms: number } | undefined {
	return timers.find((timer) => timer.ms === BRIDGE_SILENCE_LIMIT_MS);
}

function connect(over = {}) {
	const c = client(over);
	sockets[0]?.fire("open");
	sockets[0]?.say(WELCOME);
	return c;
}

beforeEach(() => {
	sockets = [];
	timers = [];
});

describe("握手", () => {
	it("连上第一帧就是 hello,带协议版本与全量 bot 名单", () => {
		client();
		sockets[0]?.fire("open");
		assert.deepEqual(sockets[0]?.sent[0], {
			type: "hello",
			// 报的就是这个插件声明的那一版。写死一个字面量的话每升一次 minor 都得来改一次,
			// 而改完什么也没多证明 —— 版本号本身对不对由 PROTOCOL.md 与 BN 的 major 判定说了算。
			protocol: BRIDGE_PROTOCOL_VERSION,
			bridge: { kind: "koishi", name: "koishi", version: "0.0.1" },
			bots: BOTS,
		});
	});

	it("welcome 里的入站订阅交出去 —— 之后按它过滤", () => {
		let got: unknown;
		connect({ onWelcome: (sub: unknown) => (got = sub) });
		assert.deepEqual(got, { private: true, group: "with-links" });
	});

	/**
	 * 🔴 地址填错(少个 `ws://`)时 `ctx.http.ws` **当场抛** `Invalid URL`。不接住的话:这一轮
	 * 没有 socket、也没人安排重连,插件从此再不连了;而且这一抛是从重连定时器里出去的,
	 * 没人接得住(uncaughtException)。
	 */
	it("开连接就抛 → 说出原因并照常退避重连,不就此装死", () => {
		const { said, log } = recording();
		let thrown = false;
		client({
			log,
			open: () => {
				if (!thrown) {
					thrown = true;
					throw new TypeError("Invalid URL");
				}
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket;
			},
		});
		assert.equal(timers.length, 1, "开连接抛了之后没人安排重连");
		assert.ok(
			said.some((line) => line.includes("Invalid URL")),
			`只说了:${said.join(" | ")}`,
		);
		fireTimer();
		assert.equal(sockets.length, 1, "没回去重连");
	});
});

describe("活着", () => {
	it("BN 催一声就回一声", () => {
		connect();
		sockets[0]?.say({ type: "ping" });
		assert.deepEqual(sockets[0]?.last("pong"), { type: "pong" });
	});

	it("带 id 的 ping 是面板在探活:pong 原样回 id,BN 才量得出这一趟的往返", () => {
		connect();
		sockets[0]?.say({ type: "ping", id: "probe-1" });
		assert.deepEqual(sockets[0]?.last("pong"), { type: "pong", id: "probe-1" });
	});

	it("不认识的帧当没看见,连接照旧", () => {
		connect();
		sockets[0]?.say({ type: "从未来来的帧" });
		sockets[0]?.say({ type: "ping" });
		assert.ok(sockets[0]?.last("pong"));
	});

	/**
	 * 🔴 `null` 与 `123` 都是**合法 JSON**,但都不是帧。不挡的话读 `.type` 当场抛在 ws 的回调
	 * 里 —— 那里没人接得住,整个 koishi 收一发 uncaughtException。
	 */
	it("是 JSON 但不是对象(null / 数字)→ 忽略,不炸也不投递", async () => {
		let delivered = 0;
		connect({
			deliver: async () => {
				delivered += 1;
				return { ok: true };
			},
		});
		sockets[0]?.say(null);
		sockets[0]?.say(123);
		await settle();
		assert.equal(delivered, 0, "拿不是帧的东西去投递了");
		// 还活着:下一帧照认。
		sockets[0]?.say({ type: "ping" });
		assert.ok(sockets[0]?.last("pong"), "被一帧垃圾打死了");
	});
});

describe("投递", () => {
	it("发成功 → 回执 ok", async () => {
		connect();
		sockets[0]?.say(SEND);
		await settle();
		assert.deepEqual(sockets[0]?.last("result"), { type: "result", id: "s-1", ok: true });
	});

	/** 🔴 **发不出去也一定要回执**。不回的话 BN 那头只能等到超时,而超时那 30 秒里
	 * 主人看到的是「推送卡着不动」——比一条明确的失败难查得多。 */
	it("发失败 → 回执带着那句理由,不是干等超时", async () => {
		connect({ deliver: async () => ({ ok: false, err: "群被禁言了" }) });
		sockets[0]?.say(SEND);
		await settle();
		assert.deepEqual(sockets[0]?.last("result"), {
			type: "result",
			id: "s-1",
			ok: false,
			err: "群被禁言了",
		});
	});

	it("投递里抛了异常也照回执 —— 异常不是「不回」的理由", async () => {
		connect({
			deliver: async () => {
				throw new Error("bot 掉线了");
			},
		});
		sockets[0]?.say(SEND);
		await settle();
		const result = sockets[0]?.last("result");
		assert.equal(result?.ok, false);
		assert.match(String(result?.err), /掉线/);
	});
});

/**
 * 回执里那句原因(`err`)。它会原样出现在 BN 的推送历史里,是主人手里唯一的线索 ——
 * 所以两头都不能出事:太长了把桥打断线,空了等于什么都没说。
 */
describe("回执里的原因", () => {
	/** 拿一条 `send` 过去,回来那条回执的 `err`。 */
	async function errOf(deliver: Parameters<typeof client>[0]["deliver"]): Promise<unknown> {
		connect({ deliver });
		sockets[0]?.say(SEND);
		await settle();
		const result = sockets[0]?.last("result");
		assert.equal(result?.ok, false, "该是一条失败的回执");
		return result?.err;
	}

	/**
	 * 🔴 BN 的单帧上限是 1 MiB,超了 ws 直接关 1009 —— 一句异常原文(整页 HTML 的报错、一条
	 * data: 地址)就能把整条桥打断线。**只在出口截一次**:截两次的话「后面还有 N 字」就成了
	 * 截断注明自己的长度。
	 */
	it("投递回来的原因太长 → 截到上限,并注明后面还有多少字", async () => {
		const err = await errOf(async () => ({ ok: false, err: "嗯".repeat(5000) }));
		assert.equal(err, `${"嗯".repeat(MAX_ERR_CHARS)}…(后面还有 4000 字)`);
	});

	it("投递自己抛出来的原因太长 → 同一个出口,照样截", async () => {
		const err = await errOf(async () => {
			throw new Error("啊".repeat(5000));
		});
		assert.equal(err, `${"啊".repeat(MAX_ERR_CHARS)}…(后面还有 4000 字)`);
	});

	/**
	 * 🔴 satori 发送失败抛的是它自己的 `AggregateError`,**它自己的 message 恒为空串**,真正的
	 * 原因在 `.errors` 里。只读 `.message` 的话,主人在推送历史里看到的是一条没有理由的失败。
	 */
	it("satori 的 AggregateError(message 是空串)→ 把 .errors 里每一条的原因说出来", async () => {
		// 照 `@satorijs/core` 的原样:自己的类、不是全局那个 AggregateError。
		class AggregateError extends Error {
			constructor(public errors: Error[]) {
				super("");
			}
		}
		const err = await errOf(async () => {
			throw new AggregateError([new Error("群被禁言了"), new Error("消息太长")]);
		});
		assert.match(String(err), /群被禁言了/);
		assert.match(String(err), /消息太长/);
	});

	/**
	 * 🔴 onebot 的 `SenderError` 把**整条消息参数**连同 base64 的图一起 stringify 进 message ——
	 * 回执里就是几 MB 的 base64,截完也是一千个没人看得懂的字,真正的 retcode 被截在后面。
	 */
	it("原因里的 base64 图整段换成一个短占位", async () => {
		const blob = "iVBORw0KGgo".repeat(400);
		const err = String(
			await errOf(async () => {
				throw new Error(
					`Error with request send_group_msg, args: {"message":[{"type":"image","data":{"file":"base64://${blob}"}},{"type":"image","data":{"file":"data:image/png;base64,${blob}"}}]}, retcode: 1200`,
				);
			}),
		);
		assert.ok(!err.includes("iVBORw0KGgo"), `base64 还在:${err.slice(0, 200)}`);
		assert.match(err, /\[base64 图片\]/);
		assert.match(err, /retcode: 1200/, "真正有用的那半句被吞了");
	});

	/** 空串 = 没说原因。`??` 拦不住空串 —— 回执里一个空的 err,等于告诉主人「失败了,不知道为什么」却连这句都不说。 */
	it("投递回来的原因是空串 → 回兜底那句,不是一个空的 err", async () => {
		const err = await errOf(async () => ({ ok: false, err: "" }));
		assert.equal(typeof err, "string");
		assert.match(String(err), /发不出去/);
	});

	it("抛出来的异常没有原话 → 至少说出它是什么异常", async () => {
		const err = await errOf(async () => {
			throw new TypeError("");
		});
		assert.equal(err, "TypeError");
	});
});

/**
 * 同时在跑的投递有上限。每条都把要发的图整张读进内存(一张最多 16 MiB,交给适配器时还要再
 * base64 一遍)—— BN 把一张卡推给三十个群,条条同时开跑,小机器上的 koishi 就被撑爆了。
 */
describe("投递名额", () => {
	/** 每条投递都挂着,由测试决定什么时候放行。 */
	function gated() {
		const started: string[] = [];
		const finish: Array<() => void> = [];
		const deliver = (frame: { id: string }) =>
			new Promise<{ ok: boolean }>((resolve) => {
				started.push(frame.id);
				finish.push(() => resolve({ ok: true }));
			});
		return { started, finish, deliver };
	}

	const sendOf = (n: number) => ({ ...SEND, id: `s-${n}` });

	/** 把 info 也记下来 —— 「不发了」那一行是主人唯一能看见这条去向的地方。 */
	function infoLog() {
		const said: string[] = [];
		return { said, log: { info: (m: string) => said.push(m), warn: () => {} } };
	}

	it(`同时最多 ${MAX_CONCURRENT_SENDS} 条在投,其余排队;放掉一条补上一条`, async () => {
		const g = gated();
		connect({ deliver: g.deliver });
		for (let n = 0; n < MAX_CONCURRENT_SENDS + 2; n++) sockets[0]?.say(sendOf(n));
		await settle();
		assert.equal(g.started.length, MAX_CONCURRENT_SENDS, "名额没拦住");

		g.finish[0]?.();
		await settle();
		assert.equal(g.started.length, MAX_CONCURRENT_SENDS + 1, "放掉一条之后排着的没补上");
		// 回执写在名额外面,先放掉的那条已经回了。
		assert.equal(sockets[0]?.count("result"), 1);

		for (const go of g.finish.slice(1)) go();
		await settle();
		for (const go of g.finish.slice(MAX_CONCURRENT_SENDS + 1)) go();
		await settle();
		assert.equal(sockets[0]?.count("result"), MAX_CONCURRENT_SENDS + 2, "有的 send 没回执");
	});

	/** 投递抛了也得把名额还回来 —— 不然抛满四次,这条桥就再也不投递了。 */
	it("投递抛了异常,名额照样还回来", async () => {
		let calls = 0;
		connect({
			deliver: async () => {
				calls += 1;
				throw new Error("炸了");
			},
		});
		for (let n = 0; n < MAX_CONCURRENT_SENDS * 2 + 1; n++) sockets[0]?.say(sendOf(n));
		await settle();
		assert.equal(calls, MAX_CONCURRENT_SENDS * 2 + 1, "抛过异常的投递把名额占死了");
	});

	/**
	 * 🔴 排队期间连接断过:断线那一刻 BN 已经把在飞的全部判了失败(协议 §5.4),主人可能已经
	 * 人工重推了 —— 这时再发,同一条推送在群里出现两次。
	 */
	it("排队期间连接换了 → 轮到时不投递、不回执,记一行", async () => {
		const g = gated();
		const { said, log } = infoLog();
		connect({ deliver: g.deliver, log });
		for (let n = 0; n < MAX_CONCURRENT_SENDS + 1; n++) sockets[0]?.say(sendOf(n));
		await settle();

		sockets[0]?.fire("close", { code: 1006 });
		fireTimer();
		sockets[1]?.fire("open");
		sockets[1]?.say(WELCOME);

		for (const go of g.finish) go();
		await settle();
		assert.ok(!g.started.includes(`s-${MAX_CONCURRENT_SENDS}`), "连接换过了还把排着的那条投出去了");
		assert.ok(
			![...(sockets[0]?.sent ?? []), ...(sockets[1]?.sent ?? [])].some(
				(f) => f.type === "result" && f.id === `s-${MAX_CONCURRENT_SENDS}`,
			),
			"没投递的那条回了执",
		);
		assert.ok(
			said.some((line) => line.includes(`s-${MAX_CONCURRENT_SENDS}`)),
			`没说那条去哪了:${said.join(" | ")}`,
		);
	});

	/** 排队等的那段也算在 BN 的回执窗口里:过了 30 秒它已经判失败了,再发就和人工重推撞车。 */
	it(`排队超过 ${SEND_RESULT_WINDOW_MS}ms → 轮到时不投递、不回执,记一行`, async () => {
		const g = gated();
		const { said, log } = infoLog();
		let clock = 0;
		connect({ deliver: g.deliver, log, now: () => clock });
		for (let n = 0; n < MAX_CONCURRENT_SENDS; n++) sockets[0]?.say(sendOf(n));
		sockets[0]?.say(sendOf(98));
		clock += SEND_RESULT_WINDOW_MS - 1;
		sockets[0]?.say(sendOf(99));
		await settle();

		// 放掉一条:s-98 已经排满了窗口,不发;放掉第二条:s-99 还差一毫秒,照发。
		clock += 1;
		g.finish[0]?.();
		await settle();
		assert.ok(!g.started.includes("s-98"), "排过了回执窗口还投递了");
		assert.ok(!sockets[0]?.sent.some((f) => f.type === "result" && f.id === "s-98"));
		assert.ok(said.some((line) => line.includes("s-98")), `没说那条去哪了:${said.join(" | ")}`);

		g.finish[1]?.();
		await settle();
		assert.ok(g.started.includes("s-99"), "没排满窗口的那条被错杀了");
	});

	/** 收摊了,排着的就不该再投 —— 插件都卸载了还在往群里发。 */
	it("收摊时排队的全部放掉,不投递", async () => {
		const g = gated();
		const c = connect({ deliver: g.deliver });
		for (let n = 0; n < MAX_CONCURRENT_SENDS + 2; n++) sockets[0]?.say(sendOf(n));
		await settle();
		c.dispose();
		for (const go of g.finish) go();
		await settle();
		assert.equal(g.started.length, MAX_CONCURRENT_SENDS, "收摊之后排着的还是被投递了");
	});
});

describe("名单变了", () => {
	it("推一份全量快照上去", () => {
		const c = connect();
		c.pushBots([{ botId: "kook:2", platform: "kook" }]);
		assert.deepEqual(sockets[0]?.last("bots"), {
			type: "bots",
			bots: [{ botId: "kook:2", platform: "kook" }],
		});
	});

	it("还没连上就变了 → 不发,等握手时随 hello 报上去", () => {
		const c = client();
		c.pushBots([{ botId: "kook:2", platform: "kook" }]);
		assert.equal(sockets[0]?.sent.length, 0);
	});

	/**
	 * 🔴 koishi 的 `login-updated` 每一次状态翻转都会响,而 bot 线上形状里**没有状态这一格** ——
	 * 一个连不上的 bot 抖一分钟,就是十几份一模一样的 KB 级帧。名单是全量快照,一样的那份
	 * 再推一遍什么也没多说。
	 */
	it("同一份名单推两次只发一次 —— 抖一抖不该刷屏", () => {
		const c = connect();
		c.pushBots([{ botId: "kook:2", platform: "kook" }]);
		c.pushBots([{ botId: "kook:2", platform: "kook" }]);
		assert.equal(sockets[0]?.count("bots"), 1);
	});

	it("名单真变了就发", () => {
		const c = connect();
		c.pushBots([{ botId: "kook:2", platform: "kook" }]);
		c.pushBots([
			{ botId: "kook:2", platform: "kook" },
			{ botId: "kook:3", platform: "kook" },
		]);
		assert.equal(sockets[0]?.count("bots"), 2);
	});

	/** 换了一条连接就得从头说一遍 —— 新的那头什么都不知道(hello 只报了握手那一刻的)。 */
	it("重连之后同一份名单照发", () => {
		const c = connect();
		c.pushBots([{ botId: "kook:2", platform: "kook" }]);
		sockets[0]?.fire("close", { code: 1006 });
		fireTimer();
		sockets[1]?.fire("open");
		sockets[1]?.say(WELCOME);
		c.pushBots([{ botId: "kook:2", platform: "kook" }]);
		assert.equal(sockets[1]?.count("bots"), 1, "重连之后把名单咽下去了");
	});
});

describe("断了之后", () => {
	it("普通断线 → 退避重连,回去还是先 hello", () => {
		connect();
		sockets[0]?.fire("close", { code: 1006 });
		fireTimer();
		assert.equal(sockets.length, 2);
		sockets[1]?.fire("open");
		assert.equal(sockets[1]?.sent[0]?.type, "hello");
	});

	/** 这几档再试一次也是同样的结果,该把错显示给用户,而不是拿同样的 token 去捶 BN。 */
	for (const code of [4001, 4002, 4005, 4006]) {
		it(`BN 拿 ${code} 断的 → 就此打住`, () => {
			connect();
			sockets[0]?.fire("close", { code });
			assert.equal(timers.length, 0, `close ${code} 之后不该再重连`);
		});
	}

	/**
	 * 协议 §10:4003(我们发了形状不对的帧)与 4004(10 秒内没握手)是**插件自己的 bug**。
	 * 跟用户的配置一点关系都没有 —— 把这两档说成「配置那头的事」,只会让人去翻一份没问题的配置。
	 */
	for (const code of [4003, 4004]) {
		it(`BN 拿 ${code} 断的 → 说清楚这是插件的 bug,不是配置`, () => {
			const { said, log } = recording();
			connect({ log });
			sockets[0]?.fire("close", { code });
			assert.equal(timers.length, 0, `close ${code} 之后不该再重连`);
			assert.ok(
				said.some((line) => line.includes("插件")),
				`没说这是插件的 bug:${said.join(" | ")}`,
			);
			assert.ok(
				!said.some((line) => line.includes("配置")),
				`把插件的 bug 说成了配置问题:${said.join(" | ")}`,
			);
		});
	}

	/** 4007 是「这条接入被停用了」—— 主人把开关拨回来,它就该自己回去。 */
	it("接入被停用(4007)照样退避重连", () => {
		connect();
		sockets[0]?.fire("close", { code: 4007 });
		assert.equal(timers.length, 1);
	});

	/**
	 * 🔴 **按「握完手」清零不够**:BN 收下 hello、回了 welcome、转手又把连接断掉(断的码又是
	 * 该重连的那种)时,每一轮都握过手 —— 照握手清零的话,这个循环永远用最短的 0.5 秒去捶 BN。
	 */
	it("握完手转手就被踢的循环,退避照样往上涨", () => {
		const asked: number[] = [];
		client({
			backoff: (attempt) => {
				asked.push(attempt);
				return 10;
			},
			now: () => 0,
		});
		for (let round = 0; round < 4; round++) {
			sockets[round]?.fire("open");
			sockets[round]?.say(WELCOME);
			sockets[round]?.fire("close", { code: 1011 });
			fireTimer();
		}
		assert.deepEqual(asked, [0, 1, 2, 3], "握完手就被踢的循环,退避没往上涨");
	});

	/**
	 * 连接**稳稳地跑过一阵**才算真的好了:那之后再断就是一次新的意外,从最短那档重新数 ——
	 * 不然 BN 重启一次,插件要背着上一次断网攒下的 30 秒才回得去。「一阵」从 welcome 起算。
	 */
	it("握完手稳稳跑满 STABLE_SESSION_MS 再断,退避从头数;差一点都不算", () => {
		const asked: number[] = [];
		let clock = 0;
		client({
			backoff: (attempt) => {
				asked.push(attempt);
				return 10;
			},
			now: () => clock,
		});
		// 先连不上两次,把退避攒起来。
		for (let round = 0; round < 2; round++) {
			sockets[round]?.fire("close", { code: 1006 });
			fireTimer();
		}
		assert.deepEqual(asked, [0, 1]);

		// 握完手撑了差一毫秒就断:还不算稳,接着往上数。welcome 来得晚 —— 从 socket 开起算
		// 早就够了,从 welcome 起算还差一点。
		sockets[2]?.fire("open");
		clock += 30_000;
		sockets[2]?.say(WELCOME);
		clock += STABLE_SESSION_MS - 1;
		sockets[2]?.fire("close", { code: 1006 });
		assert.equal(asked.at(-1), 2, "没稳住的连接一断,退避就从头数了");
		fireTimer();

		// 这一条稳稳跑满了:断了从最短那档重新数。
		sockets[3]?.fire("open");
		sockets[3]?.say(WELCOME);
		clock += STABLE_SESSION_MS;
		sockets[3]?.fire("close", { code: 1006 });
		assert.equal(asked.at(-1), 0, "跑满了一阵的连接断了,退避还背着旧账");
	});

	/** 被看门狗踢掉那一路也看同一个判据 —— 它和收到一个 close 没有区别。 */
	it("稳稳跑满之后被看门狗踢掉,也从头数", () => {
		const asked: number[] = [];
		let clock = 0;
		client({
			backoff: (attempt) => {
				asked.push(attempt);
				return 10;
			},
			now: () => clock,
		});
		sockets[0]?.fire("close", { code: 1006 });
		fireTimer();
		sockets[1]?.fire("open");
		sockets[1]?.say(WELCOME);
		clock += STABLE_SESSION_MS;
		watchdog()?.fn();
		assert.deepEqual(asked, [0, 0]);
	});

	/**
	 * 🔴 **主人 2026-09-10 真机第一次连就撞上这个**:日志里只有一句「连接出错」,没有任何
	 * 线索。事件里带着真正的原因(`ECONNREFUSED` / `Unexpected server response: 401` …),
	 * 吞掉它等于让人对着一台连不上的 BN 猜半天。
	 */
	it("连不上时把真正的原因说出来,不是一句「连接出错」", () => {
		const { said, log } = recording();
		client({ log });
		sockets[0]?.fire("error", { message: "connect ECONNREFUSED 127.0.0.1:8787" });
		assert.ok(
			said.some((line) => line.includes("ECONNREFUSED")),
			`只说了:${said.join(" | ")}`,
		);
	});

	it("原因藏在 error 字段里也捞得出来", () => {
		const { said, log } = recording();
		client({ log });
		sockets[0]?.fire("error", { error: new Error("getaddrinfo ENOTFOUND nas") });
		assert.ok(
			said.some((line) => line.includes("ENOTFOUND")),
			`只说了:${said.join(" | ")}`,
		);
	});

	/** 握手完了之后再出错,说「连不上 <地址>」是把人往地址 / 防火墙那头带 —— 那地址明明通着。 */
	it("已经连上之后报的错不说「连不上」,但原因照说", () => {
		const { said, log } = recording();
		connect({ log });
		sockets[0]?.fire("error", { message: "read ECONNRESET" });
		assert.ok(
			said.some((line) => line.includes("ECONNRESET")),
			`只说了:${said.join(" | ")}`,
		);
		assert.ok(
			!said.some((line) => line.includes("连不上")),
			`都连上了还说连不上:${said.join(" | ")}`,
		);
	});

	/**
	 * 🔴 协议 §2:**401 是「别再试了」**。upgrade 被拒时 close code 是 1006(看着像普通断线),
	 * 照 close code 判的话 token 填错就会**永远捶 BN**,而屏幕上什么有用的都没有。
	 */
	it("token 不对(401)→ 就此打住,不去捶 BN", () => {
		const { said, log } = recording();
		client({ log });
		sockets[0]?.fire("error", { message: "Unexpected server response: 401" });
		sockets[0]?.fire("close", { code: 1006 });
		assert.equal(timers.length, 0, "401 之后还在重连");
		assert.ok(said.some((line) => line.includes("401")));
	});

	/** 404 = 这台 BN 上眼下没有桥在跑;503 = 这条接入停用了。都是拨一下就好,该重连。 */
	for (const status of [404, 503]) {
		it(`upgrade 被 ${status} 拒了 → 照样退避重连`, () => {
			client();
			sockets[0]?.fire("error", { message: `Unexpected server response: ${status}` });
			sockets[0]?.fire("close", { code: 1006 });
			assert.equal(timers.length, 1, `${status} 之后该重连`);
		});
	}

	/**
	 * 🔴 **「连着」不等于「通着」**。NAT / 家宽 / 休眠的路由器会把一条闲着的 TCP 静默掐断:
	 * 两头都不会收到 FIN,`close` 事件永远不来。BN 每 30 秒催一声,可我们从来不检查
	 * 「多久没听见它说话了」的话,`connected()` 就恒为 true —— 插件以为自己在岗,BN 那头
	 * 90 秒后把会话清了,推送全部失败,而 koishi 的日志里一个字都没有。
	 */
	it("BN 三个心跳没说过话 → 主动断掉,走既有的退避重连", () => {
		const c = connect();
		const dog = watchdog();
		assert.ok(dog, "没给这条连接排看门狗");

		dog.fn();
		assert.equal(c.connected(), false, "还以为自己连着");
		assert.ok(sockets[0]?.closed, "那条死 socket 没被关掉");
		fireTimer();
		assert.equal(sockets.length, 2, "没回去重连");
		sockets[1]?.fire("open");
		assert.equal(sockets[1]?.sent[0]?.type, "hello");
	});

	/** 判据是「最近听见过任何帧」,不是「回过 pong」—— 名单、回执、入站一样算活着。 */
	it("BN 说了话就重新计时,而且只排一只狗", () => {
		connect();
		const before = watchdog();
		sockets[0]?.say({ type: "ping" });
		const after = watchdog();
		assert.ok(after);
		assert.notEqual(before, after, "收到帧之后没有重新计时");
		assert.equal(
			timers.filter((timer) => timer.ms === BRIDGE_SILENCE_LIMIT_MS).length,
			1,
			"排了不止一只狗",
		);
	});

	/** 「失败的原因不许吞」:这一断和网线松了长得一样,不说清楚没人查得出来。 */
	it("被看门狗踢掉时说清楚是为什么", () => {
		const { said, log } = recording();
		connect({ log });
		watchdog()?.fn();
		assert.ok(
			said.some((line) => line.includes("90000") || line.includes("没说过话")),
			`只说了:${said.join(" | ")}`,
		);
	});

	/**
	 * 宿主那头记着 BN 下发的入站订阅。连断了订阅就作废 —— 不叫一声的话它会照着上一条连接的
	 * 订阅继续往一条没了的路上驮群消息。
	 */
	it("断了叫一声 onDisconnect", () => {
		let lost = 0;
		connect({ onDisconnect: () => (lost += 1) });
		sockets[0]?.fire("close", { code: 1006 });
		assert.equal(lost, 1);
	});

	it("被看门狗踢掉也算断", () => {
		let lost = 0;
		connect({ onDisconnect: () => (lost += 1) });
		watchdog()?.fn();
		assert.equal(lost, 1, "静默超时那一路没叫");
	});

	/** 收摊是我们自己走的,不是「连丢了」—— 那时宿主整个都在拆,再回调一次只会添乱。 */
	it("收摊不叫 onDisconnect", () => {
		let lost = 0;
		const c = connect({ onDisconnect: () => (lost += 1) });
		c.dispose();
		sockets[0]?.fire("close", { code: 1000 });
		assert.equal(lost, 0);
	});
});

describe("收摊", () => {
	/** 看门狗自己排的定时器也得收摊,不然 koishi 卸载插件之后它还会醒一次。 */
	it("收摊之后看门狗也撤了", () => {
		const c = connect();
		assert.ok(watchdog(), "本来就没排");
		c.dispose();
		assert.equal(watchdog(), undefined, "收摊之后还留着一只");
	});

	it("收摊之后不再重连", () => {
		const c = connect();
		c.dispose();
		sockets[0]?.fire("close", { code: 1006 });
		assert.equal(timers.length, 0);
	});

	/**
	 * 🔴 关闭握手那几十毫秒里还会落进来帧。这时 `armWatchdog()` 是往 koishi 一只已经失效的
	 * scope 上排定时器(`ctx.setTimeout` 抛 `INACTIVE_EFFECT`),而那一帧 `send` 还会被真的
	 * 投递出去 —— 插件都卸载了,它还在往群里发。
	 */
	it("收摊之后落进来的帧:不重排看门狗,也不投递", async () => {
		let delivered = 0;
		const c = connect({
			deliver: async () => {
				delivered += 1;
				return { ok: true };
			},
		});
		c.dispose();
		sockets[0]?.say(SEND);
		await settle();
		assert.equal(watchdog(), undefined, "收摊之后又排了一只狗");
		assert.equal(delivered, 0, "收摊之后还把帧投递出去了");
	});

	/** `connected()` 是宿主判断「现在能不能推」的唯一依据,收摊之后它必须当场说实话。 */
	it("收摊之后 connected() 不再说自己连着", () => {
		const c = connect();
		assert.equal(c.connected(), true);
		c.dispose();
		assert.equal(c.connected(), false);
	});
});
