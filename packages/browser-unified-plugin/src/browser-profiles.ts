/**
 * browser-profiles — 定位"装了本扩展的那个浏览器 profile"，以及各品牌在
 * 各平台的默认安装位置。跨平台：Windows 原生 / WSL（Linux 进程 + Windows 浏览器）/
 * macOS / Linux。
 *
 * ## 为什么需要它
 *
 * 扩展**无法**告诉桥"我在哪个 profile"：Chromium 扩展 API 没有这个接口，
 * 而 `edge://version` / `chrome://version` 这类页面被 scheme 拦死
 * （实测 2026-10-02：`debugger attach failed: Cannot access chrome:// and edge:// URLs`，
 * 关掉 DevTools 也没用，是 scheme 限制，页面上那句提示是误导）。
 *
 * 但这件事在磁盘上是明文的：每个 profile 的 `Secure Preferences` 里
 * `extensions.settings` 记着每个扩展的安装路径与 `location`。
 *
 * ## 实测（2026-10-02，本机 Profile 3）
 *
 * ```
 * Profile 3/Secure Preferences → extensions.settings["nlhedoliokpkcodjlgdlhiiohjcbbaap"]
 *   = { path: "D:\\edge-extensions\\<ext dir>", location: 4, from_webstore: false }
 * ```
 * 全机唯一命中（`Default` 里 0 条）。
 *
 * ⚠️ **`Preferences` 里 `extensions.settings` 是空的**（实测 Profile 3：0 条，
 * `Secure Preferences` 里 30 条）。读错文件会得到一个**干净的假阴性** —— 所以
 * 两个文件都读，且永远不要把"没读到"当成"没装"。
 *
 * @module browser-unified-plugin/browser-profiles
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** 插件进程与浏览器所在系统的关系 —— 决定路径形态与怎么启动。 */
export type HostStyle = 'win32' | 'wsl' | 'posix'

/**
 * 一个 Chromium 系品牌在各平台的落点。
 *
 * `userDataDir` 是**模板**：`%LOCALAPPDATA%` / `%APPDATA%` 在 Windows 侧展开，
 * `~` 在 posix 侧展开。Windows 用反斜杠书写（给人读的形态），运行时统一转成
 * 当前进程能访问的形态。
 */
export interface BrowserBrand {
	/** 稳定 id，也用作配置值（如 `edge`）。 */
	readonly id: string
	/** 显示名（给人看，也用于从 UA/hello 反查时的提示）。 */
	readonly label: string
	/** 可执行文件名：Windows 带 `.exe`，macOS 带 `.app`，Linux 给命令名。 */
	readonly exe: { readonly win: string; readonly mac: string; readonly linux: string }
	/**
	 * Windows 上的**安装子目录**，会依次拼在 `%ProgramFiles(x86)%` / `%ProgramFiles%` /
	 * `%LOCALAPPDATA%` 三个根下面找（后一个覆盖"按用户安装"的情况）。
	 * 例：`Microsoft\Edge\Application`。
	 */
	readonly installRelWin: string
	/** macOS 上相对于 `/Applications` 的安装子路径（含 `.app` 内的可执行文件）。 */
	readonly installRelMac: string
	/** Linux 上的可执行名候选（按顺序在 PATH 里找）。 */
	readonly installRelLinux: readonly string[]
	/** 用户数据目录模板（user-data-dir 的父目录）。 */
	readonly userDataDir: { readonly win: string; readonly mac: string; readonly linux: string }
}

