/**
 * bridge-registry.ts — L1「身份与占用」：这台机器上，某个浏览器 profile 归哪个桥。
 *
 * 解决的问题（2026-11-14 台机「两套桥并行」、2026-11-15「唤起了但没用」）：
 * 桥不知道自己要拉起的那套 profile 是否已经有主，也不知道别的桥正占着同一个浏览器。
 * 以前两个 `dsh web` 对同一个 Edge 各说各话，用户看到的是「两边都像能用、都不对」。
 *
 * **作用域是机器，不是 DSH_HOME**：桌面两个 DSH 实例用两个 DSH_HOME 指向同一个浏览器，
 * 正是要靠这张表互相看见。所以默认落在平台状态目录；理由与取舍见 DESIGN.md §4.1。
 *
 * 三条纪律：
 *  1. **写入时机是「知道是哪个浏览器之后」**（配对学会 / 配置给 / 拉起目标确定），
 *     不是「桥一启动」—— 桥刚起来时它还不知道自己要伺候哪个浏览器。
 *  2. **写失败不影响桥**：这是保护，不是前置条件。调用方只记日志。
 *  3. **只删自己的那条**：`pid` 与 `port` 都对得上才删；别人的记录一律不动。
 *
 * @module bridge-registry
 */
/** 一条占用记录。字段只放「谁占着、占的是哪」——不放 token、不放策略状态。 */
export interface BridgeOwnerRecord {
    readonly schema: 1;
    /** 浏览器 `--user-data-dir`（目标系统形态，原样记录）。 */
    readonly userDataDir: string;
    /** `--profile-directory`（如 `Profile 3`），知道就写。 */
    readonly profileDir?: string;
    /** 桥真正绑定的端口（不是配置端口 —— 端口被占时会回退）。 */
    readonly port: number;
    /** 桥进程 pid。 */
    readonly pid: number;
    /** 该桥所属 DSH 的 home（人用来认领「那是哪个实例」）。 */
    readonly dshHome: string;
    /** 实例短名（`DSH_HOME` 的目录名，如 `dsh-data-assistant`）。 */
    readonly instanceName: string;
    readonly pluginVersion?: string;
    readonly extensionId?: string;
    readonly extensionVersion?: string;
    /** 这条记录第一次写下的时刻（ISO）。 */
    readonly startedAt: string;
    /** 最近一次更新的时刻（ISO）。hello 会刷新它。 */
    readonly updatedAt: string;
}
/** 目录/时钟/平台可注入，便于离线台子上钉住行为。 */
export interface OwnerStoreOptions {
    /** 覆盖状态根（默认见 {@link bridgeStateRoot}）。 */
    readonly stateDir?: string;
    /** 覆盖 `process.env`（读 `DSH_BROWSER_BRIDGE_STATE_DIR` 用）。 */
    readonly env?: NodeJS.ProcessEnv;
    /** 覆盖平台判定（路径大小写与默认根不同）。 */
    readonly platform?: NodeJS.Platform;
    /** 覆盖时钟（测试用）。 */
    readonly now?: () => Date;
}
/**
 * 状态根。
 *
 * 顺序：`DSH_BROWSER_BRIDGE_STATE_DIR` 显式覆盖 → 平台习惯位置。
 * 显式覆盖只给测试与运维用，不进设置页 —— 它一旦被两个实例配成不同值，
 * 这张表就失效了，而失效是**静默**的（各自都觉得自己是主人）。
 * @param options - 可注入的 env/platform。
 * @returns 绝对路径（不保证已存在）。
 */
export declare function bridgeStateRoot(options?: OwnerStoreOptions): string;
/** 记录目录。 */
export declare function bridgesDir(options?: OwnerStoreOptions): string;
/**
 * 规范化 `userDataDir`：分隔符统一、去掉尾部分隔符、Windows 上统一小写。
 *
 * posix 上**不**小写 —— 那里路径本来就区分大小写，统一小写会把两个不同的目录合成一条。
 * @param userDataDir - 原始路径。
 * @param platform - 平台。
 */
