#!/usr/bin/env node
/**
 * bridge-http-auth.mjs — 桥的 HTTP 面与 WS 升级的鉴权/来源边界回归（2026-10-10）。
 *
 * 动机：这块的错全是**静默**的 —— 修之前是"任意网页能驱动已登录浏览器"（2026-09-25 实测复现：
 * 外部页面 `POST /api/command` 拿到 200）；修之后最危险的失败模式变成**假绿**：以为收紧了，
 * 其实 token 没验、或 `Host`/`Origin` 没查，而没人会去看响应头。所以这里逐条钉住：
 *
 *   1. `/api/status` 只读、且**只对回环来源**回显 ACAO（GUI 设置页探测靠它，公网来源不给）；
 *      HTTP 面本身也查 `Host`/`Origin`（DNS-rebinding 读不到策略快照）—— 2026-11-01 审计第 1 条；
 *   2. 预检（OPTIONS）不再回任何 CORS 头 —— 网页的 JSON POST 卡在预检，真请求发不出；
 *   3. `/api/command`、`/api/cleanup` 无 token/错 token → 401；带 token（三种形式都认）才放行；
 *   4. **阳性对照**：带 token 时确实走到 `execute`（503 = 没有扩展），证明不是"全都 401"的假绿；
 *   5. 清理是真写操作：无 token 时哨兵文件必须还在，带 token 时才被删；
 *   6. 状态页 `/` 不再内嵌 token（内嵌＝任何本机程序 GET 一次就拿到唯一凭据）；
 *   7. WS 升级：`Host` 非回环（DNS-rebinding）→ 403，网页 `Origin` → 403，
 *      扩展 scheme / 不带 Origin → 101，token 错 → 401；
 *   8. `guardCommand`（X18）在 HTTP 命令面上仍然生效 → 403 blocked；
 *   9. 弱 token（内置默认/短于 16 字符）在状态面自报 `insecureToken`，并在启动日志里告警；
 *  10. 换链路之后，旧 socket 自己迟到的 `data` / `error` 不许拆掉**新**链路
 *      （2026-11-01 审计第 3 条：以前旧连接报错会把新连接判成 link_lost）。
 *
 * 复现：cd packages/browser-unified-core && npm run build && cd ../.. && node tests/bridge-http-auth.mjs
 * （本脚本自带 3 个独立端口的桥实例，连不上真实桥；也不需要 DSH 与浏览器。）
 * 出处：用例形态参考上游 caob23/dsh-browser-control v1.0.8 的 `verify/verify_http.mjs`（AGPL-3.0），
 * 判据按本仓库的差异点重写（回环 CORS 回显、空 token 兼容、guardCommand）。
 */

import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const coreDist = path.join(repo, 'packages', 'browser-unified-core', 'dist', 'index.js')
const { BridgeServer } = await import(pathToFileURL(coreDist).href)

const STRONG = 'test-token-0123456789abcdef'
const P_STATUS = 9821
const P_GUARD = 9822
const P_WEAK = 9823

const results = []
function check(name, ok, detail) {
	results.push({ name, ok: ok === true })
	console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

function request(port, { method = 'GET', target = '/', headers = {}, body } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
			let text = ''
			res.setEncoding('utf8')
			res.on('data', (chunk) => { text += chunk })
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }))
		})
		req.on('error', reject)
		if (body !== undefined) req.write(body)
		req.end()
	})
}

/** 发一次原始 WS 握手，回第一行状态行（101/401/403/…）。 */
function wsUpgrade(port, { token, host, origin } = {}) {
	const target = `/ws${token === undefined ? '' : `?token=${encodeURIComponent(token)}`}`
	return new Promise((resolve) => {
		const socket = net.connect(port, '127.0.0.1', () => {
			const lines = [
				`GET ${target} HTTP/1.1`,
				`Host: ${host === undefined ? `127.0.0.1:${port}` : host}`,
				'Upgrade: websocket',
				'Connection: Upgrade',
				'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
				'Sec-WebSocket-Version: 13',
			]
			if (origin !== undefined) lines.push(`Origin: ${origin}`)
			socket.write(`${lines.join('\r\n')}\r\n\r\n`)
		})
		let buffer = ''
		const settle = () => {
			socket.destroy()
			resolve(buffer.length === 0 ? 'NO-RESPONSE' : buffer.split('\r\n')[0])
		}
		socket.setTimeout(3000, settle)
		socket.on('data', (chunk) => {
			buffer += chunk.toString('latin1')
			if (buffer.includes('\r\n')) settle()
		})
		socket.on('error', () => resolve('SOCKET-ERROR'))
	})
}