/**
 * Chromium 家族登记表。`userDataDir` 各平台差异只是厂商目录名不同，
 * profile 内部结构（`Default` / `Profile N` + `Local State`）**全家族一致**。
 *
 * ⚠️ **出处等级**（2026-10-02 核对；别把没验过的当验过的用）：
 * - **有官方源码出处**：Chrome / Chromium 的三平台 exe、.app、命令名与数据目录
 *   （`chrome_constants.cc`、`chrome_paths_{win,linux}.cc`、`docs/user_data_dir.md`）；
 *   Brave 的 Windows / Linux（brave-core 的 `chromium_src` 与 Windows 单测原文）。
 * - **本机实测**：Edge 的 Windows 安装目录与数据目录（`C:\Program Files (x86)\Microsoft\Edge\
 *   Application\msedge.exe` 存在且能从 WSL 直接执行；`%LOCALAPPDATA%\Microsoft\Edge\User Data`
 *   下确有 `Default` / `Profile 1..3` 与 `Local State`）。
 * - **待核（未找到权威出处，按常见约定写的）**：Edge 的 macOS/Linux、Brave 的 macOS 数据目录、
 *   **Vivaldi 的全部**（只有 Linux snap 的启动器路径有官方出处）、**Opera 的全部**、
 *   **Arc 的全部**。用它们之前先跑一次 `exeCandidates()` / `locateExtensionProfile()`
 *   看命中情况：命中不了会返回空数组和说明性 notes，不会假装成功。
 * - **Opera 结构特殊**：数据目录在 `%APPDATA%`（Roaming）而非 `%LOCALAPPDATA%`，
 *   且"profile"概念与 Chromium 的 `Profile N` 不同 —— 这里只保证能找到它的用户数据目录。
 * - **stable 才符合本表**：canary / beta / dev 通道会改可执行名与数据目录名
 *   （Windows 靠 `install_suffix`、Linux 靠 `$CHROME_VERSION_EXTRA`、macOS 靠 app 包
 *   `Info.plist` 的 `CrProductDirName`）—— 所以**不能只看 app 名推目录名**。
 */
export const BROWSER_BRANDS: readonly BrowserBrand[] = [
	{
		id: 'edge',
		label: 'Microsoft Edge',
		exe: { win: 'msedge.exe', mac: 'Microsoft Edge.app', linux: 'microsoft-edge' },
		installRelWin: 'Microsoft\\Edge\\Application',
		installRelMac: 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
		installRelLinux: ['microsoft-edge', 'microsoft-edge-stable'],
		userDataDir: {
			win: '%LOCALAPPDATA%\\Microsoft\\Edge\\User Data',
			mac: '~/Library/Application Support/Microsoft Edge',
			linux: '~/.config/microsoft-edge',
		},
	},
	{
		id: 'chrome',
		label: 'Google Chrome',
		exe: { win: 'chrome.exe', mac: 'Google Chrome.app', linux: 'google-chrome' },
		installRelWin: 'Google\\Chrome\\Application',
		installRelMac: 'Google Chrome.app/Contents/MacOS/Google Chrome',
		installRelLinux: ['google-chrome', 'google-chrome-stable'],
		userDataDir: {
			win: '%LOCALAPPDATA%\\Google\\Chrome\\User Data',
			mac: '~/Library/Application Support/Google/Chrome',
			linux: '~/.config/google-chrome',
		},
	},
	{
		id: 'brave',
		label: 'Brave',
		exe: { win: 'brave.exe', mac: 'Brave Browser.app', linux: 'brave-browser' },
		installRelWin: 'BraveSoftware\\Brave-Browser\\Application',
		installRelMac: 'Brave Browser.app/Contents/MacOS/Brave Browser',
		installRelLinux: ['brave-browser', 'brave'],
		userDataDir: {
			win: '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\User Data',
			mac: '~/Library/Application Support/BraveSoftware/Brave-Browser',
			linux: '~/.config/BraveSoftware/Brave-Browser',
		},
	},
	{
		id: 'vivaldi',
		label: 'Vivaldi',
		exe: { win: 'vivaldi.exe', mac: 'Vivaldi.app', linux: 'vivaldi' },
		installRelWin: 'Vivaldi\\Application',
		installRelMac: 'Vivaldi.app/Contents/MacOS/Vivaldi',
		installRelLinux: ['vivaldi', 'vivaldi-stable'],
		userDataDir: {
			win: '%LOCALAPPDATA%\\Vivaldi\\User Data',
			mac: '~/Library/Application Support/Vivaldi',
			linux: '~/.config/vivaldi',
		},
	},
	{
		id: 'chromium',
		label: 'Chromium',
		exe: { win: 'chrome.exe', mac: 'Chromium.app', linux: 'chromium' },
		installRelWin: 'Chromium\\Application',
		installRelMac: 'Chromium.app/Contents/MacOS/Chromium',
		installRelLinux: ['chromium', 'chromium-browser'],
		userDataDir: {
			win: '%LOCALAPPDATA%\\Chromium\\User Data',
			mac: '~/Library/Application Support/Chromium',
			linux: '~/.config/chromium',
		},
	},
	{
		id: 'opera',
		label: 'Opera',
		exe: { win: 'opera.exe', mac: 'Opera.app', linux: 'opera' },
		installRelWin: 'Opera',
		installRelMac: 'Opera.app/Contents/MacOS/Opera',
		installRelLinux: ['opera'],
		userDataDir: {
			win: '%APPDATA%\\Opera Software\\Opera Stable',
			mac: '~/Library/Application Support/com.operasoftware.Opera',
			linux: '~/.config/opera',
		},
	},
]