export declare function normalizeUserDataDir(userDataDir: string, platform?: NodeJS.Platform): string;
/**
 * 一条 `userDataDir` 对应的记录文件名（不含目录）：哈希前 16 位。
 *
 * 用哈希而不是直接拿路径当文件名：Windows 路径里有 `\`、大小写、长路径问题，
 * 直接拼文件名会被截断或非法；而记录里本来就写着原始路径，人读得到。
 * @param userDataDir - 原始路径。
 * @param platform - 平台。
 * @returns 形如 `8d1f…c2.json`。
 */
export declare function ownerFileName(userDataDir: string, platform?: NodeJS.Platform): string;
/** 一条 `userDataDir` 对应的记录绝对路径。 */
export declare function ownerFilePath(userDataDir: string, options?: OwnerStoreOptions): string;
/**
 * pid 还活着吗。
 *
 * `process.kill(pid, 0)`：`ESRCH` = 没这个进程；`EPERM` = 有但没权限（照样算活着）。
 * 传自己的 pid 时直接返回 true（有的平台对同进程 kill 语义不一致）。
 * @param pid - 目标 pid。
 */
export declare function isProcessAlive(pid: number): boolean;
/** pid 复用/残记录的上限：超过这个年龄的记录不再当作活记录（宁可少拦一次，也不要永远拦着）。 */
export declare const OWNER_RECORD_MAX_AGE_MS: number;
/**
 * 读一条记录。
 *
 * 读不出来（不存在 / 坏 JSON / 旧 schema）时返回 `error` 而不是抛 —— 调用方据此
 * 「当作没有」继续走，同时能在诊断里说清「表里那条读不动」。
 * @param userDataDir - 浏览器 user-data-dir。
 * @param options - 目录/平台注入。
 */
export declare function readOwnerRecord(userDataDir: string, options?: OwnerStoreOptions): {
    record?: BridgeOwnerRecord;
    file: string;
    error?: string;
};
/**
 * 原子写一条记录（临时文件 + rename，不留半截 JSON）。
 *
 * **不会覆盖别人的活记录**（2026-11-18 补）：一个 `userDataDir` 只留一行，因为这张表要
 * 回答的是「这个浏览器归谁」—— 一行才唯一。第二个桥来写时如果发现那行还活着且不是自己，
 * 就不写、把现有那条还回去，让调用方知道「我不是主人」。以前的写法是直接覆盖，结果是
 * 两个桥互相把对方的记录踩掉，谁都说自己是主人 —— 那正是 2026-11-14 故障的形状。
 * @param record - 记录内容。
 * @param options - 目录/平台注入。
 * @returns 写成的绝对路径，以及是否真的写成（`false` 时 `existing` 是占着的那条）。
 */
export declare function writeOwnerRecord(record: BridgeOwnerRecord, options?: OwnerStoreOptions): {
    file: string;
    written: boolean;
    existing?: BridgeOwnerRecord;
};
/**
 * 一条记录是否还「活着」。
 * @param record - 记录。
 * @param now - 当前时刻（注入）。
 */
export declare function isRecordLive(record: BridgeOwnerRecord, now?: Date): boolean;
/**
 * 找这条 `userDataDir` 的活占用者，顺手清掉死记录。
 *
 * `exclude` 用来排除自己：自己刚写的记录不是「别人占着」。
 * @param userDataDir - 浏览器 user-data-dir。
 * @param options - 目录注入 + `exclude`。
 * @returns 活占用者（没有则 undefined）与本次清掉的死记录路径。
 */
export declare function findLiveOwner(userDataDir: string, options?: OwnerStoreOptions & {
    exclude?: {
        pid: number;
        port: number;
    };
}): {
    record?: BridgeOwnerRecord;
    file: string;
    removedDead: readonly string[];
};
/**
 * 删自己那条记录（`pid` + `port` 都对得上才删）。
 * @returns 真删了为 true。
 */
export declare function removeOwnRecord(userDataDir: string, self: {
    pid: number;
    port: number;
}, options?: OwnerStoreOptions): boolean;
/**
 * 列全部记录并清死记录（状态面/诊断用）。
 * @param options - 目录注入。
 */
export declare function listOwnerRecords(options?: OwnerStoreOptions): {
    readonly records: readonly BridgeOwnerRecord[];
    readonly removedDead: readonly string[];
    readonly unreadable: readonly string[];
};
