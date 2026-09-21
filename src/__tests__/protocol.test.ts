/**
 * 协议这一层的几个小工具 —— 它们各自守着一道「一条消息就能把整条桥打死」的门。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clipErr, MAX_ERR_CHARS, reasonOf } from "../protocol";

describe("clipErr", () => {
	/** 没超原样;超了截到上限,并注明后面还有多少字 —— 主人看得出这句话没说完。 */
	it("正好卡在上限上原样,多一个字就截并注明", () => {
		assert.equal(clipErr("x".repeat(MAX_ERR_CHARS)), "x".repeat(MAX_ERR_CHARS));
		assert.equal(
			clipErr("x".repeat(MAX_ERR_CHARS + 1)),
			`${"x".repeat(MAX_ERR_CHARS)}…(后面还有 1 字)`,
		);
	});

	/** 按字数、不按 UTF-16 码元:截在一个 emoji 中间,回执里就是半个乱码。 */
	it("按字截,不把一个 emoji 劈成两半", () => {
		const out = clipErr("😀".repeat(MAX_ERR_CHARS + 3));
		assert.equal(out, `${"😀".repeat(MAX_ERR_CHARS)}…(后面还有 3 字)`);
	});
});

describe("reasonOf", () => {
	it("有原话就是原话", () => {
		assert.equal(reasonOf(new Error("群被禁言了")), "群被禁言了");
	});

	/** 抛出来的不一定是 Error —— `throw "x"` 也是 JS。 */
	it("抛的是字符串就用那个字符串", () => {
		assert.equal(reasonOf("超时了"), "超时了");
	});

	it("没有原话 → 报它是什么异常,不回一个空串", () => {
		assert.equal(reasonOf(new RangeError("")), "RangeError");
		assert.notEqual(reasonOf(undefined), "");
		assert.notEqual(reasonOf({}), "");
	});

	/** satori 的 `AggregateError` 自己的 message 是空串,原因在 `.errors` 里。 */
	it("带 .errors 的把每一条都说出来", () => {
		const err = Object.assign(new Error(""), {
			errors: [new Error("第一条"), new Error("第二条")],
		});
		const out = reasonOf(err);
		assert.match(out, /第一条/);
		assert.match(out, /第二条/);
	});

	it("base64:// 与 data:…;base64, 两种写法都换成占位", () => {
		const out = reasonOf(
			new Error('a "base64://QUJDRA==" b "data:image/png;charset=x;base64,QUJDRA==" c'),
		);
		assert.equal(out, 'a "[base64 图片]" b "[base64 图片]" c');
	});
});
