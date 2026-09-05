/**
 * dsh-browser-unified — browser client half (hand-assembled module-loader bundle).
 *
 * Registers one "浏览器" section in the DSH Settings shell (settings.section)
 * and edits the `browser-bridge` settings namespace through the shared
 * settings-scope transport (ctx.settingsScope). Every write lands in the Host
 * settings document; the host plugin's scope.watch then reconciles the bridge
 * live — the metadata endpoint lists apply without restarting the listener.
 *
 * Styling follows the DSH native theme tokens (--dsw-alias-*): the section
 * adapts to light/dark automatically and never hardcodes theme colors.
 * Sub-groups are fold cards (accordion) mirroring the settings plugin cards.
 *
 * Loader format as produced by the official client bundler:
 * `window.__ModuleLoader__.load({ id, factory })`, with require('react')
 * resolved from the page module table. No TSX / no other bare imports, so it
 * needs no bundler of its own. AGPL-3.0 (see NOTICE.md).
 */
window.__ModuleLoader__.load({
	id: 'dsh-browser-unified',
	factory: (require) => {
		'use strict'
		var module = { exports: {} }
		var exports = module.exports
		var react = require('react')
		var React = react && react.__esModule && react.default ? react.default : react
		var createElement = React.createElement
		var useState = React.useState
		var useRef = React.useRef
		var useSyncExternalStore = React.useSyncExternalStore

		// --- minimal zh/en copy (static; the page follows the browser language) ---
		function isZh() {
			try { return (navigator.language || 'zh').toLowerCase().indexOf('zh') === 0 } catch (e) { return true }
		}
		var L = {
			zh: {
				nav: '浏览器插件',
				intro: 'DSH 浏览器控制（browser-bridge）：本地桥、URL 策略与访问控制。保存即时生效。',
				idBadge: 'dsh-browser-unified · browser-bridge',
				general: '常规',
				enabled: '启用浏览器桥',
				enabledDesc: '关闭后工具仍挂载，但每次调用会提示如何重新开启。',
				urlMode: 'URL 策略档位',
				urlModePublic: 'public —— 拦私网 / 回环 / 云元数据目标',
				urlModeIntranet: 'intranet —— 放行本地 / LAN，仍拦截云元数据端点',
				transport: '监听与路径',
				transportSub: '端口、令牌与目录（改动会重启本地桥）',
				port: '端口',
				token: '令牌（扩展连接用）',
				shotsDir: '截图目录',
				registryDir: 'registry 目录（留空用包内副本）',
				metadata: '云元数据端点拦截',
				metadataSub: '拦截实例元数据服务；内置默认仅是初始值，可整体替换',
				blockMetadata: '拦截云元数据端点',
				blockMetadataDesc: '关闭表示接受访问实例元数据服务（如自建 VPC 沙箱内）。',
				metaHosts: '拦截的主机名',
				metaHostsHint: '整体替换内置默认；清空则不拦此类；支持 *.suffix 通配（如 *.baidu.com 拦所有子域）。',
				metaIps: '拦截的 IP',
				metaIpsHint: '整体替换内置默认。',
				defaultsHint: '内置默认仅是初始值：AWS/GCP/Azure 169.254.169.254、阿里 100.100.100.200 等。修改列表会整体替换内置默认。',
				addHost: '添加主机名…',
				addIp: '添加 IP…',
				add: '添加',
				remove: '移除',
				resetDefaults: '恢复内置默认',
				clearAll: '清空全部',
				saving: '保存中…',
				saved: '已保存',
				error: '写入失败：',
				unavailable: '设置服务暂不可用（namespace 未暴露或页面为 memory 模式）。',
				loading: '正在读取配置…',
				enabledOn: '已启用',
				enabledOff: '已停用',
				collapse: '展开/折叠',
				empty: '（空）',
				access: '访问控制',
				accessSub: '外网 / 局域网 / 本机分域：放行、需审批或拒绝；临时授权与 DSH 页面访问可单独开关',
				realmInternet: '外网访问',
				realmLan: '局域网访问',
				realmLocal: '本机（回环）访问',
				realmDesc: '需审批=陌生主机弹一次批准（本会话记住）；拒绝=一律拒绝；白名单主机在需审批下免批准。',
				tempInternet: '允许外网临时授权',
				tempLan: '允许局域网临时授权',
				tempLocal: '允许本机临时授权',
				tempHint: '关闭后该域不再弹批准，只能靠白名单放行',
				askMode: '审批缺失（完全权限）时的策略',
				askModeDesc: '仅影响 ask 域且主机未列入白名单、且无法请求审批时：继承=沿用此前设置（含本会话临时授权）；放行=视为已授权放行（云元数据端点、未启用的 DSH 页面访问、凭据与 denyHosts 等在放行前先行判定）；禁止=直接拒绝',
				askModeInherit: '继承',
				askModeAllow: '放行',
				askModeDeny: '禁止',
				modeAllow: '放行',
				modeAsk: '需审批',
				modeDeny: '拒绝',
				dshItem: '允许访问本 DSH 页面',
				dshItemDesc: '已录入的控制页地址在关闭（默认）时会被拒绝、开启后放行（即使 public 档也放行并跳过域审批）。先录地址即可生效拦截，开启需二次确认。',
				dshConfirmTitle: '二次确认：允许模型访问本 DSH 控制页',
				dshConfirmBody: '模型能操作浏览器，若它也访问本控制页，理论上可自行与页面交互（含你的会话内容与审批界面）。请仅在需要模型调试 DSH 自身时开启；开启后仍受 denyHosts/元数据等红线约束。',
				dshConfirmOk: '仍然开启（我已了解风险）',
				dshCancel: '取消',
				dshDetected: '检测到本页面地址：',
				dshEnableDetected: '填入该地址并开启',
				dshOriginsLabel: 'DSH 页面地址',
				dshAddOrigin: '添加 DSH 页面地址…',
				allowHosts: '白名单（需审批的域里免批准）',
				allowHostsHint: '支持精确主机/IP 与 *.suffix 通配',
				denyHosts: '黑名单（任何模式都拦截）',
				denyHostsHint: '支持精确主机/IP 与 *.suffix 通配',
				addAllow: '添加白名单主机…',
				addDeny: '添加黑名单主机…',
			},
			en: {
				nav: 'Browser plugin',
				intro: 'DSH Browser Control (browser-bridge): local bridge, URL policy and access control. Saves apply live.',
				idBadge: 'dsh-browser-unified · browser-bridge',
				general: 'General',
				enabled: 'Enable browser bridge',
				enabledDesc: 'When off, tools stay mounted but every call explains how to turn it back on.',
				urlMode: 'URL policy mode',
				urlModePublic: 'public — blocks private / loopback / cloud-metadata targets',
				urlModeIntranet: 'intranet — allows local / LAN, still blocks cloud-metadata endpoints',
				transport: 'Listener & paths',
				transportSub: 'Port, token and directories (changing restarts the local bridge)',
				port: 'Port',
				token: 'Token (presented by the extension)',
				shotsDir: 'Screenshots directory',
				registryDir: 'Registry directory (empty = package copies)',
				metadata: 'Cloud-metadata endpoint blocking',
				metadataSub: 'Instance-metadata services; built-in defaults are only the initial value and can be fully replaced',
				blockMetadata: 'Block cloud-metadata endpoints',
				blockMetadataDesc: 'Off means accepting access to instance-metadata services (e.g. inside your own VPC sandbox).',
				metaHosts: 'Blocked hostnames',
				metaHostsHint: 'Fully replaces built-in defaults; empty blocks none. Supports *.suffix wildcards (e.g. *.baidu.com).',
				metaIps: 'Blocked IPs',
				metaIpsHint: 'Fully replaces built-in defaults.',
				defaultsHint: 'Built-ins are only the initial value: AWS/GCP/Azure 169.254.169.254, Alibaba 100.100.100.200 etc. Editing the list replaces them entirely.',
				addHost: 'Add hostname…',
				addIp: 'Add IP…',
				add: 'Add',
				remove: 'Remove',
				resetDefaults: 'Restore built-in defaults',
				clearAll: 'Clear all',
				saving: 'Saving…',
				saved: 'Saved',
				error: 'Write failed: ',
				unavailable: 'Settings service unavailable (namespace not exposed, or page is in memory mode).',
				loading: 'Loading configuration…',
				enabledOn: 'enabled',
				enabledOff: 'disabled',
				collapse: 'Expand/collapse',
				empty: '(empty)',
				access: 'Access control',
				accessSub: 'Per-realm (internet/intranet) authorization: allow / ask / deny, temp grants and Full Access as separate switches',
				realmInternet: 'Internet access',
				realmIntranet: 'Intranet access',
				realmDesc: 'ask = approvals required per unknown host (remembered this session); deny = always refused. Allow-listed hosts skip ask.',
				tempInternet: 'Allow temporary internet grants',
				tempIntranet: 'Allow temporary intranet grants',
				tempHint: 'When off, ask realms never pop approvals — only the allow list grants access',
				askMode: 'Ask behaviour when approvals are missing (Full Access)',
				askModeDesc: 'Applies when an ask-realm host is not on the allow list and no approval can be requested: inherit=keep earlier behaviour (incl. session grants); allow=act as approved (metadata endpoints, disabled DSH-page access, credentials and denyHosts are still enforced before this); deny=refuse',
				askModeInherit: 'Inherit',
				askModeAllow: 'Allow',
				askModeDeny: 'Deny',
				// --- English parity supplements (last value wins) ---
				accessSub: 'Per-realm (internet / LAN / local) authorization: allow, ask or deny, with separate temp-grant toggles and a DSH-page rule',
				realmLan: 'LAN access',
				realmLocal: 'Local (loopback) access',
				realmDesc: 'Ask = approval needed per unknown host (remembered this session); deny = always refused. Allow-listed hosts skip ask.',
				tempLan: 'Allow temporary LAN grants',
				tempLocal: 'Allow temporary local grants',
				modeAllow: 'Allow',
				modeAsk: 'Ask',
				modeDeny: 'Deny',
				dshItem: 'Allow access to this DSH page',
				dshItemDesc: 'Recorded control-page origins are refused while this is OFF (default) and allowed once ON (even under public mode, skipping realm approvals). List first, then the interception applies; enabling needs a second confirmation.',
				dshConfirmTitle: 'Second confirmation: let the model access this DSH control page',
				dshConfirmBody: 'The model drives this browser; if it can also visit this control page it may in theory interact with the page itself, including your session content and approval surfaces. Turn this on only to debug DSH itself; denyHosts / metadata red lines still apply.',
				dshConfirmOk: 'Enable anyway (I understand the risk)',
				dshCancel: 'Cancel',
				dshDetected: 'Detected this page:',
				dshEnableDetected: 'Fill in and enable',
				dshOriginsLabel: 'DSH page origins',
				dshAddOrigin: 'Add DSH page origin…',
				allowHosts: 'Allow list (skips ask in ask realms)',
				allowHostsHint: 'Exact hosts/IPs or *.suffix wildcards',
				denyHosts: 'Deny list (always blocked, every mode)',
				denyHostsHint: 'Exact hosts/IPs or *.suffix wildcards',
				addAllow: 'Add allow host…',
				addDeny: 'Add deny host…',
				modeAllow: 'allow',
				modeAsk: 'ask',
				modeDeny: 'deny',
				fullAccess: 'Full Access',
				fullAccessHint: 'Relaxes routing and realm approvals; keeps denyHosts / metadata / credential red lines. Previous values stay so switching off restores them.',
				allowHosts: 'Allow list (no approval needed in ask mode)',
				allowHostsHint: 'Exact hosts/IPs or *.suffix wildcards',
				denyHosts: 'Deny list (always blocked, every mode)',
				denyHostsHint: 'Exact hosts/IPs or *.suffix wildcards',
				addAllow: 'Add allow host…',
				addDeny: 'Add deny host…',
			},
		}

		// Live locale: follow the DSH UI language (host preference, surfaced as
		// <html lang="…">) instead of the browser locale. Switching the language
		// re-renders the section with the matching dictionary.
		function uiLang() {
			try {
				var lang = document.documentElement.lang || navigator.language || ''
				return lang.toLowerCase()
			} catch (e) { return 'zh' }
		}
		var langListeners = []
		var langVersion = 0
		var langObserver
		function ensureLangObserver() {
			if (langObserver) return
			try {
				langObserver = new MutationObserver(function () { langVersion += 1; for (var i = 0; i < langListeners.length; i++) langListeners[i]() })
				langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
			} catch (e) { /* observer unavailable; copy stays whatever it is */ }
		}
		function subscribeLang(listener) {
			langListeners.push(listener)
			ensureLangObserver()
			return function () {
				var i = langListeners.indexOf(listener)
				if (i !== -1) langListeners.splice(i, 1)
			}
		}
		function getLangVersion() { return langVersion }
		function t(key) {
			var dict = uiLang().indexOf('zh') === 0 ? L.zh : L.en
			var v = dict[key]
			if (v === undefined) v = L.zh[key]
			return v === undefined ? key : v
		}

		// --- DSH native theme tokens (light/dark aware; no hardcoded colors) ---
		var T = {
			bgBase: 'var(--dsw-alias-bg-base)',
			bg1: 'var(--dsw-alias-bg-layer-1)',
			bg2: 'var(--dsw-alias-bg-layer-2)',
			bg3: 'var(--dsw-alias-bg-layer-3)',
			label1: 'var(--dsw-alias-label-primary)',
			label2: 'var(--dsw-alias-label-secondary)',
			label3: 'var(--dsw-alias-label-tertiary)',
			dim: 'var(--dsw-alias-label-dimmed)',
			line1: 'var(--dsw-alias-border-l1)',
			line2: 'var(--dsw-alias-border-l2)',
			brand: 'var(--dsw-alias-button-primary-fill)',
			hover: 'var(--dsw-alias-interactive-bg-hover)',
			hoverAccent: 'var(--dsw-alias-interactive-bg-hover-accent)',
			active: 'var(--dsw-alias-interactive-bg-active)',
			error: 'var(--dsw-alias-state-error-primary)',
			success: 'var(--dsw-alias-state-success-primary)',
			warn: 'var(--dsw-alias-state-warn-primary)',
			accentSoft: 'var(--dsw-alias-accent-soft, var(--dsw-alias-bg-layer-2))',
			mono: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
		}

		// --- shared primitives ---
		var sectionStyle = {
			display: 'flex', flexDirection: 'column', gap: '12px',
			width: '100%', maxWidth: '760px', boxSizing: 'border-box',
			padding: '2px 2px 12px',
		}
		var introStyle = { margin: '0 0 2px 2px', fontSize: '13px', lineHeight: '20px', color: T.label3 }
		var pillStyle = {
			alignSelf: 'flex-start', padding: '2px 10px', borderRadius: '999px',
			background: T.accentSoft, fontSize: '11px', lineHeight: '18px',
			fontWeight: 500, color: T.label2, fontFamily: T.mono,
		}
		var cardStyle = {
			border: '1px solid ' + T.line2, borderRadius: '16px', overflow: 'hidden',
			background: T.bg3,
		}
		var cardHeaderStyle = {
			display: 'flex', alignItems: 'flex-start', gap: '10px', width: '100%',
			padding: '13px 16px', border: 0, background: 'transparent',
			font: 'inherit', textAlign: 'left', cursor: 'pointer',
			color: T.label1,
		}
		var cardTitleStyle = { flex: '1', minWidth: 0, fontSize: '13px', lineHeight: '20px', fontWeight: 600, color: T.label1 }
		var cardSubStyle = { margin: '1px 0 0', fontSize: '12px', lineHeight: '18px', color: T.label3 }
		var chevronStyle = {
			flex: 'none', width: '16px', height: '16px', marginTop: '2px',
			fontSize: '12px', lineHeight: '16px', textAlign: 'center',
			color: T.label3, transition: 'transform 0.15s ease',
		}
		var cardBodyStyle = {
			borderTop: '1px solid ' + T.line1, padding: '4px 16px 14px',
		}
		var rowStyle = {
			display: 'flex', alignItems: 'center', justifyContent: 'space-between',
			gap: '14px', padding: '10px 0',
		}
		var rowTextStyle = { flex: '1', minWidth: 0 }
		var rowTitleStyle = { fontSize: '13px', lineHeight: '18px', color: T.label1 }
		var rowDescStyle = { margin: '1px 0 0', fontSize: '12px', lineHeight: '16px', color: T.label3 }
		var rowControlStyle = { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '8px' }
		var controlStyle = {
			boxSizing: 'border-box', padding: '6px 10px', fontSize: '13px', lineHeight: '18px',
			borderRadius: '10px', border: '1px solid ' + T.line2,
			background: T.bg1, color: T.label1,
		}
		var inputStyle = Object.assign({}, controlStyle, { width: '250px', maxWidth: '46vw' })
		var numberStyle = Object.assign({}, controlStyle, { width: '120px' })
		var selectStyle = Object.assign({}, controlStyle, { width: 'auto', minWidth: '120px', paddingRight: '26px' })
		var btnBase = {
			display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
			padding: '4px 12px', fontSize: '12px', lineHeight: '18px', fontWeight: 500,
			borderRadius: '999px', border: '1px solid ' + T.line2,
			background: T.bg2, color: T.label1, cursor: 'pointer',
		}
		var codeStyle = {
			display: 'block', padding: '4px 9px', borderRadius: '8px',
			border: '1px solid ' + T.line1, background: T.bg2,
			fontSize: '12px', lineHeight: '18px', color: T.label2,
			fontFamily: T.mono, wordBreak: 'break-all',
		}
		var listFootStyle = { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }
		var listInputStyle = Object.assign({}, controlStyle, { width: '230px', maxWidth: '100%' })

		// One settings row: title/desc on the left, control on the right.
		function Row(props) {
			return createElement(
				'div',
				{ style: rowStyle },
				createElement(
					'div',
					{ style: rowTextStyle },
					createElement('div', { style: rowTitleStyle }, props.title),
					props.desc ? createElement('div', { style: rowDescStyle }, props.desc) : null,
				),
				createElement('div', { style: rowControlStyle }, props.children),
			)
		}

		// Custom switch (native checkbox semantics, styled track/thumb).
		function Switch(props) {
			return createElement(
				'label',
				{ style: { position: 'relative', display: 'inline-flex', flex: 'none', cursor: 'pointer' } },
				createElement('input', {
					type: 'checkbox',
					checked: props.checked === true,
					onChange: function (e) { props.onChange(e.target.checked) },
					style: { position: 'absolute', width: '1px', height: '1px', margin: '0', opacity: 0 },
				}),
				createElement(
					'span',
					{
						style: {
							display: 'inline-flex', alignItems: 'center', width: '34px', height: '19px',
							padding: '2px', boxSizing: 'border-box', borderRadius: '999px',
							border: '1px solid ' + (props.checked === true ? T.brand : T.line2),
							background: props.checked === true ? T.brand : T.bg2,
							transition: 'background 0.15s ease, border-color 0.15s ease',
						},
					},
					createElement('span', {
						style: {
							display: 'block', width: '13px', height: '13px', borderRadius: '50%',
							background: props.checked === true ? T.bg3 : T.label3,
							transform: props.checked === true ? 'translateX(15px)' : 'translateX(0)',
							transition: 'transform 0.15s ease, background 0.15s ease',
						},
					}),
				),
			)
		}

		// Fold card: an accordion group in the settings-shell card recipe.
		function FoldCard(props) {
			var openDefault = props.open !== false
			var state = useState(openDefault)
			var open = state[0]
			var setOpen = state[1]
			return createElement(
				'div',
				{ style: cardStyle },
				createElement(
					'button',
					{
						onClick: function () { setOpen(!open) },
						style: cardHeaderStyle,
						title: t('collapse'),
						'aria-expanded': open ? 'true' : 'false',
					},
					createElement('div', { style: { flex: '1', minWidth: 0 } },
						createElement('div', { style: cardTitleStyle }, props.title),
						props.subtitle ? createElement('div', { style: cardSubStyle }, props.subtitle) : null,
					),
					createElement('span', {
						style: Object.assign({}, chevronStyle, open ? { transform: 'rotate(0deg)' } : { transform: 'rotate(-90deg)' }),
					}, '▾'),
				),
				open
					? createElement('div', { style: cardBodyStyle }, props.children)
					: null,
			)
		}

		function TextInput(props) {
			return createElement('input', {
				type: props.password === true ? 'password' : 'text',
				value: props.value === undefined || props.value === null ? '' : String(props.value),
				onChange: function (e) { props.onChange(e.target.value) },
				style: inputStyle,
				placeholder: props.placeholder || '',
				spellCheck: false,
			})
		}

		// Editable string list (hostnames / IPs).
		function StringListEditor(props) {
			var items = Array.isArray(props.value) ? props.value : []
			var state = useState('')
			var draft = state[0]
			var setDraft = state[1]
			var add = function () {
				var value = draft.trim()
				if (value.length === 0) return
				if (items.indexOf(value) !== -1) { setDraft(''); return }
				props.onChange(items.concat([value]))
				setDraft('')
			}
			var removeAt = function (index) {
				props.onChange(items.slice(0, index).concat(items.slice(index + 1)))
			}
			var rows = items.map(function (entry, index) {
				return createElement(
					'div',
					{ key: String(index) + ':' + entry, style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '5px 0' } },
					createElement('div', { style: { flex: '1', minWidth: 0 } }, createElement('code', { style: codeStyle }, entry)),
					createElement('button', {
						onClick: function () { removeAt(index) },
						title: t('remove'),
						style: btnBase,
					}, t('remove')),
				)
			})
			return createElement(
				'div',
				{ style: { marginTop: '6px' } },
				rows.length
					? rows
					: createElement('div', { style: Object.assign({}, cardSubStyle, { padding: '2px 0 0' }) }, t('empty')),
				createElement('div', { style: listFootStyle },
					createElement('input', {
						value: draft,
						onChange: function (e) { setDraft(e.target.value) },
						onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); add() } },
						placeholder: props.placeholder || '',
						style: listInputStyle,
						spellCheck: false,
					}),
					createElement('button', { onClick: add, style: btnBase }, t('add')),
					createElement('button', { onClick: props.onReset, style: btnBase }, t('resetDefaults')),
					createElement('button', { onClick: function () { props.onChange([]) }, style: btnBase }, t('clearAll')),
				),
			)
		}

		// One realm selector row.
		function realmSelectRow(title, current, key, setField) {
			return createElement(Row, { title: title, desc: t('realmDesc') },
				createElement('select', {
					value: String(current || 'allow'),
					onChange: function (e) { setField(key, e.target.value) },
					style: selectStyle,
				},
					createElement('option', { value: 'allow' }, t('modeAllow')),
					createElement('option', { value: 'ask' }, t('modeAsk')),
					createElement('option', { value: 'deny' }, t('modeDeny')),
				),
			)
		}

		var SELF_ORIGIN = (function () {
			try {
				var o = window.location.origin || ''
				return /^https?:\/\//.test(o) ? o : null
			} catch (e) { return null }
		})()

		// DSH-page access block: the origin list is ALWAYS editable (so you can
		// record the control-page address before ever enabling anything); the
		// switch only controls whether those origins are reachable, with a
		// two-step confirmation when turning it on.
		function DshEnableRow(props) {
			var state = useState(0)
			var step = state[0]
			var setStep = state[1]
			var origins = Array.isArray(props.origins) ? props.origins : []
			var confirmOk = function () {
				if (SELF_ORIGIN && origins.indexOf(SELF_ORIGIN) === -1) {
					props.onSetOrigins(origins.concat([SELF_ORIGIN]))
				}
				props.onTurnOn()
				setStep(0)
			}
			return createElement(
				'div',
				{ style: { padding: '2px 0 2px' } },
				step === 1
					? createElement('div', { style: { margin: '6px 0 12px', padding: '12px 14px', borderRadius: '12px', border: '1px solid ' + T.error, background: 'color-mix(in srgb, ' + T.error + ' 8%, transparent)' } },
						createElement('div', { style: Object.assign({}, rowTitleStyle, { color: T.error }) }, t('dshConfirmTitle')),
						createElement('div', { style: Object.assign({}, rowDescStyle, { marginTop: '4px' }) }, t('dshConfirmBody')),
						createElement('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } },
							createElement('button', { onClick: confirmOk, style: Object.assign({}, btnBase, { borderColor: T.error, color: T.error }) }, t('dshConfirmOk')),
							createElement('button', { onClick: function () { setStep(0) }, style: btnBase }, t('dshCancel')),
						),
					)
					: createElement(Row, { title: t('dshItem'), desc: t('dshItemDesc') },
						createElement(Switch, {
							checked: props.enabled === true,
							onChange: function (on) {
								if (on) setStep(1)
								else props.onTurnOff()
							},
						}),
					),
				createElement('div', { style: { padding: '4px 2px 0' } },
					createElement('div', { style: rowTitleStyle }, t('dshOriginsLabel')),
					createElement(StringListEditor, {
						value: origins,
						placeholder: t('dshAddOrigin'),
						onChange: props.onSetOrigins,
						onReset: function () { props.onSetOrigins([]) },
					}),
				),
			)
		}

		// --- section body; props = { ctx, scope } injected by the slot registration ---
		function BrowserSectionBody(props) {
			// Re-render when the DSH UI language (<html lang>) changes.
			useSyncExternalStore(subscribeLang, getLangVersion, getLangVersion)
			var ctx = props.ctx
			var scope = props.scope
			var snapshot = useSyncExternalStore(
				function (cb) { return scope.subscribe(cb) },
				function () { return scope.getSnapshot() },
				function () { return scope.getSnapshot() },
			)
			var busyState = useState(null)
			var busy = busyState[0]
			var setBusy = busyState[1]
			var writeBusy = useRef(false)

			var status = snapshot.status
			if (status === 'unavailable') {
				return createElement('div', { style: { fontSize: '13px', color: T.warn } }, t('unavailable'))
			}
			if (status === 'loading' || snapshot.value === undefined) {
				return createElement('div', { style: cardSubStyle }, t('loading'))
			}
			var value = snapshot.value || {}
			var setField = function (field, next) {
				writeBusy.current = true
				setBusy('saving')
				var done = scope.set(field, next)
				if (done && typeof done.then === 'function') {
					done.then(
						function () {
							if (writeBusy.current) {
								writeBusy.current = false
								setBusy('saved')
								window.setTimeout(function () { setBusy(null) }, 1400)
							}
						},
						function (err) {
							writeBusy.current = false
							var msg = err && err.message ? err.message : String(err)
							setBusy({ error: msg })
						},
					)
				} else {
					writeBusy.current = false
					setBusy('saved')
					window.setTimeout(function () { setBusy(null) }, 1400)
				}
			}
			var noop = function () {}

			var metaHosts = Array.isArray(value.metadataHostnames) ? value.metadataHostnames : []
			var metaIps = Array.isArray(value.metadataIps) ? value.metadataIps : []

			var statusRow = null
			if (busy !== null) {
				var statusText = busy === 'saving'
					? t('saving')
					: (busy && busy.error ? t('error') + busy.error : t('saved'))
				var statusColor = busy === 'saving' ? T.label3 : (busy && busy.error ? T.error : T.success)
				statusRow = createElement('div', {
					style: { fontSize: '12px', color: statusColor, padding: '0 4px' },
				}, statusText)
			}

			return createElement(
				'div',
				{ style: sectionStyle },
				createElement('p', { style: introStyle }, t('intro')),
				createElement('span', { style: pillStyle }, t('idBadge')),
				createElement(FoldCard, { title: t('general') },
					createElement(Row, {
						title: t('enabled'),
						desc: (value.enabled === true ? t('enabledOn') : t('enabledOff')) + ' · ' + t('enabledDesc'),
					},
						createElement(Switch, {
							checked: value.enabled === true,
							onChange: function (on) { setField('enabled', on) },
						}),
					),
					createElement(Row, {
						title: t('urlMode'),
						desc: value.urlMode === 'intranet' ? t('urlModeIntranet') : t('urlModePublic'),
					},
						createElement('select', {
							value: String(value.urlMode || 'public'),
							onChange: function (e) { setField('urlMode', e.target.value) },
							style: selectStyle,
						},
							createElement('option', { value: 'public' }, 'public'),
							createElement('option', { value: 'intranet' }, 'intranet'),
						),
					),
				),
				createElement(FoldCard, { title: t('access'), subtitle: t('accessSub') },
					realmSelectRow(t('realmInternet'), value.internetAccess, 'internetAccess', setField),
					realmSelectRow(t('realmLan'), value.lanAccess, 'lanAccess', setField),
					realmSelectRow(t('realmLocal'), value.localAccess, 'localAccess', setField),
					createElement('div', { style: rowDescStyle }, t('realmDesc')),
					createElement(Row, { title: t('tempInternet'), desc: t('tempHint') },
						createElement(Switch, { checked: value.internetTemp !== false, onChange: function (on) { setField('internetTemp', on) } }),
					),
					createElement(Row, { title: t('tempLan'), desc: t('tempHint') },
						createElement(Switch, { checked: value.lanTemp !== false, onChange: function (on) { setField('lanTemp', on) } }),
					),
					createElement(Row, { title: t('tempLocal'), desc: t('tempHint') },
						createElement(Switch, { checked: value.localTemp !== false, onChange: function (on) { setField('localTemp', on) } }),
					),
					createElement(Row, { title: t('askMode'), desc: t('askModeDesc') },
						createElement('select', {
							value: String(value.askMode || 'inherit'),
							onChange: function (e) { setField('askMode', e.target.value) },
							style: selectStyle,
						},
							createElement('option', { value: 'inherit' }, t('askModeInherit')),
							createElement('option', { value: 'allow' }, t('askModeAllow')),
							createElement('option', { value: 'deny' }, t('askModeDeny')),
						),
					),
					createElement(DshEnableRow, {
						enabled: value.dshAccessEnabled === true,
						origins: Array.isArray(value.dshOrigins) ? value.dshOrigins : [],
						onTurnOn: function () { setField('dshAccessEnabled', true) },
						onTurnOff: function () { setField('dshAccessEnabled', false) },
						onSetOrigins: function (next) { setField('dshOrigins', next) },
					}),
					createElement('div', { style: { padding: '10px 0 2px' } },
						createElement('div', { style: rowTitleStyle }, t('allowHosts')),
						createElement('div', { style: rowDescStyle }, t('allowHostsHint')),
						createElement(StringListEditor, {
							value: Array.isArray(value.allowHosts) ? value.allowHosts : [],
							placeholder: t('addAllow'),
							onChange: function (next) { setField('allowHosts', next) },
							onReset: function () { scope.unset('allowHosts').then(noop, noop) },
						}),
					),
					createElement('div', { style: { padding: '4px 0 2px' } },
						createElement('div', { style: rowTitleStyle }, t('denyHosts')),
						createElement('div', { style: rowDescStyle }, t('denyHostsHint')),
						createElement(StringListEditor, {
							value: Array.isArray(value.denyHosts) ? value.denyHosts : [],
							placeholder: t('addDeny'),
							onChange: function (next) { setField('denyHosts', next) },
							onReset: function () { scope.unset('denyHosts').then(noop, noop) },
						}),
					),
				),
				createElement(FoldCard, { title: t('transport'), subtitle: t('transportSub'), open: false },
					createElement(Row, { title: t('port') },
						createElement('input', {
							type: 'number', min: 1024, max: 65535, step: 1,
							value: typeof value.port === 'number' ? value.port : 9777,
							onChange: function (e) {
								var n = parseInt(e.target.value, 10)
								setField('port', isNaN(n) ? 1024 : n)
							},
							style: numberStyle,
						}),
					),
					createElement(Row, { title: t('token') },
						createElement(TextInput, { value: value.token, password: true, onChange: function (v) { setField('token', v) } }),
					),
					createElement(Row, { title: t('shotsDir') },
						createElement(TextInput, { value: value.shotsDir, onChange: function (v) { setField('shotsDir', v) } }),
					),
					createElement(Row, { title: t('registryDir') },
						createElement(TextInput, { value: value.registryDir, onChange: function (v) { setField('registryDir', v) } }),
					),
				),
				createElement(FoldCard, { title: t('metadata'), subtitle: t('metadataSub') },
					createElement(Row, {
						title: t('blockMetadata'),
						desc: t('blockMetadataDesc'),
					},
						createElement(Switch, {
							checked: value.blockMetadata !== false,
							onChange: function (on) { setField('blockMetadata', on) },
						}),
					),
					createElement('div', { style: { padding: '10px 0 2px' } },
						createElement('div', { style: rowTitleStyle }, t('metaHosts')),
						createElement('div', { style: rowDescStyle }, t('metaHostsHint')),
						createElement(StringListEditor, {
							value: metaHosts,
							placeholder: t('addHost'),
							onChange: function (next) { setField('metadataHostnames', next) },
							onReset: function () { scope.unset('metadataHostnames').then(noop, noop) },
						}),
					),
					createElement('div', { style: { padding: '4px 0 2px' } },
						createElement('div', { style: rowTitleStyle }, t('metaIps')),
						createElement('div', { style: rowDescStyle }, t('metaIpsHint')),
						createElement(StringListEditor, {
							value: metaIps,
							placeholder: t('addIp'),
							onChange: function (next) { setField('metadataIps', next) },
							onReset: function () { scope.unset('metadataIps').then(noop, noop) },
						}),
					),
					createElement('div', { style: Object.assign({}, cardSubStyle, { marginTop: '8px' }) }, t('defaultsHint')),
				),
				statusRow,
			)
		}

		// Render-error boundary: a failure inside the section must never leave a
		// silent blank panel — it surfaces the message and logs the stack.
		var Boundary = (function () {
			return class extends React.Component {
				constructor(props) {
					super(props)
					this.state = { err: null }
				}
				static getDerivedStateFromError(error) {
					return { err: error }
				}
				componentDidCatch(error, info) {
					console.error('[dsh-browser-unified] settings section render error:', error, info)
				}
				render() {
					if (this.state.err) {
						var msg = this.state.err && this.state.err.message ? this.state.err.message : String(this.state.err)
						return createElement('div', {
							style: { margin: '10px 0', padding: '10px 12px', borderRadius: '10px', border: '1px solid ' + T.error, color: T.error, fontSize: '13px', whiteSpace: 'pre-wrap' },
						}, '浏览器分区渲染失败：' + msg)
					}
					return this.props.children
				}
			}
		})()

		/** Slot entry: boundary-wrapped section body. */
		function BrowserSettingsSection(props) {
			return createElement(Boundary, null, createElement(BrowserSectionBody, { ctx: props.ctx, scope: props.scope }))
		}

		function apply(ctx) {
			try {
				var slots = ctx.slots
				var settings = ctx.settingsScope
				if (!slots || !settings) return
				// Bind once per activation on THIS fiber (the binder binds to the caller).
				var scope = settings.bind({ namespace: 'browser-bridge' })
				ctx.slots.inject('settings.section', function () {
					return ctx.slots.register({
						name: 'settings.section',
						id: 'browser-bridge',
						order: 60,
						label: function () { return t('nav') },
						inject: function () { return { ctx: ctx, scope: scope } },
					}, BrowserSettingsSection)
				})
			} catch (error) {
				console.error('[dsh-browser-unified] settings section load error:', error)
				try {
					var bar = document.createElement('div')
					bar.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483000;max-width:70vw;padding:8px 12px;font:12px/1.5 ui-monospace,monospace;color:#f2a1a1;background:#1b1b22;border:1px solid #f2a1a1;border-radius:8px;white-space:pre-wrap'
					bar.textContent = '[dsh-browser-unified] settings load error: ' + (error instanceof Error ? error.message : String(error))
					document.body.appendChild(bar)
				} catch { /* best effort */ }
			}
		}

		var inject = ['slots', 'settingsScope']
		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
