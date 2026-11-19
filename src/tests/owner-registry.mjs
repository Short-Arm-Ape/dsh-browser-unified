#!/usr/bin/env node
/**
 * owner-registry.mjs — v0.11.54 a 半的回归：L1 占用表 + 「扩展没连上」的指名诊断。
 *
 * 为什么这两块要单独钉（两个真实故障换来的）：
 *  - 2026-11-14 台机「两套桥并行」：两个 `dsh web` 对同一个 Edge 各说各话，没有一张表
 *    回答「这个浏览器归谁」。L1 就是那张表 —— 它的危险失败模式是「各自都觉得自己是主人」
 *    和「频繁误拦」，两者都**静默**。
 *  - 2026-11-15/16 台机「唤起了但没用」：`extension_offline` 把四件不同的事压成一句话
 *    （端口 / 令牌 / 没装 / 被禁用），修法各不相同。诊断必须**指名**，而不是再喊一遍
 *    「扩展没连上」。
 *
 * 本套件钉九件事：
 *   1. 状态根与记录命名（平台差异、路径归一化）；
 *   2. 原子写 / 读坏文件不抛 / 「读不出 ≠ 没有」；
 *   3. 活死判定与顺手清理（死 pid、过期记录）；
 *   4. 排除自己、只删自己那条；
 *   5. 全表列举（活的留下，死的清掉，坏的报出来）；
 *   6. 诊断的每条原因都能被指名，且**优先级**正确（占用 > 令牌 > 端口 > 进程没起来 > 装/禁 > 合并 > 曾经连上 > 超时 > 从未来过）；
 *   7. 桥状态面新增的三样证据（握手被拒计数、最近一次 hello、断开时刻）真的被填上；
 *   8. 接线（按实例分截图目录、L1 写/删、占不到不谎报、离线回执带诊断）；
 *   9. 默认预算（schema 与 buddy 兜底同值 —— 只改一处会静默不生效）。
 *
 * 复现：
 *   cd packages/browser-unified-core && node node_modules/typescript/bin/tsc -p tsconfig.json
 *   cd ../browser-unified-plugin && node node_modules/typescript/bin/tsc -p tsconfig.json
 *   cd .. && node tests/owner-registry.mjs
 * （自带一个 9841 端口的桥实例，不需要 DSH、不需要浏览器。）
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const coreDist = path.join(repo, 'packages', 'browser-unified-core', 'dist', 'index.js')
const pluginLib = path.join(repo, 'packages', 'browser-unified-plugin', 'lib')
const { BridgeServer } = await import(pathToFileURL(coreDist).href)
const registry = await import(pathToFileURL(path.join(pluginLib, 'bridge-registry.js')).href)
const diagnosis = await import(pathToFileURL(path.join(pluginLib, 'offline-diagnosis.js')).href)
const pluginIndex = await import(pathToFileURL(path.join(pluginLib, 'index.js')).href)

const results = []
function check(name, ok, detail) {
	results.push({ name, ok: ok === true })
	console.log(`  ${ok === true ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'owner-registry-'))
const cleanup = []
function tempStateDir(label) {
	const dir = path.join(tmpRoot, label)
	mkdirSync(dir, { recursive: true })
	cleanup.push(dir)
	return dir
}

/** 拿一个**确定已经退出**的进程 pid（僵尸/退出后 pid 不会立刻被复用）。 */
function deadPid() {
	const run = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' })
	return run.pid
}

function makeRecord(overrides = {}) {
	const now = new Date().toISOString()
	return {
		schema: 1,
		userDataDir: 'C:\\Users\\localuser\\AppData\\Local\\Microsoft\\Edge\\User Data',
		profileDir: 'Profile 3',
		port: 9777,
		pid: process.pid,
		dshHome: 'D:\\dsh-data',
		instanceName: 'dsh-data',
		startedAt: now,
		updatedAt: now,
		...overrides,
	}
}

