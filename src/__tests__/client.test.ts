/**
 * 那条长连接的行为 —— 协议 §12「最小实现清单」里除了「真的连得上」之外的每一条。
 *
 * socket 是**注入口**(生产里是 koishi 的 `ctx.http.ws`),这里给一个记账的替身:要钉的是
 * 「什么时候发什么帧、断了要不要回去」,而不是 TCP。真的连得上由真机验。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { BRIDGE_SILENCE_LIMIT_MS, createBridgeClient, type SocketLike } from "../client";

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
}

const SILENT = { info() {}, warn() {} };
const BOTS = [{ botId: "discord:1", platform: "discord" }];
const WELCOME = {
	type: "welcome",
	protocol: { major: 1, minor: 1 },
	server: { version: "9.9.9" },
	inbound: { private: true, group: "with-links" },
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
			protocol: { major: 1, minor: 3 },
			bridge: { kind: "koishi", name: "koishi", version: "0.0.1" },
			bots: BOTS,
		});
	});

	it("welcome 里的入站订阅交出去 —— 之后按它过滤", () => {
		let got: unknown;
		connect({ onWelcome: (sub: unknown) => (got = sub) });
		assert.deepEqual(got, { private: true, group: "with-links" });
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
});

describe("投递", () => {
	const SEND = {
		type: "send",
		id: "s-1",
		botId: "discord:1",
		platform: "discord",
		target: { scope: "group", address: "g-1" },
		message: { kind: "text", text: "开播啦" },
	};

	it("发成功 → 回执 ok", async () => {
		connect();
		sockets[0]?.say(SEND);
		await new Promise((r) => setTimeout(r, 5));
		assert.deepEqual(sockets[0]?.last("result"), { type: "result", id: "s-1", ok: true });
	});

	/** 🔴 **发不出去也一定要回执**。不回的话 BN 那头只能等到超时,而超时那 30 秒里
	 * 主人看到的是「推送卡着不动」——比一条明确的失败难查得多。 */
	it("发失败 → 回执带着那句理由,不是干等超时", async () => {
		connect({ deliver: async () => ({ ok: false, err: "群被禁言了" }) });
		sockets[0]?.say(SEND);
		await new Promise((r) => setTimeout(r, 5));
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
		await new Promise((r) => setTimeout(r, 5));
		const result = sockets[0]?.last("result");
		assert.equal(result?.ok, false);
		assert.match(String(result?.err), /掉线/);
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
	it("token 不对 / 协议不兼容 / 接入被删 → 就此打住", () => {
		for (const code of [4001, 4002, 4005]) {
			sockets = [];
			timers = [];
			connect();
			sockets[0]?.fire("close", { code });
			assert.equal(timers.length, 0, `close ${code} 之后不该再重连`);
		}
	});

	/** 4007 是「这条接入被停用了」—— 主人把开关拨回来,它就该自己回去。 */
	it("接入被停用(4007)照样退避重连", () => {
		connect();
		sockets[0]?.fire("close", { code: 4007 });
		assert.equal(timers.length, 1);
	});

	/**
	 * 🔴 **主人 2026-09-10 真机第一次连就撞上这个**:日志里只有一句「连接出错」,没有任何
	 * 线索。事件里带着真正的原因(`ECONNREFUSED` / `Unexpected server response: 401` …),
	 * 吞掉它等于让人对着一台连不上的 BN 猜半天。
	 */
	it("连不上时把真正的原因说出来,不是一句「连接出错」", () => {
		const said: string[] = [];
		client({ log: { info: () => {}, warn: (m: string) => said.push(m) } });
		sockets[0]?.fire("error", { message: "connect ECONNREFUSED 127.0.0.1:8787" });
		assert.ok(
			said.some((line) => line.includes("ECONNREFUSED")),
			`只说了:${said.join(" | ")}`,
		);
	});

	it("原因藏在 error 字段里也捞得出来", () => {
		const said: string[] = [];
		client({ log: { info: () => {}, warn: (m: string) => said.push(m) } });
		sockets[0]?.fire("error", { error: new Error("getaddrinfo ENOTFOUND nas") });
		assert.ok(said.some((line) => line.includes("ENOTFOUND")), `只说了:${said.join(" | ")}`);
	});

	/**
	 * 🔴 协议 §2:**401 是「别再试了」**。upgrade 被拒时 close code 是 1006(看着像普通断线),
	 * 照 close code 判的话 token 填错就会**永远捶 BN**,而屏幕上什么有用的都没有。
	 */
	it("token 不对(401)→ 就此打住,不去捶 BN", () => {
		const said: string[] = [];
		client({ log: { info: () => {}, warn: (m: string) => said.push(m) } });
		sockets[0]?.fire("error", { message: "Unexpected server response: 401" });
		sockets[0]?.fire("close", { code: 1006 });
		assert.equal(timers.length, 0, "401 之后还在重连");
		assert.ok(said.some((line) => line.includes("401")));
	});

	/** 404 = 这台 BN 上眼下没有桥在跑;503 = 这条接入停用了。都是拨一下就好,该重连。 */
	it("404 / 503 照样退避重连", () => {
		for (const status of [404, 503]) {
			sockets = [];
			timers = [];
			client({ log: { info: () => {}, warn: () => {} } });
			sockets[0]?.fire("error", { message: `Unexpected server response: ${status}` });
			sockets[0]?.fire("close", { code: 1006 });
			assert.equal(timers.length, 1, `${status} 之后该重连`);
		}
	});

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
		const said: string[] = [];
		client({ log: { info: () => {}, warn: (m: string) => said.push(m) } });
		sockets[0]?.fire("open");
		sockets[0]?.say(WELCOME);
		watchdog()?.fn();
		assert.ok(
			said.some((line) => line.includes("90000") || line.includes("没说过话")),
			`只说了:${said.join(" | ")}`,
		);
	});

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
});
