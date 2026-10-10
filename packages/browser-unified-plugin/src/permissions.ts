/**
 * 浏览器级权限（content settings）只读探针。
 *
 * 为什么需要它：页面在等一个**浏览器 chrome 自己的**权限气泡（最典型的是「本地网络访问」
 * LNA —— 页面一访问 127.0.0.1 就会弹）时，CDP 侧**没有任何事件**：扩展看不见它，也就答不了、
 * 报不出来。表现出来只是一句 `eval timeout after 15000ms`，模型只能自己瞎排查"页面是不是卡了"。
 *
 * 事实来源（两条，都是本机可读的）：
 *  1. `<profile>/Preferences` → `profile.content_settings.exceptions.<class>.<pattern>.setting`
 *     —— 这就是浏览器（和用户手点的那个气泡）真正落盘的地方；`3` 表示"询问"，即**会弹窗**。
 *     类名不是猜的：本机 Edge 154 的该表里有 124 个类，下面 CURATED 直接取其中的真实键名。
 *  2. 桥自己的 `network.log`（在调用方拼）—— 有 pending 的 loopback/私网请求 + 该类是"询问"
 *     ⇒ 屏幕上大概率正挂着一个气泡。
 *
 * 本模块**纯读**、不依赖桥，故可离线用夹具测试（tests/permissions-read.mjs）。
 * 这里只回答"现在是什么状态"；"谁来定 / 要不要替用户答"是策略层（de-034），不在本文件。
 * @module @deepseek-ai/dsh-browser-bridge/permissions
 */

import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { hostStyle, toLinuxPath, toWindowsPath } from './browser-profiles.js'

/** `content_settings.exceptions` 里 setting 的取值（Chromium ContentSetting 枚举）。 */
export const CONTENT_SETTING = {
	ALLOW: 1,
	BLOCK: 2,
	ASK: 3,
	SESSION_ONLY: 4,
	DETECT_IMPORTANT_CONTENT: 5,
} as const

const SETTING_LABEL: Record<number, string> = {
	1: '允许',
	2: '拒绝',
	3: '询问（会弹窗，需人点）',
	4: '仅本次会话允许',
	5: '自动检测',
}

/** 一条例外记录。 */
export interface PermissionException {
	setting: number
	label: string
	/** 命中的 pattern 原文（回给模型，便于人核对）。 */
	pattern: string
	lastModified?: string
}

/** 一个受关注权限类的现状。 */
export interface PermissionReading {
	pref: string
	label: string
	trigger: string
	/** 该 origin 的显式记录；undefined = 没有任何记录（走浏览器默认）。 */
	exception?: PermissionException
}

/**
 * 受关注的权限类 —— 只收"会拦人 / 会卡住自动化"的那些，且**键名取自本机 Preferences 的真实枚举**
 * （Edge 154 共 124 个类，这里选 24 个），不做名称猜测：枚举值写死过一次假阴性
 * （`browser-trust fence` 大小写），这里宁可少列也不猜。
 */
