/**
 * offline-diagnosis.ts — 把「扩展没连上」拆成**能被指名的一条原因**。
 *
 * 为什么需要：`extension_offline` 是一个把四件完全不同的事压成一模一样的症状的报错 ——
 * 端口不对 / 令牌不对 / 扩展没装在这个资料页 / 扩展被禁用。用户与模型看到的都是
 * 「浏览器扩展没连上」，于是只能猜；2026-11-15 与 11-16 台机那两次故障就是这样
 * 各花了几十分钟。修法各不相同，所以这里只做一件事：**把证据摆出来并指名**。
 *
 * 设计约束：
 *  1. **纯函数**，不读盘、不联网 —— 证据由调用方收集，这样它能在离线台子上被逐条钉住；
 *  2. **不许把「读不出」当「确定没有」**（`unknown` 与 `absent` 分开）；
 *  3. 证据不足时**不编原因**，只说「拿不到决定性证据」+ 已核过什么 + 四种常见原因。
 *
 * @module offline-diagnosis
 */
const DEFAULT_SCAN = { base: 9777, count: 10 };
/**
 * chromium 的 `RESULT_CODE_PROFILE_IN_USE`（CEF 侧同名常量 `CEF_RESULT_CODE_PROFILE_IN_USE`）＝ 21。
 *
 * 2026-11-19 台机实测：Edge 157 已在跑（用户从开始菜单起的，没带 `--user-data-dir`），
 * 再用 `--user-data-dir=<默认那份>` 拉起，进程 56–75 ms 就退出、**exit 21**；
 * 而同一份代码在临时 `user-data-dir` 上的第二次拉起是 **exit 0**（那才是被合并进已运行实例）。
 * 两件事对用户是同一个症状（窗口没出来、资料页没加载），但**成因相反**：
 * exit 0 是「网址交给了老进程」，exit 21 是「老进程没接，这次启动作废」。
 * 混成一句就会把人支去关浏览器 —— 11-15 那次「唤起了但没用」就是这个坑。
 */
const PROFILE_IN_USE_EXIT_CODE = 21;
function profileLabel(target) {
    return `${target.profileDir}${target.profileName === undefined ? '' : `（${target.profileName}）`}`;
}
/**
 * 按证据给原因。
 *
 * 优先级 = 「越接近根因的越靠前」：占用（别的桥在管）> 握手被拒（扩展来了但被拦）
 * > 端口不在窗口内（扩展拨不到）> 浏览器进程根本没起来 > 扩展不在/被禁
 * > 资料页被别的浏览器进程占着（exit 21）> 启动被合并进已运行实例（exit 0）
 * > 曾经连上过 > 超时。
 * @param evidence - 调用方收集的证据。
 * @returns 诊断结果（`text` 已可直接拼进错误文案）。
 */
