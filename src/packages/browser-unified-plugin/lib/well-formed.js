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
export function toWellFormed(text) {
    if (typeof text.toWellFormed === 'function') {
        return text.toWellFormed();
    }
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                out += text[i] + text[i + 1];
                i++;
            }
            else
                out += '\uFFFD';
        }
        else if (code >= 0xdc00 && code <= 0xdfff)
            out += '\uFFFD';
        else
            out += text[i];
    }
    return out;
}
/** 按字符截断但**不切出半个代理项**：切点落在高位代理项上就退一格。 */
export function sliceWellFormed(text, max) {
    if (text.length <= max)
        return text;
    let end = max;
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff)
        end -= 1;
    return text.slice(0, end);
}
/** 把 render 结果里的每段文本都过一遍 `toWellFormed`（结构原样保留）。 */
function wellFormedParts(parts) {
    if (typeof parts === 'string')
        return toWellFormed(parts);
    if (Array.isArray(parts))
        return parts.map(wellFormedParts);
    if (parts !== null && typeof parts === 'object') {
        const out = { ...parts };
        if (typeof out.text === 'string')
            out.text = toWellFormed(out.text);
        return out;
    }
    return parts;
}
/**
 * 给一份工具定义套上良构闸（不改别的字段），返回同一类型。
 *
 * 两条注册路径都要用它：走 `defineTool` 的（index.ts / unified-tools.ts）由 `safeDefineTool`
 * 代劳；**直接** `ctx.tools.register({...})` 的（buddy.ts）必须自己调一次，否则那几条工具
 * 的 render 会绕过闸门。
 */
export function hardenToolDefinition(definition) {
    const source = definition;
    const wrapped = { ...source };
    // 工具的 render 实际挂在 `output.render` 上（`{ output: { schema, render } }`）；
    // 顶层 render 只在个别旧形状里出现，两处都包。
    const output = source.output;
    if (output !== undefined && output !== null && typeof output.render === 'function') {
        const render = output.render;
        wrapped.output = { ...output, render: (args, value) => wellFormedParts(render(args, value)) };
    }
    if (typeof source.render === 'function') {
        const render = source.render;
        wrapped.render = (args, value) => wellFormedParts(render(args, value));
    }
    if (typeof source.execute === 'function') {
        const execute = source.execute;
        wrapped.execute = async (...args) => {
            try {
                return await execute(...args);
            }
            catch (error) {
                if (error instanceof Error && error.message)
                    error.message = toWellFormed(error.message);
                throw error;
            }
        };
    }
    return wrapped;
}
/**
 * `@deepseek-ai/dsh-tools` 的 `defineTool` 包装：注册前给 render / execute 套上良构闸。
 *
 * 参数类型故意放宽到 `unknown` —— 各 rc 版本的 schema 类型不一致，这一层只做包装不做校验；
 * 返回值类型原样透传（`ctx.tools.register` 要的是 `ToolDefinition`）。
 */
export function safeDefineTool(rawDefineTool) {
    return (options) => rawDefineTool(hardenToolDefinition(options));
}