/**
 * 发一次原始 WS 握手并**保持这条连接**：回 {socket, line}（line 是第一行状态行）。
 *
 * `allowHalfOpen: true` 是刻意的 —— 桥在换链路时会给旧连接发 close 帧并 `end()`，
 * 普通 socket 收到 FIN 就自己关了，于是"旧连接还活着、只是被换掉"这一刻根本复现不出来，
 * 后面的守卫断言会变成永远绿的假象（2026-11-01 变异验证第一次没抓住第 3 条，就是这个坑）。
 */
function wsOpen(port, { token } = {}) {
	const target = `/ws?token=${encodeURIComponent(token ?? '')}`
	return new Promise((resolve) => {
		const socket = new net.Socket({ allowHalfOpen: true })
		let buffer = ''
		const timer = setTimeout(() => resolve({ socket, line: 'NO-RESPONSE' }), 3000)
		socket.on('connect', () => {
			socket.write([
				`GET ${target} HTTP/1.1`,
				`Host: 127.0.0.1:${port}`,
				'Upgrade: websocket',
				'Connection: Upgrade',
				'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
				'Sec-WebSocket-Version: 13',
			].join('\r\n') + '\r\n\r\n')
		})
		socket.on('data', (chunk) => {
			buffer += chunk.toString('latin1')
			if (!buffer.includes('\r\n')) return
			clearTimeout(timer)
			// 握手之后不再读：留着连接即可，迟到的 close 帧与 RST 都别把测试进程带崩。
			socket.removeAllListeners('data')
			socket.on('error', () => {})
			resolve({ socket, line: buffer.split('\r\n')[0] })
		})
		socket.on('error', () => { clearTimeout(timer); resolve({ socket, line: 'SOCKET-ERROR' }) })
		socket.connect(port, '127.0.0.1')
	})
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const shotsStatus = mkdtempSync(path.join(tmpdir(), 'dsh-bridge-auth-status-'))
const shotsGuard = mkdtempSync(path.join(tmpdir(), 'dsh-bridge-auth-guard-'))
const logs = []

const status = new BridgeServer({ port: P_STATUS, token: STRONG, shotsDir: shotsStatus, log: (line) => logs.push(line) })
const guard = new BridgeServer({
	port: P_GUARD,
	token: STRONG,
	shotsDir: shotsGuard,
	log: (line) => logs.push(line),
	guardCommand: (command) => (command === 'eval' ? '策略：HTTP 面禁止 eval（测试）' : undefined),
})
const weak = new BridgeServer({ port: P_WEAK, token: 'dsh-local', shotsDir: shotsStatus, log: (line) => logs.push(line) })

try {
	await status.start()
	await guard.start()
	await weak.start()

	console.log('\n1) /api/status：只读可读，ACAO 只给回环来源')
	const plain = await request(P_STATUS, { target: '/api/status' })
	const plainBody = JSON.parse(plain.body)
	check('无 Origin 的 /api/status 返回 200 且 ok:true', plain.status === 200 && plainBody.ok === true, `status=${plain.status}`)
	check('状态体带 wsUrl / shotsDir（GUI 探测与状态页依赖）', typeof plainBody.wsUrl === 'string' && typeof plainBody.shotsDir === 'string')
	check('无 Origin 时不回 ACAO', plain.headers['access-control-allow-origin'] === undefined, String(plain.headers['access-control-allow-origin']))
	check('/api/status 回 Cache-Control: no-store', plain.headers['cache-control'] === 'no-store', String(plain.headers['cache-control']))

	const gui = await request(P_STATUS, { target: '/api/status', headers: { Origin: 'http://127.0.0.1:3080' } })
	check('回环来源（DSH 控制页）回显该来源', gui.headers['access-control-allow-origin'] === 'http://127.0.0.1:3080', String(gui.headers['access-control-allow-origin']))
	check('回显时带 Vary: Origin', String(gui.headers.vary ?? '').includes('Origin'), String(gui.headers.vary))

	const evilRead = await request(P_STATUS, { target: '/api/status', headers: { Origin: 'https://evil.example' } })
	check('公网来源读 /api/status → 403（不再靠"回了 200 但没 ACAO"兜）', evilRead.status === 403, `status=${evilRead.status}`)
	const rebindRead = await request(P_STATUS, { target: '/api/status', headers: { Host: 'evil.example' } })
	check('Host 非回环（DNS-rebinding）读 /api/status → 403', rebindRead.status === 403, `status=${rebindRead.status}`)
	const rebindWrite = await request(P_STATUS, {
		method: 'POST',
		target: '/api/command',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${STRONG}`, Host: 'evil.example' },
		body: JSON.stringify({ command: 'ping', params: {} }),
	})
	check('Host 非回环 + 正确 token 的 POST /api/command → 403（token 不解决"页面凭什么发"）', rebindWrite.status === 403, `status=${rebindWrite.status}`)
	check('被 Host 校验拦下时日志点名了那个 Host', logs.some((line) => line.includes('http rejected: host evil.example')), 'logs')

	console.log('\n2) 预检（OPTIONS）不再放行任何跨域写')
	const preflight = await request(P_STATUS, {
		method: 'OPTIONS',
		target: '/api/command',
		headers: {
			Origin: 'https://evil.example',
			'Access-Control-Request-Method': 'POST',
			'Access-Control-Request-Headers': 'content-type',
		},
	})
	check('OPTIONS 返回 403（来源既不是回环也不是扩展，就连预检都不应答）', preflight.status === 403, `status=${preflight.status}`)
	check('OPTIONS 不回 ACAO', preflight.headers['access-control-allow-origin'] === undefined, String(preflight.headers['access-control-allow-origin']))
	check('OPTIONS 不回 Allow-Methods', preflight.headers['access-control-allow-methods'] === undefined, String(preflight.headers['access-control-allow-methods']))

	console.log('\n3) /api/command：无 token / 错 token 401，三种 token 形式都认')
	const cmdBody = JSON.stringify({ command: 'ping', params: {} })
	const noToken = await request(P_STATUS, { method: 'POST', target: '/api/command', headers: { 'Content-Type': 'application/json' }, body: cmdBody })
	check('无 token → 401', noToken.status === 401, `status=${noToken.status}`)
	const wrongToken = await request(P_STATUS, { method: 'POST', target: `/api/command?token=nope`, headers: { 'Content-Type': 'application/json' }, body: cmdBody })
	check('错 token → 401', wrongToken.status === 401, `status=${wrongToken.status}`)

	const viaQuery = await request(P_STATUS, { method: 'POST', target: `/api/command?token=${encodeURIComponent(STRONG)}`, headers: { 'Content-Type': 'application/json' }, body: cmdBody })
	check('?token= 放行（阳性对照：真的走到 execute → 503 无扩展）', viaQuery.status === 503, `status=${viaQuery.status} body=${viaQuery.body.slice(0, 60)}`)
	const viaBearer = await request(P_STATUS, { method: 'POST', target: '/api/command', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${STRONG}` }, body: cmdBody })
	check('Authorization: Bearer 放行', viaBearer.status === 503, `status=${viaBearer.status}`)
	const viaXToken = await request(P_STATUS, { method: 'POST', target: '/api/command', headers: { 'Content-Type': 'application/json', 'X-Token': STRONG }, body: cmdBody })
	check('X-Token 放行', viaXToken.status === 503, `status=${viaXToken.status}`)
	const viaLegacyHeader = await request(P_STATUS, { method: 'POST', target: '/api/command', headers: { 'Content-Type': 'application/json', 'X-DSH-Token': STRONG }, body: cmdBody })
	check('旧头 X-DSH-Token 仍兼容（本仓库差异点）', viaLegacyHeader.status === 503, `status=${viaLegacyHeader.status}`)

	console.log('\n4) /api/cleanup：真写操作，无 token 不动文件')
	const sentinel = path.join(shotsStatus, 'sentinel.png')
	writeFileSync(sentinel, 'x')
	// 阳性对照的另一半：非产物文件必须留下（以前是"清空目录里的一切"，
	// shotsDir 被指到真实目录就等于把用户的东西删了）。
	const stranger = path.join(shotsStatus, 'notes.txt')
	writeFileSync(stranger, 'keep me')
	const cleanupDenied = await request(P_STATUS, { method: 'POST', target: '/api/cleanup' })
	check('无 token → 401', cleanupDenied.status === 401, `status=${cleanupDenied.status}`)
	check('被拒后哨兵文件仍在（写操作没执行）', existsSync(sentinel))
	const cleanupAllowed = await request(P_STATUS, { method: 'POST', target: '/api/cleanup', headers: { Authorization: `Bearer ${STRONG}` } })
	const cleanupBody = JSON.parse(cleanupAllowed.body)
	check('带 token → 200 且真的删掉了哨兵文件', cleanupAllowed.status === 200 && !existsSync(sentinel), `status=${cleanupAllowed.status} removed=${cleanupBody.shotsRemoved}`)
	check('不是产物的文件没被删（只清 png/jpeg/webp/pdf/svg）', existsSync(stranger), `exists=${existsSync(stranger)}`)

	console.log('\n5) 状态页 / 不内嵌 token')
	const page = await request(P_STATUS, { target: '/' })
	check('状态页 200', page.status === 200, `status=${page.status}`)
	check('正文不含 token（内嵌=任何本机程序 GET / 就拿到凭据）', !page.body.includes(STRONG))
	check('正文含"不写盘/需 Token"提示', page.body.includes('Token'))

	console.log('\n6) WS 升级：Host 必须回环、Origin 必须不是网页')
	check('无 Origin + 正确 token → 101', (await wsUpgrade(P_STATUS, { token: STRONG })).includes('101'), await wsUpgrade(P_STATUS, { token: STRONG }))
	check('扩展来源（chrome-extension://）→ 101', (await wsUpgrade(P_STATUS, { token: STRONG, origin: 'chrome-extension://abcdefghijklmnop' })).includes('101'))
	check('网页来源 https://evil.example → 403', (await wsUpgrade(P_STATUS, { token: STRONG, origin: 'https://evil.example' })).includes('403'))
	check('Host 非回环（DNS-rebinding）→ 403', (await wsUpgrade(P_STATUS, { token: STRONG, host: 'evil.example' })).includes('403'))
	check('token 错 → 401', (await wsUpgrade(P_STATUS, { token: 'nope' })).includes('401'))

	console.log('\n6b) 换链路之后，旧 socket 自己的 data / error 不许拆掉新链路（审计第 3 条）')
	// 两段各自开一对链路：一段只测 data，一段只测 error —— 别让前一段的副作用替后一段作证。
	{
		const old = await wsOpen(P_STATUS, { token: STRONG })
		const fresh = await wsOpen(P_STATUS, { token: STRONG })
		check('两条链路都握手成功（第二条替换第一条）', old.line.includes('101') && fresh.line.includes('101'), `${old.line} / ${fresh.line}`)
		const up = JSON.parse((await request(P_STATUS, { target: '/api/status' })).body)
		check('状态面确认扩展已连上（阳性对照）', up.extensionConnected === true, `extensionConnected=${String(up.extensionConnected)}`)
		// 未掩码的数据帧（FIN+text、len=3、无 mask、载荷 ABC）＝协议错误。
		// 以前旧 socket 的 data 不认身份，这一帧会让桥 closeClientSocket(1002)，把**新**链路拆掉。
		try { old.socket.write(Buffer.from([0x81, 0x03, 0x41, 0x42, 0x43])) } catch {}
		await delay(200)
		const after = JSON.parse((await request(P_STATUS, { target: '/api/status' })).body)
		check('旧链路发来坏帧后，新链路仍连着', after.extensionConnected === true, `extensionConnected=${String(after.extensionConnected)}`)
		fresh.socket.destroy()
		await delay(150)
	}
	{
		const old = await wsOpen(P_STATUS, { token: STRONG })
		const fresh = await wsOpen(P_STATUS, { token: STRONG })
		check('（第二对）两条链路都握手成功', old.line.includes('101') && fresh.line.includes('101'), `${old.line} / ${fresh.line}`)
		// 旧链路上制造一次 socket error（RST）：以前它走 closeClientSocket(1011)，同样拆掉新链路。
		try { old.socket.resetAndDestroy() } catch {}
		await delay(250)
		const up = JSON.parse((await request(P_STATUS, { target: '/api/status' })).body)
		check('旧链路报错（ECONNRESET）后，新链路仍连着', up.extensionConnected === true, `extensionConnected=${String(up.extensionConnected)}`)
		// 阳性对照：新链路自己断开时，状态面必须如实变 false（证明上面不是"永远 true"的假绿）。
		fresh.socket.destroy()
		await delay(200)
		const after = JSON.parse((await request(P_STATUS, { target: '/api/status' })).body)
		check('新链路自己断开 → extensionConnected:false（阳性对照）', after.extensionConnected === false, `extensionConnected=${String(after.extensionConnected)}`)
	}

	console.log('\n6c) 链路掉了要在途命令当场失败，而不是熬到超时（同一处自查发现）')
	const thirdLink = await wsOpen(P_STATUS, { token: STRONG })
	const pendingRead = request(P_STATUS, {
		method: 'POST',
		target: '/api/command',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${STRONG}` },
		body: JSON.stringify({ command: 'ping', params: {} }),
	})
	await delay(120) // 让在途命令真的发出去（否则可能先断线再发命令，测的就不是这条路径）
	thirdLink.socket.destroy()
	const pendingRes = await pendingRead
	check('在途命令立即 502 且点名「断开」，不是 504 超时', pendingRes.status === 502 && /disconnect/i.test(pendingRes.body), `status=${pendingRes.status} body=${pendingRes.body.slice(0, 90)}`)

	console.log('\n7) guardCommand（X18）在 HTTP 命令面上仍生效')
	const blocked = await request(P_GUARD, { method: 'POST', target: '/api/command', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${STRONG}` }, body: JSON.stringify({ command: 'eval', params: { expression: '1' } }) })
	check('被策略拒绝 → 403 blocked', blocked.status === 403 && blocked.body.includes('blocked'), `status=${blocked.status} body=${blocked.body.slice(0, 80)}`)
	const allowed = await request(P_GUARD, { method: 'POST', target: '/api/command', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${STRONG}` }, body: JSON.stringify({ command: 'ping', params: {} }) })
	check('不在名单里的命令仍放行（阳性对照）', allowed.status === 503, `status=${allowed.status}`)

	console.log('\n8) 弱 token 自报 + 启动告警')
	const weakStatus = JSON.parse((await request(P_WEAK, { target: '/api/status' })).body)
	check('内置默认 token → insecureToken:true', weakStatus.insecureToken === true, JSON.stringify(weakStatus.insecureToken))
	check('强 token 实例 → insecureToken:false', plainBody.insecureToken === false, JSON.stringify(plainBody.insecureToken))
	check('启动日志有弱 token 告警', logs.some((line) => line.includes('token is the built-in default')))
} finally {
	await status.stop()
	await guard.stop()
	await weak.stop()
	rmSync(shotsStatus, { recursive: true, force: true })
	rmSync(shotsGuard, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
	console.log('失败：')
	for (const f of failed) console.log(`  ✗ ${f.name}`)
	process.exit(1)
}