/**
 * Windows 上的安装根，按优先级：先看系统安装（Program Files 两个根），
 * 再看按用户安装（`%LOCALAPPDATA%`）。
 */
const WIN_INSTALL_ROOTS = ['ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA'] as const

/** Linux 上额外找一遍的目录（PATH 之外的常见位置）。 */
const LINUX_INSTALL_DIRS = ['/usr/bin', '/usr/local/bin', '/opt'] as const

/**
 * 找浏览器可执行文件。
 *
 * **不再返回裸名**：非 Windows 上 `spawn('msedge')` 会 ENOENT（WSL 的 PATH 里
 * 根本没有 Edge 目录 —— 实测 `command -v msedge` 为空），而那个 ENOENT 是异步
 * 的，会被 `child.on('error')` 吞掉、函数照旧报"已拉起"⇒ 假成功。所以这里只返回
 * **真实存在**的路径。
 *
 * WSL 下返回 `/mnt/c/...` 形态：它能被 WSL 直接 exec（实测可拉起 Windows Edge），
 * 而参数仍要按 Windows 形态给（见 `locateExtensionProfile().userDataDir`）。
 *
 * @param style - 当前进程与浏览器的关系。
 * @param brandIds - 限定品牌；省略=按登记表顺序找全部。
 * @returns 存在的可执行文件路径（可能为空数组 ⇒ 调用方必须报"找不到"，不许假装成功）。
 */
export function exeCandidates(style: HostStyle, brandIds?: readonly string[]): string[] {
	const out: string[] = []
	const brands =
		brandIds !== undefined && brandIds.length > 0
			? brandIds.map((id) => brandById(id)).filter((b): b is BrowserBrand => b !== undefined)
			: BROWSER_BRANDS
	for (const brand of brands) {
		if (style === 'win32' || style === 'wsl') {
			for (const rootName of WIN_INSTALL_ROOTS) {
				const root = windowsEnv(rootName)
				if (root === undefined || root === '') continue
				const winPath = `${root}\\${brand.installRelWin}\\${brand.exe.win}`
				const local = style === 'wsl' ? toLinuxPath(winPath) : winPath
				if (existsSync(local)) out.push(local)
			}
		} else if (process.platform === 'darwin') {
			const appPath = path.join('/Applications', brand.installRelMac)
			if (existsSync(appPath)) out.push(appPath)
		} else {
			for (const name of brand.installRelLinux) {
				for (const dir of LINUX_INSTALL_DIRS) {
					const candidate = path.join(dir, name)
					if (existsSync(candidate)) out.push(candidate)
				}
			}
			// PATH 兜底：posix 上让 spawn 自己解析（这里只登记名字，不假装已存在）。
			for (const name of brand.installRelLinux) out.push(name)
		}
	}
	return [...new Set(out)]
}

/** 浏览器品牌 id 的查询。 */
export function brandById(id: string): BrowserBrand | undefined {
	const want = id.trim().toLowerCase()
	return BROWSER_BRANDS.find((b) => b.id === want)
}

/**
 * 从 `hello.browser.name` 映射到品牌 id。
 *
 * 扩展现在自己用 UA 正则猜这个值（`/Edg\//` → edge，否则 chrome/chromium），
 * 所以这里只做**宽进**映射：认不出来就返回 undefined，由调用方决定是"扫全部品牌"
 * 还是"要求用户指定"。**不要**在这里猜成 chromium —— 那正是 Firefox 会被误判的地方。
 */
