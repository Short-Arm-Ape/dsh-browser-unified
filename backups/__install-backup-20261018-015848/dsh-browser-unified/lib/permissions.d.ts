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
/** `content_settings.exceptions` 里 setting 的取值（Chromium ContentSetting 枚举）。 */
export declare const CONTENT_SETTING: {
    readonly ALLOW: 1;
    readonly BLOCK: 2;
    readonly ASK: 3;
    readonly SESSION_ONLY: 4;
    readonly DETECT_IMPORTANT_CONTENT: 5;
};
/** 一条例外记录。 */
export interface PermissionException {
    setting: number;
    label: string;
    /** 命中的 pattern 原文（回给模型，便于人核对）。 */
    pattern: string;
    lastModified?: string;
}
/** 一个受关注权限类的现状。 */
export interface PermissionReading {
    pref: string;
    label: string;
    trigger: string;
    /** 该 origin 的显式记录；undefined = 没有任何记录（走浏览器默认）。 */
    exception?: PermissionException;
}
/**
 * 受关注的权限类 —— 只收"会拦人 / 会卡住自动化"的那些，且**键名取自本机 Preferences 的真实枚举**
 * （Edge 154 共 124 个类，这里选 24 个），不做名称猜测：枚举值写死过一次假阴性
 * （`browser-trust fence` 大小写），这里宁可少列也不猜。
 */
export declare const CURATED_CLASSES: ReadonlyArray<{
    pref: string;
    label: string;
    trigger: string;
}>;
/** 读到的权限存储。 */
export interface PermissionStore {
    /** Preferences 文件绝对路径。 */
    file: string;
    /** 文件修改时间（用来判断"这是不是刚刚那份"）。 */
    modifiedAt: Date;
    /** class → pattern → 例外记录。 */
    exceptions: Map<string, Map<string, {
        setting: number;
        lastModified?: string;
    }>>;
    /** 该文件里出现的全部类名（本机 Edge 的权威枚举，124 个）。 */
    classNames: string[];
}
/**
 * 读取一个 profile 的权限存储。
 *
 * `profileDir` 是 **profile 目录**（如 `.../User Data/Profile 3`），不是 `User Data`：
 * Preferences 就在 profile 目录下。传错时抛出带修复指引的错误（这是最常见的配置错法）。
 */
export declare function readPermissionStore(profileDir: string): PermissionStore;
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
export declare function readPermissionStoreTolerant(profileDirs: readonly (string | undefined)[]): {
    store: PermissionStore;
    usedDir: string;
    /** 配置里的原值（形态转换前）。 */
    configuredDir: string;
    /** 命中不是原样命中，而是形态转换后命中。 */
    converted: boolean;
    tried: string[];
};
/**
 * 把 URL 化成匹配用的候选 pattern。
 *
 * Preferences 的键形如 `"https://ti.qianxin.com:443,*"`（`<主pattern>,<次pattern>`，
 * 默认端口会显式写出来），也有裸 `*` 或只有主机名的写法 —— 三种都试，避免"看起来没记录"的假阴性。
 */
export declare function originPatterns(url: string): {
    origin: string;
    candidates: string[];
};
/** 取某个 origin 下所有受关注类的现状。 */
export declare function readOriginPermissions(store: PermissionStore, url: string, filter?: {
    pref?: string;
}): {
    origin: string;
    readings: PermissionReading[];
};
/** Chromium 时间戳（微秒，自 1601-01-01）→ 本地时间字符串。 */
export declare function chromiumTime(value: string | undefined): string;