try {
	console.log('\n[1] 状态根与记录命名')
	{
		const win = registry.bridgeStateRoot({ env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, platform: 'win32' })
		check('Windows 默认根在 %LOCALAPPDATA%\\dsh-browser-bridge', win.endsWith(path.join('AppData', 'Local', 'dsh-browser-bridge')), win)
		const xdg = registry.bridgeStateRoot({ env: { XDG_STATE_HOME: '/home/x/.state' }, platform: 'linux' })
		check('posix 默认根跟随 XDG_STATE_HOME', xdg === path.join('/home/x/.state', 'dsh-browser-bridge'), xdg)
		const over = registry.bridgeStateRoot({ env: { DSH_BROWSER_BRIDGE_STATE_DIR: tmpRoot }, platform: 'win32' })
		check('环境变量能覆盖状态根（测试/运维用）', path.resolve(over) === path.resolve(tmpRoot), over)

		const a = registry.ownerFileName('C:\\Users\\x\\Edge\\User Data', 'win32')
		const b = registry.ownerFileName('c:/users/X/EDGE/user data/', 'win32')
		check('Windows 上大小写/分隔符/尾斜杠归一成同一个文件名', a === b, `${a} vs ${b}`)
		const c = registry.ownerFileName('/home/x/.config/edge', 'linux')
		const d = registry.ownerFileName('/home/X/.config/edge', 'linux')
		check('posix 上大小写**不**归一（区分大小写的文件系统）', c !== d)
		check('文件名是 16 位哈希 + .json', /^[0-9a-f]{16}\.json$/.test(a), a)
	}

	console.log('\n[2] 原子写 / 读坏文件不抛')
	{
		const stateDir = tempStateDir('write')
		const record = makeRecord()
		const first = registry.writeOwnerRecord(record, { stateDir })
		check('写出一条记录', first.written === true && existsSync(first.file), first.file)
		const file = first.file
		const read = registry.readOwnerRecord(record.userDataDir, { stateDir })
		check('读回来的字段对得上', read.record?.port === 9777 && read.record?.pid === process.pid, JSON.stringify(read.record))
		check('目录里没有残留 .tmp', readdirSync(path.dirname(file)).every((name) => !name.endsWith('.tmp')), readdirSync(path.dirname(file)).join(','))
		check('落盘是格式化 JSON（人可读）', readFileSync(file, 'utf8').includes('\n\t"schema": 1'))

		const missing = registry.readOwnerRecord('D:\\none\\User Data', { stateDir })
		check('没有记录时：record=undefined 且不报错（不是"读不出"）', missing.record === undefined && missing.error === undefined)

		writeFileSync(file, '{ 这不是 json', 'utf8')
		const broken = registry.readOwnerRecord(record.userDataDir, { stateDir })
		check('坏 JSON：报 error 且不抛（调用方据此"当作没有"继续）', broken.record === undefined && typeof broken.error === 'string', broken.error)

		writeFileSync(file, JSON.stringify({ schema: 2, userDataDir: 'x', port: 1, pid: 1, startedAt: 'a', updatedAt: 'a' }), 'utf8')
		const oldSchema = registry.readOwnerRecord(record.userDataDir, { stateDir })
		check('旧/未知 schema：不认（不当成有效记录）', oldSchema.record === undefined && typeof oldSchema.error === 'string')
	}

	console.log('\n[3] 活死判定与顺手清理')
	{
		const stateDir = tempStateDir('liveness')
		const live = makeRecord()
		registry.writeOwnerRecord(live, { stateDir })
		const found = registry.findLiveOwner(live.userDataDir, { stateDir, exclude: { pid: 1, port: 1 } })
		check('自己的 pid 活着 ⇒ 算活记录', found.record?.pid === process.pid)

		const dead = makeRecord({ userDataDir: 'D:\\dead\\User Data', pid: deadPid(), port: 9888 })
		registry.writeOwnerRecord(dead, { stateDir })
		const afterDead = registry.findLiveOwner(dead.userDataDir, { stateDir, exclude: { pid: 1, port: 1 } })
		check('死 pid ⇒ 不算活记录', afterDead.record === undefined)
		check('死记录被顺手删掉', afterDead.removedDead.length === 1, afterDead.removedDead.join(','))

		const staleDir = tempStateDir('stale')
		const stale = makeRecord({
			userDataDir: 'D:\\stale\\User Data',
			updatedAt: new Date(Date.now() - registry.OWNER_RECORD_MAX_AGE_MS - 60_000).toISOString(),
		})
		registry.writeOwnerRecord(stale, { stateDir: staleDir })
		check('pid 活着但记录过期 ⇒ 判死（防 pid 复用把桥永远拦住）',
			registry.findLiveOwner(stale.userDataDir, { stateDir: staleDir }).record === undefined)
	}

	console.log('\n[4] 排除自己 / 只删自己那条')
	{
		const stateDir = tempStateDir('self')
		const own = makeRecord({ port: 9777 })
		registry.writeOwnerRecord(own, { stateDir })
		const excluded = registry.findLiveOwner(own.userDataDir, { stateDir, exclude: { pid: process.pid, port: 9777 } })
		check('exclude 命中自己 ⇒ 返回"没有别人占用"', excluded.record === undefined)
		const otherPort = registry.findLiveOwner(own.userDataDir, { stateDir, exclude: { pid: process.pid, port: 1 } })
		check('exclude 只排除同 pid+port ⇒ 端口不同就算别人', otherPort.record?.port === 9777)

		check('端口对不上 ⇒ 不删', registry.removeOwnRecord(own.userDataDir, { pid: process.pid, port: 1 }, { stateDir }) === false)
		check('记录还在', existsSync(registry.ownerFilePath(own.userDataDir, { stateDir })))
		check('pid+port 对得上 ⇒ 删掉', registry.removeOwnRecord(own.userDataDir, { pid: process.pid, port: 9777 }, { stateDir }) === true)
		check('删完文件没了', !existsSync(registry.ownerFilePath(own.userDataDir, { stateDir })))
	}

	console.log('\n[4b] 一个浏览器只留一行：不覆盖别人的活记录')
	{
		const stateDir = tempStateDir('takeover')
		const userDataDir = 'D:\\edge\\User Data'
		// 一个活着的"别的桥"：起一个会睡一会儿的子进程冒充它。
		const foreign = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'ignore' })
		try {
			const theirs = makeRecord({ userDataDir, pid: foreign.pid, port: 9787, instanceName: 'dsh-data-assistant' })
			check('别人先写成功', registry.writeOwnerRecord(theirs, { stateDir }).written === true)
			const mine = makeRecord({ userDataDir, pid: process.pid, port: 9777 })
			const refused = registry.writeOwnerRecord(mine, { stateDir })
			check('第二个桥来写 ⇒ 被拒（written=false）', refused.written === false)
			check('被拒时把占着的那条还回来（能指名）', refused.existing?.port === 9787 && refused.existing?.pid === foreign.pid)
			const still = registry.readOwnerRecord(userDataDir, { stateDir })
			check('文件内容仍是第一个桥的（没被踩掉）', still.record?.port === 9787 && still.record?.pid === foreign.pid)
			check('第二个桥删不掉别人的记录',
				registry.removeOwnRecord(userDataDir, { pid: process.pid, port: 9777 }, { stateDir }) === false
				&& existsSync(registry.ownerFilePath(userDataDir, { stateDir })))
		} finally {
			foreign.kill()
		}
	}

	console.log('\n[5] 全表列举：活的留下、死的清掉、坏的报出来')
	{
		const stateDir = tempStateDir('list')
		registry.writeOwnerRecord(makeRecord({ userDataDir: 'D:\\a\\User Data', port: 9777 }), { stateDir })
		registry.writeOwnerRecord(makeRecord({ userDataDir: 'D:\\b\\User Data', pid: deadPid(), port: 9787 }), { stateDir })
		const brokenFile = path.join(registry.bridgesDir({ stateDir }), 'ffffffffffffffff.json')
		writeFileSync(brokenFile, 'not json', 'utf8')
		const listed = registry.listOwnerRecords({ stateDir })
		check('活记录 1 条', listed.records.length === 1, String(listed.records.length))
		check('死记录被清 1 条', listed.removedDead.length === 1, listed.removedDead.join(','))
		check('坏文件被报出来（不静默吞掉）', listed.unreadable.length === 1, listed.unreadable.join(','))
	}

	console.log('\n[6] 诊断：每条原因都能被指名，优先级正确')
	{
		const { diagnoseOffline } = diagnosis
		const owner = { port: 9787, pid: 23144, dshHome: 'F:\\dsh-data-assistant', instanceName: 'dsh-data-assistant', startedAt: '2026-11-15T09:12:44Z' }
		const target = { userDataDir: 'C:\\Users\\localuser\\AppData\\Local\\Microsoft\\Edge\\User Data', profileDir: 'Profile 4', profileName: 'Agent' }

		const owned = diagnoseOffline({ otherOwner: owner, handshakeRejects: { badToken: 2, badHost: 0, badOrigin: 0, lastReason: 'bad-token', lastAt: '2026-11-18T00:01:02Z' } })
		check('占用 + 令牌被拒 ⇒ 主因是占用（别的桥在管，先解决谁管）', owned.primary?.id === 'other-bridge-owns', owned.primary?.id)
		check('占用文案带端口/pid/DSH_HOME', owned.text.includes('9787') && owned.text.includes('23144') && owned.text.includes('dsh-data-assistant'))
		check('令牌被拒排在"已核"里，没被吞掉', owned.causes.some((cause) => cause.id === 'token-mismatch'))

		const token = diagnoseOffline({ handshakeRejects: { badToken: 3, badHost: 0, badOrigin: 0, lastReason: 'bad-token', lastAt: '2026-11-18T00:01:02Z' } })
		check('握手 badToken ⇒ token-mismatch', token.primary?.id === 'token-mismatch', token.primary?.id)
		check('令牌文案说清"扩展拨过桥"这件关键事实', token.text.includes('拨过'))

		const port = diagnoseOffline({ port: 9900, scanWindow: { base: 9777, count: 10 } })
		check('端口在扫描窗口外 ⇒ port-out-of-scan', port.primary?.id === 'port-out-of-scan', port.primary?.id)
		check('端口文案给出两个修法（填扩展端口 / 改回窗口内）', port.text.includes('9900'))

		const absent = diagnoseOffline({ target, extension: 'absent', extensionId: 'nlhedoliokpkcodjlgdlhiiohjcbbaap' })
		check('确定没装 ⇒ extension-absent', absent.primary?.id === 'extension-absent', absent.primary?.id)

		const unknown = diagnoseOffline({ target, extension: 'unknown' })
		check('读不出（unknown）**不许**说成没装', !unknown.causes.some((cause) => cause.id === 'extension-absent'))
		check('读不出时落到 never-connected 并把四种原因列全',
			unknown.primary?.id === 'never-connected'
			&& ['端口', '令牌', '没装', '被禁用'].every((word) => unknown.text.includes(word)), unknown.primary?.id)

		const disabled = diagnoseOffline({ target, extension: 'present-disabled' })
		check('装了但禁用 ⇒ extension-disabled', disabled.primary?.id === 'extension-disabled', disabled.primary?.id)
		check('禁用文案指到 edge://extensions', disabled.text.includes('edge://extensions'))

		const merged = diagnoseOffline({ target, spawn: { pid: 4242, spawnedAt: 1000, exitedAt: 1100, exitCode: 0, waitedMs: 8000 } })
		check('拉起进程 100 ms 就 exit 0 ⇒ merged-into-running-instance', merged.primary?.id === 'merged-into-running-instance', merged.primary?.id)
		check('合并文案给出毫秒数与资料页', merged.text.includes('100 ms') && merged.text.includes('Profile 4'))

		const dropped = diagnoseOffline({ lastHello: { version: '1.0.56', at: '2026-11-17T15:44:17Z' }, lastDisconnectAt: '2026-11-18T00:10:00Z' })
		check('曾经 hello 过 ⇒ dropped-after-hello', dropped.primary?.id === 'dropped-after-hello', dropped.primary?.id)

		const timeout = diagnoseOffline({ target, spawn: { pid: 5151, spawnedAt: 1000, exitCode: null, waitedMs: 8000 } })
		check('进程还在、等到超时 ⇒ hello-timeout', timeout.primary?.id === 'hello-timeout', timeout.primary?.id)
		check('超时文案带等待时长', timeout.text.includes('8000 ms'))

		const sandbox = diagnoseOffline({ env: 'sandbox', target: { userDataDir: 'D:\\tmp\\sb', profileDir: 'Default' } })
		check('沙箱环境要标出来（沙箱结论不代表用户的浏览器）', sandbox.text.includes('sandbox'))

		// 2026-11-18：拉起的进程根本没起来（ENOENT/EACCES）以前会被说成「还在跑」，
		// 而且会被拖去 edge://extensions 白折腾。现在它必须**排在扩展那两条前面**、指名到路径。
		const launchFailed = diagnoseOffline({
			target,
			extension: 'absent',
			spawn: { pid: 6001, waitedMs: 120, spawnError: 'spawn ENOENT' },
		})
		check('进程没起来 ⇒ launch-failed', launchFailed.primary?.id === 'launch-failed', launchFailed.primary?.id)
		check('launch-failed 是主因（extension-absent 只降级到"已核（不是主因）"）',
			launchFailed.causes[0]?.id === 'launch-failed'
			&& launchFailed.text.startsWith('诊断：浏览器')
			&& launchFailed.text.includes('已核（不是主因）'),
			launchFailed.causes.map((cause) => cause.id).join(','))
		check('launch-failed 文案带原始错误与修法',
			launchFailed.text.includes('ENOENT') && launchFailed.text.includes('autoLaunchBrowserExe'))
		check('launch-failed 不谎报「还在跑」', !launchFailed.text.includes('还在跑'))
		check('evidence 标 spawnState=error',
			launchFailed.primary?.evidence.some((row) => row === 'spawnState=error') === true,
			JSON.stringify(launchFailed.primary?.evidence ?? null))

		// 有 spawnError 时不许被读成「合并进已运行实例」：两者修法相反（一个改路径、一个关窗口）。
		const errWithExit = diagnoseOffline({
			target,
			spawn: { pid: 6002, spawnedAt: 1000, exitedAt: 1100, exitCode: 0, spawnError: 'spawn EACCES', waitedMs: 100 },
		})
		check('spawnError 在场就不判 merged-into-running-instance',
			!errWithExit.causes.some((cause) => cause.id === 'merged-into-running-instance'),
			errWithExit.primary?.id)
		check('spawnError 在场也不判 hello-timeout（进程没起来，谈不上"起来了没连上"）',
			!errWithExit.causes.some((cause) => cause.id === 'hello-timeout'),
			errWithExit.causes.map((cause) => cause.id).join(','))
	}

	console.log('\n[7] 桥状态面：握手被拒计数 + hello 历史留下来')
	{
		const PORT = 9841
		const TOKEN = 'owner-registry-token-0123456789'
		const shotsDir = tempStateDir('shots')
		const server = new BridgeServer({
			port: PORT,
			token: TOKEN,
			shotsDir,
			log: () => {},
			pluginVersion: '0.11.54-test',
		})
		await server.start()

		const bad = await wsUpgrade(PORT, { token: 'wrong-token' })
		check('错误 token：401', bad.line === 'HTTP/1.1 401 Unauthorized', bad.line)
		check('握手被拒被计数（badToken=1）', server.status.handshakeRejects.badToken === 1, String(server.status.handshakeRejects.badToken))
		check('记下最后一次被拒原因', server.status.handshakeRejects.lastReason === 'bad-token', String(server.status.handshakeRejects.lastReason))
		check('记下被拒时刻', typeof server.status.handshakeRejects.lastAt === 'string')

		const web = await wsUpgrade(PORT, { token: TOKEN, origin: 'https://evil.example' })
		check('网页来源带对的 token：403', web.line === 'HTTP/1.1 403 Forbidden', web.line)
		check('badOrigin 也被计数', server.status.handshakeRejects.badOrigin === 1, String(server.status.handshakeRejects.badOrigin))

		check('还没 hello 时 lastHello 是 undefined（状态面不许编）', server.status.lastHello === undefined)

		const good = await wsUpgrade(PORT, { token: TOKEN })
		check('扩展来源（不带网页 Origin）：101', good.line === 'HTTP/1.1 101 Switching Protocols', good.line)
		check('连上了 ⇒ extensionConnected=true', server.status.extensionConnected === true)
		sendText(good.socket, JSON.stringify({
			type: 'hello',
			client: 'dsh-browser-extension',
			version: '1.0.56',
			protocol: 1,
			extensionId: 'nlhedoliokpkcodjlgdlhiiohjcbbaap',
			browser: { name: 'edge', version: '157.0.0.0', ua: 'test' },
		}))
		await sleep(200)
		check('hello 之后 status.hello 有版本', server.status.hello?.version === '1.0.56', String(server.status.hello?.version))
		check('lastHello 留档（含到达时刻）',
			server.status.lastHello?.version === '1.0.56' && typeof server.status.lastHello?.at === 'string',
			JSON.stringify(server.status.lastHello === undefined ? null : { v: server.status.lastHello.version, at: server.status.lastHello.at }))

		good.socket.destroy()
		await sleep(300)
		check('断开后 hello 清空', server.status.hello === undefined)
		check('断开后 lastDisconnectAt 有值', typeof server.status.lastDisconnectAt === 'string')
		check('断开后 lastHello **仍然留着**（"连上过又掉了"要能分辨）', server.status.lastHello?.version === '1.0.56')

		await server.stop()
		check('停掉后不再监听', server.status.listening === false)
	}

	console.log('\n[8] 接线：默认截图目录按实例分、桥起来就写 L1、抢占到别人就拒写')
	{
		const dshHome = tempStateDir('dsh-home')
		const stateDir = tempStateDir('wired-state')
		const fakeUserData = tempStateDir('fake-userdata')
		process.env.DSH_HOME = dshHome
		process.env.DSH_BROWSER_BRIDGE_STATE_DIR = stateDir
		const instanceName = path.basename(dshHome)
		writeFileSync(path.join(dshHome, 'browser-unified-pairing.json'), JSON.stringify({
			brandId: 'edge',
			userDataDir: fakeUserData,
			profileDir: 'Default',
			matchedBy: 'extension-id',
			resolvedAt: new Date().toISOString(),
		}), 'utf8')

		const baseConfig = {
			enabled: true, port: 9861, token: 'owner-registry-strong-token-0', shotsDir: 'dsh-browser-shots',
			urlMode: 'public', blockMetadata: true, metadataHostnames: [], metadataIps: [],
			internetAccess: 'allow', lanAccess: 'deny', localAccess: 'deny',
			internetTemp: false, lanTemp: false, localTemp: false, askMode: 'inherit',
			dshAccessEnabled: false, dshOrigins: [], allowHosts: [], denyHosts: [], registryDir: '',
			readOnly: false, allowScript: true, holdMode: 'black', holdEnabled: true, evalNavGuard: true,
			focusMode: 'auto', restoreWhenMinimized: false, permissionDecider: 'ask',
			autoLaunchEnabled: false, autoLaunchIdleSeconds: 15, autoLaunchBrowserExe: '',
			autoLaunchProfileDir: '', autoLaunchProfileName: '', autoLaunchTempProfile: false,
			autoLaunchExtensionDir: '', autoLaunchOnToolUse: false, autoLaunchWaitMs: 300,
		}
		const controller = new pluginIndex.BridgeController(() => {})
		await controller.reconcile(baseConfig, { throwOnError: true })
		check('默认 shotsDir 自动多加一层实例名（两个 DSH 实例共用工作区时不会互相清理）',
			controller.shotsDir?.endsWith(path.join('dsh-browser-shots', instanceName)) === true, String(controller.shotsDir))
		const recordFile = registry.ownerFilePath(fakeUserData, { stateDir })
		check('桥起来就写出一条 L1 记录', existsSync(recordFile), recordFile)
		const written = JSON.parse(readFileSync(recordFile, 'utf8'))
		check('记录里的端口/pid/DSH_HOME/实例名都对',
			written.port === 9861 && written.pid === process.pid
			&& path.resolve(written.dshHome) === path.resolve(dshHome) && written.instanceName === instanceName,
			JSON.stringify({ port: written.port, pid: written.pid, dshHome: written.dshHome }))
		check('状态面能看到自己占着哪个浏览器', controller.describePolicy().ownerRecord?.userDataDir === fakeUserData)

		// A2 的形状：扩展没连上时，工具调用拿到的必须是**指名**的 extension_offline，而不是一句「没连上」。
		let offlineError
		const offlineStart = Date.now()
		try {
			await controller.execute('tabs.list', {}, new AbortController().signal)
		} catch (error) {
			offlineError = error
		}
		const offlineElapsed = Date.now() - offlineStart
		check('没扩展时**真的重试了**（耗时不小于两轮间隔；否则"重试"是空话）',
			offlineElapsed >= 700, `${offlineElapsed} ms`)
		check('没扩展时 execute 抛 extension_offline', offlineError?.code === 'extension_offline', String(offlineError?.code))
		check('回执里带「诊断：」和具体原因（不是只喊"扩展没连上"）',
			typeof offlineError?.message === 'string' && offlineError.message.includes('诊断：')
			&& /端口|令牌|没装|被禁用/.test(offlineError.message),
			typeof offlineError?.message === 'string' ? offlineError.message.slice(0, 120) : String(offlineError))
		check('回执仍带"重试安全"那半句（effectState 契约没被吞掉）',
			typeof offlineError?.message === 'string' && offlineError.message.includes('重试安全'))

		await controller.stop()
		check('停掉后自己那条记录被删', !existsSync(recordFile))

		// 抢占：别人占着时本桥不写、不自称主人，状态面把占用者说出来。
		const foreign = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'ignore' })
		try {
			registry.writeOwnerRecord(makeRecord({ userDataDir: fakeUserData, pid: foreign.pid, port: 9787 }), { stateDir })
			const second = new pluginIndex.BridgeController(() => {})
			await second.reconcile({ ...baseConfig, port: 9862 }, { throwOnError: true })
			const conflict = second.describePolicy()
			check('写不进别人的记录 ⇒ 状态面报 ownerConflict', conflict.ownerConflict?.port === 9787, JSON.stringify(conflict.ownerConflict ?? null))
			check('同时不谎报自己占着', conflict.ownerRecord === undefined)
			check('文件仍是第一个桥的', JSON.parse(readFileSync(recordFile, 'utf8')).port === 9787)
			await second.stop()
		} finally {
			foreign.kill()
		}
	}

	console.log('\n[9] 默认预算：schema 与 buddy 兜底必须同值')
	{
		// 为什么单独钉：这个默认值有两处来源（插件 Config schema / buddy 的 BUDDY_DEFAULTS），
		// 只改一处不会报错 —— 走热更新那条路时仍拿旧值，于是「改小了却没变快」。
		const buddy = await import(pathToFileURL(path.join(pluginLib, 'buddy.js')).href)
		const schemaDefault = pluginIndex.Config?.dict?.autoLaunchWaitMs?.meta?.default
		check('schema 默认 4000（2026-11-18 主人定：坏的时候别让调用方干等 8 s）', schemaDefault === 4000, String(schemaDefault))
		check('buddy 兜底与 schema 同值', buddy.BUDDY_DEFAULTS?.autoLaunchWaitMs === schemaDefault,
			`buddy=${String(buddy.BUDDY_DEFAULTS?.autoLaunchWaitMs)} vs schema=${String(schemaDefault)}`)
	}

	console.log('\n[10] 只在「扩展还没连上」时重试（发送前失败才幂等）')
	{
		const retry = await import(pathToFileURL(path.join(pluginLib, 'offline-retry.js')).href)
		const { shouldRetryOffline, OFFLINE_RETRY_ROUNDS, OFFLINE_RETRY_DELAY_MS } = retry
		check('extension_offline 第 1 轮 ⇒ 再试', shouldRetryOffline({ code: 'extension_offline', round: 1 }) === true)
		check('没到上限都再试', shouldRetryOffline({ code: 'extension_offline', round: OFFLINE_RETRY_ROUNDS - 1 }) === true)
		check('到上限就放弃', shouldRetryOffline({ code: 'extension_offline', round: OFFLINE_RETRY_ROUNDS }) === false)
		check('link_lost **绝不**重试（写操作可能已落地，重试＝点两次）',
			shouldRetryOffline({ code: 'link_lost', round: 1 }) === false)
		check('command_timeout 不重试', shouldRetryOffline({ code: 'command_timeout', round: 1 }) === false)
		check('cancelled_in_flight 不重试', shouldRetryOffline({ code: 'cancelled_in_flight', round: 1 }) === false)
		check('已中止就不重试', shouldRetryOffline({ code: 'extension_offline', round: 1, aborted: true }) === false)
		check('轮数与间隔是具体数（3 轮 / 400 ms）',
			OFFLINE_RETRY_ROUNDS === 3 && OFFLINE_RETRY_DELAY_MS === 400,
			`${OFFLINE_RETRY_ROUNDS} 轮 / ${OFFLINE_RETRY_DELAY_MS} ms`)
	}
} finally {
	for (const dir of cleanup) {
		try {
			rmSync(dir, { recursive: true, force: true })
		} catch {
			// 临时目录删不掉不影响判定。
		}
	}
	try {
		rmSync(tmpRoot, { recursive: true, force: true })
	} catch {
		// 同上。
	}
}

