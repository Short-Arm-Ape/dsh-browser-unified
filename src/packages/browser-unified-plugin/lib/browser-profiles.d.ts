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
/** 插件进程与浏览器所在系统的关系 —— 决定路径形态与怎么启动。 */
export type HostStyle = 'win32' | 'wsl' | 'posix';
/**
 * 一个 Chromium 系品牌在各平台的落点。
 *
 * `userDataDir` 是**模板**：`%LOCALAPPDATA%` / `%APPDATA%` 在 Windows 侧展开，
 * `~` 在 posix 侧展开。Windows 用反斜杠书写（给人读的形态），运行时统一转成
 * 当前进程能访问的形态。
 */
export interface BrowserBrand {
    /** 稳定 id，也用作配置值（如 `edge`）。 */
    readonly id: string;
    /** 显示名（给人看，也用于从 UA/hello 反查时的提示）。 */
    readonly label: string;
    /** 可执行文件名：Windows 带 `.exe`，macOS 带 `.app`，Linux 给命令名。 */
    readonly exe: {
        readonly win: string;
        readonly mac: string;
        readonly linux: string;
    };
    /**
     * Windows 上的**安装子目录**，会依次拼在 `%ProgramFiles(x86)%` / `%ProgramFiles%` /
     * `%LOCALAPPDATA%` 三个根下面找（后一个覆盖"按用户安装"的情况）。
     * 例：`Microsoft\Edge\Application`。
     */
    readonly installRelWin: string;
    /** macOS 上相对于 `/Applications` 的安装子路径（含 `.app` 内的可执行文件）。 */
    readonly installRelMac: string;
    /** Linux 上的可执行名候选（按顺序在 PATH 里找）。 */
    readonly installRelLinux: readonly string[];
    /** 用户数据目录模板（user-data-dir 的父目录）。 */
    readonly userDataDir: {
        readonly win: string;
        readonly mac: string;
        readonly linux: string;
    };
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
export declare const BROWSER_BRANDS: readonly BrowserBrand[];
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
export declare function exeCandidates(style: HostStyle, brandIds?: readonly string[]): string[];
/** 浏览器品牌 id 的查询。 */
export declare function brandById(id: string): BrowserBrand | undefined;
/**
 * 从 `hello.browser.name` 映射到品牌 id。
 *
 * 扩展现在自己用 UA 正则猜这个值（`/Edg\//` → edge，否则 chrome/chromium），
 * 所以这里只做**宽进**映射：认不出来就返回 undefined，由调用方决定是"扫全部品牌"
 * 还是"要求用户指定"。**不要**在这里猜成 chromium —— 那正是 Firefox 会被误判的地方。
 */
export declare function brandIdFromHelloName(name: string): string | undefined;
/** 当前进程与浏览器的关系。 */
export declare function hostStyle(): HostStyle;
/** 是否在 WSL 里（Linux 进程、Windows 浏览器）。 */
export declare function isWsl(): boolean;
/** `C:\a\b` → `/mnt/c/a/b`（只在 WSL 上有意义；非 WSL 原样返回）。 */
export declare function toLinuxPath(winPath: string): string;
/** `/mnt/c/a/b` → `C:\a\b`（非 WSL 原样返回）。 */
export declare function toWindowsPath(linuxPath: string): string;
/**
 * 读一个 Windows 环境变量。WSL 下 `process.env` 里没有 Windows 的
 * `%LOCALAPPDATA%` 之类，所以**问目标系统本身**（`cmd.exe /c echo`），
 * 而不是硬编码 `C:\Users\<谁>\AppData\Local`。
 */
export declare function windowsEnv(name: string): string | undefined;
/** 把品牌模板展开成当前进程**能直接访问**的目录（WSL 下是 `/mnt/c/...`）。 */
export declare function expandUserDataDir(brand: BrowserBrand, style?: HostStyle): string | undefined;
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
export declare function userDataDirCandidates(brand: BrowserBrand, style?: HostStyle): string[];
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
export declare function splitProfilePath(value: string, profileName?: string): {
    userDataDir: string;
    profileDir: string;
} | undefined;
/** 一个已定位到的 profile。 */
export interface ProfileLocation {
    readonly brandId: string;
    /** 浏览器 `--user-data-dir` 值（**目标系统形态**，可直接喂给浏览器）。 */
    readonly userDataDir: string;
    /** 同一个目录，当前进程可访问的形态（读文件用）。 */
    readonly userDataDirLocal: string;
    /** 浏览器 `--profile-directory` 值，如 `Profile 3`。 */
    readonly profileDir: string;
    /** 显示名，如 `Agent`（给人看/让模型确认用）。 */
    readonly profileName: string | undefined;
    /** 该 profile 里记录的本扩展安装路径（Windows 形态，若登记表里有）。 */
    readonly extensionPath: string | undefined;
    /** 命中依据：按扩展 id 命中，还是按路径片段命中。 */
    readonly matchedBy: 'extension-id' | 'extension-path';
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
export declare function profileDisplayName(userDataDirLocal: string, profileDir: string): string | undefined;
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
export declare function profileHasExtension(userDataDirLocal: string, profileDir: string, extensionId: string): boolean | undefined;
/** 定位结果 + 过程信息（诊断用；失败时要说清扫了哪些地方）。 */
export interface LocateResult {
    readonly location: ProfileLocation | undefined;
    /** 扫过的 user-data-dir（本地形态）。 */
    readonly searched: readonly string[];
    /** 扫过的 profile 目录（`<userDataDir>/<profile>`）。 */
    readonly profilesScanned: readonly string[];
    /** 值得报告但不算失败的情况（如某品牌目录不存在、某文件读不动）。 */
    readonly notes: readonly string[];
}
interface LocateOptions {
    /** 指定品牌 id；不给就把所有已知品牌扫一遍（只扫存在的目录）。 */
    readonly brandId?: string;
    /** 扩展 id（来自 `hello`）。给了就用它精确命中。 */
    readonly extensionId?: string;
    /** 扩展安装目录（Windows 形态或本地形态都行）。`hello` 里还没有 id 时的兜底判据。 */
    readonly extensionPathHint?: string;
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
export declare function locateExtensionProfile(options?: LocateOptions): LocateResult;
export {};