export function brandIdFromHelloName(name: string): string | undefined {
	const n = name.trim().toLowerCase()
	if (n === '' || n === 'unknown') return undefined
	if (n.includes('edge')) return 'edge'
	if (n.includes('brave')) return 'brave'
	if (n.includes('vivaldi')) return 'vivaldi'
	if (n.includes('opera')) return 'opera'
	if (n.includes('chrome')) return 'chrome'
	if (n.includes('chromium')) return 'chromium'
	return undefined
}

/** 当前进程与浏览器的关系。 */
export function hostStyle(): HostStyle {
	if (process.platform === 'win32') return 'win32'
	if (process.platform === 'linux' && isWsl()) return 'wsl'
	return 'posix'
}

/** 是否在 WSL 里（Linux 进程、Windows 浏览器）。 */
export function isWsl(): boolean {
	if (process.platform !== 'linux') return false
	if (process.env['WSL_DISTRO_NAME'] !== undefined) return true
	try {
		return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft')
	} catch {
		return false
	}
}

/** `C:\a\b` → `/mnt/c/a/b`（只在 WSL 上有意义；非 WSL 原样返回）。 */
export function toLinuxPath(winPath: string): string {
	const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath.trim())
	if (m === null) return winPath
	const rest = m[2]!.replace(/\\/g, '/')
	return `/mnt/${m[1]!.toLowerCase()}/${rest}`
}

/** `/mnt/c/a/b` → `C:\a\b`（非 WSL 原样返回）。 */
export function toWindowsPath(linuxPath: string): string {
	const m = /^\/mnt\/([A-Za-z])\/(.*)$/.exec(linuxPath.trim())
	if (m === null) return linuxPath
	return `${m[1]!.toUpperCase()}:\\${m[2]!.replace(/\//g, '\\')}`
}

/**
 * 读一个 Windows 环境变量。WSL 下 `process.env` 里没有 Windows 的
 * `%LOCALAPPDATA%` 之类，所以**问目标系统本身**（`cmd.exe /c echo`），
 * 而不是硬编码 `C:\Users\<谁>\AppData\Local`。
 */
export function windowsEnv(name: string): string | undefined {
	const cached = windowsEnvCache.get(name)
	if (cached !== undefined) return cached === '' ? undefined : cached
	const direct = process.env[name] ?? process.env[name.toUpperCase()]
	if (direct !== undefined && direct !== '') {
		windowsEnvCache.set(name, direct)
		return direct
	}
	if (hostStyle() !== 'wsl') return undefined
	try {
		// 必须换 cwd：WSL 的 cwd 是 UNC（\\wsl.localhost\…），cmd.exe 会打一行
		// "UNC paths are not supported" 到 stderr 并把工作目录退到 Windows 目录。
		// 同时把 stderr 丢掉 —— 这里只关心那一个变量的值。
		const out = execFileSync('cmd.exe', ['/c', `echo %${name}%`], {
			encoding: 'utf8',
			timeout: 5_000,
			cwd: '/mnt/c',
			stdio: ['ignore', 'pipe', 'ignore'],
		})
		const value = out.trim()
		if (value === '' || value === `%${name}%`) {
			windowsEnvCache.set(name, '')
			return undefined
		}
		windowsEnvCache.set(name, value)
		return value
	} catch {
		return undefined
	}
}

/** `windowsEnv` 的进程内缓存：每个品牌根展开都会问一次，不值得反复起 cmd.exe。 */
const windowsEnvCache = new Map<string, string>()

/** 把品牌模板展开成当前进程**能直接访问**的目录（WSL 下是 `/mnt/c/...`）。 */
export function expandUserDataDir(brand: BrowserBrand, style: HostStyle = hostStyle()): string | undefined {
	const template =
		style === 'win32' || style === 'wsl'
			? brand.userDataDir.win
			: process.platform === 'darwin'
				? brand.userDataDir.mac
				: brand.userDataDir.linux
	let out = template
	if (style === 'win32' || style === 'wsl') {
		// 展开 %VAR% 形式；拿不到值的就放弃（不要把未展开的模板当路径用）。
		let unresolved = false
		out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_all, name: string) => {
			const value = windowsEnv(name)
			if (value === undefined) {
				unresolved = true
				return ''
			}
			return value
		})
		if (unresolved) return undefined
		if (style === 'wsl') return toLinuxPath(out)
		return out
	}
	return expandPosixLinuxDir(brand)
}

