#!/usr/bin/env node
/**
 * permissions-decider.mjs — de-034「谁来定浏览器权限气泡」的**纯决策**验收（离线、不需要浏览器/重启）。
 *
 * 为什么单独测：权限气泡原本只能由人点；把决定权变成配置项之后，最容易出的错不是崩溃，
 * 而是**红线被悄悄绕过** —— 没有用户配置却自动放行、敏感类被模型一句"放行"就过、
 * `deny` 被模型主张盖掉。这些都不会报错，只会安静地把"要不要答"变成"已经答了"。
 *
 * 本文件只钉决策函数本身；执行侧（`chrome.contentSettings` / CDP `Browser.setPermission`）
 * 需要扩展权限 + 真机验证，尚未接线，这里**不假装**它能跑。
 *
 * 复现：node tests/permissions-decider.mjs      # 需要先 npm run build（lib/permissions.js）
 */

import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.resolve(here, '..', 'packages', 'browser-unified-plugin')
const require = createRequire(path.join(pkg, 'package.json'))
const core = await import(pathToFileURL(require.resolve('browser-unified-core')).href)

const results = []
function check(name, ok, detail) {
	results.push({ name, ok })
	console.log(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}

const perms = await import(pathToFileURL(path.join(pkg, 'lib', 'permissions.js')).href)
const { decidePermission, parsePermissionPolicy, permissionAuditRow, MODEL_CANNOT_ALLOW, PERMISSION_DECIDERS, CONTENT_SETTING, DEFAULT_PERMISSION_POLICY, DEFAULT_PERMISSION_POLICY_ENTRIES } = perms

console.log('\n[1] 红线：没有显式放权就绝不自作主张')
{
	const d0 = decidePermission({ decider: undefined, pref: 'automatic_downloads' })
	check('默认（没有配置）⇒ ask', d0.action === 'ask', JSON.stringify(d0))
	check('默认由"没人定"落账（by=none）', d0.by === 'none', JSON.stringify(d0))
	check('非法 decider ⇒ ask', decidePermission({ decider: 'nope', pref: 'notifications' }).action === 'ask')
	// 互斥配置：decider=ask 时即便写了类策略也不自动答（ask 的语义就是逐次问）
	const a1 = decidePermission({ decider: 'ask', policy: ['automatic_downloads=allow'], pref: 'automatic_downloads' })
	check('decider=ask 时类策略不生效（不越权）', a1.action === 'ask' && a1.by === 'none', JSON.stringify(a1))
}

console.log('\n[2] decider=policy：按类策略，inherit 仍交回人')
{
	const allow = decidePermission({ decider: 'policy', policy: ['automatic_downloads=allow'], pref: 'automatic_downloads' })
	check('类策略 allow ⇒ allow 且记为用户配置', allow.action === 'allow' && allow.by === 'configuration', JSON.stringify(allow))
	const deny = decidePermission({ decider: 'policy', policy: ['geolocation=deny'], pref: 'geolocation' })
	check('类策略 deny ⇒ deny 且记为用户配置', deny.action === 'deny' && deny.by === 'configuration', JSON.stringify(deny))
	const inherit = decidePermission({ decider: 'policy', policy: ['geolocation=deny'], pref: 'notifications' })
	check('没配的类 ⇒ ask（inherit）', inherit.action === 'ask' && inherit.by === 'none', JSON.stringify(inherit))
	const bogus = decidePermission({ decider: 'policy', policy: ['notifications=maybe'], pref: 'notifications' })
	check('策略值非法 ⇒ 按 inherit（宁可问，不猜）', bogus.action === 'ask', JSON.stringify(bogus))
}

console.log('\n[3] decider=model：模型能主张，但敏感类与 deny 压得住它')
{
	const normal = decidePermission({ decider: 'model', pref: 'automatic_downloads', requested: 'allow' })
	check('非敏感类：模型主张放行 ⇒ allow（by=model）', normal.action === 'allow' && normal.by === 'model', JSON.stringify(normal))
	const sensitive = decidePermission({ decider: 'model', pref: 'loopback_network', requested: 'allow' })
	check('敏感类（本地网络）：模型主张放行 ⇒ 降级为 ask', sensitive.action === 'ask' && sensitive.by === 'none', JSON.stringify(sensitive))
	const sensitiveConfigured = decidePermission({ decider: 'model', policy: ['loopback_network=allow'], pref: 'loopback_network', requested: 'allow' })
	check('敏感类 + 用户显式 allow ⇒ 由配置放行（不是模型）', sensitiveConfigured.action === 'allow' && sensitiveConfigured.by === 'configuration', JSON.stringify(sensitiveConfigured))
	const denyWins = decidePermission({ decider: 'model', policy: ['automatic_downloads=deny'], pref: 'automatic_downloads', requested: 'allow' })
	check('类策略 deny 压过模型主张', denyWins.action === 'deny' && denyWins.by === 'configuration', JSON.stringify(denyWins))
	const modelDeny = decidePermission({ decider: 'model', pref: 'notifications', requested: 'deny' })
	check('模型主张拒绝 ⇒ deny（by=model）', modelDeny.action === 'deny' && modelDeny.by === 'model', JSON.stringify(modelDeny))
	const noClaim = decidePermission({ decider: 'model', pref: 'notifications' })
	check('模型没有主张 ⇒ ask', noClaim.action === 'ask' && noClaim.by === 'none', JSON.stringify(noClaim))
	check('敏感类清单覆盖 de-034 点名的五类',
		['loopback_network', 'media_stream_camera', 'media_stream_mic', 'geolocation', 'clipboard'].every((k) => MODEL_CANNOT_ALLOW.has(k)))
	check('批量下载不在敏感清单里（用户明确愿意放权的一类）', !MODEL_CANNOT_ALLOW.has('automatic_downloads'))
}

console.log('\n[4] 配置解析与留痕形状')
{
	const parsed = parsePermissionPolicy(['automatic_downloads=allow', ' notifications = DENY ', '', '# 注释', 'nonsense', '=allow', 'x=weird'])
	check('解析：允许/拒绝/大小写与空白都认', parsed.automatic_downloads === 'allow' && parsed.notifications === 'deny')
	check('解析：注释、空行、没有 = 的条目被忽略', parsed[''] === undefined && Object.keys(parsed).length === 3, JSON.stringify(parsed))
	check('解析：非法值落成 inherit', parsed.x === 'inherit', JSON.stringify(parsed))
	check('解析：不是数组的输入也不炸', Object.keys(parsePermissionPolicy(undefined)).length === 0)

	const decided = decidePermission({ decider: 'policy', policy: ['automatic_downloads=allow'], pref: 'automatic_downloads' })
	const row = permissionAuditRow({ origin: 'https://example.com', pref: 'automatic_downloads', decided, from: CONTENT_SETTING.ASK, at: '2026-10-22T00:00:00.000Z' })
	check('留痕：带上旧值（可回滚）', row.from === CONTENT_SETTING.ASK, JSON.stringify(row))
	check('留痕：放行 ⇒ to=ALLOW', row.to === CONTENT_SETTING.ALLOW, JSON.stringify(row))
	check('留痕：带上决定来源与理由', row.by === 'configuration' && row.reason.length > 0, JSON.stringify(row))
	const asked = permissionAuditRow({ origin: 'https://example.com', pref: 'geolocation', decided: decidePermission({ decider: 'ask', pref: 'geolocation' }) })
	check('留痕：ask 不写盘（没有 to）', asked.to === undefined, JSON.stringify(asked))
	check('三个决定权取值都在（UI 可据此渲染）', PERMISSION_DECIDERS.join(',') === 'ask,policy,model', PERMISSION_DECIDERS.join(','))
}

console.log('\n[5] 默认放权口径（主人 2026-10-22 定）：只有允许与询问，没有自动拒绝')
{
	check('默认条目：剪贴板放行', DEFAULT_PERMISSION_POLICY.clipboard === 'allow', JSON.stringify(DEFAULT_PERMISSION_POLICY))
	check('默认条目：本地网络三类都放行',
		['loopback_network', 'local_network_access', 'local_network'].every((k) => DEFAULT_PERMISSION_POLICY[k] === 'allow'),
		JSON.stringify(DEFAULT_PERMISSION_POLICY))
	check('默认条目里没有任何 deny（默认不替用户拒绝）', Object.values(DEFAULT_PERMISSION_POLICY).every((v) => v !== 'deny'))
	check('默认条目能直接当配置值用（pref=allow 形态）',
		DEFAULT_PERMISSION_POLICY_ENTRIES.includes('clipboard=allow') && DEFAULT_PERMISSION_POLICY_ENTRIES.every((e) => e.endsWith('=allow')),
		DEFAULT_PERMISSION_POLICY_ENTRIES.join(','))

	const asConfig = [...DEFAULT_PERMISSION_POLICY_ENTRIES]
	const clip = decidePermission({ decider: 'policy', policy: asConfig, pref: 'clipboard' })
	check('默认配置下剪贴板 ⇒ allow（by=configuration）', clip.action === 'allow' && clip.by === 'configuration', JSON.stringify(clip))
	const lna = decidePermission({ decider: 'policy', policy: asConfig, pref: 'loopback_network' })
	check('默认配置下本地网络 ⇒ allow', lna.action === 'allow', JSON.stringify(lna))
	const geo = decidePermission({ decider: 'policy', policy: asConfig, pref: 'geolocation' })
	check('默认配置下定位 ⇒ ask（不自动放行，也不自动拒绝）', geo.action === 'ask' && geo.by === 'none', JSON.stringify(geo))
	const cam = decidePermission({ decider: 'policy', policy: asConfig, pref: 'media_stream_camera' })
	check('默认配置下摄像头 ⇒ ask', cam.action === 'ask', JSON.stringify(cam))
	const everyClass = ['clipboard', 'loopback_network', 'notifications', 'geolocation', 'media_stream_camera', 'media_stream_mic', 'automatic_downloads', 'file_system_write_guard', 'unknown_class_x']
	check('默认配置下任何类都不会被自动拒绝',
		everyClass.every((pref) => decidePermission({ decider: 'policy', policy: asConfig, pref }).action !== 'deny'))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) process.exit(1)
