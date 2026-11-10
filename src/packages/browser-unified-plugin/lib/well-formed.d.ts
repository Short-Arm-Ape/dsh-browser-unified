/**
 * 文本的「良构」闸：孤立代理项（半个 emoji）不许进模型请求体。
 *
 * 为什么必须有：页面文本被截断时切点可能落在一个 emoji 的高位代理项上。孤立代理项经
 * `JSON.stringify` 变成裸 `\ud83d`，模型侧的 JSON 解析器会拒收**整个请求体**；坏字符还会
 * 随会话历史每轮重放，`/compact` 也清不掉（上游 v1.7.10 / issue #26 就是这个）。
 *
 * 用法：注册工具时用 `safeDefineTool`，它在两端动手——
 *   ① `render` 产出的每段文本 → `toWellFormed`（兜底，任何来源的半个字符都变成 U+FFFD）；
 *   ② `execute` 抛出的错误文案 → `toWellFormed`（错误也会进请求体）。
 * 源头截断点（把长文本切到 N 字符的地方）另用 `sliceWellFormed`，让切点直接落在整字符上。
 */
/** 把字符串里的孤立代理项换成 U+FFFD（优先用 ES2024 的 `String.prototype.toWellFormed`）。 */
export declare function toWellFormed(text: string): string;
/** 按字符截断但**不切出半个代理项**：切点落在高位代理项上就退一格。 */
export declare function sliceWellFormed(text: string, max: number): string;
/**
 * 给一份工具定义套上良构闸（不改别的字段），返回同一类型。
 *
 * 两条注册路径都要用它：走 `defineTool` 的（index.ts / unified-tools.ts）由 `safeDefineTool`
 * 代劳；**直接** `ctx.tools.register({...})` 的（buddy.ts）必须自己调一次，否则那几条工具
 * 的 render 会绕过闸门。
 */
export declare function hardenToolDefinition<T extends object>(definition: T): T;
/**
 * `@deepseek-ai/dsh-tools` 的 `defineTool` 包装：注册前给 render / execute 套上良构闸。
 *
 * 参数类型故意放宽到 `unknown` —— 各 rc 版本的 schema 类型不一致，这一层只做包装不做校验；
 * 返回值类型原样透传（`ctx.tools.register` 要的是 `ToolDefinition`）。
 */
export declare function safeDefineTool<T>(rawDefineTool: (options: never) => T): (options: unknown) => T;
