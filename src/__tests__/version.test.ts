/**
 * 报给 BN 的版本号与 `package.json` 对不上,排障时就会指着一个不存在的版本查半天,
 * 而这种漂**没有任何别的东西会发现**。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VERSION } from "../version";

test("报上去的版本号跟 package.json 一致", () => {
	const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
	assert.equal(VERSION, pkg.version);
});
