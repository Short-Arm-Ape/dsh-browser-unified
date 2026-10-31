#!/usr/bin/env node
/**
 * status-page-escape.mjs — 状态页（`http://127.0.0.1:<port>/`）不能把「被控端报上来的字符串」当 HTML 拼。
 *
 * 动机（2026-10-31 审计）：状态页用 `innerHTML` 拼 rows，而其中 `扩展类型` / `浏览器` 两行来自
 * 扩展的 `hello` 消息（`client` / `browser.name` / `browser.version`），截图目录来自配置。
 * 这些字符串一旦被"被控端"污染（装了个假扩展、扩展被改），就能在状态页上执行脚本 ——
 * 而那页上正存着桥 token（输入框 + sessionStorage）。
 *
 * 怎么验才不假绿：状态页的 rows 是**在浏览器里 fetch 之后填的**，光看 HTTP 返回的 HTML 一个字都看不见。
 * 所以这里把返回的 `<script>` 原样取出来，在 node:vm 里配假 document / fetch 跑一遍真正的 `refresh()`，
 * 拿它写进 `innerHTML` 的那串去断言。钉三件事：
 *   1. 恶意 `hello` 字段落进 rows 后是**转义文本**，不是标签；
 *   2. `/api/status` 的 JSON 仍原样带真值（转义只在渲染侧做，不污染数据面）；
 *   3. 阳性对照：正常 `hello` 照样把浏览器名/版本显示出来（别为了转义把内容也弄没了）。
 *
 * 复现：npm run build && node tests/status-page-escape.mjs
 */

import net from 'node:net'
import vm from 'node:vm'
import http from 'node:http'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
// 直接指向**本仓库构建产物**（不是 profile 里那份部署副本），否则改了源码这条测试还在验旧代码。
const coreDist = path.join(repo, 'packages', 'browser-unified-core', 'dist', 'index.js')
const { BridgeServer } = await import(pathToFileURL(coreDist).href)

const PORT = 9847
const TOKEN = 'status-page-escape-token-0123456789'
const shotsDir = mkdtempSync(path.join(tmpdir(), 'dsh-status-escape-'))

const results = []
function check(name, ok, detail) {
	results.push({ name, ok })
	console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 最小的 HTTP GET（用 node:http，chunked 由它解码；自己拼字节会被 chunk 长度前缀骗到）。 */
function request(port, target) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: target }, (res) => {
			let text = ''
			res.setEncoding('utf8')
			res.on('data', (chunk) => { text += chunk })
			res.on('end', () => resolve({ status: res.statusCode, body: text }))
		})
		req.on('error', reject)
		req.end()
	})
}

/** 发一个**已掩码**的文本帧（RFC 6455 要求客户端掩码）。 */
function sendText(socket, text) {
	const payload = Buffer.from(text, 'utf8')
	const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
	let header
	if (payload.length < 126) {
		header = Buffer.from([0x81, 0x80 | payload.length])
	} else {
		header = Buffer.alloc(4)
		header[0] = 0x81
		header[1] = 0x80 | 126
		header.writeUInt16BE(payload.length, 2)
	}
	const masked = Buffer.from(payload)
	for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4]
	socket.write(Buffer.concat([header, mask, masked]))
}

/** 开一条 WS 并保持（101 之后就不再读，留着这条链路冒充扩展）。 */
function wsOpen(port, token) {
	return new Promise((resolve) => {
		const socket = new net.Socket({ allowHalfOpen: true })
		let buffer = ''
		const timer = setTimeout(() => resolve({ socket, line: 'NO-RESPONSE' }), 3000)
		socket.on('connect', () => {
			socket.write([
				`GET /ws?token=${encodeURIComponent(token)} HTTP/1.1`,
				`Host: 127.0.0.1:${port}`,
				'Upgrade: websocket',
				'Connection: Upgrade',
				'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
				'Sec-WebSocket-Version: 13',
			].join('\r\n') + '\r\n\r\n')
		})
		socket.on('data', function onData(chunk) {
			buffer += chunk.toString('latin1')
			if (!buffer.includes('\r\n')) return
			clearTimeout(timer)
			socket.removeListener('data', onData)
			socket.on('error', () => {})
			resolve({ socket, line: buffer.split('\r\n')[0] })
		})
		socket.on('error', () => { clearTimeout(timer); resolve({ socket, line: 'SOCKET-ERROR' }) })
		socket.connect(port, '127.0.0.1')
	})
}

/**
 * 把状态页里那段脚本在 vm 里跑一遍，返回它填出来的 `innerHTML`。
 * @param {string} html 状态页原文
 * @param {Record<string, unknown>} status `/api/status` 的那份 JSON
 */
