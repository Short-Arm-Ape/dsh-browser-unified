import fs from 'node:fs';
const f = 'src/tests/extension-hold.mjs';
let s = fs.readFileSync(f, 'utf8');
const pairs = [
[`	// ③ domcontentloaded（默认）：readyState 一变成 interactive 就回
	{
		const { ctx, fake } = await makeNavWorker()
		fake.setReadyState('interactive')
		fake.setNavState({ status: 'loading' }) // 还在 loading，但 DOM 已可用
		const res = await ctx.cmdNav({ url: 'https://new.example/', tabId: 7 })
		eq('默认口径是 domcontentloaded', res.waitUntil, 'domcontentloaded')
		eq('domcontentloaded：回显 readyState', res.readyState, 'interactive')
		ok('domcontentloaded：DOM 可用即回（不等 load）', res.loadPending === true, JSON.stringify(res))
	}`,
`	// ③ 默认口径 = load（2026-10-30 与上游对齐；domcontentloaded 变成显式选项）
	{
		const { ctx, fake } = await makeNavWorker()
		fake.setReadyState('complete')
		const res = await ctx.cmdNav({ url: 'https://new.example/', tabId: 7 })
		eq('默认口径是 load', res.waitUntil, 'load')
		eq('load：回显 readyState', res.readyState, 'complete')
		ok('load：整页加载完才算到达', res.loadPending === undefined, JSON.stringify(res))
	}

	// ③b 显式 domcontentloaded：readyState 一变成 interactive 就回（元素可能还没挂上）
	{
		const { ctx, fake } = await makeNavWorker()
		fake.setReadyState('interactive')
		fake.setNavState({ status: 'loading' }) // 还在 loading，但 DOM 已可用
		const res = await ctx.cmdNav({ url: 'https://new.example/', tabId: 7, waitUntil: 'domcontentloaded' })
		eq('domcontentloaded：口径回显', res.waitUntil, 'domcontentloaded')
		eq('domcontentloaded：回显 readyState', res.readyState, 'interactive')
		ok('domcontentloaded：DOM 可用即回（不等 load）', res.loadPending === true, JSON.stringify(res))
	}`],
[`		eq('非法 waitUntil ⇒ domcontentloaded', res.waitUntil, 'domcontentloaded')`,
 `		eq('非法 waitUntil ⇒ load（默认口径）', res.waitUntil, 'load')`],
[`		eq('default 预算 = 4000ms（domcontentloaded）', ctx.navBudget('domcontentloaded', undefined), 4000)`,
 `		eq('domcontentloaded 预算 = 4000ms（显式时才用它）', ctx.navBudget('domcontentloaded', undefined), 4000)`],
];
for (const [a, b] of pairs) { if (!s.includes(a)) throw new Error('NOT FOUND: ' + a.slice(0, 60)); s = s.split(a).join(b); }
fs.writeFileSync(f, s);
console.log('tests updated');
