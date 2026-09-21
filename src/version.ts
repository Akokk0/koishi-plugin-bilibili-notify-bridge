/**
 * 报给 BN 的插件版本(握手帧里那一格),排障用。
 *
 * 单独一个文件是为了**测得着**:`index.ts` 引 koishi,而 koishi 的 ESM 产物在纯 Node 下
 * 加载即炸(`@koishijs/loader` 里一处 class extends),测试进不去。
 * 与 `package.json` 的一致性由 `__tests__/version.test.ts` 钉着。
 */
export const VERSION = "0.0.2";