export const CURATED_CLASSES: ReadonlyArray<{ pref: string; label: string; trigger: string }> = [
	// 网络类：与桥自身 / 本机端口直接相关，最要紧
	{ pref: 'loopback_network', label: '本地网络访问（LNA）', trigger: '页面访问 127.0.0.1 / localhost（含本机桥端口）时' },
	{ pref: 'local_network_access', label: '本地网络访问（新命名）', trigger: '同上（新版 Chromium 的另一条记录）' },
	{ pref: 'local_network', label: '局域网访问', trigger: '页面访问 192.168/10./172.16-31 等私网地址时' },
	{ pref: 'direct_sockets', label: '直接套接字', trigger: '页面使用 Direct Sockets API 时' },
	{ pref: 'direct_sockets_private_network_access', label: '直接套接字（私网）', trigger: 'Direct Sockets 访问私网时' },
	// 下载/文件：用户明确愿意放权的一类（批量下载）
	{ pref: 'automatic_downloads', label: '批量下载', trigger: '一次触发多个文件下载时' },
	{ pref: 'file_system_access_extended_permission', label: '文件系统写入', trigger: '页面要求长期读写本地目录时' },
	{ pref: 'file_system_write_guard', label: '文件系统写入保护', trigger: '同上（写入侧记录）' },
	// 通知 / 定位 / 采集器件
	{ pref: 'notifications', label: '发送通知', trigger: '页面调用 Notification.requestPermission() 时' },
	{ pref: 'geolocation', label: '读取定位', trigger: '页面调用 geolocation 时' },
	{ pref: 'geolocation_with_options', label: '读取定位（带选项）', trigger: '同上（带 options 的调用记录）' },
	{ pref: 'media_stream_camera', label: '摄像头', trigger: '页面调用 getUserMedia({video}) 时' },
	{ pref: 'media_stream_mic', label: '麦克风', trigger: '页面调用 getUserMedia({audio}) 时' },
	{ pref: 'display_media_system_audio', label: '屏幕/系统声音共享', trigger: '页面调用 getDisplayMedia 时' },
	{ pref: 'clipboard', label: '剪贴板', trigger: '页面读写剪贴板时' },
	{ pref: 'midi_sysex', label: 'MIDI 设备', trigger: '页面请求 MIDI 时' },
	{ pref: 'idle_detection', label: '空闲检测', trigger: '页面请求 Idle Detection 时' },
	{ pref: 'sensors', label: '传感器', trigger: '页面请求加速度/陀螺仪等时' },
	{ pref: 'local_fonts', label: '本机字体枚举', trigger: '页面调用 queryLocalFonts() 时' },
	// 设备 / 外设
	{ pref: 'hid_guard', label: 'HID 设备', trigger: '页面请求 HID 设备时' },
	{ pref: 'serial_guard', label: '串口设备', trigger: '页面请求串口时' },
	{ pref: 'usb_guard', label: 'USB 设备', trigger: '页面请求 USB 设备时' },
	{ pref: 'bluetooth_guard', label: '蓝牙设备', trigger: '页面请求蓝牙时' },
	// 其它常见的拦人项
	{ pref: 'pointer_lock', label: '鼠标指针锁定', trigger: '页面请求 pointer lock 时' },
	{ pref: 'protocol_handler', label: '外部协议', trigger: '页面要打开外部应用（如 tel:/自定义协议）时' },
	{ pref: 'popups', label: '弹窗', trigger: '页面自动开新窗口时' },
]

/** 读到的权限存储。 */
export interface PermissionStore {
	/** Preferences 文件绝对路径。 */
	file: string
	/** 文件修改时间（用来判断"这是不是刚刚那份"）。 */
	modifiedAt: Date
	/** class → pattern → 例外记录。 */
	exceptions: Map<string, Map<string, { setting: number; lastModified?: string }>>
	/** 该文件里出现的全部类名（本机 Edge 的权威枚举，124 个）。 */
	classNames: string[]
}

const SETTING_NUMBER = /^-?\d+$/

/** 把 Preferences 里的 setting 值收敛成数字（兼容字符串形式）。 */
function settingOf(raw: unknown): number | undefined {
	if (typeof raw === 'number' && Number.isFinite(raw)) return raw
	if (typeof raw === 'string' && SETTING_NUMBER.test(raw)) return Number(raw)
	return undefined
}

/**
 * 读取一个 profile 的权限存储。
 *
 * `profileDir` 是 **profile 目录**（如 `.../User Data/Profile 3`），不是 `User Data`：
 * Preferences 就在 profile 目录下。传错时抛出带修复指引的错误（这是最常见的配置错法）。
 */
