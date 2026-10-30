import fs from 'node:fs';

const edits = [];
const apply = (file, pairs) => {
  let s = fs.readFileSync(file, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) throw new Error('NOT FOUND in ' + file + ': ' + a.slice(0, 70));
    s = s.split(a).join(b);
  }
  fs.writeFileSync(file, s);
  edits.push(file);
};

// 1) 扩展：默认口径 load（与上游一致）
apply('src/extension/background.js', [
  [' * `domcontentloaded`（默认）= DOM 可用即回；`load` = 老行为（等 `load`）。',
   ' * `load`（默认，与上游行为一致）= 等 `load` 事件；`domcontentloaded` = DOM 可用即回（更快，元素可能还没挂上）。'],
  ["\tif (text === 'none' || text === 'commit' || text === 'load' || text === 'domcontentloaded') return text;\n\treturn 'domcontentloaded';",
   "\tif (text === 'none' || text === 'commit' || text === 'load' || text === 'domcontentloaded') return text;\n\treturn 'load';"],
  ['\t// 默认 domcontentloaded：DOM 一可用就回，内容晚到再用 waitSelector/waitText/waitFn 或 read 复查。',
   '\t// 默认 load（2026-10-30 与上游对齐）：要更快由调用方显式传 domcontentloaded / commit / none。'],
]);

// 2) 插件：工具描述与回执兜底跟着改
apply('src/packages/browser-unified-plugin/src/index.ts', [
  ['description: "Navigate a tab to a URL and return as soon as the DOM is usable (`waitUntil` defaults to \\"domcontentloaded\\"; pass \\"load\\" only when the page really must finish loading). SPA',
   'description: "Navigate a tab to a URL and wait for the page load to settle (`waitUntil` defaults to \\"load\\", the same semantics as Playwright; pass \\"domcontentloaded\\" for pages whose DOM is usable before subresources arrive — faster, but elements may not be mounted yet, so follow with browser_wait; \\"commit\\" returns when the URL lands; \\"none\\" returns immediately). SPA'],
  ['waitUntil: { type: \'string\', description: \'"domcontentloaded" (default) returns as soon as the DOM is usable; "commit" returns when the URL lands (page may still be loading); "none" returns immediately; "load" waits for the full load event (slow). Prefer the default and read/wait afterwards instead of blocking here.\' },',
   'waitUntil: { type: \'string\', description: \'"load" (default) waits for the full load event; "domcontentloaded" returns as soon as the DOM is usable, which is faster but the elements you want may not be mounted yet — follow with browser_wait instead of retrying blind; "commit" returns when the URL lands (page still loading); "none" returns immediately.\' },'],
  ['timeoutMs: { type: \'number\', description: \'Budget for the load wait (default 15000; ignored when waitUntil is "none").\' },',
   'timeoutMs: { type: \'number\', description: \'Budget for the navigation wait: default 15000 with waitUntil "load", 4000 with "commit"/"domcontentloaded", ignored with "none". An explicit value always wins.\' },'],
  ["String(value.waitUntil ?? 'domcontentloaded')", "String(value.waitUntil ?? 'load')"],
]);

console.log('edited:', edits.join(' | '));