async function renderRowsInPage(html, status) {
	const at = html.indexOf('<script>')
	const end = html.lastIndexOf('</script>')
	if (at < 0 || end < 0) throw new Error('状态页里没有 <script> 块')
	const code = html.slice(at + '<script>'.length, end)
	const els = new Map()
	const getEl = (id) => {
		if (!els.has(id)) els.set(id, { id, innerHTML: '', textContent: '', className: '', value: '', onclick: null })
		return els.get(id)
	}
	const sandbox = {
		document: { getElementById: getEl },
		fetch: async () => ({ json: async () => status }),
		sessionStorage: { getItem: () => null, setItem: () => {} },
		confirm: () => false,
		prompt: () => '',
		// 页面脚本结尾自带 `refresh();setInterval(refresh,2000);` —— 定时器在台子上不需要。
		setInterval: () => 0,
		setTimeout: () => 0,
		console: { log: () => {}, error: () => {} },
	}
	sandbox.globalThis = sandbox
	const ctx = vm.createContext(sandbox)
	new vm.Script(code).runInContext(ctx)
	await vm.runInContext('refresh()', ctx)
	return { rows: getEl('rows').innerHTML, sub: getEl('sub').textContent, raw: getEl('raw').textContent }
}

const server = new BridgeServer({ port: PORT, token: TOKEN, shotsDir, log: () => {} })
let socket

try {
	await server.start()
	const pageHtml = (await request(PORT, '/')).body
	check('状态页 200 且带脚本块（否则下面无从验起）', pageHtml.includes('<script>'), `len=${pageHtml.length}`)

	console.log('\n[1] 恶意 hello ⇒ rows 里必须是转义文本，不是标签')
	{
		const opened = await wsOpen(PORT, TOKEN)
		socket = opened.socket
		check('WS 握手 101（阳性对照：链路真的通了）', opened.line.includes('101'), opened.line)

		const hostileName = '<img src=x onerror=alert(1)>'
		const hostileVersion = '</script><b>pwn</b>'
		sendText(socket, JSON.stringify({
			type: 'hello',
			client: hostileName,
			version: hostileVersion,
			protocol: 2,
			extensionId: 'fake',
			browser: { name: hostileName, version: hostileVersion, ua: 'x' },
		}))
		await new Promise((r) => setTimeout(r, 250))

		const status = JSON.parse((await request(PORT, '/api/status')).body)
		check('数据面照原样带真值（转义只在渲染侧做）',
			status.hello?.browser?.name === hostileName, JSON.stringify(status.hello?.browser?.name))

		const rendered = await renderRowsInPage(pageHtml, status)
		check('rows 里没有可执行的注入片段', !rendered.rows.includes('<img src=x onerror='),
			rendered.rows.includes('<img src=x onerror=') ? '含 <img …' : '无原始标签')
		check('注入被转义成实体', rendered.rows.includes('&lt;img src=x onerror=alert(1)&gt;'),
			rendered.rows.includes('&lt;img src=x onerror=alert(1)&gt;') ? '已转义' : '未含 &lt;img …')
		check('`</script>` 也被转义（否则直接闭合脚本块）', !rendered.rows.includes('</script>'),
			rendered.rows.includes('</script>') ? '含 </script>' : '无原始 </script>')
		check('版本串转义后仍可读（信息没被吞掉）', rendered.rows.includes('&lt;/script&gt;&lt;b&gt;pwn&lt;/b&gt;'),
			rendered.rows.includes('&lt;/script&gt;') ? '保留实体文本' : '内容丢了')
	}

	console.log('\n[2] 阳性对照：正常 hello 照常显示')
	{
		sendText(socket, JSON.stringify({
			type: 'hello',
			client: 'dsh-browser-control',
			version: '1.0.99',
			protocol: 2,
			extensionId: 'ok',
			browser: { name: 'Edge', version: '155.0.0.0', ua: 'x' },
		}))
		await new Promise((r) => setTimeout(r, 250))
		const status = JSON.parse((await request(PORT, '/api/status')).body)
		check('已连接且 hello 换成新的那份', status.extensionConnected === true && status.hello?.version === '1.0.99', JSON.stringify(status.hello?.version))
		const rendered = await renderRowsInPage(pageHtml, status)
		check('rows 里能看到浏览器名 + 版本', rendered.rows.includes('Edge 155.0.0.0'), rendered.rows.slice(0, 160))
		check('rows 里能看到扩展类型与版本', rendered.rows.includes('dsh-browser-control v1.0.99'), rendered.rows.slice(0, 160))
		check('状态文字说"已连接"', rendered.sub.includes('dsh-browser-control'), rendered.sub)
	}
} finally {
	try { socket?.destroy() } catch { /* 已关 */ }
	await server.stop().catch(() => {})
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
	console.log('失败项：')
	for (const f of failed) console.log(`  - ${f.name}`)
}
process.exit(failed.length === 0 ? 0 : 1)
