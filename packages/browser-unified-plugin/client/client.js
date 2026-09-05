/**
 * dsh-browser-unified — browser client half (hand-assembled module-loader bundle).
 *
 * Registers one "浏览器" section in the DSH Settings shell (settings.section)
 * and edits the `browser-bridge` settings namespace through the shared
 * settings-scope transport (ctx.settingsScope). Every write lands in the Host
 * settings document; the host plugin's scope.watch then reconciles the bridge
 * live — the metadata endpoint lists apply without restarting the listener.
 *
 * This file intentionally follows the loader format produced by the official
 * client bundler: `window.__ModuleLoader__.load({ id, factory })` with
 * `require('react')` resolved from the page module table. No TSX and no other
 * bare imports, so it needs no bundler of its own. AGPL-3.0 (see NOTICE.md).
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
		var useEffect = React.useEffect
		var useRef = React.useRef
		var useSyncExternalStore = React.useSyncExternalStore

		// --- minimal zh/en copy (static; the page follows the browser language) ---
		function isZh() {
			try { return (navigator.language || 'zh').toLowerCase().indexOf('zh') === 0 } catch (e) { return true }
		}
		var L = {
			zh: {
				nav: '浏览器',
				intro: 'DSH 浏览器控制（browser-bridge）：本地桥、URL 策略与云元数据端点配置。保存即时生效。',
				general: '常规',
				enabled: '启用浏览器桥',
				enabledDesc: '关闭后工具仍挂载，但每次调用会提示如何重新开启。',
				urlMode: 'URL 策略档位',
				urlModePublic: 'public —— 拦私网 / 回环 / 云元数据目标',
				urlModeIntranet: 'intranet —— 放行本地 / LAN，仍拦截云元数据端点',
				transport: '监听与路径（改动会重启本地桥）',
				port: '端口',
				token: '令牌（扩展连接用）',
				shotsDir: '截图目录',
				registryDir: 'registry 目录（留空用包内副本）',
				metadata: '云元数据端点拦截',
				blockMetadata: '拦截云元数据端点',
				blockMetadataDesc: '关闭表示接受访问实例元数据服务（如自建 VPC 沙箱内）。',
				metaHosts: '拦截的主机名（整体替换内置默认；清空则不拦此类）',
				metaIps: '拦截的 IP（整体替换内置默认）',
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
			},
			en: {
				nav: 'Browser',
				intro: 'DSH Browser Control (browser-bridge): local bridge, URL policy and cloud-metadata endpoints. Saves apply live.',
				general: 'General',
				enabled: 'Enable browser bridge',
				enabledDesc: 'When off, tools stay mounted but every call explains how to turn it back on.',
				urlMode: 'URL policy mode',
				urlModePublic: 'public — blocks private / loopback / cloud-metadata targets',
				urlModeIntranet: 'intranet — allows local / LAN, still blocks cloud-metadata endpoints',
				transport: 'Listener & paths (changing restarts the local bridge)',
				port: 'Port',
				token: 'Token (presented by the extension)',
				shotsDir: 'Screenshots directory',
				registryDir: 'Registry directory (empty = package copies)',
				metadata: 'Cloud-metadata endpoint blocking',
				blockMetadata: 'Block cloud-metadata endpoints',
				blockMetadataDesc: 'Off means accepting access to instance-metadata services (e.g. inside your own VPC sandbox).',
				metaHosts: 'Blocked hostnames (fully replaces built-in defaults; empty blocks none)',
				metaIps: 'Blocked IPs (fully replaces built-in defaults)',
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
			},
		}

		var COPY = isZh() ? L.zh : L.en
		var FALLBACK_COPY = L.zh
		function t(key) {
			var v = COPY[key]
			if (v === undefined) v = FALLBACK_COPY[key]
			return v === undefined ? key : v
		}

		// --- tiny reusable field row (label + hint + children) ---
		function Field(props) {
			return createElement(
				'div',
				{ style: fieldStyle },
				createElement('label', { style: labelStyle }, props.label),
				props.children,
				props.hint ? createElement('div', { style: hintStyle }, props.hint) : null,
			)
		}
		var fieldStyle = { margin: '0 0 18px 0' }
		var labelStyle = {
			display: 'block', fontSize: '13px', fontWeight: 600, margin: '0 0 6px 0',
			color: 'var(--dsw-text-secondary, #444)',
		}
		var hintStyle = { fontSize: '12px', color: 'var(--dsw-text-tertiary, #888)', marginTop: '5px', lineHeight: '1.45' }
		var inputStyle = {
			width: '100%', maxWidth: '560px', boxSizing: 'border-box',
			padding: '7px 10px', fontSize: '13px', borderRadius: '8px',
			border: '1px solid var(--dsw-border-default, #d9d9d9)',
			background: 'var(--dsw-bg-field, #fff)', color: 'var(--dsw-text-primary, #1a1a1a)',
		}
		var btnBase = {
			padding: '5px 12px', fontSize: '12px', borderRadius: '8px', cursor: 'pointer',
			border: '1px solid var(--dsw-border-default, #d0d0d0)',
			background: 'var(--dsw-bg-elevated, #f6f6f6)', color: 'var(--dsw-text-primary, #1a1a1a)',
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

		function Toggle(props) {
			return createElement('input', {
				type: 'checkbox',
				checked: props.checked === true,
				onChange: function (e) { props.onChange(e.target.checked) },
				style: { width: '16px', height: '16px', cursor: 'pointer' },
			})
		}

		// --- editable string list (hostnames / IPs) ---
		function StringListEditor(props) {
			var items = Array.isArray(props.value) ? props.value : []
			var [draft, setDraft] = useState('')
			var add = function () {
				var value = draft.trim()
				if (value.length === 0) return
				if (items.indexOf(value) !== -1) { setDraft(''); return }
				props.onChange(items.concat([value]))
				setDraft('')
			}
			var removeAt = function (index) {
				var next = items.slice(0, index).concat(items.slice(index + 1))
				props.onChange(next)
			}
			var reset = function () {
				props.onReset && props.onReset()
			}
			var clear = function () { props.onChange([]) }
			var rows = items.map(function (entry, index) {
				return createElement(
					'div',
					{ key: String(index) + ':' + entry, style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
					createElement('code', {
						style: {
							flex: '1', fontSize: '12px', padding: '4px 8px', borderRadius: '6px',
							background: 'var(--dsw-bg-subtle, #f0f0f0)', wordBreak: 'break-all',
							color: 'var(--dsw-text-primary, #1a1a1a)',
						},
					}, entry),
					createElement('button', {
						onClick: function () { removeAt(index) },
						title: t('remove'),
						style: Object.assign({}, btnBase, { flex: '0 0 auto' }),
					}, t('remove')),
				)
			})
			return createElement(
				'div',
				null,
				createElement('div', { style: { display: 'flex', flexDirection: 'column', maxWidth: '560px' } }, rows.length ? rows : createElement('div', { style: hintStyle }, props.emptyHint || '—')),
				createElement('div', { style: { display: 'flex', gap: '6px', marginTop: '8px', maxWidth: '560px' } },
					createElement('input', {
						value: draft,
						onChange: function (e) { setDraft(e.target.value) },
						onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); add() } },
						placeholder: props.placeholder || '',
						style: Object.assign({}, inputStyle, { maxWidth: '320px' }),
						spellCheck: false,
					}),
					createElement('button', { onClick: add, style: btnBase }, t('add')),
					createElement('button', {
						onClick: reset,
						style: btnBase,
						title: t('defaultsHint'),
					}, t('resetDefaults')),
					createElement('button', { onClick: clear, style: btnBase }, t('clearAll')),
				),
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
							style: { margin: '10px 0', padding: '10px 12px', borderRadius: '8px', border: '1px solid #e0a2a2', background: '#fdf0f0', color: '#c0392b', fontSize: '13px', whiteSpace: 'pre-wrap' },
						}, '浏览器分区渲染失败：' + msg)
					}
					return this.props.children
				}
			}
		})()

		// section body; props = { ctx, scope } injected by the slot registration
		function BrowserSectionBody(props) {
			var ctx = props.ctx
			var scope = props.scope
			var snapshot = useSyncExternalStore(
				function (cb) { return scope.subscribe(cb) },
				function () { return scope.getSnapshot() },
				function () { return scope.getSnapshot() },
			)
			var [busy, setBusy] = useState(null) // null | 'saving' | { error: string }
			var writeBusy = useRef(false)

			var status = snapshot.status
			if (status === 'unavailable') {
				return createElement('div', { style: { color: '#b25b00' } }, t('unavailable'))
			}
			if (status === 'loading' || snapshot.value === undefined) {
				return createElement('div', { style: hintStyle }, t('loading'))
			}
			var value = snapshot.value || {}
			var setField = function (field, next) {
				writeBusy.current = true
				setBusy('saving')
				var done = scope.set(field, next)
				if (done && typeof done.then === 'function') {
					done.then(
						function () { if (writeBusy.current) { writeBusy.current = false; setBusy(null) } },
						function (err) {
							writeBusy.current = false
							var msg = err && err.message ? err.message : String(err)
							setBusy({ error: msg })
						},
					)
				} else {
					writeBusy.current = false
					setBusy(null)
				}
			}

			var metaHosts = Array.isArray(value.metadataHostnames) ? value.metadataHostnames : []
			var metaIps = Array.isArray(value.metadataIps) ? value.metadataIps : []

			return createElement(
				'div',
				null,
				createElement('p', { style: hintStyle }, t('intro')),
				createElement('h3', { style: headingStyle }, t('general')),
				createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' } },
					createElement(Toggle, {
						checked: value.enabled === true,
						onChange: function (on) { setField('enabled', on) },
					}),
					createElement('span', { style: { fontSize: '13px' } }, t('enabled')),
					createElement('span', { style: Object.assign({}, hintStyle, { marginTop: 0 }) },
						value.enabled === true ? t('enabledOn') : t('enabledOff')),
				),
				createElement('div', { style: hintStyle }, t('enabledDesc')),
				createElement(Field, { label: t('urlMode'), hint: value.urlMode === 'intranet' ? t('urlModeIntranet') : t('urlModePublic') },
					createElement('select', {
						value: String(value.urlMode || 'public'),
						onChange: function (e) { setField('urlMode', e.target.value) },
						style: Object.assign({}, inputStyle, { maxWidth: '320px' }),
					},
						createElement('option', { value: 'public' }, 'public'),
						createElement('option', { value: 'intranet' }, 'intranet'),
					),
				),
				createElement('h3', { style: headingStyle }, t('transport')),
				createElement(Field, { label: t('port') },
					createElement('input', {
						type: 'number', min: 1024, max: 65535, step: 1,
						value: typeof value.port === 'number' ? value.port : 9777,
						onChange: function (e) {
							var n = parseInt(e.target.value, 10)
							setField('port', isNaN(n) ? 1024 : n)
						},
						style: Object.assign({}, inputStyle, { maxWidth: '160px' }),
					}),
				),
				createElement(Field, { label: t('token') },
					createElement(TextInput, { value: value.token, password: true, onChange: function (v) { setField('token', v) } }),
				),
				createElement(Field, { label: t('shotsDir') },
					createElement(TextInput, { value: value.shotsDir, onChange: function (v) { setField('shotsDir', v) } }),
				),
				createElement(Field, { label: t('registryDir') },
					createElement(TextInput, { value: value.registryDir, onChange: function (v) { setField('registryDir', v) } }),
				),
				createElement('h3', { style: headingStyle }, t('metadata')),
				createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' } },
					createElement(Toggle, {
						checked: value.blockMetadata !== false,
						onChange: function (on) { setField('blockMetadata', on) },
					}),
					createElement('span', { style: { fontSize: '13px' } }, t('blockMetadata')),
				),
				createElement('div', { style: hintStyle }, t('blockMetadataDesc')),
				createElement(Field, { label: t('metaHosts') },
					createElement(StringListEditor, {
						value: metaHosts,
						placeholder: t('addHost'),
						onChange: function (next) { setField('metadataHostnames', next) },
						onReset: function () { scope.unset('metadataHostnames').then(noop, noop) },
					}),
				),
				createElement(Field, { label: t('metaIps') },
					createElement(StringListEditor, {
						value: metaIps,
						placeholder: t('addIp'),
						onChange: function (next) { setField('metadataIps', next) },
						onReset: function () { scope.unset('metadataIps').then(noop, noop) },
					}),
				),
				createElement('div', { style: hintStyle }, t('defaultsHint')),
				statusRow(busy),
			)
		}

		/** Slot entry: boundary-wrapped section body. */
		function BrowserSettingsSection(props) {
			return createElement(Boundary, null, createElement(BrowserSectionBody, { ctx: props.ctx, scope: props.scope }))
		}

		function noop() {}

		var headingStyle = {
			fontSize: '14px', fontWeight: 700, margin: '22px 0 12px 0',
			color: 'var(--dsw-text-primary, #1a1a1a)',
		}

		function statusRow(busy) {
			if (busy === null) return null
			if (busy === 'saving') {
				return createElement('div', { style: statusBaseStyle }, t('saving'))
			}
			if (busy && busy.error) {
				return createElement('div', { style: Object.assign({}, statusBaseStyle, { color: '#c0392b', borderColor: '#e0a2a2' }) },
					t('error') + busy.error)
			}
			return createElement('div', { style: Object.assign({}, statusBaseStyle, { color: '#1e7d32' }) }, t('saved'))
		}
		var statusBaseStyle = {
			marginTop: '10px', fontSize: '12px', padding: '6px 10px', borderRadius: '8px',
			border: '1px solid transparent', background: 'var(--dsw-bg-subtle, #f0f0f0)',
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