/**
 * posix（含 WSL 里那半边）的数据目录展开。
 *
 * Linux 不只看 `~/.config`：Chromium 源码的优先级是 `$CHROME_CONFIG_HOME` >
 * `$XDG_CONFIG_HOME` > `~/.config`，而**只有 Chrome / Chromium 认第一个**
 * （Brave 只认 `$XDG_CONFIG_HOME`）。不认这两个变量，用户自定义过 config home
 * 的机器就会定位错。
 */
function expandPosixLinuxDir(brand: BrowserBrand): string | undefined {
	const template = process.platform === 'darwin' ? brand.userDataDir.mac : brand.userDataDir.linux
	let out = template.startsWith('~') ? path.join(homedir(), template.slice(1)) : template
	if (process.platform !== 'linux') return out
	const usesChromeConfigHome = brand.id === 'chrome' || brand.id === 'chromium'
	const override = (usesChromeConfigHome ? process.env['CHROME_CONFIG_HOME'] : undefined) ?? process.env['XDG_CONFIG_HOME']
	const defaultConfigHome = path.join(homedir(), '.config')
	if (override !== undefined && override !== '' && out.startsWith(defaultConfigHome)) {
		out = path.join(override, path.relative(defaultConfigHome, out))
	}
	return out
}

/**
 * 一个品牌**可能**在的所有 user-data-dir（按可信度排序）。
 *
 * WSL 是个双面环境：浏览器通常在 Windows 那一侧（`/mnt/c/…`），但**也可能**在
 * WSL 里装了 Linux 版（`~/.config/…`）。两边都列出来，找不到哪个就不选哪个 ——
 * 只列一个的话，"WSL 里跑 Chrome"这种环境就永远定位不到。
 *
 * @param brand - 品牌。
 * @param style - 当前进程与浏览器的关系。
 * @returns 存在的与不存在的都返回（调用方要能报告"扫过哪些地方"）；去重。
 */
export function userDataDirCandidates(brand: BrowserBrand, style: HostStyle = hostStyle()): string[] {
	const out: string[] = []
	const primary = expandUserDataDir(brand, style)
	if (primary !== undefined) out.push(primary)
	if (style === 'wsl') {
		const linuxSide = expandPosixLinuxDir(brand)
		if (linuxSide !== undefined && !out.includes(linuxSide)) out.push(linuxSide)
	}
	return out
}

/**
 * 把配置里填的 profile 目录拆成 `--user-data-dir` + `--profile-directory`。
 *
 * ⚠️ **不要用 `path.resolve` / `path.basename`**：WSL 下那是 Linux 口径，
 * `C:\Users\x\User Data\Profile 3` 会被当成"不含分隔符的单个文件名"，于是
 * `--user-data-dir` 变成 `/home/wsluser/C:\Users\…`、profile 名回落 `Default`
 * —— 参数全错，浏览器起来却落在别的 profile（实测 2026-10-02 的缺陷③）。
 * 这里自己按两种分隔符拆，并**保留原始形态**（填 Windows 形态就还填 Windows 形态，
 * 因为参数最终是喂给 Windows 版浏览器的）。
 *
 * @param value - 用户填写值，如 `C:\Users\x\…\User Data\Profile 3` 或 `/home/x/.config/…/Default`。
 * @param profileName - `autoLaunchProfileName`：明确指定 profile 目录名时压过推断。
 * @returns `user-data-dir` 与 profile 目录名；`value` 为空返回 undefined。
 */
export function splitProfilePath(value: string, profileName?: string): { userDataDir: string; profileDir: string } | undefined {
	const trimmed = value.trim().replace(/[\\/]+$/, '')
	if (trimmed === '') return undefined
	const lastSep = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
	const tail = lastSep >= 0 ? trimmed.slice(lastSep + 1) : trimmed
	const head = lastSep >= 0 ? trimmed.slice(0, lastSep).replace(/[\\/]+$/, '') : ''
	const explicit = profileName !== undefined && profileName.trim() !== '' ? profileName.trim() : undefined
	if (head !== '' && PROFILE_DIR_PATTERN.test(tail)) {
		return { userDataDir: head, profileDir: explicit ?? tail }
	}
	// 给的是 user-data-dir 本身（没带 profile 名）⇒ 用显式名，或落回 Default。
	return { userDataDir: trimmed, profileDir: explicit ?? 'Default' }
}

