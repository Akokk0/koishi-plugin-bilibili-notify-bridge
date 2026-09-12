/**
 * 打包成 **CJS**:koishi 插件市场上的插件无一例外是 CJS(`main: lib/index.js`、package.json
 * 里没有 `type` 字段),koishi 的加载器与各种 register 钩子也是按这个形状写的。我们从前是
 * `"type": "module"`,是这一片里唯一的异类。
 *
 * `target: node18` 与 package.json 的 `engines` 对齐 —— 那是 cordis(koishi 内核)自己的
 * 下限。构建机跑的 Node 高得多(.node-version),但**发出去的字节必须能在用户的 Node 18 上跑**。
 *
 * koishi / @satorijs/element 是 peerDependencies,tsdown 默认就把它们留在外面:宿主手里那份
 * 才是真的,打进来的话插件拿到的 `Context` 与宿主的不是同一个类,装上去当场认不出。
 */

import { defineConfig } from "tsdown";

export default defineConfig({
	entry: "src/index.ts",
	outDir: "lib",
	format: "cjs",
	platform: "node",
	target: "node18",
	dts: true,
	clean: true,
	// 产物叫 `lib/index.js` / `lib/index.d.ts`,而不是 tsdown 默认的 `.cjs` / `.d.cts` ——
	// koishi 插件市场上的插件清一色是前者,`main` 指向一个 `.cjs` 虽然也能加载,但没有理由
	// 在这种地方标新立异。
	outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