export function diagnoseOffline(evidence) {
    const causes = [];
    const scan = evidence.scanWindow ?? DEFAULT_SCAN;
    const target = evidence.target;
    const owner = evidence.otherOwner;
    if (owner !== undefined) {
        causes.push({
            id: 'other-bridge-owns',
            detail: `这个浏览器资料页已经被另一个桥占着：端口 ${owner.port} / pid ${owner.pid}`
                + ` / DSH_HOME ${owner.dshHome || '未知'}${owner.instanceName === undefined ? '' : `（${owner.instanceName}）`}`
                + ` / 起始 ${owner.startedAt}${target === undefined ? '' : ` / 资料页 ${profileLabel(target)}`}`
                + '。要么用那个桥（它已经在服务这个浏览器），要么先把它关掉再让我拉起',
            evidence: [
                `port=${owner.port}`,
                `pid=${owner.pid}`,
                `dshHome=${owner.dshHome}`,
                `startedAt=${owner.startedAt}`,
            ],
        });
    }
    const rejects = evidence.handshakeRejects;
    if (rejects !== undefined && rejects.badToken > 0) {
        causes.push({
            id: 'token-mismatch',
            detail: `扩展**拨过**这个桥，但令牌不一致被 401 拒了 ${rejects.badToken} 次`
                + `${rejects.lastAt === undefined ? '' : `（最近一次 ${rejects.lastAt}）`}`
                + '：把扩展 popup 里的「桥接端口 / Token」改成与桥配置一致',
            evidence: [
                `handshakeRejects.badToken=${rejects.badToken}`,
                ...(rejects.lastAt === undefined ? [] : [`lastAt=${rejects.lastAt}`]),
                ...(evidence.port === undefined ? [] : [`bridgePort=${evidence.port}`]),
            ],
        });
    }
    if (rejects !== undefined && rejects.badHost + rejects.badOrigin > 0) {
        causes.push({
            id: 'handshake-blocked',
            detail: `有连接被 Host / Origin 校验拒了 ${rejects.badHost + rejects.badOrigin} 次`
                + `${rejects.lastReason === undefined ? '' : `（原因 ${rejects.lastReason}）`}`
                + '：拨桥的不是扩展本身（扩展发的是扩展来源、不带网页 Origin）',
            evidence: [
                `handshakeRejects.badHost=${rejects.badHost}`,
                `handshakeRejects.badOrigin=${rejects.badOrigin}`,
            ],
        });
    }
    if (evidence.port !== undefined && (evidence.port < scan.base || evidence.port >= scan.base + scan.count)) {
        causes.push({
            id: 'port-out-of-scan',
            detail: `桥绑在端口 ${evidence.port}，而扩展只会在 ${scan.base}..${scan.base + scan.count - 1} 里找桥：`
                + `到扩展的高级里把「桥接端口」填成 ${evidence.port}，或把桥配置的 port 改回扫描窗口内`,
            evidence: [`boundPort=${evidence.port}`, `scanWindow=${scan.base}..${scan.base + scan.count - 1}`],
        });
    }
    const spawn = evidence.spawn;
    if (spawn !== undefined && spawn.spawnError !== undefined) {
        // 进程从来没起来过：这时候再说"扩展没装/被禁用"是拿一个不存在的浏览器判案，
        // 会把人支去 edge://extensions 白折腾。所以它排在扩展那两条**前面**。
        causes.push({
            id: 'launch-failed',
            detail: `浏览器**没能启动**：${spawn.spawnError}`
                + `${spawn.pid === undefined ? '' : `（pid ${spawn.pid}）`}`
                + '：多半是 autoLaunchBrowserExe / autoLaunchProfileDir 写的路径不对，'
                + '或者那个可执行文件当前用户无权执行。先确认这个路径存在，再让我拉起',
            evidence: [
                `spawnError=${spawn.spawnError}`,
                ...(spawn.pid === undefined ? [] : [`spawnPid=${spawn.pid}`]),
                'spawnState=error',
            ],
        });
    }
    if (evidence.extension === 'absent') {
        causes.push({
            id: 'extension-absent',
            detail: `${target === undefined ? '目标资料页' : `资料页 ${profileLabel(target)}`} 里**没有**这个扩展`
                + `${evidence.extensionId === undefined ? '' : `（${evidence.extensionId}）`}`
                + '：把扩展装进那个资料页（edge://extensions → 加载解压缩的扩展）',
            evidence: ['extension=absent', ...(evidence.extensionId === undefined ? [] : [`extensionId=${evidence.extensionId}`])],
        });
    }
    if (evidence.extension === 'present-disabled') {
        causes.push({
            id: 'extension-disabled',
            detail: `扩展**装了但被禁用**：${target === undefined ? '目标资料页' : `资料页 ${profileLabel(target)}`}`
                + '里它是禁用状态 —— 到 edge://extensions 把「DSH Browser Control」打开，再点一下扩展图标确认变绿',
            evidence: ['extension=present-disabled', ...(evidence.extensionId === undefined ? [] : [`extensionId=${evidence.extensionId}`])],
        });
    }
    // exit 21 = PROFILE_IN_USE：连资料页都没接过就退出了。它必须排在
    // `merged-into-running-instance` 前面 —— 那一条说的是 exit 0「网址已经交给老进程」，
    // 而这里连交都没交成。判据只看「起来过又退出 + exit 21」，不看退出得多快：
    // 用户在别的机器/会话里也可能让这个 user-data-dir 被占着。
    if (spawn !== undefined && spawn.spawnError === undefined && spawn.exitedAt !== undefined
        && spawn.exitCode === PROFILE_IN_USE_EXIT_CODE) {
        const livedMs = spawn.spawnedAt === undefined ? undefined : spawn.exitedAt - spawn.spawnedAt;
        causes.push({
            id: 'profile-in-use',
            detail: `这个资料页被别的浏览器进程占着，**这次启动作废**（exit ${PROFILE_IN_USE_EXIT_CODE} = PROFILE_IN_USE）：`
                + `拉起的进程${spawn.pid === undefined ? '' : ` pid ${spawn.pid}`}`
                + `${livedMs === undefined ? '' : `在 ${livedMs} ms 内就退出了`}，`
                + `${target === undefined ? '目标资料页' : `目标资料页 ${profileLabel(target)}`}没有被加载 —— `
                + '已经有 Edge 在用这个 user-data-dir，新进程连这个资料页都没接过，所以网址也没进去。'
                + '要么让那个已经在跑的 Edge 自己打开这个资料页（手动点一下），'
                + '要么把它的窗口全部关掉，再让我拉起',
            evidence: [
                ...(spawn.pid === undefined ? [] : [`spawnPid=${spawn.pid}`]),
                ...(livedMs === undefined ? [] : [`livedMs=${livedMs}`]),
                `exitCode=${String(spawn.exitCode)}`,
                'profileInUse=21',
                `waitedMs=${spawn.waitedMs}`,
            ],
        });
    }
    if (spawn !== undefined && spawn.spawnError === undefined && spawn.exitedAt !== undefined
        && (spawn.exitCode === 0 || spawn.exitCode === null || spawn.exitCode === undefined)) {
        const livedMs = spawn.spawnedAt === undefined ? undefined : spawn.exitedAt - spawn.spawnedAt;
        causes.push({
            id: 'merged-into-running-instance',
            detail: `启动**被合并进已运行实例**：拉起的进程${spawn.pid === undefined ? '' : ` pid ${spawn.pid}`}`
                + `${livedMs === undefined ? '' : `在 ${livedMs} ms 内就退出了`}（exit ${String(spawn.exitCode)}），`
                + `${target === undefined ? '目标资料页' : `目标资料页 ${profileLabel(target)}`}没有被加载 —— `
                + '这个浏览器已经有进程在跑，新拉起只是把网址丢给那个进程；要它的扩展连上，得让那个进程真的打开这个资料页',
            evidence: [
                ...(spawn.pid === undefined ? [] : [`spawnPid=${spawn.pid}`]),
                ...(livedMs === undefined ? [] : [`livedMs=${livedMs}`]),
                `exitCode=${String(spawn.exitCode)}`,
                `waitedMs=${spawn.waitedMs}`,
            ],
        });
    }
    if (evidence.lastHello !== undefined) {
        causes.push({
            id: 'dropped-after-hello',
            detail: `扩展**曾经连上过**（${evidence.lastHello.version}，${evidence.lastHello.at}）`
                + `${evidence.lastDisconnectAt === undefined ? '' : `，${evidence.lastDisconnectAt} 断开`}`
                + '：多半是浏览器被关、扩展被重载、或那个资料页的窗口没了；让它重新连上即可',
            evidence: [
                `lastHelloVersion=${evidence.lastHello.version}`,
                `lastHelloAt=${evidence.lastHello.at}`,
                ...(evidence.lastDisconnectAt === undefined ? [] : [`lastDisconnectAt=${evidence.lastDisconnectAt}`]),
            ],
        });
    }
    if (spawn !== undefined && spawn.spawnError === undefined) {
        // 进程已经退出时**不许**再说「浏览器起来了」—— 那是 11-15 台机那句误人的话
        // （进程 56 ms 就死了，回执却让人去查端口和令牌）。退出与否决定这句话。
        const exited = spawn.exitedAt !== undefined;
        causes.push({
            id: 'hello-timeout',
            detail: `拉起后等了 ${spawn.waitedMs} ms 没等到 hello`
                + `${spawn.pid === undefined ? '' : `（进程 pid ${spawn.pid} ${exited ? `已退出，exit ${String(spawn.exitCode)}` : '还在跑'}）`}`
                + (exited
                    ? '：**拉起的进程已经退出了**，「浏览器起来了」这一步没成立 —— 先看上面那条原因'
                    : '：浏览器起来了但扩展没连上，按下面的顺序查端口 → 令牌 → 扩展是否装在这个资料页 → 是否被禁用'),
            evidence: [
                `waitedMs=${spawn.waitedMs}`,
                ...(spawn.pid === undefined ? [] : [`spawnPid=${spawn.pid}`]),
                ...(spawn.exitedAt === undefined ? ['spawnState=alive'] : ['spawnState=exited']),
            ],
        });
    }
    if (causes.length === 0) {
        causes.push({
            id: 'never-connected',
            detail: '从没等到 hello，也没有握手被拒的记录：扩展没拨这个桥'
                + `${evidence.port === undefined ? '' : `（桥在 127.0.0.1:${evidence.port}）`}`
                + '。四种常见原因：① 端口不在扩展的扫描窗口内；② 令牌不一致；'
                + '③ 扩展没装在这个资料页；④ 扩展被禁用。'
                + '最快的判据：打开装了扩展的那个浏览器，看扩展图标是不是绿的',
            evidence: [
                ...(evidence.port === undefined ? [] : [`boundPort=${evidence.port}`]),
                `lastHello=none`,
                `handshakeRejects=${rejects === undefined ? 'unknown' : 'none'}`,
            ],
        });
    }
    const primary = causes[0];
    const others = causes.slice(1);
    const parts = [`诊断：${primary.detail}`];
    if (others.length > 0)
        parts.push(`已核（不是主因）：${others.map((cause) => cause.detail).join('；')}`);
    if (evidence.env === 'sandbox')
        parts.push('环境：sandbox —— 沙箱里没有你的登录态与扩展，这里的结论不代表你日常浏览器的结论');
    return {
        primary,
        causes,
        text: parts.join('。'),
    };
}
/**
 * 一句话版本（状态工具/日志用，不带全部证据）。
 * @param evidence - 证据。
 */
export function offlineCauseLine(evidence) {
    const diagnosis = diagnoseOffline(evidence);
    return diagnosis.primary?.detail ?? '拿不到决定性证据';
}