/** 一个已定位到的 profile。 */
export interface ProfileLocation {
	readonly brandId: string
	/** 浏览器 `--user-data-dir` 值（**目标系统形态**，可直接喂给浏览器）。 */
	readonly userDataDir: string
	/** 同一个目录，当前进程可访问的形态（读文件用）。 */
	readonly userDataDirLocal: string
	/** 浏览器 `--profile-directory` 值，如 `Profile 3`。 */
	readonly profileDir: string
	/** 显示名，如 `Agent`（给人看/让模型确认用）。 */
	readonly profileName: string | undefined
	/** 该 profile 里记录的本扩展安装路径（Windows 形态，若登记表里有）。 */
	readonly extensionPath: string | undefined
	/** 命中依据：按扩展 id 命中，还是按路径片段命中。 */
	readonly matchedBy: 'extension-id' | 'extension-path'
}

/**
 * 读某个 profile 的**显示名**（`Local State` 的 `profile.info_cache`，如 `Agent`）。
 *
 * 只用于展示与人工确认 —— 浏览器的 `--profile-directory` 要的是目录名（`Profile 3`），
 * 显示名喂进去是错的。查不到就返回 undefined，不要编。
 *
 * @param userDataDirLocal - user-data-dir，当前进程可访问的形态。
 * @param profileDir - profile 目录名。
 */
export function profileDisplayName(userDataDirLocal: string, profileDir: string): string | undefined {
	const parsed = readJson(path.join(userDataDirLocal, 'Local State'))
	const info = (parsed.value?.['profile'] as Record<string, unknown> | undefined)?.['info_cache']
	if (info === null || typeof info !== 'object') return undefined
	const entry = (info as Record<string, unknown>)[profileDir]
	if (entry === null || typeof entry !== 'object') return undefined
	const name = (entry as Record<string, unknown>)['name']
	return typeof name === 'string' && name !== '' ? name : undefined
}

/**
 * 某个 profile 里装了指定扩展吗？
 *
 * 用途：用户显式填了 `autoLaunchProfileDir` 时**校验一下**，而不是盲信 ——
 * 填错的表现是"窗口起来了、扩展就是连不上"，很难查。
 *
 * @param userDataDirLocal - user-data-dir，**当前进程可访问的形态**。
 * @param profileDir - profile 目录名，如 `Profile 3`。
 * @param extensionId - 扩展 id（来自 `hello`）。
 * @returns `true` 装了；`false` **确定**没装；`undefined` 看不出来（目录不存在 / 文件读不动）。
 *   调用方**不许**把 `undefined` 当 `false`，否则会把"读不到"误判成"没装"。
 */
export function profileHasExtension(userDataDirLocal: string, profileDir: string, extensionId: string): boolean | undefined {
	if (extensionId === '' || !existsSync(userDataDirLocal)) return undefined
	const profilePath = path.join(userDataDirLocal, profileDir)
	if (!existsSync(profilePath)) return undefined
	const match = matchInProfile(profilePath, { extensionId })
	if (match.hit !== undefined) return true
	return match.sawSettings ? false : undefined
}

/** 定位结果 + 过程信息（诊断用；失败时要说清扫了哪些地方）。 */
export interface LocateResult {
	readonly location: ProfileLocation | undefined
	/** 扫过的 user-data-dir（本地形态）。 */
	readonly searched: readonly string[]
	/** 扫过的 profile 目录（`<userDataDir>/<profile>`）。 */
	readonly profilesScanned: readonly string[]
	/** 值得报告但不算失败的情况（如某品牌目录不存在、某文件读不动）。 */
	readonly notes: readonly string[]
}

/** profile 目录名的通用规则（Chromium 全家族一致）。 */
const PROFILE_DIR_PATTERN = /^(Default|Profile\s?\d+)$/i