export function readPermissionStore(profileDir: string): PermissionStore {
	if (typeof profileDir !== 'string' || profileDir.trim().length === 0) {
		throw new Error('未配置浏览器 profile 目录（browser-bridge.autoLaunchProfileDir），无法读取权限现状')
	}
	const dir = profileDir.trim()
	const file = path.join(dir, 'Preferences')
	let stat
	try {
		stat = statSync(file)
	} catch {
		// 修 bi-013：以前这里断言成「autoLaunchProfileDir 要指向 profile 目录…也可能是该 profile
		// 从未启动过」——配置**本来就是对的时候**这两句都与事实相反，会把模型引向"去改配置"（而那是
		// 写操作）。这里只陈述观察到的事实，诊断交给下面的 readPermissionStoreTolerant（它知道
		// 路径形态这一层原因）。
		throw new Error(`这个路径下没有 Preferences 文件：${file}`)
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(file, 'utf8'))
	} catch (error) {
		throw new Error(`解析 ${file} 失败：${error instanceof Error ? error.message : String(error)}`)
	}
	const raw = (parsed as { profile?: { content_settings?: { exceptions?: unknown } } })
		?.profile?.content_settings?.exceptions
	const exceptions = new Map<string, Map<string, { setting: number; lastModified?: string }>>()
	const classNames: string[] = []
	if (raw !== null && typeof raw === 'object') {
		for (const [className, table] of Object.entries(raw as Record<string, unknown>)) {
			classNames.push(className)
			if (table === null || typeof table !== 'object') continue
			const rows = new Map<string, { setting: number; lastModified?: string }>()
			for (const [pattern, entry] of Object.entries(table as Record<string, unknown>)) {
				if (entry === null || typeof entry !== 'object') continue
				const setting = settingOf((entry as { setting?: unknown }).setting)
				if (setting === undefined) continue
				const lastModified = (entry as { last_modified?: unknown }).last_modified
				rows.set(pattern, { setting, ...(typeof lastModified === 'string' ? { lastModified } : {}) })
			}
			if (rows.size > 0) exceptions.set(className, rows)
		}
	}
	classNames.sort()
	return { file, modifiedAt: stat.mtime, exceptions, classNames }
}

/** 该路径看起来是 Windows 形态（`C:\…` / `C:/…` / UNC）。 */
function looksWindowsPath(value: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/** Windows 形态路径可能对应的一串本地形态（先按品牌 user-data 目录反推，再退回通用的 /mnt/<盘> 映射）。 */
function localFormsOf(winPath: string): string[] {
	const out: string[] = []
	try {
		out.push(toLinuxPath(winPath))
	} catch { /* 无法转换就只留原样 */ }
	return out
}

/**
 * 读一个 profile 的权限存储，**容忍路径形态**（修 bi-013）。
 *
 * 现场：`autoLaunchProfileDir` 配的是 `C:\Users\…\Profile 3`（Windows 形态，浏览器在 Windows 侧），
 * 而宿主进程跑在 WSL 里 —— 直接 `path.join(dir, 'Preferences')` 得到一个不存在的相对路径，
 * 于是一个**配置完全正确**的部署会读不到权限，并（改前）把原因误报成"配置写错了"。
 * 这里对每个候选目录按 `[原样, 形态转换后]` 依次试，命中即用，并把"用了哪个、转过没有"回报给调用方。
 *
 * @param profileDirs 候选（按优先级）：通常是 `[autoLaunchProfileDir, 配对记录里的 profileDir]`。
 * @throws 全不命中时，错误里列出**试过哪些路径**与两种真实可能的原因。
 */
export function readPermissionStoreTolerant(profileDirs: readonly (string | undefined)[]): {
	store: PermissionStore
	usedDir: string
	/** 配置里的原值（形态转换前）。 */
	configuredDir: string
	/** 命中不是原样命中，而是形态转换后命中。 */
	converted: boolean
	tried: string[]
} {
	const tried: string[] = []
	const problems: string[] = []
	for (const raw of profileDirs) {
		if (typeof raw !== 'string' || raw.trim().length === 0) continue
		const configured = raw.trim()
		const forms = [configured, ...(looksWindowsPath(configured) ? localFormsOf(configured) : [])]
		const unique = [...new Set(forms)]
		for (const [index, dir] of unique.entries()) {
			tried.push(dir)
			try {
				const store = readPermissionStore(dir)
				return { store, usedDir: dir, configuredDir: configured, converted: index > 0 || dir !== configured, tried }
			} catch (error) {
				problems.push(`${dir} → ${error instanceof Error ? error.message : String(error)}`)
			}
		}
	}
	if (tried.length === 0) {
		throw new Error('没有可用的浏览器 profile 目录：browser-bridge.autoLaunchProfileDir 未配置，'
			+ '配对记录里也没有位置。先手动打开一次装了扩展的那个 profile，让扩展连上过一回（桥会自己记住位置）。')
	}
	throw new Error(`读不到浏览器权限存储，试过：\n${tried.map((dir) => `  - ${dir}`).join('\n')}\n`
		+ `明细：\n${problems.map((line) => `  - ${line}`).join('\n')}\n`
		+ '真实可能的原因只有两种：① 路径指的是上层 "User Data" 而不是 profile 目录（Preferences 在 profile 目录下）；'
		+ '② 该 profile 从未启动过（没有 Preferences 文件）。'
		+ '注意"配置写错"已经不是原因之一：路径形态（Windows/WSL 两种写法）本工具会自动尝试转换。')
}

/**
 * 把 URL 化成匹配用的候选 pattern。
 *
 * Preferences 的键形如 `"https://ti.qianxin.com:443,*"`（`<主pattern>,<次pattern>`，
 * 默认端口会显式写出来），也有裸 `*` 或只有主机名的写法 —— 三种都试，避免"看起来没记录"的假阴性。
 */
export function originPatterns(url: string): { origin: string; candidates: string[] } {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return { origin: url, candidates: [url] }
	}
	const host = parsed.hostname
	const port = parsed.port.length > 0 ? parsed.port : (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '')
	const origin = `${parsed.protocol}//${host}${parsed.port.length > 0 ? `:${parsed.port}` : ''}`
	const candidates = [
		`${parsed.protocol}//${host}:${port}`,
		`${parsed.protocol}//${host}`,
		host,
		'*',
	]
	return { origin, candidates }
}

