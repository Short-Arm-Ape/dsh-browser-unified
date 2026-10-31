import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * nav-budget.mjs — 导航等待预算与"交给桥的超时"必须同一套口径。
 *
 * 动机：桥有自己的命令超时（默认 60s）。若导航预算比桥超时还长，先到的是桥，
 * 模型拿到 `command_timeout`（结果未知）而不是"导航等待超时"（没动过页面）——
 * 两条错误该做的下一步完全不同。2026-10-30 上游 issue #19 评审点出的就是这个。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..', 'packages', 'browser-unified-plugin');
const mod = await import(pathToFileURL(path.join(pkg, 'lib', 'nav-budget.js')).href);
const { NAV_BRIDGE_MARGIN_MS, NAV_DEFAULT_BUDGET_MS, navBridgeTimeout, navWaitBudget, normalizeNavWaitMode } = mod;

const results = [];
function check(name, ok, detail) {
	results.push({ name, ok });
	console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

check('默认口径是 load（与上游一致）', normalizeNavWaitMode(undefined) === 'load', normalizeNavWaitMode(undefined));
check('认得出的口径原样返回', normalizeNavWaitMode('domcontentloaded') === 'domcontentloaded');
check('认不出的值回落 load（写错不该变慢或报错）', normalizeNavWaitMode('whenever') === 'load', normalizeNavWaitMode('whenever'));
check('默认预算 = 15000（load）', navWaitBudget(undefined, undefined) === 15_000, navWaitBudget(undefined, undefined));
check('domcontentloaded 预算 = 4000', navWaitBudget('domcontentloaded', undefined) === 4_000);
check('none 预算 = 0', navWaitBudget('none', undefined) === 0);
check('显式 timeoutMs 优先', navWaitBudget('domcontentloaded', 900) === 900);
check('显式 timeoutMs 上限截到 120000', navWaitBudget('load', 999_999) === 120_000);
check('显式 timeoutMs 下限 100', navWaitBudget('load', 1) === 100);

check('交给桥的超时 = 预算 + 余量（默认 17s，不是桥的 60s）',
	navBridgeTimeout(undefined, undefined) === 15_000 + NAV_BRIDGE_MARGIN_MS, navBridgeTimeout(undefined, undefined));
check('none 也要留出余量（探针与回报）', navBridgeTimeout('none', undefined) === NAV_BRIDGE_MARGIN_MS, navBridgeTimeout('none', undefined));
check('显式预算同样带余量', navBridgeTimeout('load', 30_000) === 32_000, navBridgeTimeout('load', 30_000));
check('余量为正（等于 0 就退化成桥先超时）', NAV_BRIDGE_MARGIN_MS > 0, NAV_BRIDGE_MARGIN_MS);
check('扩展与插件共用四个口径', Object.keys(NAV_DEFAULT_BUDGET_MS).sort().join(',') === 'commit,domcontentloaded,load,none');

// 页内预算（browser_wait / browser_evaluate 的 timeoutMs）也走同一笔账：
// 桥默认 60s，而这两个工具的预算上限是 120s —— 预算比桥长时先报的会是"扩展超时未回应"。
check('页内预算 120s ⇒ 交给桥 122s（比桥默认 60s 长，先到的是页内自己）',
	mod.pageBridgeTimeout(120_000) === 120_000 + NAV_BRIDGE_MARGIN_MS, mod.pageBridgeTimeout(120_000));
check('页内预算 15s ⇒ 17s', mod.pageBridgeTimeout(15_000) === 15_000 + NAV_BRIDGE_MARGIN_MS, mod.pageBridgeTimeout(15_000));
check('页内预算超上限被截到 120s（不许把桥超时抬到任意大）',
	mod.pageBridgeTimeout(999_999) === 120_000 + NAV_BRIDGE_MARGIN_MS, mod.pageBridgeTimeout(999_999));
check('页内预算非法值回落默认 15s', mod.pageBridgeTimeout(Number.NaN) === 15_000 + NAV_BRIDGE_MARGIN_MS, mod.pageBridgeTimeout(Number.NaN));
check('页内预算下限 100ms 也留余量', mod.pageBridgeTimeout(1) === 100 + NAV_BRIDGE_MARGIN_MS, mod.pageBridgeTimeout(1));

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
	for (const f of failed) console.log('  - ' + f.name);
	process.exit(1);
}