interface LocateOptions {
	/** 指定品牌 id；不给就把所有已知品牌扫一遍（只扫存在的目录）。 */
	readonly brandId?: string
	/** 扩展 id（来自 `hello`）。给了就用它精确命中。 */
	readonly extensionId?: string
	/** 扩展安装目录（Windows 形态或本地形态都行）。`hello` 里还没有 id 时的兜底判据。 */
	readonly extensionPathHint?: string
}

/** 读 JSON；读不动/解析不了返回 undefined（**不算"没有"**，由调用方记 note）。 */
function readJson(file: string): { value?: Record<string, unknown>; error?: string } {
	try {
		return { value: JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> }
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) }
	}
}

/** 路径比较：统一分隔符 + 大小写不敏感（Windows 文件系统口径）。 */
function samePath(a: string, b: string): boolean {
	const norm = (s: string): string => s.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
	return norm(a) === norm(b)
}

/** 列出 `<userDataDir>` 下的 profile 目录名，优先用 `Local State` 的 `info_cache`。 */
function profileDirs(userDataDirLocal: string): { dirs: string[]; names: Map<string, string>; notes: string[] } {
	const notes: string[] = []
	const names = new Map<string, string>()
	const fromInfoCache: string[] = []
	const localState = readJson(path.join(userDataDirLocal, 'Local State'))
	if (localState.value !== undefined) {
		const info = (localState.value['profile'] as Record<string, unknown> | undefined)?.['info_cache']
		if (info !== null && typeof info === 'object') {
			for (const [dir, entry] of Object.entries(info as Record<string, unknown>)) {
				fromInfoCache.push(dir)
				const name = (entry as Record<string, unknown> | undefined)?.['name']
				if (typeof name === 'string' && name !== '') names.set(dir, name)
			}
		}
	} else if (localState.error !== undefined) {
		notes.push(`Local State 读不动（${localState.error}）`)
	}
	let dirs = fromInfoCache
	if (dirs.length === 0) {
		try {
			dirs = readdirSync(userDataDirLocal, { withFileTypes: true })
				.filter((e) => e.isDirectory() && PROFILE_DIR_PATTERN.test(e.name))
				.map((e) => e.name)
			if (dirs.length > 0) notes.push('Local State 里没有 info_cache，改用目录名枚举')
		} catch (error) {
			notes.push(`列目录失败（${error instanceof Error ? error.message : String(error)}）`)
			return { dirs: [], names, notes }
		}
	}
	dirs = dirs.filter((d) => existsSync(path.join(userDataDirLocal, d)))
	return { dirs, names, notes }
}

/**
 * 在一个 profile 里找本扩展。
 *
 * 两个文件都要读，而且**顺序与品牌有关**（2026-10-02 核对到的关键事实）：
 * `extensions.settings` 是 Chromium 的 tracked split pref，落在哪个文件取决于该品牌
 * `kTrackedPrefs` 里的 EnforcementLevel ——
 * 上游 Chromium（以及只 `#include` 上游、没改这张表的 Brave）是 `NO_ENFORCEMENT`
 * ⇒ 落 **`Preferences`**；而 **Edge 实测落 `Secure Preferences`**
 * （本机 Profile 3：`Preferences` 里 `extensions.settings` **0 条**，
 * `Secure Preferences` 里 30 条；`Default` 里是 0 vs 40）。
 * ⇒ 所以这里是"两个都读、Secure 优先"，**不是**按平台二选一；
 * 而且**读不到不等于没装**（读不动/解析失败要返回 `undefined` 语义，由调用方区分）。
 */
