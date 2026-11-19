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
/**
 * 「谁来定」——浏览器权限气泡原本只能由人点。de-034 把它拆成显式配置：
 *
 *   - `ask`（默认）：永远交回浏览器/人。**没有任何配置时这就是唯一可能的结果。**
 *   - `policy`：按权限类的策略定（`allow` / `deny` / `inherit`）；`inherit` 仍交回人。
 *   - `model`：模型可以逐次主张（例如为了批量下载要求放行），但策略 `deny` 压过它，
 *     且**敏感类不允许模型自己放行**（见 {@link MODEL_CANNOT_ALLOW}）。
 *
 * 这里只做**纯决策**：执行侧（`chrome.contentSettings` 或 CDP `Browser.setPermission`）
 * 需要给扩展加权限 / 重载扩展 / 真机验证可达性，属于依赖用户动作的那一半，尚未接。
 * @module @deepseek-ai/dsh-browser-bridge/permissions
 */
export type PermissionDecider = 'ask' | 'policy' | 'model';
/** 单个权限类的策略；`inherit` = 没给策略。 */
export type PermissionClassPolicy = 'inherit' | 'allow' | 'deny';
/** 一次决定的结果。`ask` 永远是安全落点：交回浏览器/人。 */
export type PermissionDecision = 'ask' | 'allow' | 'deny';
export declare const PERMISSION_DECIDERS: readonly PermissionDecider[];
/**
 * 这些类**不让模型自己放行**：即使 `decider=model`，模型主张 `allow` 也只降级成 `ask`。
 * 依据 de-034 的 notes：本地网络访问（能摸本机端口与桥）/ 摄像头 / 麦克风 / 定位 / 剪贴板。
 */
export declare const MODEL_CANNOT_ALLOW: ReadonlySet<string>;
/**
 * 把配置里的列表解析成 `pref → 策略`。
 *
 * 用列表而不是嵌套对象：本插件的其它配置项（`allowHosts` / `metadataIps`）都是字符串数组，
 * 设置页也按"每行一条"渲染；非法值一律按 `inherit`（宁可不放行，也不猜）。
 * @param entries - 形如 `automatic_downloads=allow` 的条目；`#` 开头当注释。
 */
export declare function parsePermissionPolicy(entries: readonly string[] | undefined): Record<string, PermissionClassPolicy>;
/**
 * 默认放权（主人 2026-10-22 定）：默认结果只有**允许**或**询问**，没有自动拒绝。
 * 剪贴板与本地网络默认允许；其余类保持询问（交回浏览器/人）。
 *
 * 安全性说明写在这里而不是注释里含糊过去：本地网络访问（LNA）能让第三方站点摸本机端口、
 * 包括这个桥的 9777 —— 默认放行等于接受这一点；真正冻住浏览器仍靠桥的 token 与扩展的硬锁。
 */
export declare const DEFAULT_PERMISSION_POLICY: Readonly<Record<string, PermissionClassPolicy>>;
/** {@link DEFAULT_PERMISSION_POLICY} 的配置条目形态（插件配置的默认值时用）。 */
export declare const DEFAULT_PERMISSION_POLICY_ENTRIES: readonly string[];
export interface PermissionDecideInput {
    /** 配置里的 `permissionDecider`；非法值按 `ask`。 */
    decider: PermissionDecider | string | undefined;
    /** `parsePermissionPolicy()` 的结果，或原始条目列表。 */
    policy?: Record<string, PermissionClassPolicy> | readonly string[] | undefined;
    /** 权限类键名（`CURATED_CLASSES[].pref`）。 */
    pref: string;
    /** `decider=model` 时模型希望的方向；不给 = 模型没有主张。 */
    requested?: 'allow' | 'deny' | undefined;
}
export interface PermissionDecided {
    action: PermissionDecision;
    /** 这个结论是谁定的：用户配置 / 模型主张 / 没人定（默认最保守）。 */
    by: 'configuration' | 'model' | 'none';
    /** 给日志与留痕用的一句话理由。 */
    reason: string;
}
/**
 * 决定一次权限请求该怎么答。
 *
 * 顺序（先命中先返回）：
 *  1. `decider=ask`（含非法值）⇒ `ask` —— 红线：没有显式放权就绝不自作主张；
 *  2. 类策略 `deny` ⇒ `deny`（压过模型主张）；
 *  3. 类策略 `allow` ⇒ `allow`（这是用户配置，不是模型主张）；
 *  4. `decider=policy` 其余 ⇒ `ask`；
 *  5. `decider=model`：模型主张 `allow` 且该类在 {@link MODEL_CANNOT_ALLOW} ⇒ 降级 `ask`；
 *     否则采纳模型主张（`allow` / `deny`），模型没主张 ⇒ `ask`。
 */
export declare function decidePermission(input: PermissionDecideInput): PermissionDecided;
/** 一次自动放行/拒绝的留痕行（执行侧接上后写入；现在只有纯函数与之对应的形状）。 */
export interface PermissionAuditRow {
    at: string;
    origin: string;
    pref: string;
    action: PermissionDecision;
    by: PermissionDecided['by'];
    /** 变化前的 Chromium setting（`CONTENT_SETTING`），无记录则省略。 */
    from?: number;
    /** 变化后的 Chromium setting；`ask` 不写盘，故省略。 */
    to?: number;
    reason: string;
}
/**
 * 造一条留痕行。**自动决定必须可回滚**（de-034 的红线），所以 `from` 一定要带上旧值：
 * 回滚就是把旧值写回去，而不是"再放行一次"。
 */
export declare function permissionAuditRow(input: {
    origin: string;
    pref: string;
    decided: PermissionDecided;
    from?: number;
    at?: string;
}): PermissionAuditRow;