const failed = results.filter((row) => !row.ok)
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
	console.log('失败项：')
	for (const row of failed) console.log(`  ✗ ${row.name}`)
	process.exit(1)
}

/** 发一条已掩码的文本帧（客户端必须掩码，RFC 6455）。 */
function sendText(socket, text) {
	const payload = Buffer.from(text, 'utf8')
	const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
	let header
	if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length])
	else {
		header = Buffer.alloc(4)
		header[0] = 0x81
		header[1] = 0x80 | 126
		header.writeUInt16BE(payload.length, 2)
	}
	const masked = Buffer.from(payload)
	for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4]
	socket.write(Buffer.concat([header, mask, masked]))
}

/** 发一次原始 WS 握手，回状态行（101/401/403）与那条 socket。 */
function wsUpgrade(port, { token, origin } = {}) {
	return new Promise((resolve) => {
		const socket = new net.Socket({ allowHalfOpen: true })
		let buffer = ''
		const settle = (line) => {
			socket.removeListener('data', onData)
			socket.on('error', () => {})
			resolve({ socket, line })
		}
		const timer = setTimeout(() => settle('NO-RESPONSE'), 3000)
		const onData = (chunk) => {
			buffer += chunk.toString('latin1')
			if (!buffer.includes('\r\n')) return
			clearTimeout(timer)
			settle(buffer.split('\r\n')[0])
		}
		socket.on('data', onData)
		socket.on('error', () => {
			clearTimeout(timer)
			settle('SOCKET-ERROR')
		})
		socket.connect(port, '127.0.0.1', () => {
			const lines = [
				`GET /ws?token=${encodeURIComponent(token ?? '')} HTTP/1.1`,
				`Host: 127.0.0.1:${port}`,
				'Upgrade: websocket',
				'Connection: Upgrade',
				'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
				'Sec-WebSocket-Version: 13',
			]
			if (origin !== undefined) lines.push(`Origin: ${origin}`)
			socket.write(`${lines.join('\r\n')}\r\n\r\n`)
		})
	})
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
