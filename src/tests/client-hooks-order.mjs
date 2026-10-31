// client-hooks-order.mjs — 设置页客户端的「hook 顺序」静态守门。
//
// 为什么需要它：早退夹在 hook 之间（首帧 loading 走 4 个 hook、下一帧 ready 走 9 个）会让 React 抛
// "Rendered more hooks than during the previous render"，整个分区在错误边界里消失。这个故障
// **看不出来**（只有"第一次挂着时配置还没读到"才会触发），所以要靠结构断言钉住：
// 组件函数体里任何 return 都不许出现在最后一个 hook 调用之前。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const file = path.join(repo, 'packages', 'browser-unified-plugin', 'client', 'client.js')
const src = readFileSync(file, 'utf8')
const lines = src.split('\n')

const HOOK_RE = /\b(useState|useRef|useEffect|useMemo|useCallback|useLayoutEffect|useSyncExternalStore|useReducer|useContext)\s*\(/
const results = []
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`) }

/** 抽出所有 `function Name(props) { ... }`（按大括号配平），返回顶层语句的行号集合。 */
const comps = []
for (let i = 0; i < lines.length; i++) {
	const m = lines[i].match(/^\s*function ([A-Z][A-Za-z0-9_]*)\s*\(\s*(props|_props)\s*\)\s*\{/)
	if (!m) continue
	const name = m[1]
	let depth = 0
	const body = []
	for (let j = i; j < lines.length; j++) {
		const line = lines[j]
		// 逐字符算深度，同时记录这一行起始时的深度
		let startDepth = depth
		for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth-- }
		body.push({ lineNo: j + 1, text: line, startDepth })
		if (depth === 0) break
	}
	comps.push({ name, defLine: i + 1, body })
}

check('找到了组件函数（至少 8 个）', comps.length >= 8, `实际 ${comps.length}`)

let violations = 0
for (const comp of comps) {
	// 只看组件自己的顶层（startDepth === 1 是函数体第一层）
	const hookLines = comp.body.filter((b) => b.startDepth === 1 && HOOK_RE.test(b.text)).map((b) => b.lineNo)
	const returnLines = comp.body.filter((b) => b.startDepth === 1 && /^\s*return\b/.test(b.text)).map((b) => b.lineNo)
	if (hookLines.length === 0 || returnLines.length === 0) continue
	const lastHook = Math.max(...hookLines)
	const early = returnLines.filter((l) => l < lastHook)
	if (early.length > 0) {
		violations++
		check(`${comp.name}（第 ${comp.defLine} 行）：return 都在 hook 之后`, false, `早退在 ${early.join(',')} 行，最后一个 hook 在 ${lastHook} 行`)
	}
}
check('没有任何组件在 hook 之前早退', violations === 0, `违规组件 ${violations} 个`)

// 反向对照：把 shell 的第一处 return 插到一个 hook 之前，必须被判红（说明这条断言真的有牙）
{
	const mutated = lines.map((l) => l)
	const shellAt = mutated.findIndex((l) => /function BrowserSectionBody\(props\)/.test(l))
	if (shellAt >= 0) {
		const returnAt = mutated.findIndex((l, i) => i > shellAt && /^\s*return createElement\('div'/.test(l))
		if (returnAt > shellAt + 2) {
			const moved = mutated[returnAt]
			mutated.splice(returnAt, 1)
			mutated.splice(shellAt + 1, 0, moved)
			const mutSrc = mutated.join('\n')
			// 用同一套解析逻辑跑一遍变异版本
			const mutLines = mutSrc.split('\n')
			let mutViolations = 0
			for (let i = 0; i < mutLines.length; i++) {
				const m = mutLines[i].match(/^\s*function ([A-Z][A-Za-z0-9_]*)\s*\(\s*(props|_props)\s*\)\s*\{/)
				if (!m) continue
				let depth = 0
				const body = []
				for (let j = i; j < mutLines.length; j++) {
					const line = mutLines[j]
					const startDepth = depth
					for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth-- }
					body.push({ lineNo: j + 1, text: line, startDepth })
					if (depth === 0) break
				}
				const hooks = body.filter((b) => b.startDepth === 1 && HOOK_RE.test(b.text)).map((b) => b.lineNo)
				const rets = body.filter((b) => b.startDepth === 1 && /^\s*return\b/.test(b.text)).map((b) => b.lineNo)
				if (hooks.length === 0 || rets.length === 0) continue
				const lastHook = Math.max(...hooks)
				if (rets.some((l) => l < lastHook)) mutViolations++
			}
			check('变异对照：把早退挪到 hook 之前会被判红', mutViolations > 0, `变异后违规 ${mutViolations} 个`)
		}
	}
}

const failed = results.filter((r) => !r.ok)
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) { for (const f of failed) console.log('  - ' + f.name); process.exit(1) }