function matchInProfile(
	profilePath: string,
	options: LocateOptions,
): { hit?: { key: string; extensionPath: string | undefined }; notes: string[]; sawSettings: boolean } {
	const notes: string[] = []
	let sawSettings = false
	for (const file of ['Secure Preferences', 'Preferences']) {
		const filePath = path.join(profilePath, file)
		if (!existsSync(filePath)) continue
		const parsed = readJson(filePath)
		if (parsed.value === undefined) {
			notes.push(`${file} 解析失败（${parsed.error ?? '未知'}）`)
			continue
		}
		const settings = ((parsed.value['extensions'] as Record<string, unknown> | undefined)?.['settings'] ?? {}) as Record<
			string,
			unknown
		>
		const entries = Object.entries(settings)
		if (entries.length > 0) sawSettings = true
		for (const [id, raw] of entries) {
			const entry = (raw ?? {}) as Record<string, unknown>
			const extPath = typeof entry['path'] === 'string' ? (entry['path'] as string) : undefined
			if (options.extensionId !== undefined && options.extensionId !== '' && id === options.extensionId) {
				return { hit: { key: id, extensionPath: extPath }, notes, sawSettings }
			}
			if (
				options.extensionId === undefined &&
				options.extensionPathHint !== undefined &&
				options.extensionPathHint !== '' &&
				extPath !== undefined &&
				samePath(extPath, options.extensionPathHint)
			) {
				return { hit: { key: id, extensionPath: extPath }, notes, sawSettings }
			}
		}
	}
	return { notes, sawSettings }
}

/**
 * 定位"装了本扩展的那个 profile"。
 *
 * 判据优先级：`extensionId`（精确）> `extensionPathHint`（路径比对）。
 * 两个都没有时**不做任何猜测**，直接返回空结果并说明原因 —— 猜错会把
 * 冷启动打到别的 profile 上，症状是"起了窗口但扩展就是连不上"，很难查。
 *
 * @param options - 品牌（可省，省了就把已知品牌扫一遍）与判据。
 */
export function locateExtensionProfile(options: LocateOptions = {}): LocateResult {
	const style = hostStyle()
	const searched: string[] = []
	const profilesScanned: string[] = []
	const notes: string[] = []

	const hasJudgement =
		(options.extensionId !== undefined && options.extensionId !== '') ||
		(options.extensionPathHint !== undefined && options.extensionPathHint !== '')
	if (!hasJudgement) {
		return {
			location: undefined,
			searched,
			profilesScanned,
			notes: ['没有判据：需要扩展 id（来自 hello）或扩展安装路径；不做猜测'],
		}
	}

	const brands =
		options.brandId !== undefined && options.brandId !== ''
			? [brandById(options.brandId)].filter((b): b is BrowserBrand => b !== undefined)
			: BROWSER_BRANDS
	if (brands.length === 0) {
		return { location: undefined, searched, profilesScanned, notes: [`未知品牌：${options.brandId ?? ''}`] }
	}

	for (const brand of brands) {
		const roots = userDataDirCandidates(brand, style)
		if (roots.length === 0) {
			notes.push(`${brand.id}: 用户数据目录模板无法展开（缺 %LOCALAPPDATA% 之类的环境值）`)
			continue
		}
		// WSL 下这里通常有两个根：Windows 那侧（/mnt/c/…）与 WSL 自己那侧（~/.config/…）。
		for (const local of roots) {
			if (!existsSync(local)) {
				notes.push(`${brand.id}: 目录不存在 ${local}`)
				continue
			}
			searched.push(local)
			const { dirs, names, notes: dirNotes } = profileDirs(local)
			notes.push(...dirNotes.map((n) => `${brand.id}: ${n}`))
			for (const dir of dirs) {
				const profilePath = path.join(local, dir)
				profilesScanned.push(profilePath)
				const match = matchInProfile(profilePath, options)
				notes.push(...match.notes.map((n) => `${brand.id}/${dir}: ${n}`))
				if (match.hit === undefined) {
					if (!match.sawSettings) notes.push(`${brand.id}/${dir}: 两个 Preferences 里都没有 extensions.settings`)
					continue
				}
				// Windows 侧的根要转回 Windows 形态喂给浏览器；WSL 自己那侧的根 `/mnt/...`
				// 匹配不上，`toWindowsPath` 会原样返回 —— 那正是对的（浏览器也是 Linux 的）。
				const userDataDir = style === 'posix' ? local : toWindowsPath(local)
				return {
					location: {
						brandId: brand.id,
						userDataDir,
						userDataDirLocal: local,
						profileDir: dir,
						profileName: names.get(dir),
						extensionPath: match.hit.extensionPath,
						matchedBy: options.extensionId !== undefined && options.extensionId !== '' ? 'extension-id' : 'extension-path',
					},
					searched,
					profilesScanned,
					notes,
				}
			}
		}
	}
	return { location: undefined, searched, profilesScanned, notes }
}