function matchException(
	store: PermissionStore,
	className: string,
	candidates: readonly string[],
): PermissionException | undefined {
	const rows = store.exceptions.get(className)
	if (rows === undefined) return undefined
	for (const candidate of candidates) {
		for (const [pattern, entry] of rows) {
			// 键是 `<主pattern>,<次pattern>`：主 pattern 才是作用域。
			const primary = pattern.split(',')[0]?.trim() ?? pattern
			if (primary !== candidate) continue
			return {
				setting: entry.setting,
				label: SETTING_LABEL[entry.setting] ?? `未知(${entry.setting})`,
				pattern,
				...(entry.lastModified === undefined ? {} : { lastModified: entry.lastModified }),
			}
		}
	}
	return undefined
}

/** 取某个 origin 下所有受关注类的现状。 */
export function readOriginPermissions(
	store: PermissionStore,
	url: string,
	filter?: { pref?: string },
): { origin: string; readings: PermissionReading[] } {
	const { origin, candidates } = originPatterns(url)
	const wanted = CURATED_CLASSES.filter((entry) => filter?.pref === undefined || entry.pref === filter.pref)
	const readings = wanted.map((entry) => ({
		pref: entry.pref,
		label: entry.label,
		trigger: entry.trigger,
		...(matchException(store, entry.pref, candidates) === undefined
			? {}
			: { exception: matchException(store, entry.pref, candidates) as PermissionException }),
	}))
	return { origin, readings }
}

/** Chromium 时间戳（微秒，自 1601-01-01）→ 本地时间字符串。 */
export function chromiumTime(value: string | undefined): string {
	if (typeof value !== 'string' || !SETTING_NUMBER.test(value)) return '未知'
	const micros = Number(value)
	if (!Number.isFinite(micros)) return '未知'
	const ms = micros / 1000 - 11_644_473_600_000
	const date = new Date(ms)
	return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleString('sv-SE')
}
