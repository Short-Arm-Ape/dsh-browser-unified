/**
 * dsh-browser-unified — browser client half (hand-assembled module-loader bundle).
 *
 * Registers one "浏览器" section in the DSH Settings shell (settings.section)
 * and edits the `browser-bridge` settings namespace through the shared
 * config-forms transport (ctx.configForms). Every write lands in the Host
 * settings document; the host plugin then reconciles the bridge live — the
 * metadata endpoint lists apply without restarting the listener.
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
				// 2026-10-14 bi-038 修好后，这句话才名副其实：宿主对 volatile 字段是「原地提交 + 事件」，
				// 插件自己订阅 loader/volatile-update 重建桥与策略，所以改档**不需要重启**。
				// 只有更换插件包版本（安装/升级/卸载）必须重启 —— 这点照插件市场那句实话写出来。
				// 2026-10-14 用户口径：别在页面上自夸「即时生效」—— 改成「写完确实改了值就弹 1 秒胶囊」，
				// 改不动就弹「还没看到生效」。眼见为实，比一句承诺可靠。
				intro: 'DSH 浏览器控制（browser-bridge）：本地桥、URL 策略与访问控制。只有更换插件包版本（安装 / 升级 / 卸载）才需要重启 dsh web。',
				savedToast: '配置已保存',
				writePending: '配置尚未生效',
				writeFailed: '保存失败：',
				writeInvalid: '格式不对，没保存',
				idBadge: 'dsh-browser-unified · browser-bridge',
				general: '常规',
				enabled: '启用浏览器桥',
				enabledDesc: '关闭后工具仍挂载，但每次调用会提示如何重新开启。',
				// 2026-09-28 收敛：网络预设整行砍掉 —— 三档分域（外网/局域网/本机）才是真控制面，
				// 预设只是它们的默认值。urlMode 键仍在 schema 里（老设置继续生效），只是不再露出。
				probeLabel: '本地桥',
				probeLoading: '正在探测…',
				probeRemote: '页面不在本机，跳过探测',
				probeNone: '未发现（候选端口上都没有 /api/status）',
				probeNoneHint: '浏览器没开或桥没起来：打开装有扩展的浏览器后点「重新探测」。',
				probeRetry: '重新探测',
				probeExtOn: '扩展已连接',
				probeExtOff: '扩展未连接',
				probeShifted: '（配置端口被占，已自动顺延）',
				realmTemp: '允许临时授权',
				advanced: '高级',
				advancedSub: '日常不用动：临时实例、受限态策略、目录与路径',
				autoLaunchCard: '自动拉起浏览器',
				autoLaunchCardSub: '断线看门狗与「模型调用时唤醒」共用同一套目标配置（可执行文件 / profile）',
				wakeOnToolUse: '模型调用时自动拉起',
				wakeOnToolUseDesc: '任何 browser_* 调用发现扩展未连接时，先唤醒浏览器、等它连上再执行本次调用。默认关。',
				wakeWait: '拉起后最多等待（毫秒）',
				wakeWaitDesc: '默认 8000。太小会在扩展还没连上时就放行，于是第一次调用照样失败。',
				wakeShareHint: '以上两行由本插件自己执行（同伴件 dsh-browser-buddy 已于 2026-10-10 合并进来），目标配置就是本卡上面的 exe / profile —— 只有一份。',
				toolSurfaceCard: '工具面',
				toolSurfaceCardSub: '模型每轮看到哪些 browser_* 工具（同伴件合并进来后，这两行也归本分区）',
				layeredTools: '工具面分层',
				layeredToolsDesc: '只把常驻白名单与「已展开组」的工具交给模型；未展开的组对模型不可见，需要时让它调 browser_tools enable <组>。默认开。',
				enabledGroups: '启动时已展开的组',
				enabledGroupsDesc: '可填 interact / debug / session / frames / registry；留空=只给常驻工具（默认）。',
				transport: '监听与路径',
				transportSub: '起始端口与令牌（改动会重启本地桥；目录类设置移到了「高级」）',
				port: '起始端口',
				portDesc: '被占则自动顺延（+1…+9）；扩展与上面的「本地桥」都会自动探测，不必和扩展里填的一致。',
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
				askMode: '受限态（无法请求审批，如完全权限）时的 ask 策略',
				askModeDesc: '仅在无法请求审批时生效（审批可用则始终弹窗，不受此项影响）：忽略=ask 失效、黑白名单等其余规则照常；放行=连黑白名单一并忽略（红线仍生效）；禁止=直接拒绝',
				askModeInherit: '忽略',
				askModeAllow: '放行',
				askModeDeny: '禁止',
				autoLaunch: '断线自动拉起浏览器',
				autoLaunchDesc: '扩展断开超过「断开容忍秒数」后自动拉起浏览器（需装有扩展的专用 profile，或临时实例+扩展目录）。默认关。',
				autoIdle: '断开容忍秒数',
				autoExe: '浏览器可执行文件（留空自动探测 msedge/chrome）',
				autoProfile: '专用 profile 目录（推荐：已装扩展）',
				autoProfileName: '配置文件名称（如 Profile 4；留空自动识别目录名或 Default）',
				autoTemp: '用临时干净实例（无痕式）',
				autoExt: '未打包扩展目录（临时实例 sideload 用）',
				modeAllow: '放行',
				modeAsk: '需审批',
				modeDeny: '拒绝',
				dshItem: '允许访问本 DSH 页面',
				dshItemDesc: '开启后模型可以打开并操作本机 DSH 控制页（含你的会话列表与审批界面）。关闭时一律拒绝；关闭即时生效，开启需二次确认。',
				staleTitle: '有改动还没生效',
				staleBody: '下面这些值已经保存，但运行中的桥还是旧的 —— 重启 dsh web 后生效：',
				staleBridgeDown: '桥没报出生效值（插件或 core 版本较旧），无法确认这些改动是否已生效。',
				dshConfirmTitle: '二次确认：允许模型访问本 DSH 控制页',
				dshConfirmBody: '模型能操作浏览器，若它也访问本控制页，理论上可自行与页面交互（含你的会话内容与审批界面）。请仅在需要模型调试 DSH 自身时开启；开启后仍受 denyHosts/元数据等红线约束。',
				dshConfirmOk: '仍然开启（我已了解风险）',
				dshCancel: '取消',
				dshDetected: '检测到本页面地址：',
				dshEnableDetected: '填入该地址并开启',
				dshAutoOrigin: '本机控制页地址（宿主自动识别，无需登记）：',
				dshAutoOriginNote: '宿主从 web 服务端口推导它（端口变了会跟着变），下面的列表只用于**额外**地址：局域网 IP、自定义域名、反向代理。',
				dshOriginsLabel: '额外地址',
				dshAddOrigin: '添加额外地址（如 http://192.168.1.9:3080）…',
				allowHosts: '白名单（需审批的域里免批准）',
				allowHostsHint: '支持精确主机/IP 与 *.suffix 通配',
				denyHosts: '黑名单（任何模式都拦截）',
				denyHostsHint: '支持精确主机/IP 与 *.suffix 通配',
				addAllow: '添加白名单主机…',
				addDeny: '添加黑名单主机…',
			},
			en: {
				nav: 'Browser plugin',
				intro: 'DSH Browser Control (browser-bridge): local bridge, URL policy and access control. Only swapping the plugin package version (install / upgrade / uninstall) needs a dsh web restart.',
				savedToast: 'Saved',
				writePending: 'Not applied yet',
				writeFailed: 'Save failed: ',
				writeInvalid: 'Invalid format — not saved',
				idBadge: 'dsh-browser-unified · browser-bridge',
				general: 'General',
				enabled: 'Enable browser bridge',
				enabledDesc: 'When off, tools stay mounted but every call explains how to turn it back on.',
				probeLabel: 'Local bridge',
				probeLoading: 'probing\u2026',
				probeRemote: 'page is not on this machine — probe skipped',
				probeNone: 'not found (no /api/status on any candidate port)',
				probeNoneHint: 'The browser or the bridge is not up: open the browser that has the extension, then probe again.',
				probeRetry: 'Probe again',
				probeExtOn: 'extension connected',
				probeExtOff: 'extension not connected',
				probeShifted: '(configured port was busy; shifted automatically)',
				realmTemp: 'allow temp grants',
				advanced: 'Advanced',
				advancedSub: 'Rarely touched: temp instance, restricted-state policy, directories and paths',
				autoLaunchCard: 'Auto-launch the browser',
				autoLaunchCardSub: 'The disconnect watchdog and "wake on model call" share one target config (executable / profile)',
				wakeOnToolUse: 'Wake on model tool call',
				wakeOnToolUseDesc: 'When a browser_* call finds the extension disconnected, wake the browser first and wait for it to link before running the call. Off by default.',
				wakeWait: 'Max wait after waking (ms)',
				wakeWaitDesc: 'Default 8000. Too small and the call proceeds before the extension links, so the first call fails anyway.',
				wakeShareHint: 'The two rows above are executed by this plugin itself (the companion dsh-browser-buddy was merged in on 2026-10-10) using the exe / profile configured above \u2014 one copy only.',
				toolSurfaceCard: 'Tool surface',
				toolSurfaceCardSub: 'Which browser_* tools the model sees each turn (these two rows moved here with the companion merge)',
				layeredTools: 'Layer the tool surface',
				layeredToolsDesc: 'Expose only the resident allowlist plus expanded groups. Default on.',
				enabledGroups: 'Groups expanded at startup',
				enabledGroupsDesc: 'interact / debug / session / frames / registry; empty = resident tools only (default).',
				transport: 'Listener & paths',
				transportSub: 'Starting port and token (changing restarts the local bridge; directory settings moved to Advanced)',
				port: 'Starting port',
				portDesc: 'Shifted automatically when busy (+1\u2026+9). The extension and the “Local bridge” line above both auto-probe, so it need not match the value in the extension.',
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
				askMode: 'Ask-realm behaviour under restricted state (approvals unavailable, e.g. Full Access)',
				askModeDesc: 'Only applies when approvals cannot be requested (when approvals work you always get the prompt): ignore=ask gate off, other rules (white/black lists, realm allow/deny) still apply; allow=also ignores white/black lists (red lines still apply); deny=refuse',
				askModeInherit: 'Ignore',
				askModeAllow: 'Allow',
				askModeDeny: 'Deny',
				autoLaunch: 'Auto-launch browser after disconnect',
				autoLaunchDesc: 'Launch the browser when the extension stays disconnected longer than the idle seconds (dedicated profile with the extension, or temp instance + extension dir). Default off.',
				autoIdle: 'Disconnect tolerance (s)',
				autoExe: 'Browser executable (empty = detect msedge/chrome)',
				autoProfile: 'Dedicated profile dir (recommended: extension installed)',
				autoProfileName: 'Profile name (e.g. Profile 4; empty = detect dir name or Default)',
				autoTemp: 'Fresh temp instance (incognito-like)',
				autoExt: 'Unpacked extension dir (sideload for temp instance)',
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
				dshItemDesc: 'When ON, the model can open and operate this machine\'s DSH control page (your session list and approval UI included). It is always refused while OFF; turning OFF applies instantly, turning ON needs a second confirmation.',
				staleTitle: 'Saved changes are not in force yet',
				staleBody: 'These values are saved, but the running bridge still uses the old ones — restart dsh web to apply:',
				staleBridgeDown: 'The bridge did not report its in-force policy (older plugin or core), so these changes cannot be verified.',
				dshConfirmTitle: 'Second confirmation: let the model access this DSH control page',
				dshConfirmBody: 'The model drives this browser; if it can also visit this control page it may in theory interact with the page itself, including your session content and approval surfaces. Turn this on only to debug DSH itself; denyHosts / metadata red lines still apply.',
				dshConfirmOk: 'Enable anyway (I understand the risk)',
				dshCancel: 'Cancel',
				dshDetected: 'Detected this page:',
				dshEnableDetected: 'Fill in and enable',
				dshAutoOrigin: 'Local control-page address (identified automatically by the host): ',
				dshAutoOriginNote: 'The host derives it from the web service port (so it follows a port change); the list below is only for EXTRA addresses: LAN IPs, custom domains, reverse proxies.',
				dshOriginsLabel: 'Extra addresses',
				dshAddOrigin: 'Add an extra address (e.g. http://192.168.1.9:3080)\u2026',
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
		/** 胶囊：固定视口底部居中，不吃点击（pointerEvents: none），颜色随结果。 */
		var capsuleWrapStyle = {
			position: 'fixed', left: '50%', bottom: '28px', transform: 'translateX(-50%)',
			zIndex: 2147483000, pointerEvents: 'none',
			padding: '7px 16px', borderRadius: '999px',
			background: T.bg2, border: '1px solid ' + T.line2,
			boxShadow: '0 6px 24px rgba(0,0,0,0.28)',
			fontSize: '13px', lineHeight: '20px', fontWeight: 500,
			whiteSpace: 'nowrap', maxWidth: '80vw', overflow: 'hidden', textOverflow: 'ellipsis',
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
			var foldKey = 'dshBu:fold:' + (props.id || '')
			var stored = null
			try {
				var raw = window.localStorage.getItem(foldKey)
				if (raw !== null) stored = raw === '1'
			} catch (e) { /* storage unavailable */ }
			var openDefault = stored !== null ? stored : props.open !== false
			var state = useState(openDefault)
			var open = state[0]
			var setOpen = state[1]
			var toggle = function () {
				var next = !open
				setOpen(next)
				if (foldKey) {
					try { window.localStorage.setItem(foldKey, next ? '1' : '0') } catch (e) { /* ignore */ }
				}
			}
			return createElement(
				'div',
				{ style: cardStyle },
				createElement(
					'button',
					{
						onClick: toggle,
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

		// One realm row: access selector + that realm's temp-grant toggle.
		//
		// 2026-09-28 收敛：原来「访问控制」卡里是 3 个域选择 + 3 个临时授权开关（6 行），
		// 外加「常规」卡里一个网络预设。预设砍掉后（它本来就是各域的默认值），
		// 每个域一行、临时授权跟在同一行 —— 6 行变 3 行，且「这个域的授权与临时授权」
		// 在同一处看得见。未显式设置过的域显示它**当前生效**的值（来自内置默认），
		// 选择即写入显式覆盖。
		function presetRealmAccess(urlMode, realm) {
			if (String(urlMode || 'public') === 'intranet') return 'allow'
			return realm === 'internet' ? 'allow' : 'deny'
		}

		function realmRow(props) {
			var value = props.value
			var current = value[props.key]
			var effective = current === undefined || current === null
				? presetRealmAccess(value.urlMode, props.realm)
				: String(current)
			var tempOn = value[props.tempKey] !== false
			return createElement(Row, { title: props.title, desc: t('realmDesc') },
				createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '14px' } },
					createElement('select', {
						value: effective,
						onChange: function (e) { props.setField(props.key, e.target.value) },
						style: selectStyle,
					},
						createElement('option', { value: 'allow' }, t('modeAllow')),
						createElement('option', { value: 'ask' }, t('modeAsk')),
						createElement('option', { value: 'deny' }, t('modeDeny')),
					),
					createElement('label', {
						title: t('tempHint'),
						style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: T.label3, whiteSpace: 'nowrap', cursor: 'pointer' },
					},
						createElement(Switch, {
							checked: tempOn,
							onChange: function (on) { props.setField(props.tempKey, on) },
						}),
						t('realmTemp'),
					),
				),
			)
		}

		// ---- live bridge probe (page-side, read-only) --------------------------------
		// `/api/status` 是唯一带 CORS 的只读端点（写类端点自 2026-09-25 起不发 CORS 头），
		// 所以设置页可以直接探测本机桥：不经宿主、不需要新通道，也不碰安全边界。
		// 这替代了「让人手填端口、还得和扩展里填的一致」那种笨办法 —— 与扩展一样自动探测。
		var PROBE_COUNT = 10
		var PROBE_TIMEOUT_MS = 400

		function pageIsLocal() {
			try {
				var h = window.location.hostname
				return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
			} catch (e) { return false }
		}

		function probeOne(port) {
			var controller = typeof AbortController === 'function' ? new AbortController() : null
			var timer = window.setTimeout(function () { if (controller) controller.abort() }, PROBE_TIMEOUT_MS)
			var done = function (out) { window.clearTimeout(timer); return out }
			return fetch('http://127.0.0.1:' + port + '/api/status', {
				cache: 'no-store',
				signal: controller ? controller.signal : undefined,
			}).then(function (res) {
				return res.ok ? res.json() : null
			}).then(function (body) {
				if (!body || body.ok !== true || typeof body.wsUrl !== 'string') return done(null)
				return done({
					port: port,
					extensionConnected: body.extensionConnected === true,
					extensionVersion: body.hello && typeof body.hello.version === 'string' ? body.hello.version : null,
					// 运行中**生效**的策略快照（core 0.1.7 起随 /api/status 一起给）
					policy: body.policy && typeof body.policy === 'object' ? body.policy : null,
				})
			}, function () { return done(null) })
		}

		/** 深比较：标量照实比，数组/对象走 JSON（设置里的列表就是这么用的）。 */
		function sameValue(a, b) {
			if (a === b) return true
			try {
				return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b)
			} catch (e) { return false }
		}

		/**
		 * 一次写完之后的判定（纯函数，单测用）：
		 *   'saved'   —— 快照已经是新值、且与写之前不同 ⇒「配置已保存」
		 *   'noop'    —— 新值跟写之前一模一样：真没改，不打扰（这不是失败）
		 *   'pending' —— 超时还没看到新值 ⇒「已提交，但还没看到生效」（旧版插件要重启就是这种）
		 *   'wait'    —— 还没到超时，继续看
		 */
		function writeOutcome(before, next, seen, timedOut) {
			if (sameValue(seen, next)) return sameValue(before, next) ? 'noop' : 'saved'
			return timedOut ? 'pending' : 'wait'
		}

		/** 主机列表条目的合法形态（与插件 assertHostList 同一条规则：主机名/IP 或 *.suffix）。 */
		function validHostEntry(entry) {
			if (typeof entry !== 'string') return false
			var value = entry.trim()
			return value.length > 0 && value.length <= 253 && !/[\s/\\@?#\u0000-\u001f\u007f]/.test(value)
		}

		/**
		 * 「存下来的值」vs「运行中生效的值」：返回改了但**还没生效**的字段名。
		 *
		 * 为什么需要（2026-10-17）：用户在设置页开了「允许访问本 DSH 页面」，文件里是 true、
		 * 页面也显示已开，但运行中的桥还是旧策略 ⇒ 实际仍被 `WEB_DSH_DISABLED` 拒。
		 * 光显示"存下来的值"等于骗人，所以桥会把生效快照吐到 `/api/status`（`policy`），这里比对。
		 * `dshOrigins` 刻意不比：生效值里含宿主推导出来的控制页地址，与用户列表天然不同。
		 */
		function stalePolicyKeys(stored, policy) {
			if (!policy || typeof policy !== 'object') return []
			var flagKeys = ['enabled', 'dshAccessEnabled', 'blockMetadata']
			var plainKeys = ['internetAccess', 'lanAccess', 'localAccess', 'askMode']
			var listKeys = ['allowHosts', 'denyHosts']
			var out = []
			var i
			for (i = 0; i < flagKeys.length; i += 1) {
				var fk = flagKeys[i]
				var want = fk === 'blockMetadata' || fk === 'enabled' ? (stored && stored[fk] !== false) : (stored && stored[fk] === true)
				var got = fk === 'dshAccessEnabled' ? policy[fk] === true : policy[fk] !== false
				if (want !== got) out.push(fk)
			}
			for (i = 0; i < plainKeys.length; i += 1) {
				var pk = plainKeys[i]
				var a = stored ? stored[pk] : undefined
				if (a !== policy[pk]) out.push(pk)
			}
			for (i = 0; i < listKeys.length; i += 1) {
				var lk = listKeys[i]
				var la = Array.isArray(stored && stored[lk]) ? stored[lk].slice().join('\u0001') : ''
				var lb = Array.isArray(policy[lk]) ? policy[lk].slice().join('\u0001') : ''
				if (la !== lb) out.push(lk)
			}
			return out
		}

		/** 并行探 10 个候选端口（起始端口 +0..+9，与插件/扩展同构），返回命中的桥或 null。 */
		function probeBridge(basePort) {
			var jobs = []
			for (var i = 0; i < PROBE_COUNT; i += 1) jobs.push(probeOne(basePort + i))
			return Promise.all(jobs).then(function (results) {
				for (var j = 0; j < results.length; j += 1) if (results[j]) return results[j]
				return null
			})
		}

		/** 「本地桥」状态行：探测结果 + 重新探测。只读，不改任何设置。 */
		/** 「本地桥」状态行：纯展示 —— 探针由 body 统一持有（一次扫描两处共用）。 */
		function BridgeStatus(props) {
			var snap = props.probe

			var text = t('probeLabel') + '：'
			var color = T.label3
			if (snap.phase === 'remote') {
				text += t('probeRemote')
			} else if (snap.phase === 'loading') {
				text += t('probeLoading')
			} else if (snap.found === null) {
				text += t('probeNone')
				color = T.warn
			} else {
				var f = snap.found
				text += '127.0.0.1:' + f.port + ' · '
					+ (f.extensionConnected ? t('probeExtOn') : t('probeExtOff'))
					+ (f.extensionVersion ? '（' + f.extensionVersion + '）' : '')
					+ (f.port !== props.basePort ? ' ' + t('probeShifted') : '')
				color = f.extensionConnected ? T.success : T.warn
			}
			return createElement('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '10px', margin: '0 0 10px' } },
				createElement('div', { style: { flex: '1', minWidth: 0 } },
					createElement('div', { style: { fontSize: '12px', lineHeight: '18px', color: color } }, text),
					snap.phase === 'ready' && snap.found === null
						? createElement('div', { style: { marginTop: '2px', fontSize: '12px', lineHeight: '16px', color: T.label3 } }, t('probeNoneHint'))
						: null,
				),
				createElement('button', { onClick: props.onRetry, style: btnBase }, t('probeRetry')),
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
					createElement('div', { style: rowTitleStyle }, t('dshAutoOrigin') + (SELF_ORIGIN || '（未知）')),
					createElement('div', { style: rowDescStyle }, t('dshAutoOriginNote')),
				),
				createElement('div', { style: { padding: '10px 2px 0' } },
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

			// --- 胶囊（toast）------------------------------------------------------------
			// 只在**真的改了值**之后弹一次「配置已保存」，1 秒后自己消失；后来的胶囊直接覆盖
			// 前一个（清掉旧定时器再挂新的）。改不动时弹琥珀「还没看到生效」/ 红「保存失败」——
			// 「没改也能看出来」是这条 UX 的一半，光报成功等于没有信息。
			var capsuleState = useState(null)
			var capsule = capsuleState[0]
			var setCapsule = capsuleState[1]
			// 探桥结果由 body 统一持有：「本地桥」行与「生效值比对」共用**一次**扫描（原来两处各扫一遍）。
			var probeState = useState({ phase: 'loading', found: null, nonce: 0 })
			var probe = probeState[0]
			var setProbe = probeState[1]
			var capsuleTimer = useRef(null)
			// 卸载守卫：复验轮询最多跑 1.5s，但期间用户可能切走页面 —— 卸载后一律不再 setState。
			var aliveRef = useRef(true)
			React.useEffect(function () {
				aliveRef.current = true
				return function () { aliveRef.current = false }
			}, [])
			var showCapsule = function (kind, text) {
				if (!aliveRef.current) return
				if (capsuleTimer.current) window.clearTimeout(capsuleTimer.current)
				setCapsule({ kind: kind, text: text })
				capsuleTimer.current = window.setTimeout(function () { setCapsule(null) }, kind === 'ok' ? 1000 : 2600)
			}
			/** 当前**存下来**的值 —— 写完拿它复验：真改了才敢说「已保存」。 */
			var readField = function (field) {
				try {
					var snap = scope.getSnapshot()
					return snap && snap.value ? snap.value[field] : undefined
				} catch (e) { return undefined }
			}
			/**
			 * 轮询到「快照变成新值」为止，再按 writeOutcome 决定弹什么。
			 *
			 * **有终止**：`deadline` 是硬上界（1.5s），每 tick 用 `Date.now() > deadline` 重算；
			 * 过了上界 `writeOutcome` 必返回 'pending'（'wait' 只在未超时且未命中时出现），
			 * 而**只有 'wait' 分支才重排下一次** ⇒ 最多 ceil(1500/60)+1 ≈ 26 次就停，不会常驻轮询。
			 * 另外卸载后不再 setState（aliveRef），页面切走也不会留下在跑的定时器。
			 */
			var confirmWrite = function (field, next, before) {
				var deadline = Date.now() + 1500
				var step = function () {
					if (!aliveRef.current) return
					var outcome = writeOutcome(before, next, readField(field), Date.now() > deadline)
					if (outcome === 'wait') { window.setTimeout(step, 60); return }
					if (outcome === 'saved') showCapsule('ok', t('savedToast'))
					else if (outcome === 'pending') showCapsule('warn', t('writePending') + '（' + field + '）')
					// 无论 saved 还是 pending 都重探一次生效值：saved 时确认它真的进策略了，
					// pending 时让"未生效"提示条把这一项列出来。
					setProbe(function (prev) { return { phase: 'loading', found: prev.found, nonce: prev.nonce + 1 } })
					// 'noop'：选了个跟原来一样的值，确实没改 —— 不打扰
				}
				step()
			}
			var runWrite = function (target, field, next) {
				writeBusy.current = true
				setBusy('saving')
				var before = readField(field)
				var done = target.set(field, next)
				if (done && typeof done.then === 'function') {
					done.then(
						function () {
							if (writeBusy.current) {
								writeBusy.current = false
								setBusy(null) // 成功不再写内联文字：改由胶囊回报
								confirmWrite(field, next, before)
							}
						},
						function (err) {
							writeBusy.current = false
							var msg = err && err.message ? err.message : String(err)
							setBusy({ error: msg })
							showCapsule('bad', t('writeFailed') + msg)
						},
					)
				} else {
					writeBusy.current = false
					setBusy(null)
					confirmWrite(field, next, before)
				}
			}
			/** 复位（unset）走同样的回报：清掉就等于把这项改回「未设置」。 */
			var runUnset = function (field) {
				var before = readField(field)
				var land = function () { confirmWrite(field, undefined, before) }
				var fail = function (err) {
					showCapsule('bad', t('writeFailed') + (err && err.message ? err.message : String(err)))
				}
				var done = scope.unset(field)
				if (done && typeof done.then === 'function') done.then(land, fail)
				else land()
			}
			var setField = function (field, next) { runWrite(scope, field, next) }
			/** 主机列表先按插件那条规则自查一遍：格式不对就别写出去（否则它会拒，白跑一趟）。 */
			var setHostList = function (field, next) {
				var list = Array.isArray(next) ? next : []
				var bad = list.filter(function (entry) { return !validHostEntry(entry) })
				if (bad.length > 0) { showCapsule('warn', t('writeInvalid')); return }
				setField(field, list)
			}
			var noop = function () {}

			var metaHosts = Array.isArray(value.metadataHostnames) ? value.metadataHostnames : []
			var metaIps = Array.isArray(value.metadataIps) ? value.metadataIps : []
			var basePort = typeof value.port === 'number' ? value.port : 9777

			React.useEffect(function () {
				if (!pageIsLocal()) {
					setProbe({ phase: 'remote', found: null, nonce: probe.nonce })
					return undefined
				}
				var cancelled = false
				probeBridge(basePort).then(function (found) {
					if (!cancelled) setProbe({ phase: 'ready', found: found, nonce: probe.nonce })
				})
				return function () { cancelled = true }
			}, [basePort, probe.nonce])

			// 只认桥自己报的生效值；桥没连上/没给 policy 时**不**下"已生效"的结论（宁可不说）
			var effPolicy = probe.phase === 'ready' && probe.found !== null && probe.found.policy ? probe.found.policy : null
			var staleKeys = effPolicy !== null ? stalePolicyKeys(value, effPolicy) : []
			var fieldLabel = function (key) {
				if (key === 'enabled') return t('enabled')
				if (key === 'dshAccessEnabled') return t('dshItem')
				if (key === 'internetAccess') return t('realmInternet')
				if (key === 'lanAccess') return t('realmLan')
				if (key === 'localAccess') return t('realmLocal')
				if (key === 'askMode') return '受限态 ask 策略'
				if (key === 'blockMetadata') return t('blockMetadata')
				if (key === 'allowHosts') return '白名单'
				if (key === 'denyHosts') return '黑名单'
				return key
			}
			var noPolicyNote = probe.phase === 'ready' && probe.found !== null && probe.found.policy === null
				? createElement('div', { style: { margin: '0 0 10px', fontSize: '12px', lineHeight: '18px', color: T.label3 } },
					t('staleBridgeDown'))
				: null
			var staleBanner = staleKeys.length === 0 ? null : createElement('div', {
				style: {
					margin: '2px 0 12px', padding: '10px 12px', borderRadius: '12px',
					border: '1px solid ' + T.warn,
					background: 'color-mix(in srgb, ' + T.warn + ' 10%, transparent)',
				},
			},
				createElement('div', { style: { fontSize: '13px', fontWeight: 600, color: T.warn } }, t('staleTitle')),
				createElement('div', { style: { marginTop: '3px', fontSize: '12px', lineHeight: '18px', color: T.label2 } },
					t('staleBody') + staleKeys.map(fieldLabel).join('、')),
			)

			var statusRow = null
			if (busy !== null) {
				var statusText = busy === 'saving'
					? t('saving')
					: (busy && busy.error ? t('error') + busy.error : '')
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
				createElement(BridgeStatus, {
					probe: probe,
					onRetry: function () { setProbe({ phase: 'loading', found: probe.found, nonce: probe.nonce + 1 }) },
				}),
				createElement(FoldCard, { id: 'general', title: t('general') },
					createElement(Row, {
						title: t('enabled'),
						desc: (value.enabled === true ? t('enabledOn') : t('enabledOff')) + ' · ' + t('enabledDesc'),
					},
						createElement(Switch, {
							checked: value.enabled === true,
							onChange: function (on) { setField('enabled', on) },
						}),
					),
				),
				createElement(FoldCard, { id: 'access', title: t('access'), subtitle: t('accessSub') },
					staleBanner,
					noPolicyNote,
					realmRow({ title: t('realmInternet'), key: 'internetAccess', tempKey: 'internetTemp', realm: 'internet', value: value, setField: setField }),
					realmRow({ title: t('realmLan'), key: 'lanAccess', tempKey: 'lanTemp', realm: 'lan', value: value, setField: setField }),
					realmRow({ title: t('realmLocal'), key: 'localAccess', tempKey: 'localTemp', realm: 'local', value: value, setField: setField }),
					createElement('div', { style: rowDescStyle }, t('realmDesc')),
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
							onChange: function (next) { setHostList('allowHosts', next) },
							onReset: function () { runUnset('allowHosts') },
						}),
					),
					createElement('div', { style: { padding: '4px 0 2px' } },
						createElement('div', { style: rowTitleStyle }, t('denyHosts')),
						createElement('div', { style: rowDescStyle }, t('denyHostsHint')),
						createElement(StringListEditor, {
							value: Array.isArray(value.denyHosts) ? value.denyHosts : [],
							placeholder: t('addDeny'),
							onChange: function (next) { setHostList('denyHosts', next) },
							onReset: function () { runUnset('denyHosts') },
						}),
					),
				),
				createElement(FoldCard, { id: 'toolsurface', title: t('toolSurfaceCard'), subtitle: t('toolSurfaceCardSub'), open: false },
				createElement(Row, { title: t('layeredTools'), desc: t('layeredToolsDesc') },
					createElement(Switch, {
						checked: value.layeredTools !== false,
						onChange: function (on) { setField('layeredTools', on) },
					}),
				),
				createElement(Row, { title: t('enabledGroups'), desc: t('enabledGroupsDesc') },
					createElement(StringListEditor, {
						value: Array.isArray(value.enabledGroups) ? value.enabledGroups : [],
						placeholder: 'frames',
						onChange: function (next) { setField('enabledGroups', next) },
						onReset: function () { setField('enabledGroups', []) },
					}),
				),
			),
			createElement(FoldCard, { id: 'autolaunch', title: t('autoLaunchCard'), subtitle: t('autoLaunchCardSub'), open: false },
					createElement(Row, { title: t('autoLaunch'), desc: t('autoLaunchDesc') },
						createElement(Switch, {
							checked: value.autoLaunchEnabled === true,
							onChange: function (on) { setField('autoLaunchEnabled', on) },
						}),
					),
					createElement(Row, { title: t('autoIdle') },
						createElement('input', {
							type: 'number', min: 3, max: 3600, step: 1,
							value: typeof value.autoLaunchIdleSeconds === 'number' ? value.autoLaunchIdleSeconds : 15,
							onChange: function (e) {
								var n = parseInt(e.target.value, 10)
								setField('autoLaunchIdleSeconds', isNaN(n) ? 15 : n)
							},
							style: numberStyle,
						}),
					),
					createElement(Row, { title: t('wakeOnToolUse'), desc: t('wakeOnToolUseDesc') },
						createElement(Switch, {
							checked: value.autoLaunchOnToolUse === true,
							onChange: function (on) { setField('autoLaunchOnToolUse', on) },
						}),
					),
					createElement(Row, { title: t('wakeWait'), desc: t('wakeWaitDesc') },
						createElement('input', {
							type: 'number', min: 0, max: 60_000, step: 500,
							value: typeof value.autoLaunchWaitMs === 'number' ? value.autoLaunchWaitMs : 8000,
							onChange: function (e) {
								var n = parseInt(e.target.value, 10)
								setField('autoLaunchWaitMs', isNaN(n) ? 8000 : n)
							},
							style: numberStyle,
						}),
					),
					createElement(Row, { title: t('autoExe') },
						createElement(TextInput, { value: value.autoLaunchBrowserExe, onChange: function (v) { setField('autoLaunchBrowserExe', v) } }),
					),
					createElement(Row, { title: t('autoProfile') },
						createElement(TextInput, { value: value.autoLaunchProfileDir, onChange: function (v) { setField('autoLaunchProfileDir', v) } }),
					),
					createElement('div', { style: Object.assign({}, cardSubStyle, { marginTop: '8px' }) }, t('wakeShareHint')),
				),
				createElement(FoldCard, { id: 'transport', title: t('transport'), subtitle: t('transportSub'), open: false },
					createElement(Row, { title: t('port'), desc: t('portDesc') },
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
				),
				createElement(FoldCard, { id: 'metadata', title: t('metadata'), subtitle: t('metadataSub') },
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
							onReset: function () { runUnset('metadataHostnames') },
						}),
					),
					createElement('div', { style: { padding: '4px 0 2px' } },
						createElement('div', { style: rowTitleStyle }, t('metaIps')),
						createElement('div', { style: rowDescStyle }, t('metaIpsHint')),
						createElement(StringListEditor, {
							value: metaIps,
							placeholder: t('addIp'),
							onChange: function (next) { setField('metadataIps', next) },
							onReset: function () { runUnset('metadataIps') },
						}),
					),
					createElement('div', { style: Object.assign({}, cardSubStyle, { marginTop: '8px' }) }, t('defaultsHint')),
				),
				createElement(FoldCard, { id: 'advanced', title: t('advanced'), subtitle: t('advancedSub'), open: false },
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
					createElement(Row, { title: t('autoProfileName') },
						createElement(TextInput, { value: value.autoLaunchProfileName, onChange: function (v) { setField('autoLaunchProfileName', v) } }),
					),
					createElement(Row, { title: t('autoTemp') },
						createElement(Switch, {
							checked: value.autoLaunchTempProfile === true,
							onChange: function (on) { setField('autoLaunchTempProfile', on) },
						}),
					),
					createElement(Row, { title: t('autoExt') },
						createElement(TextInput, { value: value.autoLaunchExtensionDir, onChange: function (v) { setField('autoLaunchExtensionDir', v) } }),
					),
					createElement(Row, { title: t('shotsDir') },
						createElement(TextInput, { value: value.shotsDir, onChange: function (v) { setField('shotsDir', v) } }),
					),
					createElement(Row, { title: t('registryDir') },
						createElement(TextInput, { value: value.registryDir, onChange: function (v) { setField('registryDir', v) } }),
					),
				),
				statusRow,
				capsule === null ? null : createElement('div', {
					style: Object.assign({}, capsuleWrapStyle, {
						color: capsule.kind === 'ok' ? T.success : (capsule.kind === 'bad' ? T.error : T.warn),
						borderColor: capsule.kind === 'ok' ? T.success : (capsule.kind === 'bad' ? T.error : T.warn),
					}),
				}, (capsule.kind === 'ok' ? '✓ ' : '⚠ ') + capsule.text),
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
				var settings = ctx.configForms
				if (!slots || !settings) return
				// One resident form per namespace, addressed by loader entry id.
				var scope = settings.get('browser-bridge')
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

		var inject = ['slots', 'configForms']
		exports.apply = apply
		exports.inject = inject
		// 单测入口（纯函数；见 tests/render-settings-pages.mjs 的 [胶囊] 段）
		exports.__test = { writeOutcome: writeOutcome, sameValue: sameValue, validHostEntry: validHostEntry, stalePolicyKeys: stalePolicyKeys }
		return module.exports
	},
})
