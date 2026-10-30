/**
 * DSH Browser Control — MV3 service worker.
 *
 * Maintains one outbound WebSocket to the local bridge (bridge/server.mjs),
 * receives JSON commands, executes them through chrome.tabs and the Chrome
 * DevTools Protocol (chrome.debugger), and replies with JSON results.
 *
 * Wire protocol (text frames, one JSON object each):
 *   ext -> bridge: {type:'hello', client, version, browser}
 *                  {type:'pong', t}                     (reply to {type:'ping'})
 *                  {type:'result', id, ok, result|error}
 *   bridge -> ext: {type:'ping', t}
 *                  {type:'command', id, command, params}
 *
 * 端口发现：不再只认一个写死的端口。连接前按 [用户设置端口, 上次命中端口,
 * 9777..9786] 依次用 `GET /api/status` 探测本地桥（该端点带 CORS 头、无需 token），
 * 命中即用之——桥换端口、或候选端口被别的程序占用时，扩展自动跟随。
 */
'use strict';

const EXT_VERSION = chrome.runtime.getManifest().version;
const HEARTBEAT_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_PORT = 9777;
/**
 * 帧契约版本（与本扩展的 manifest 版本**无关**）：桥那边用它判断"两边说的是不是同一种帧"。
 * 来源：上游 v1.0.9 的口径（core 0.1.5 起我们的桥也会协商它）。缺失时旧桥按 v1 兼容处理。
 */
const PROTOCOL_VERSION = 1;
const DEFAULT_TOKEN = 'dsh-local';
/** 端口发现：在 [DEFAULT_PORT, DEFAULT_PORT+PORT_SCAN_COUNT) 里找桥。 */
const PORT_SCAN_BASE = DEFAULT_PORT;
const PORT_SCAN_COUNT = 10;
/** 单个候选端口的探测超时；10 个候选最坏 ~4s，之后交给退避重连。 */
const PROBE_TIMEOUT_MS = 400;

/** Stored config shape (version 4): {port, token, autoConnect, lastKnownPort, dialogPolicy}. */
const DEFAULT_CONFIG = Object.freeze({
	port: DEFAULT_PORT,
	token: DEFAULT_TOKEN,
	autoConnect: true,
	/** 上一次探测命中的端口（由扩展自己维护，用户不必手填）。 */
	lastKnownPort: null,
	/** JS 对话框（alert/confirm/prompt）的默认处理：accept=自动确定、dismiss=自动取消、manual=不处理。
	 *  这是**用户偏好**，持久化在 chrome.storage.local；运行时可用 `dialog` 命令临时覆盖。 */
	dialogPolicy: 'accept',
});

let cfg = { ...DEFAULT_CONFIG };
let ws = null;
let wsState = 'idle'; // idle | connecting | open
let backoffAttempt = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
let helloInfo = null;
let lastError = null;
/** 本次 service worker 生命周期内探测到的桥端口；连接断开后失效以便重新探测。 */
let discoveredPort = null;
/** 探测过程的可读说明（popup 展示：扫了哪些候选、命中哪个、为什么没命中）。 */
let lastProbeNote = null;
/** 防止心跳/alarm/消息并发触发多次端口扫描。 */
let connectInFlight = false;
/** True after the user clicks 断开连接 in the popup; blocks auto-reconnect
 *  until they click 立即连接 again. Reset on browser restart. */
let manualDisconnect = false;

/** Tab ids we hold a persistent debugger attachment on. Detach only on
 *  explicit disconnect, tab close, or DevTools stealing the tab. */
const attachedTabs = new Set();

/** Per-tab ring buffer of CDP `Runtime.consoleAPICalled` entries since attach.
 *  Map<tabId, Array<entry>>. Entries are capped at 500 per tab; older entries
 *  shift off. A new attach bumps the tab's generation so stale entries queued
 *  before re-attach are not surfaced as if they were current. */
const consoleLog = new Map();
/** Bumped on every re-attach so entries recorded against an old generation are
 *  dropped. Map<tabId, number>. */
const tabBufferGenerations = new Map();
/** Per-tab in-flight network entries keyed by `Network.requestId`; merged
 *  across `requestWillBeSent` / `responseReceived` / `loadingFinished` /
 *  `loadingFailed`. Map<tabId, Map<requestId, entry>>. */
const networkLog = new Map();

/**
 * Native dialog (alert/confirm/prompt) auto-answer policy. 'accept' answers
 * every dialog as OK (prompt uses defaultText), 'dismiss' cancels, 'manual'
 * leaves dialogs open. A command can pass params.dialogPolicy to override for
 * that call's duration; the default is accept so automation never deadlocks.
 */
let dialogPolicy = 'accept';
/** Dialogs answered since attach, surfaced in results for verification. */
const dialogLog = [];

/* ------------------------------------------------------------------ config */

async function loadConfig() {
	const stored = await chrome.storage.local.get(Object.keys(DEFAULT_CONFIG));
	// v1→v2 migration: convert old serverUrl to port.
	if (stored.serverUrl && stored.port === undefined) {
		try {
			stored.port = new URL(stored.serverUrl).port ? Number(new URL(stored.serverUrl).port) : DEFAULT_PORT;
		} catch { stored.port = DEFAULT_PORT; }
		delete stored.serverUrl;
	}
	cfg = { ...DEFAULT_CONFIG, ...stored };
	// v3→v4: 对话框默认行为持久化在 storage 里，启动时套用（运行时可被 dialog 命令临时覆盖）。
	applyDialogPolicy(cfg.dialogPolicy);
}

/** 套用一档对话框策略（非法值忽略）；返回实际生效的值。 */
function applyDialogPolicy(value) {
	if (value === 'accept' || value === 'dismiss' || value === 'manual') dialogPolicy = value;
	return dialogPolicy;
}

chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== 'local') return;
	for (const [key, change] of Object.entries(changes)) {
		if (key in DEFAULT_CONFIG) cfg[key] = change.newValue;
		if (key === 'dialogPolicy') applyDialogPolicy(change.newValue);
	}
});

/* ------------------------------------------------------------ ws lifecycle */

function setBadge(text, color) {
	try {
		chrome.action.setBadgeBackgroundColor({ color });
		chrome.action.setBadgeText({ text });
	} catch (err) {
		console.warn('[dsh-bridge] badge unavailable:', err.message);
	}
}

function setState(state) {
	wsState = state;
	if (state === 'open') setBadge('ON', '#16a34a');
	else if (state === 'connecting') setBadge('…', '#d97706');
	else setBadge('OFF', '#6b7280');
}

function send(obj) {
	if (!ws || ws.readyState !== WebSocket.OPEN) return false;
	ws.send(JSON.stringify(obj));
	return true;
}

function scheduleReconnect() {
	if (manualDisconnect || !cfg.autoConnect) return;
	const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** backoffAttempt);
	backoffAttempt += 1;
	clearTimeout(reconnectTimer);
	reconnectTimer = setTimeout(connect, delay);
}

/* --------------------------------------------------------- port discovery */

/**
 * 候选端口顺序：用户设置的端口 → 上次命中的端口 → 9777..9786。
 * 去重并过滤非法值；顺序即优先级。
 */
function portCandidates() {
	const out = [];
	const push = (port) => {
		const n = Number(port);
		if (!Number.isInteger(n) || n < 1024 || n > 65535) return;
		if (!out.includes(n)) out.push(n);
	};
	push(cfg.port);
	push(cfg.lastKnownPort);
	for (let i = 0; i < PORT_SCAN_COUNT; i += 1) push(PORT_SCAN_BASE + i);
	return out;
}

/**
 * 探测一个端口上是不是 DSH 桥：`GET /api/status`（该端点自带 CORS 头、不需要 token，
 * 所以能区分“没有桥”和“token 不对”——后者会走到 WS 握手才失败）。
 * @returns {Promise<{port:number, extensionConnected:boolean}|null>}
 */
async function probeBridge(port) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
			signal: controller.signal,
			cache: 'no-store',
		});
		if (!res.ok) return null;
		const body = await res.json();
		if (body && body.ok === true && typeof body.port === 'number'
			&& typeof body.wsUrl === 'string' && body.wsUrl.includes('/ws')
			&& 'extensionConnected' in body) {
			return { port, extensionConnected: body.extensionConnected === true };
		}
		return null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 依次探测候选端口，命中即记住（并持久化为 lastKnownPort，供下次优先尝试）。
 * @returns {Promise<number|null>} 命中的端口，全部未命中则 null。
 */
async function discoverBridge() {
	const candidates = portCandidates();
	const tried = [];
	for (const port of candidates) {
		const hit = await probeBridge(port);
		tried.push(hit ? `${port}✓` : `${port}✗`);
		if (hit) {
			discoveredPort = port;
			lastProbeNote = `扫描 ${candidates[0]} 起：命中 ${port}（第 ${tried.length} 个候选；${tried.join(' ')}）`;
			if (cfg.lastKnownPort !== port) {
				cfg.lastKnownPort = port;
				try { await chrome.storage.local.set({ lastKnownPort: port }); } catch { /* 存储失败不影响本次连接 */ }
			}
			return port;
		}
	}
	discoveredPort = null;
	lastProbeNote = `扫描 ${candidates.length} 个候选全部未命中：${tried.join(' ')}（桥可能未启用，或 dsh 侧端口不在此范围内）`;
	return null;
}

async function connect() {
	if (wsState === 'open' || wsState === 'connecting') return;
	clearTimeout(reconnectTimer);
	if (manualDisconnect || !cfg.autoConnect) return;
	if (connectInFlight) return;

	connectInFlight = true;
	setState('connecting');
	let port = discoveredPort;
	try {
		if (port === null) port = await discoverBridge();
	} finally {
		connectInFlight = false;
	}
	if (port === null) {
		lastError = lastProbeNote ?? '未找到本地桥';
		setState('idle');
		scheduleReconnect();
		return;
	}

	let url;
	try {
		url = new URL(`ws://127.0.0.1:${port}/ws`);
	} catch (err) {
		lastError = `端口无法解析: ${err.message}`;
		setState('idle');
		return;
	}
	url.searchParams.set('token', cfg.token);

	let sock;
	try {
		sock = new WebSocket(url.toString());
	} catch (err) {
		lastError = err.message;
		setState('idle');
		scheduleReconnect();
		return;
	}
	ws = sock;

	sock.onopen = () => {
		if (sock !== ws) return;
		backoffAttempt = 0;
		lastError = null;
		setState('open');
		startHeartbeat();
		sendHello();
	};
	sock.onmessage = (ev) => {
		if (sock !== ws || typeof ev.data !== 'string') return;
		let msg;
		try { msg = JSON.parse(ev.data); } catch { return; }
		handleBridgeMessage(msg);
	};
	sock.onclose = () => {
		if (sock !== ws) return;
		stopHeartbeat();
		ws = null;
		// 桥可能换了端口：下一次重连重新探测（lastKnownPort 仍会优先尝试）。
		discoveredPort = null;
		setState('idle');
		scheduleReconnect();
	};
	sock.onerror = () => { /* onclose always follows */ };
}

function disconnectNow() {
	clearTimeout(reconnectTimer);
	stopHeartbeat();
	if (ws) {
		const sock = ws;
		ws = null;
		sock.onclose = null;
		try { sock.close(); } catch { /* ignore */ }
	}
	detachAll();
	setState('idle');
}

function startHeartbeat() {
	stopHeartbeat();
	heartbeatTimer = setInterval(() => send({ type: 'ping', t: Date.now() }), HEARTBEAT_MS);
}

function stopHeartbeat() {
	if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function sendHello() {
	const ua = navigator.userAgent;
	const name = /Edg\//.test(ua) ? 'edge' : /Chrome\//.test(ua) ? 'chrome' : 'chromium';
	const versionMatch = ua.match(/(?:Edg|Chrome)\/([\d.]+)/);
	helloInfo = { name, version: versionMatch ? versionMatch[1] : 'unknown', ua };
	// extensionId 是桥唯一能拿到的稳定身份：浏览器侧没有"我在哪个 profile"的接口，
	// 也读不了 edge://version（scheme 被拦）。桥拿这个 id 去磁盘反查 profile。
	send({ type: 'hello', client: 'dsh-browser-extension', version: EXT_VERSION, protocol: PROTOCOL_VERSION, browser: helloInfo, extensionId: chrome.runtime.id });
}

/* Alarm keeps the SW alive for reconnect even without user events. */
try { chrome.alarms.create('keepalive', { periodInMinutes: 0.5 }); }
catch { chrome.alarms.create('keepalive', { periodInMinutes: 1 }); }
chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name !== 'keepalive') return;
	if (wsState === 'idle') connect();
	else send({ type: 'ping', t: Date.now() });
});

/* ------------------------------------------------------------- dispatching */

function handleBridgeMessage(msg) {
	if (msg.type === 'ping') { send({ type: 'pong', t: msg.t }); return; }
	if (msg.type === 'command' && typeof msg.id === 'string') {
		runCommand(msg.command, msg.params ?? {})
			.then((result) => send({ type: 'result', id: msg.id, ok: true, result }))
			.catch((err) => send({ type: 'result', id: msg.id, ok: false, error: String((err && err.message) || err) }));
	}
}

async function runCommand(command, params) {
	await ensureHardLock();
	await ensureHoldState();
	await ensureRefState();
	const handler = COMMANDS[command];
	if (!handler) throw new Error(`unknown command: ${command}`);
	// 硬锁：扩展照常连着，但除了身份/状态查询之外一律拒绝 —— 解锁只能由用户在扩展图标里做。
	if (hardLocked && !HARD_LOCK_ALLOWED.has(command)) {
		throw new Error('浏览器扩展已被用户在本地锁定，拒绝一切操作。请在浏览器右上角的扩展图标里解除锁定后再试。');
	}
	// 反向也不许：桥（＝模型侧）永远不能**解锁**，否则这把锁对跑偏的模型毫无意义。
	// 加锁方向放行（fail-safe：模型把自己锁上也只会更安全）。
	if (command === 'lock.set' && (params === null || typeof params !== 'object' || params.locked !== true)) {
		throw new Error('解锁只能在浏览器右上角的扩展图标里做；桥侧只能加锁。');
	}
	const autoHoldTab = HOLD_AUTO_COMMANDS.has(command) ? await maybeAutoHold(params) : undefined;
	const result = await handler(params);
	if (autoHoldTab !== undefined) await suppressAutoHoldIfTaken(autoHoldTab);
	return result;
}

/* ------------------------------------------------------------ tab helpers */

/**
 * 浏览器里**有没有窗口**。
 *
 * 为什么要单独判：Edge 关掉所有窗口后仍会在后台驻留（启动增强 / 后台扩展），
 * 此时扩展照样连着桥、`hello` 也正常，但 `chrome.tabs.query({})` 返回空 ⇒ 所有
 * "操作当前标签页"类命令全部失败（历史上表现为宿主报 `No current window` 或
 * `chrome_tabs_list` 回 0 个标签页）。**进程活着 ≠ 有可操作的窗口**。
 */
async function windowCount() {
	try {
		const wins = await chrome.windows.getAll({});
		return Array.isArray(wins) ? wins.length : 0;
	} catch {
		return 0;
	}
}

/**
 * 确保有一个可操作的窗口：没有窗口就新建一个（about:blank）。
 * 这是"唤起"的正确含义。仅在**确实没有任何窗口**时才新建，绝不干扰已有窗口。
 * @param reason 触发来源，写进 SW 日志便于回溯。
 * @returns 新建/复用的标签页，以及是否发生了新建。
 */
/**
 * 保证"至少有一个窗口"。已有窗口不动。
 * @param reason 日志用（谁要求的）
 * @param landingUrl 可选：新建窗口时直接落的网址（不传则 about:blank）
 */
async function ensureWindow(reason, landingUrl) {
	try {
		const existing = await chrome.tabs.query({});
		if (existing.length > 0) {
			return { created: false, tab: existing.find((t) => t.active) || existing[0] };
		}
	} catch { /* query 本身在无窗口时也可能抛，落到下面新建 */ }
	const win = await chrome.windows.create({ url: landingUrl === undefined ? 'about:blank' : landingUrl, focused: true });
	let tab = Array.isArray(win.tabs) ? win.tabs[0] : undefined;
	if (tab === undefined && win.id !== undefined) {
		const inWin = await chrome.tabs.query({ windowId: win.id });
		tab = inWin[0];
	}
	console.log(`[dsh-bridge] ensureWindow(${reason}): 之前没有任何窗口，已新建 windowId=${win.id} tabId=${tab && tab.id} url=${landingUrl ?? 'about:blank'}`);
	return { created: true, tab };
}

/**
 * 找一个可操作的标签页。
 * @param tabId 指定则直接用（不存在会抛）。
 * @param landingUrl 可选：**没有任何窗口**需要临时新建时，窗口直接落在这个网址上
 *                   （不传则 about:blank —— 2026-10-10 bi-022：调用方知道目标网址就该带上）。
 */
async function resolveTab(tabId, landingUrl) {
	if (tabId !== undefined && tabId !== null) {
		const tab = await chrome.tabs.get(tabId);
		return tab;
	}
	let focused;
	try {
		[focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
	} catch { focused = undefined; }
	if (focused) return focused;
	const all = await chrome.tabs.query({});
	if (all.length > 0) return all[0];
	// 没有任何窗口：按需唤起一个，而不是直接报错（否则关掉 Edge 窗口后整个桥就废了）。
	const { tab } = await ensureWindow('resolveTab', landingUrl);
	if (tab) return tab;
	throw new Error('no tab available，且新建窗口失败（浏览器可能不允许后台创建窗口）');
}

/**
 * 等一次**新导航**加载完成。**必须在触发导航之前调用**（先把轮询挂上），
 * 因为旧实现先 `tabs.get()` 判 `status === 'complete'` —— 那个"complete"还是
 * **导航前的旧文档**，于是 `nav` 会立刻返回旧页面（2026-10-10 真机复现：
 * navigate 秒回 `about:blank`，12 秒后标签页才落到 `chrome-error://`）。
 *
 * 判据：只有**观察到 `status === 'loading'` 之后再 complete** 才算新页面加载完；
 * 极快页面（缓存/about:blank）可能不产生可观测的 loading 事件，给 1.2s 观察窗口后按完成处理。
 * @returns true=新页面已加载完成；false=超时（仍在加载 —— 调用方应如实报 loadPending）
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 跨 realm 抛来的 Error（`instanceof Error` 为假）也要认出它的 message。 */
function failureText(error) {
	if (error instanceof Error) return error.message;
	if (error !== null && typeof error === 'object' && 'message' in error) return String(error.message);
	return String(error);
}

/** 比较目的地与真正落到的地址：忽略 hash 片段与末尾斜杠这类同文档差异。 */
function landsAt(tabUrl, expectedUrl) {
	if (typeof expectedUrl !== 'string' || expectedUrl.length === 0) return true;
	const norm = (u) => String(u ?? '').replace(/#.*$/, '').replace(/\/$/, '');
	return norm(tabUrl) === norm(expectedUrl);
}

/**
 * 等 `promise`，但**不会超过 `ms`**；超时或拒绝都回 `fallback`。
 *
 * 为什么必须有它：CDP 在文档"卡在 commit 之前"时**根本不回** `Runtime.evaluate`，
 * 于是导航后的那些探针能把整条命令拖过调用方的预算（上游实测：15s 的等待预算下，
 * 无预算的探针让 `nav` 40 多秒没回答；本仓库 2026-10-13 在 rig 上用 `/hang` 复现了同一现象 —— bi-036）。
 */
function withBudget(promise, ms, fallback) {
	return Promise.race([
		promise.catch(() => fallback),
		new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
	]);
}

/**
 * 归一导航等待口径。`none` = 不等待；`commit` = 地址落地即回；
 * `domcontentloaded`（默认）= DOM 可用即回；`load` = 老行为（等 `load`）。
 * 认不出的值按默认口径处理 —— 模型写错不该让导航变慢或报错。
 */
function navWaitMode(value) {
	const text = String(value ?? '').toLowerCase();
	if (text === 'none' || text === 'commit' || text === 'load' || text === 'domcontentloaded') return text;
	return 'domcontentloaded';
}

/**
 * 各等待口径的**默认预算**：`load` 仍 15s（它本来就可能慢）；其余口径 4s ——
 * 目标是黑洞时至少要等一次超时，把默认值压低，模型就不会被 15 秒干等（2026-10-23 真机量到：不可达目标等满 15s）。
 */
const NAV_DEFAULT_BUDGET = { none: 0, commit: 4_000, domcontentloaded: 4_000, load: 15_000 };

/**
 * 正在等待"新文档到达"的标签页。判据只认两件事：CDP 的 `Page.frameNavigated`（主框架）
 * 或标签页地址与请求一致 —— 不靠"地址变了"这种启发式：
 * 同站重定向/刷新会回到同一个地址（2026-10-23 真机：bing.com→cn.bing.com 往返，等满预算）。
 */
const navArrivals = new Map();

/** 本次等待该用多少预算（显式 timeoutMs 优先）。 */
function navBudget(waitUntil, timeoutMs) {
	const mode = navWaitMode(waitUntil);
	const explicit = Number(timeoutMs);
	if (Number.isFinite(explicit) && explicit > 0) return explicit;
	return NAV_DEFAULT_BUDGET[mode];
}

function waitForNavigationComplete(tabId, timeoutMs, expectedUrl, waitUntil, previousUrl) {
	const mode = navWaitMode(waitUntil);
	if (mode === 'none') return Promise.resolve(true);
	const started = Date.now();
	return new Promise((resolve) => {
		let sawLoading = false;
		/** 主框架发生过一次提交（CDP 事件给出真实到达地址）。 */
		let arrivedUrl = null;
		const waiter = { arrive: (url) => { arrivedUrl = url; } };
		navArrivals.set(tabId, waiter);
		const finish = (value) => {
			if (navArrivals.get(tabId) === waiter) navArrivals.delete(tabId);
			resolve(value);
		};
		/** `commit` 读到地址落地；`domcontentloaded` 再等一次 readyState。 */
		const tick = async () => {
			const tab = await chrome.tabs.get(tabId).catch(() => null);
			// 到达判据：CDP 的 frameNavigated（最准）或地址与请求一致。
			// 不再用"地址变了"这种启发式 —— 同站重定向/刷新会回到同一个地址，那样会等满预算。
			const landed = arrivedUrl !== null
				|| (tab !== null && tab !== undefined && landsAt(tab.url, expectedUrl));
			if (tab !== null && tab !== undefined) {
				if (tab.status === 'loading') sawLoading = true;
			}
			if (mode === 'commit') {
				// 新文档一开始替换旧文档就回（页面可能还在加载，交给调用方决定是否细等）
				if (landed) return finish(true);
			} else if (mode === 'domcontentloaded') {
				// DOM 可用 = readyState 不是 loading。用 CDP 读，因为 `tabs.status` 只在 load 完成时才变 complete。
				if (landed) {
					const state = await withBudget(withCDP(tabId, (send) => send('Runtime.evaluate', {
						expression: 'String(document.readyState)',
						awaitPromise: false, returnByValue: true,
					}).then((r) => String(r.result?.value ?? ''))), 800, null);
					if (state === 'interactive' || state === 'complete') return finish(true);
				}
			} else {
				// load：老逻辑（见过 loading 之后的 complete 才算新页面加载完）
				if (tab !== null && tab !== undefined && tab.status === 'complete') {
					if (sawLoading || arrivedUrl !== null) return finish(true);
					if (Date.now() - started > 1200) return finish(landsAt(tab.url, expectedUrl));
				}
			}
			if (Date.now() - started >= timeoutMs) return finish(false);
			setTimeout(tick, 120);
		};
		// 必须先把 debugger 挂上，否则收不到 Page.frameNavigated（拿不到"到达"信号）
		void ensureAttached(tabId).catch(() => {}).then(() => { void tick(); });
	});
}

/** Bring the tab and its window forward so real input can land, WITHOUT
 *  touching window geometry: `focused` only raises the window; tab activation
 *  never moves or resizes anything. The user's window size/position/state
 *  (maximized included) is never modified. A minimized window keeps its 0x0
 *  viewport where real input cannot land — report that instead of
 *  force-restoring it (state:'normal' would also un-maximize the window). */
async function activateTabWindow(tabId) {
	let win;
	try {
		const tab = await chrome.tabs.get(tabId);
		win = await chrome.windows.get(tab.windowId);
	} catch {
		return { windowState: 'unknown' }; // tab/window closing; the command reports it downstream
	}
	/** @type {{windowState: string, minimized: boolean, restored: boolean, windowId?: number}} */
	const status = { windowState: String(win.state || 'normal'), minimized: win.state === 'minimized', restored: false, windowId: win.id };
	if (status.minimized && focusRestoreMinimized) {
		// 用户显式允许：把窗口恢复出来（不抢焦点 —— restore 与 focus 是两件事）。
		try {
			await chrome.windows.update(win.id, { state: 'normal' });
			status.minimized = false;
			status.windowState = 'normal';
			status.restored = true;
		} catch { /* 恢复失败就继续按最小化处理 */ }
	}
	// auto（默认）：只切标签页，**不**把窗口提到前台 —— 抢焦点是误触来源；
	// always：老行为；never：连激活都不做（后台标签页操作，键盘类可能到不了）。
	if (focusMode !== 'never') {
		try {
			await chrome.tabs.update(tabId, { active: true });
			if (focusMode === 'always' && !status.minimized) await chrome.windows.update(win.id, { focused: true });
		} catch { /* tab may be closing; input will fail downstream anyway */ }
	}
	return status;
}

/**
 * 读当前视口尺寸，并和上一次比较。
 *
 * 为什么要它：窗口被改过大小/最小化过之后，模型手里的坐标与 ref 都可能过期；
 * 与其让它盲目重试，不如每次输入类命令都如实告诉它"视口变了"。
 * 最小化时**不预设** 0×0 —— 渲染器通常保留最后的布局尺寸，CDP 注入的事件照样进得去，
 * 真正能不能落点由下面的命中测试决定，而不是由窗口状态猜。
 */
async function viewportInfo(tabId, send) {
	const raw = await send('Runtime.evaluate', {
		expression: 'JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })',
		awaitPromise: false, returnByValue: true,
	}).then((res) => (res && res.result ? String(res.result.value ?? '') : '')).catch(() => '');
	let size = { w: 0, h: 0, dpr: 1 };
	try { size = Object.assign(size, JSON.parse(raw || '{}')) } catch { /* 页面给不出就按 0 处理 */ }
	const stamp = `${size.w}x${size.h}@${size.dpr}`;
	const previous = lastViewport.get(tabId);
	lastViewport.set(tabId, stamp);
	return {
		size: { w: Number(size.w) || 0, h: Number(size.h) || 0, dpr: Number(size.dpr) || 1 },
		...(previous === undefined || previous === stamp ? {} : { changed: true, previous }),
	};
}

/**
 * 输入类命令的前置闸：只有**最小化且视口确实为 0**时才拒，并给出可操作的三条出路。
 * 其余情况放行 —— 最小化不该等于"不能干活"。
 */
/**
 * 读页面的**几何**（不只是可见性）。
 *
 * 2026-10-24 真机对照：遮挡、失焦、最小化三种状态 CDP 输入都照样送达；
 * 唯一会静默丢弃的状态是窗口 `outerWidth/outerHeight = 0`（窗口对象存在但从未显示出来）。
 * 所以判据用几何，不用 `visibilityState`。
 */
async function geometryInfo(tabId, send) {
	const raw = await send('Runtime.evaluate', {
		expression: 'JSON.stringify({ ow: outerWidth, oh: outerHeight, vis: document.visibilityState })',
		awaitPromise: false, returnByValue: true,
	}).then((res) => (res && res.result ? String(res.result.value ?? '') : '')).catch(() => '');
	// 页面给不出答案（不是 JSON）时**不猜**"没显示"：探针失败不等于窗口没显示，
	// 误判会把能用的点击全拒掉。只有拿到明确的 JSON 才按几何判定。
	if (raw === '') return null;
	let g;
	try { g = JSON.parse(raw) } catch { return null }
	return { outerW: Number(g.ow) || 0, outerH: Number(g.oh) || 0, visibility: String(g.vis || 'unknown') };
}

/**
 * 输入类命令的前置闸。
 *
 * - 窗口有几何（可见/失焦/遮挡/最小化都算）⇒ 放行，**不抢焦点**；
 * - 窗口几何为 0×0（建了但没显示）⇒ 先让窗口落位（`focused:true`，不动最大化状态）再探一次；
 *   仍为 0 就抛 `browser-window-not-shown:`，`effectState=not_started` —— 绝不回报"点成功"。
 */
async function inputSurface(tabId, send, activation, action) {
	let geometry = await geometryInfo(tabId, send);
	let materialized = false;
	const notShown = () => geometry !== null && (geometry.outerW <= 0 || geometry.outerH <= 0);
	if (notShown() && focusMode !== 'never' && activation && typeof activation.windowId === 'number') {
		try {
			await chrome.windows.update(activation.windowId, { focused: true });
			materialized = true;
		} catch { /* 落位失败就按未显示处理 */ }
		await new Promise((r) => setTimeout(r, 400));
		geometry = await geometryInfo(tabId, send);
	}
	if (notShown()) {
		const err = new Error(`${WINDOW_NOT_SHOWN_MARKER} 浏览器窗口存在但**没有显示出来**（outerWidth×outerHeight = `
			+ `${geometry ? geometry.outerW : '?'}×${geometry ? geometry.outerH : '?'}，visibility=${geometry ? geometry.visibility : 'unknown'}），${action} 的输入无处可落、也没有落到页面上：`
			+ '请让用户把浏览器窗口切换出来（或检查自动拉起是否只创建了隐藏窗口）；'
			+ '设置「浏览器 → 访问控制」里的「操作时是否抢焦点」不是 never 时会自动尝试一次让窗口落位，这次没成功。'
			+ '读取类命令（read/snapshot）不受影响，可以先用它们看页面。');
		err.code = 'window_not_shown';
		throw err;
	}
	const viewport = await viewportInfo(tabId, send);
	// 几何正常但**视口为 0**：页面没有布局，输入同样无处可落（与"窗口没显示"同一条处理路径）
	if (viewport.size.w <= 0 || viewport.size.h <= 0) {
		const err = new Error(`${WINDOW_NOT_SHOWN_MARKER} 页面视口是 ${viewport.size.w}×${viewport.size.h}（窗口${geometry ? `，outer=${geometry.outerW}×${geometry.outerH}` : ''}），`
			+ `${action} 没有可落的位置、也没有落到页面上：请让用户把浏览器窗口切出来再试；读取类命令不受影响。`);
		err.code = 'window_not_shown';
		throw err;
	}
	return {
		viewport,
		geometry,
		materialized,
		windowState: activation ? activation.windowState : undefined,
		restored: activation ? activation.restored === true : false,
	};
}

/**
 * 焦点策略（`focus.config` 由插件下发，默认 auto）。
 *
 * 为什么要有它（主人 2026-10-22）：老行为每次点击/输入都 `chrome.windows.update({focused:true})`，
 * 等于**把浏览器窗口提到前台**；用户这时可能正在别的窗口里操作，于是下一次点击就落在浏览器上 ——
 * 误触的来源之一。auto 只切标签页、不抢窗口焦点；always 保留老行为；never 连标签页都不切。
 */
let focusMode = 'auto';
/** 最小化时是否自动恢复窗口（默认关：恢复窗口会打断用户，且 state:'normal' 会顺带取消最大化）。 */
let focusRestoreMinimized = false;
/** 每个标签页上一次看到的视口尺寸（`宽x高`）：用它把"窗口被改过大小"如实报给调用方。 */
const lastViewport = new Map();

/** `focus.config {mode:'auto'|'always'|'never'}`：插件把设置推下来（连接、配置变更时各推一次）。 */
async function cmdFocusConfig(params) {
	const mode = params && params.mode === 'always' ? 'always' : params && params.mode === 'never' ? 'never' : 'auto';
	focusMode = mode;
	focusRestoreMinimized = params && params.restoreMinimized === true;
	return { mode, restoreMinimized: focusRestoreMinimized };
}

/* ---------------------------------------------------------- debugger (CDP) — persistent attachment */

/**
 * Ensure a persistent debugger attachment on `tabId`. Attaches once on first
 * CDP call and holds the attachment until explicit detach or tab close.
 * The Chrome "is being controlled" banner stays visible until detach.
 */
async function ensureAttached(tabId) {
	if (attachedTabs.has(tabId)) return;
	await new Promise((resolve, reject) => {
		chrome.debugger.attach({ tabId }, '1.3', () => {
			const err = chrome.runtime.lastError;
			if (!err) { attachedTabs.add(tabId); resolve(); return; }
			if (/already attached/i.test(err.message)) {
				attachedTabs.add(tabId);
				resolve();
				return;
			}
			reject(new Error(`debugger attach failed: ${err.message} (DevTools 打开着这个页面? 先关掉)`));
		});
	});
	// Enable the domains whose events we consume (dialogs, navigation results,
	// console + network capture for the browser_console_log / browser_network_log tools).
	await dbgSend(tabId, 'Page.enable').catch(() => {});
	await dbgSend(tabId, 'Runtime.enable').catch(() => {});
	await dbgSend(tabId, 'Network.enable').catch(() => {});
	// Bump the per-attached-tab generation so in-flight network entries queued
	// against an old attachment are not surfaced as if they were current.
	tabBufferGenerations.set(tabId, (tabBufferGenerations.get(tabId) ?? 0) + 1);
}

/* Native dialog auto-answer: fires whenever the page opens alert/confirm/
 * prompt/beforeunload while a debugger is attached. Without an answer the
 * page's main thread stays blocked forever. */
chrome.debugger.onEvent.addListener((source, method, params) => {
	const tabId = source?.tabId;
	if (tabId === undefined) return;
	if (method === 'Page.javascriptDialogOpening') {
		const entry = {
			tabId, type: params.type, message: params.message,
			defaultPrompt: params.defaultPrompt, answeredAs: dialogPolicy, t: Date.now(),
		};
		dialogLog.push(entry);
		if (dialogLog.length > 50) dialogLog.shift();
		if (dialogPolicy === 'manual') return;
		chrome.debugger.sendCommand(
			{ tabId },
			'Page.handleJavaScriptDialog',
			{ accept: dialogPolicy === 'accept', promptText: params.defaultPrompt },
			() => void chrome.runtime.lastError,
		);
		return;
	}
	if (method === 'Page.frameNavigated' && params && params.frame && params.frame.parentId === undefined) {
		const waiter = navArrivals.get(tabId);
		if (waiter) {
			navArrivals.delete(tabId);
			waiter.arrive(String(params.frame.url ?? ''));
		}
		return;
	}
	if (method === 'Page.javascriptDialogClosed') {
		// 原生弹窗（alert/confirm/prompt/beforeunload）出现时，浏览器通常会把那个窗口/标签页提到前台；
		// 用户此时可能正在别处操作，弹窗一关，下一次点击就落在页面上 —— 黑名单模式下立刻补层，
		// 让这次误触落在浮层上，而不是页面控件上（主人 2026-10-22 的原始动机）。
		holdAutoStats.dialogCloses = (holdAutoStats.dialogCloses || 0) + 1;
		if (holdMode === 'black') maybeAutoHold({ tabId }).catch(() => {});
		return;
	}
	if (method === 'Runtime.consoleAPICalled') {
		// Skip the noisy "log-type:verbose / "time-start" pseudo entries.
		const level = (params.type || 'log').toLowerCase();
		if (level === 'verbose' || level === 'timeStart' || level === 'timeEnd') return;
		const text = (params.args || []).map(arg => arg.value !== undefined ? String(arg.value) : (arg.description || arg.type || '')).join(' ');
		let location;
		if (params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames[0]) {
			const f = params.stackTrace.callFrames[0];
			location = `${f.url || '<inline>'}:${f.lineNumber}`;
		}
		const entry = { tabId, level, text, t: params.timestamp ? Math.round(params.timestamp * 1000) : Date.now() };
		if (location) entry.location = location;
		const buf = consoleLog.get(tabId) || [];
		buf.push(entry);
		if (buf.length > 500) buf.shift();
		consoleLog.set(tabId, buf);
		return;
	}
	if (method === 'Network.requestWillBeSent') {
		// requestId from CDP; one per request. Key under the tab; the body is
		// capped at 64KB to keep the buffer from blowing up on large POSTs.
		const POST_LIMIT = 64 * 1024;
		const post = params.request.postData;
		const entry = {
			tabId,
			requestId: params.requestId,
			method: params.request.method,
			url: params.request.url,
			headers: params.request.headers,
			resourceType: params.type,
			postData: typeof post === 'string' && post.length > POST_LIMIT ? post.slice(0, POST_LIMIT) + '…(truncated)' : post,
			initiator: params.initiator && params.initiator.url,
			wallTime: params.wallTime,
		};
		let tabMap = networkLog.get(tabId);
		if (!tabMap) { tabMap = new Map(); networkLog.set(tabId, tabMap); }
		tabMap.set(params.requestId, entry);
		trimNetworkMap(tabMap);
		return;
	}
	if (method === 'Network.responseReceived') {
		const tabMap = networkLog.get(tabId);
		if (!tabMap) return;
		const entry = tabMap.get(params.requestId);
		if (!entry) return;
		entry.status = params.response.status;
		entry.statusText = params.response.statusText;
		entry.mimeType = params.response.mimeType;
		entry.responseHeaders = params.response.headers;
		return;
	}
	if (method === 'Network.loadingFinished') {
		const tabMap = networkLog.get(tabId);
		if (!tabMap) return;
		const entry = tabMap.get(params.requestId);
		if (!entry) return;
		entry.encodedDataLength = params.encodedDataLength;
		entry.finished = true;
		return;
	}
	if (method === 'Network.loadingFailed') {
		const tabMap = networkLog.get(tabId);
		if (!tabMap) return;
		const entry = tabMap.get(params.requestId);
		if (!entry) return;
		entry.failed = true;
		entry.errorText = params.errorText;
		entry.canceled = params.canceled;
		return;
	}
});

/** Cap a per-tab request map at 500 entries (LRU-by-insertion-order). */
function trimNetworkMap(tabMap) {
	if (tabMap.size <= 500) return;
	const overflow = tabMap.size - 500;
	const keys = tabMap.keys();
	for (let i = 0; i < overflow; i++) tabMap.delete(keys.next().value);
}

function detachTab(tabId) {
	attachedTabs.delete(tabId);
	consoleLog.delete(tabId);
	networkLog.delete(tabId);
	tabBufferGenerations.delete(tabId);
	chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
}

function detachAll() {
	for (const tabId of [...attachedTabs]) detachTab(tabId);
}

/* 窗口尺寸/状态变了：丢掉缓存的视口尺寸，下一次输入类命令就会如实报 `viewportChanged`。 */
if (chrome.windows && chrome.windows.onBoundsChanged) {
	chrome.windows.onBoundsChanged.addListener((win) => {
		for (const [tabId, stamp] of lastViewport) {
			if (tabId === undefined) continue;
			// 无法从事件直接映射到标签页，保守清空：宁可多报一次"变了"，也不静默用旧判断。
			lastViewport.delete(tabId);
		}
		if (win === undefined) return;
	});
}

/* Clean up when a tab is closed (detaches automatically, but remove from set). */
chrome.tabs.onRemoved.addListener((tabId) => {
	if (attachedTabs.has(tabId)) attachedTabs.delete(tabId);
	consoleLog.delete(tabId);
	networkLog.delete(tabId);
	tabBufferGenerations.delete(tabId);
});

/* Clean up when DevTools steals a tab (detach event fires). */
chrome.debugger.onDetach.addListener((_source, reason) => {
	if (reason === 'target_closed' || reason === 'canceled_by_user') {
		// attachedTabs cleanup is handled by chrome.tabs.onRemoved
	}
});

function dbgSend(tabId, method, params) {
	return new Promise((resolve, reject) => {
		chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (res) => {
			const err = chrome.runtime.lastError;
			if (err) reject(new Error(`${method} failed: ${err.message}`));
			else resolve(res);
		});
	});
}

/** Persistent CDP: attaches (if not already) and holds. */
async function withCDP(tabId, fn) {
	await ensureAttached(tabId);
	return fn((method, params) => dbgSend(tabId, method, params));
}

/* ------------------------------------------------------- command handlers */

async function cmdPing() {
	return { pong: true, t: Date.now(), version: EXT_VERSION };
}

/**
 * Return the recorded `Runtime.consoleAPICalled` entries for a tab. Filters
 * apply client-side so the model only sees the rows it asked for. `clear`
 * empties the buffer on the same call so the next call starts fresh; useful
 * for "give me the warnings that appeared after I clicked submit" without
 * earlier noise. `limit` defaults to 100, capped at 500.
 */
async function cmdConsoleLog(params) {
	const tab = await resolveTab(params.tabId);
	const limit = Math.min(500, Math.max(1, Number(params.limit) || 100));
	const levels = Array.isArray(params.levels) && params.levels.length > 0
		? new Set(params.levels.map((l) => String(l).toLowerCase()))
		: null;
	const pattern = typeof params.pattern === 'string' && params.pattern.length > 0
		? new RegExp(params.pattern, 'i')
		: null;
	const buf = consoleLog.get(tab.id) || [];
	const filtered = buf.filter((e) => {
		if (levels && !levels.has(e.level)) return false;
		if (pattern && !pattern.test(e.text || '')) return false;
		return true;
	});
	const tail = filtered.slice(-limit);
	if (params.clear === true) consoleLog.set(tab.id, []);
	return { tabId: tab.id, count: tail.length, total: filtered.length, entries: tail };
}

/**
 * Return merged request/response entries captured by `Network.*` events.
 * `includeStatic: true` surfaces images / fonts / stylesheets / scripts that
 * are filtered by default (they dominate the buffer in a typical page load).
 * `methodPattern` / `urlPattern` / `status` filter client-side.
 */
async function cmdNetworkLog(params) {
	const tab = await resolveTab(params.tabId);
	const tabMap = networkLog.get(tab.id);
	const all = tabMap ? [...tabMap.values()] : [];
	const includeStatic = params.includeStatic === true;
	const methodPattern = typeof params.methodPattern === 'string' && params.methodPattern.length > 0
		? new RegExp(params.methodPattern, 'i')
		: null;
	const urlPattern = typeof params.urlPattern === 'string' && params.urlPattern.length > 0
		? new RegExp(params.urlPattern, 'i')
		: null;
	const statusFilter = typeof params.status === 'string' && params.status.length > 0 ? params.status : null;
	const staticTypes = new Set(['Image', 'Font', 'Stylesheet', 'Script', 'Favicon', 'Manifest']);
	const filtered = all.filter((e) => {
		if (!includeStatic && staticTypes.has(e.resourceType)) return false;
		if (methodPattern && !methodPattern.test(e.method || '')) return false;
		if (urlPattern && !urlPattern.test(e.url || '')) return false;
		if (statusFilter) {
			if (e.failed) {
				if (!/^f/i.test(statusFilter)) return false;
			} else if (e.status === undefined) {
				if (!/^p/i.test(statusFilter)) return false; // pending
			} else if (statusFilter === '2xx' && (e.status < 200 || e.status >= 300)) return false;
			else if (statusFilter === '3xx' && (e.status < 300 || e.status >= 400)) return false;
			else if (statusFilter === '4xx' && (e.status < 400 || e.status >= 500)) return false;
			else if (statusFilter === '5xx' && (e.status < 500 || e.status >= 600)) return false;
		}
		return true;
	});
	filtered.sort((a, b) => (a.wallTime || 0) - (b.wallTime || 0));
	const limit = Math.min(1000, Math.max(1, Number(params.limit) || 200));
	const out = filtered.slice(-limit).map((e) => {
		const { requestId: _id, tabId: _t, ...rest } = e;
		return rest;
	});
	if (params.clear === true) networkLog.set(tab.id, new Map());
	return { tabId: tab.id, count: out.length, total: filtered.length, requests: out };
}

async function cmdNetworkClear(params) {
	const tab = await resolveTab(params.tabId);
	networkLog.set(tab.id, new Map());
	return { tabId: tab.id, cleared: true };
}

/**
 * `Page.printToPDF` returns base64-encoded PDF. The extension's MV3 SW cannot
 * write to absolute paths on the host; the bridge decodes the base64 to a
 * `path` the caller supplies (or to `<shotsDir>/<tabId>-<t>.pdf` when no path
 * is given). The result echoes the saved path + size so callers can hand it
 * off to a reader tool.
 */
async function cmdPdf(params) {
	const tab = await resolveTab(params.tabId);
	return withCDP(tab.id, async (send) => {
		const cdpParams = {
			printBackground: params.printBackground !== false,
			landscape: params.landscape === true,
			...(typeof params.paperWidth === 'number' ? { paperWidth: params.paperWidth } : {}),
			...(typeof params.paperHeight === 'number' ? { paperHeight: params.paperHeight } : {}),
			...(typeof params.scale === 'number' ? { scale: params.scale } : {}),
			...(params.pageRanges ? { pageRanges: String(params.pageRanges) } : {}),
		};
		const res = await send('Page.printToPDF', cdpParams);
		if (!res || !res.data) throw new Error('Page.printToPDF returned no data');
		return { tabId: tab.id, base64: res.data };
	});
}

/**
 * Apply `Emulation.setDeviceMetricsOverride` + `setUserAgentOverride` +
 * `setTouchEmulationEnabled` to switch how the page renders. Presets cover
 * the common shapes (desktop / iphone / ipad / pixel); a custom object
 * overrides any field. Restoring back to desktop is `device:"reset"` so
 * the agent can clean up after itself.
 */
async function cmdEmulate(params) {
	const tab = await resolveTab(params.tabId);
	const preset = params.device && params.device !== 'reset' ? PRESETS[String(params.device).toLowerCase()] : null;
	if (params.device && params.device !== 'reset' && !preset && typeof params.device === 'string') {
		throw new Error(`unknown device preset "${params.device}". Use one of: ${Object.keys(PRESETS).join(', ')}, reset, or pass width/height fields directly.`);
	}
	const width = Number(params.width ?? (preset && preset.width) ?? 0);
	const height = Number(params.height ?? (preset && preset.height) ?? 0);
	const deviceScaleFactor = Number(params.deviceScaleFactor ?? (preset && preset.deviceScaleFactor) ?? 1);
	const isMobile = params.isMobile ?? (preset && preset.isMobile) ?? false;
	const hasTouch = params.hasTouch ?? (preset && preset.hasTouch) ?? false;
	const userAgent = params.userAgent || (preset && preset.userAgent) || undefined;
	return withCDP(tab.id, async (send) => {
		if (params.device === 'reset') {
			await send('Emulation.clearDeviceMetricsOverride').catch(() => {});
			await send('Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => {});
			await send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
			return { tabId: tab.id, reset: true };
		}
		if (width > 0 && height > 0) {
			await send('Emulation.setDeviceMetricsOverride', {
				width, height, deviceScaleFactor, mobile: isMobile,
			}).catch((e) => { throw new Error(`setDeviceMetricsOverride failed: ${e.message}`); });
		}
		if (userAgent) {
			await send('Emulation.setUserAgentOverride', { userAgent }).catch(() => {});
		}
		await send('Emulation.setTouchEmulationEnabled', { enabled: hasTouch }).catch(() => {});
		return {
			tabId: tab.id,
			width, height, deviceScaleFactor, isMobile, hasTouch,
			userAgent: userAgent || null,
		};
	});
}

const PRESETS = {
	desktop: { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false, userAgent: '' },
	'mobile-iphone-13': { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
	'mobile-pixel-7': { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36' },
	'tablet-ipad': { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
};

async function cmdBrowserInfo() {
	return { client: 'dsh-browser-extension', version: EXT_VERSION, browser: helloInfo };
}

/* ------------------------------------------------------------ 标签归组（DSH 组） */

/**
 * Agent 自己开的标签会收进当前窗口里一个名叫 `DSH` 的蓝色分组：你扫一眼就知道哪些页面是
 * 机器开的，事后也能一把拆掉。**只解除归属，不关任何标签页。**
 *
 * 来源：移植自上游 caob23 v1.0.10/v1.0.11 的 `extension/background.js`（AGPL-3.0，同许可）。
 * 三条实测得来的硬约束照搬：① 刚 `tabs.create` 立刻 `tabs.group` 会跟 Chrome 自己的标签簿记
 * 打架 ⇒ 按 50/150/400ms 退避、最多 4 枪；② `groupId` 只存内存，service worker 重启或用户
 * 手动拆组后按标题反查重建；③ manifest 要 `tabGroups` 权限（Chrome ≥ 89 的具名权限，
 * **不涉及读取网页内容**）。我们**没有**顺手加 `host_permissions` 去换这个能力。
 */
const AGENT_GROUP_TITLE = 'DSH';
const AGENT_GROUP_COLOR = 'blue';
const GROUP_RETRY_DELAYS_MS = [50, 150, 400];

/** windowId -> groupId，service worker 重启后按标题反查重建。 */
const agentGroupsByWindow = new Map();

function tabGroupsAvailable() {
	return typeof chrome.tabGroups?.update === 'function' && typeof chrome.tabs?.group === 'function';
}

async function findAgentGroup(windowId) {
	const cached = agentGroupsByWindow.get(windowId);
	if (cached !== undefined) {
		// 缓存的 id 会在用户手动拆组/关掉组内最后一个标签后失效 —— 用前先问一次。
		const live = await chrome.tabGroups.get(cached).catch(() => null);
		if (live !== null) return cached;
		agentGroupsByWindow.delete(windowId);
	}
	const titled = await chrome.tabGroups.query({ title: AGENT_GROUP_TITLE, windowId }).catch(() => []);
	const found = titled[0]?.id;
	if (found !== undefined) agentGroupsByWindow.set(windowId, found);
	return found;
}

/** 把一个标签放进该窗口的 DSH 组，没有组就建一个。 */
async function addToAgentGroup(tabId) {
	if (!tabGroupsAvailable()) {
		return { grouped: false, reason: 'tabGroups API 不可用（需 Chrome ≥ 89 且已授予 tabGroups 权限）' };
	}
	let lastError = 'unknown';
	for (let attempt = 0; attempt <= GROUP_RETRY_DELAYS_MS.length; attempt += 1) {
		const tab = await chrome.tabs.get(tabId).catch(() => null);
		if (tab === null || tab.windowId === undefined) return { grouped: false, reason: '标签页已不存在' };
		try {
			const existing = await findAgentGroup(tab.windowId);
			if (existing !== undefined) {
				await chrome.tabs.group({ tabIds: [tabId], groupId: existing });
				return { grouped: true, groupId: existing, created: false };
			}
			const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
			await chrome.tabGroups.update(groupId, { title: AGENT_GROUP_TITLE, color: AGENT_GROUP_COLOR });
			agentGroupsByWindow.set(tab.windowId, groupId);
			return { grouped: true, groupId, created: true };
		} catch (error) {
			lastError = failureText(error);
			agentGroupsByWindow.delete(tab.windowId);
			const wait = GROUP_RETRY_DELAYS_MS[attempt];
			if (wait === undefined) break;
			await sleep(wait);
		}
	}
	return { grouped: false, reason: lastError };
}

/** 把 DSH 组全部解散（指定窗口，或所有窗口）—— 只解除归属，不关标签页。 */
async function dissolveAgentGroups(windowId) {
	if (!tabGroupsAvailable()) return { ungrouped: 0, groups: 0, reason: 'tabGroups API 不可用' };
	const wanted = windowId === undefined
		? { title: AGENT_GROUP_TITLE }
		: { title: AGENT_GROUP_TITLE, windowId: Number(windowId) };
	const groups = await chrome.tabGroups.query(wanted).catch(() => []);
	let ungrouped = 0;
	for (const group of groups) {
		const tabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
		const ids = tabs.map((t) => t.id).filter((id) => id !== undefined);
		if (ids.length === 0) continue;
		try {
			await chrome.tabs.ungroup(ids);
			ungrouped += ids.length;
		} catch { /* 用户可能已经手动拆开了 */ }
	}
	agentGroupsByWindow.clear();
	return { ungrouped, groups: groups.length };
}

async function cmdTabGroup(params) {
	if (params?.tabId === undefined) throw new Error('params.tabId is required');
	const result = await addToAgentGroup(Number(params.tabId));
	if (result.grouped !== true) throw new Error(`group failed: ${result.reason}`);
	return { tabId: Number(params.tabId), ...result };
}

async function cmdTabUngroup(params) {
	return dissolveAgentGroups(params?.windowId);
}

/** 这个 id 现在还在不在。关闭前先问一次，是为了不让"已经没了"把整批连坐。 */
async function tabStillThere(tabId) {
	try {
		await chrome.tabs.get(tabId);
		return true;
	} catch {
		return false;
	}
}

/**
 * 一次关多个标签：**一条命令、一份超时预算**，并且对每个 id 都有交代
 * （closed / alreadyGone / failed）—— 只报"关闭失败"会让调用方不知道哪几个其实关掉了。
 * 这套语义就是我们提给上游的 PR #11（已合并进 v1.0.16）；这里把它搬回自己的扩展线。
 */
async function cmdTabsCloseMany(params) {
	const raw = Array.isArray(params.tabIds) ? params.tabIds : [];
	const ids = [...new Set(raw.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
	if (ids.length === 0) throw new Error('params.tabIds must be a non-empty array of tab ids');
	const present = [];
	const alreadyGone = [];
	for (const id of ids) (await tabStillThere(id)) ? present.push(id) : alreadyGone.push(id);
	let report = null;
	if (present.length > 0) {
		try {
			await chrome.tabs.remove(present);
		} catch (error) {
			report = failureText(error);
		}
	}
	const closed = [];
	const failed = [];
	for (const id of present) {
		if (await tabStillThere(id)) failed.push({ tabId: id, error: report ?? 'tabs.remove resolved but the tab is still open' });
		else closed.push(id);
	}
	return { requested: ids.length, closed, alreadyGone, failed };
}

async function cmdTabsList(params) {
	let tabs = [];
	try {
		tabs = await chrome.tabs.query({});
	} catch { tabs = []; }
	const windows = await windowCount();
	// params.ensureWindow === true 时顺带唤起（显式要求才做，list 默认保持只读语义）。
	if (tabs.length === 0 && windows === 0 && params && params.ensureWindow === true) {
		await ensureWindow('tabs.list?ensureWindow=1');
		tabs = await chrome.tabs.query({}).catch(() => []);
	}
	// 分组归属（2026-10-17）：原来只回 id/url/title/active —— 分组**能做但看不见**（建了组也确认不了
	// 某个标签在不在组里）。这里补上每个标签的 groupId/groupTitle/groupColor，外加当前窗口全部组的
	// 一览。仍然保持"紧凑"：只在有组时多三个字段，未归组的标签不多占字节。
	const groups = tabGroupsAvailable() ? await chrome.tabGroups.query({}).catch(() => []) : [];
	const groupById = new Map(groups.map((g) => [g.id, g]));
	// Compact shape: the bridge serializes this straight into a tool result and
	// wide shapes were truncating mid-JSON.
	return {
		count: tabs.length,
		windows: await windowCount(),
		noWindow: tabs.length === 0,
		activeTabId: tabs.find((t) => t.active)?.id,
		groups: groups.map((g) => ({ id: g.id, title: g.title ?? '', color: g.color, windowId: g.windowId })),
		tabs: tabs.map((t) => {
			const grouped = typeof t.groupId === 'number' && t.groupId >= 0 && groupById.has(t.groupId);
			return {
				id: t.id, url: t.url, title: t.title, active: t.active,
				...(grouped
					? { groupId: t.groupId, groupTitle: groupById.get(t.groupId)?.title ?? '', groupColor: groupById.get(t.groupId)?.color }
					: {}),
			};
		}),
	};
}

/**
 * 显式唤起一个可操作的窗口（命令名 `window.ensure`）：已有窗口则什么都不做。
 * 与 `browser_launch`（起浏览器进程）互补 —— 进程活着但没有窗口时，需要的是这个。
 *
 * `params.url`（可选，仅 http/https）：新建窗口时**直接落在这个网址上**，
 * 而不是留一张 about:blank 垃圾页（2026-10-10 用户反馈：每次自动唤起都多一张空白页）。
 */
async function cmdEnsureWindow(params) {
	const before = await windowCount();
	const rawUrl = params && typeof params.url === 'string' ? params.url.trim() : '';
	const landingUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : undefined;
	const { created, tab } = await ensureWindow(String((params && params.reason) || 'window.ensure'), landingUrl);
	const after = await windowCount();
	return {
		created,
		windowsBefore: before,
		windowsAfter: after,
		tabId: tab && tab.id,
		url: tab && tab.url,
		title: tab && tab.title,
		note: created
			? (landingUrl === undefined ? '此前没有任何窗口，已新建 about:blank 窗口' : `此前没有任何窗口，已新建窗口并落在 ${landingUrl}`)
			: '已有窗口，未新建',
	};
}

async function cmdTabsOpen(params) {
	if (!params.url) throw new Error('params.url is required');
	const active = params.active !== undefined ? Boolean(params.active) : true;
	// 一个窗口都没有时：直接开一个**落在这个网址上**的窗口，别先建空白窗再开标签页
	// （那样会留下一张 about:blank 垃圾页 —— bi-022 的另一半）。
	const existing = await chrome.tabs.query({}).catch(() => []);
	let created;
	if (existing.length === 0) {
		const win = await chrome.windows.create({ url: params.url, focused: active });
		const inWin = Array.isArray(win.tabs) && win.tabs[0] !== undefined
			? win.tabs
			: await chrome.tabs.query({ windowId: win.id });
		created = inWin[0];
		if (created === undefined) throw new Error('新建窗口成功但没有标签页（浏览器行为异常）');
	} else {
		created = await chrome.tabs.create({ url: params.url, active });
	}
	const waitUntil = params.wait === false ? 'none' : navWaitMode(params.waitUntil);
	const openedAt = Date.now();
	// 新标签页的"旧地址"是 about:blank：只要地址换掉就算 commit（重定向不被卡住）
	const settled = await waitForNavigationComplete(created.id, navBudget(waitUntil, params.timeoutMs), params.url, waitUntil, 'about:blank');
	const waitedMs = Date.now() - openedAt;
	const fresh = await chrome.tabs.get(created.id).catch(() => null);
	// 还没 commit 的导航在 `url` 里看不见（空串），去处写在 `pendingUrl`。
	const pendingUrl = fresh?.pendingUrl && fresh.pendingUrl !== fresh.url ? fresh.pendingUrl : undefined;
	// 归组失败**不该**让"打开标签"这件事失败 —— 只把结果带回去（上游 v1.0.10 的口径）。
	const group = params.group === false ? { grouped: false, reason: 'group:false' } : await addToAgentGroup(created.id);
	return {
		tabId: created.id,
		url: fresh?.url,
		title: fresh?.title,
		...(pendingUrl === undefined ? {} : { pendingUrl }),
		waitUntil,
		waitedMs,
		...(settled === true ? {} : { loadPending: true }),
		...group,
	};
}

async function cmdTabsClose(params) {
	if (params.tabId === undefined) throw new Error('params.tabId is required');
	await chrome.tabs.remove(Number(params.tabId));
	return { closed: Number(params.tabId) };
}

async function cmdTabsActivate(params) {
	if (params.tabId === undefined) throw new Error('params.tabId is required');
	await chrome.tabs.update(Number(params.tabId), { active: true });
	return { activated: Number(params.tabId) };
}

async function cmdNav(params) {
	if (!params.url) throw new Error('params.url is required');
	// 带上目标网址：万一此刻没有任何窗口，自愈建出来的窗口直接落在它上面（bi-022）
	const tab = await resolveTab(params.tabId, params.url);
	// 「等多久」交给调用方选（2026-10-23 主人：让模型可以不等待页面加载）。
	// 默认 domcontentloaded：DOM 一可用就回，内容晚到再用 waitSelector/waitText/waitFn 或 read 复查。
	const waitUntil = params.wait === false ? 'none' : navWaitMode(params.waitUntil);
	const timeoutMs = navBudget(waitUntil, params.timeoutMs);
	// 用户按过「中止操作」时，导航也一并拦下（中止＝别再动这个页面）
	await withCDP(tab.id, (send) => assertNotAborted(send, 'nav')).catch((error) => {
		if (error instanceof Error && error.message.includes('用户终止控制')) throw error
		// 探不到（页面正在导航/已崩）就不拦：不能因为探针失败把正常导航也禁掉
	})
	// 先把"等新导航完成"的轮询挂上，**再**触发导航（顺序反了就会读到旧文档的 complete）。
	const startedNav = Date.now();
	const previousUrl = (await chrome.tabs.get(tab.id).catch(() => null))?.url ?? '';
	const settling = waitForNavigationComplete(tab.id, timeoutMs, params.url, waitUntil, previousUrl);
	await chrome.tabs.update(tab.id, { url: params.url });
	const settled = await settling;
	const waitedMs = Date.now() - startedNav;
	const fresh = await chrome.tabs.get(tab.id).catch(() => null);
	// Chrome lands dead navigations on an internal error page, but tabs.get()
	// keeps reporting the ORIGINAL url — only in-page location.href reveals
	// chrome-error://. Probe it so callers can react structurally.
	// 2026-10-10 补：Edge 155 的错误页 `body.className` 是空的（不能按 .neterror 判），
	// 但 `#main-frame-error` 一定在（本机真机实测：location.href=chrome-error://chromewebdata/、
	// getElementById('main-frame-error')=true、文案含 ERR_CONNECTION_TIMED_OUT）。两个判据都试。
	let landedUrl = '';
	let landedReadyState = '';
	let errorPageMarker = false;
	try {
		// bi-036：文档卡在 commit 之前时 CDP **不回** `Runtime.evaluate`，这个探针会把整条
		// `nav` 拖过调用方的预算（rig 实测：/hang 上 25s 都没回答）。给它一个自己的小预算，
		// 超时就当作"探不到落地地址"往下走 —— 后面的 loadPending 会如实说"没等完"。
		const probe = await withBudget(withCDP(tab.id, (send) => send('Runtime.evaluate', {
			expression: 'JSON.stringify({ href: location.href, readyState: document.readyState, mainFrameError: !!document.getElementById("main-frame-error") })',
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((r) => String(r.result?.value ?? ''))), waitUntil === 'none' ? 500 : 2500, null);
		if (probe !== null) {
			try {
				const parsed = JSON.parse(probe);
				landedUrl = typeof parsed.href === 'string' ? parsed.href : '';
				landedReadyState = typeof parsed.readyState === 'string' ? parsed.readyState : '';
				errorPageMarker = parsed.mainFrameError === true;
			} catch { landedUrl = probe; }
		}
	} catch { /* no debugger possible (e.g. chrome:// pages) — fall through */ }
	let siteUnreachable;
	let loadError;
	if (/^chrome-error:/.test(landedUrl) || errorPageMarker) {
		let errText = '';
		try {
			errText = await withCDP(tab.id, (send) => send('Runtime.evaluate', {
				expression: 'document.body ? document.body.innerText.slice(0, 4000) : ""',
				awaitPromise: false, returnByValue: true, userGesture: true,
			}).then((r) => String(r.result?.value ?? '')));
		} catch { /* classification falls back below */ }
		// Error-page copy is localized (zh-CN shows 无法找到 … 的 DNS 地址,
		// en-US shows ERR_NAME_NOT_RESOLVED); match either plus any bare DNS
		// mention such as DNS_PROBE_STARTED.
		const dns = /ERR_NAME_NOT_RESOLVED|ERR_DNS_TIMED_OUT|\bDNS\b|无法找到.{0,40}(DNS|服务器)/i.test(errText)
			|| /ERR_NAME_NOT_RESOLVED|dns/i.test(fresh?.title ?? '');
		siteUnreachable = { reason: dns ? 'dns' : 'unreachable' };
		// 把**具体错误码**带出去（宿主以前只认布尔 `siteUnreachable === true`，对象形状被整个丢掉 ⇒
		// "页面连不上"从来没送到模型眼前，2026-10-10 实测）。这里同时给 error 文本，两条路都能读。
		const code = /(ERR_[A-Z_]+)/.exec(errText)?.[1];
		const firstLine = errText.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)[1] ?? '';
		loadError = `${code ?? (dns ? 'DNS 解析失败' : '无法连接')}${firstLine.length > 0 ? ` — ${firstLine}` : ''}`;
	}
	return {
		tabId: tab.id,
		url: siteUnreachable ? params.url : (fresh?.url ?? params.url),
		title: siteUnreachable ? undefined : fresh?.title,
		...(siteUnreachable ? { siteUnreachable } : {}),
		...(loadError === undefined ? {} : { error: loadError }),
		// 如实交代"没等完"：以前超时会静默返回原 url/旧标题，模型就以为页面到位了
		// （2026-10-10 实测：navigate 秒回 about:blank、12s 后才是错误页）。
		// 等待口径与耗时如实回报：模型据此判断"该继续读还是该再等"
		waitUntil,
		waitedMs,
		...(landedReadyState.length > 0 ? { readyState: landedReadyState } : {}),
		// `loadPending` 的语义改成"文档还没到 complete"，与等待口径解耦：
		// 选了 commit/none 时 settled=true 只代表"按你要的口径返回了"，页面照样可能还在加载（2026-10-23）。
		...(siteUnreachable === undefined && (landedReadyState.length > 0 ? landedReadyState !== 'complete' : settled !== true)
			? {
				loadPending: true,
				// chrome.tabs 的 pendingUrl 只在"有导航在途"时有值；没有就退回调用方要的那个 URL。
				// 有了它，模型看到的就不是"还在加载"，而是"还在加载**哪个**地址"。
				pendingUrl: fresh?.pendingUrl ?? params.url,
			}
			: {}),
	};
}

async function cmdEval(params) {
	if (typeof params.expression !== 'string' || params.expression.length === 0) {
		throw new Error('params.expression is required');
	}
	const tab = await resolveTab(params.tabId);
	// Frame targeting: params.frameSelector (CSS selector of an <iframe>) runs
	// the expression inside that frame via contentDocument (same-origin).
	// Cross-origin frames need a separate debugger target — reported clearly.
	let expression = params.expression;
	if (Array.isArray(params.argNames) && Array.isArray(params.args)
		&& params.argNames.length === params.args.length && params.argNames.length > 0) {
		const argValues = params.args.map((a) => JSON.stringify(a)).join(', ');
		expression = `((${params.argNames.join(', ')}) => { ${params.expression} })(${argValues})`;
	}
	if (params.frame !== undefined && params.frame !== null && String(params.frame).length > 0) {
		// 按 frame 的 name / #序号 / url 子串定位（老式 frameset 里通常只有 name）。
		const spec = String(params.frame);
		// 包装语义（2026-09-25 修）：以前一律 `(() => { EXPR })()`，裸表达式（如
		// `JSON.stringify(...)`）因为没有 return 会**静默返回 undefined**。现在没写 return 的
		// 按表达式处理（`return (EXPR)`），写了 return 的按语句体处理。
		// 2026-10-09：改成 async 包装 ⇒ 帧内也能用顶层 await（bi-016）。
		const inner = /\breturn\b/.test(expression)
			? `(async () => { ${expression} })()`
			: `(async () => { return (${expression}); })()`;
		expression = `(async () => {
			${FRAME_HELPER}
			const frames = listFrames(document, [], 0);
			const target = pickFrame(frames, ${JSON.stringify(spec)});
			if (!target) throw new Error('frame not found: ' + ${JSON.stringify(spec)} + ' (候选: ' + frames.map((f, i) => f.name || f.url || ('#' + i)).join(', ') + ')');
			if (!target.doc) throw new Error('frame 是跨域的，无法直接 eval: ' + (target.name || target.src));
			const doc = target.doc, win = target.doc.defaultView;
			return ((document, window) => ${inner})(doc, win);
		})()`;
	}
	if (params.frameSelector) {
		const inner = expression.startsWith('(') ? expression : `(async () => { ${expression} })()`;
		// Rebind document/window to the frame by passing them as parameters of
		// the wrapping arrow — parameter shadowing, no TDZ hazard. A `const
		// document = doc` declaration in the same scope would throw
		// "Cannot access 'document' before initialization" at the host lookup
		// above it.
		expression = `(async () => {
			const host = document.querySelector(${JSON.stringify(String(params.frameSelector))});
			if (!host || !(host instanceof HTMLIFrameElement)) throw new Error('iframe not found: ${String(params.frameSelector).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');
			if (!host.contentDocument) throw new Error('cross-origin iframe: same-origin only supported, use a frame-specific tool');
			const doc = host.contentDocument, win = host.contentWindow;
			return ((document, window) => ${inner})(doc, win);
		})()`;
	}
	// params.timeoutMs races the evaluation: a hung awaitPromise (looping
	// promise, blocked page) must fail at the caller's budget instead of
	// riding the bridge-wide 60s default.
	// 默认预算：以前写成 `Math.max(100, Number(params.timeoutMs) || 0)`，未传 timeoutMs 时
	// 等于 100ms —— 而宿主从不传 timeoutMs，于是**每次 eval 都被 100ms 掐死**（实测连一句
	// JSON.stringify 都报 `eval timeout after 100ms`，因为 CDP 附加本身就超 100ms）。
	// 现在默认 15s，与其它命令一致；仍可用 params.timeoutMs 覆盖。
	const evalTimeoutMs = Math.min(120_000, Math.max(100, Number(params.timeoutMs) || 15_000));
	const raceTimeout = (ms) => new Promise((_, reject) => setTimeout(() => {
		const err = new Error(`eval timeout after ${ms}ms`);
		err.code = 'eval_timeout';
		reject(err);
	}, ms));
	/**
	 * 让**顶层 `await`** 可用（bi-012 / bi-016）：CDP 的 `Runtime.evaluate` 不支持顶层 await，
	 * 而工具描述承诺"像 promise body 一样被 await"——模型照描述写就会拿到 `SyntaxError: await is
	 * only valid in async functions`。这里照 DevTools 控制台的做法包一层 async IIFE：写了 `return`
	 * 的按语句体走，没写的按表达式走。**包不合法时调用方会回退到原样执行**，所以"能用顶层 await"
	 * 是纯增量，不会让任何原本可用的表达式（如 `let x=1; x+1`）变坏。
	 */
	const wrapTopLevelAwait = (source) => {
		const trimmed = source.trim();
		if (trimmed.length === 0) return source;
		// 已经是 IIFE 包裹的（帧分支产生的那种，以 `)()` 结尾）不再二次包裹。
		if (/\)\s*\(\s*\)\s*;?$/.test(trimmed)) return source;
		const inner = /\breturn\b/.test(trimmed) ? trimmed : `return (${trimmed});`;
		return `(async () => { ${inner} })()`;
	};
	const evaluate = (expr) => withCDP(tab.id, async (send) => {
		// Evaluate WITHOUT returnByValue first: the RemoteObject's type/subtype
		// metadata tells us honestly what came back. Newer Chrome serializes
		// un-serializable objects to `{}` under returnByValue:true, which would
		// masquerade as a legitimate empty object.
		return send('Runtime.evaluate', {
			expression: expr,
			awaitPromise: params.awaitPromise !== false,
			returnByValue: false,
			userGesture: true,
		}).then(async (res) => {
			if (res.exceptionDetails) {
				const d = res.exceptionDetails;
				const desc = String(d.exception?.description ?? d.text);
				if (CONTEXT_DESTROYED_RE.test(desc)) {
					const err = new Error('context_destroyed: page navigated while evaluate was pending');
					err.code = 'context_destroyed';
					throw err;
				}
				throw new Error(`page exception: ${desc}`);
			}
			const ro = res.result;
			// Primitives carry their value inline; nothing more to transfer.
			const isPrimitiveLike = ro.type === 'number' || ro.type === 'string' || ro.type === 'boolean'
				|| ro.type === 'bigint' || ro.type === 'undefined' || ro.subtype === 'null';
			if (isPrimitiveLike || !ro.objectId) return ro;
			// Objects known un-serializable by value get an honest report instead
			// of a silent {} (DOM nodes, functions, proxies, symbols, Map/Set…).
			const NOT_BY_VALUE = new Set(['node', 'function', 'proxy', 'symbol', 'map', 'set',
				'weakmap', 'weakset', 'iterator', 'generator']);
			if (NOT_BY_VALUE.has(ro.subtype ?? '') || ro.type === 'function' || ro.type === 'symbol') return ro;
			// Transfer by value without re-executing the expression:
			// callFunctionOn(identity) on the existing objectId.
			const ser = await send('Runtime.callFunctionOn', {
				objectId: ro.objectId,
				functionDeclaration: 'function () { return this; }',
				returnByValue: true,
			});
			if (ser.exceptionDetails) return ro;
			return { ...ro, value: ser.result.value };
		}).catch((err) => {
			// Protocol-level variant: Chrome rejects the whole sendCommand with
			// -32000 "Inspected target navigated or closed" when the target dies
			// mid-call; surface it under the same structural code.
			if (err instanceof Error && CONTEXT_DESTROYED_RE.test(err.message)) {
				const wrapped = new Error('context_destroyed: page navigated while evaluate was pending');
				wrapped.code = 'context_destroyed';
				throw wrapped;
			}
			throw err;
		});
	});
	const runWithBudget = async (expr) => {
		const pending = evaluate(expr);
		return evalTimeoutMs ? await Promise.race([pending, raceTimeout(evalTimeoutMs)]) : await pending;
	};
	const wrappedExpression = wrapTopLevelAwait(expression);
	let value;
	try {
		value = await runWithBudget(wrappedExpression);
	} catch (error) {
		// 包裹只是为了让顶层 await 可用；万一它把**本来能跑**的写法包装坏了
		// （典型：语句体 + 没写 return 的 `let x=1; x+1` 会拼成非法语法），
		// 就退回和旧版完全一致的"原样执行"，而不是把这类表达式从可用变成不可用。
		if (wrappedExpression === expression || !/SyntaxError/.test(String(error && error.message))) throw error;
		value = await runWithBudget(expression);
	}
	// Serialize what we honestly got. `value` here is a RemoteObject; a
	// missing `.value` on a non-primitive means transfer was impossible.
	let out;
	if (value.value !== undefined) {
		out = value.value;
	} else if (value.type === 'undefined') {
		out = null;
	} else if (value.subtype === 'node') {
		out = `[dom:${value.className ?? 'Node'} — wrap in JSON.stringify() or read specific properties]`;
	} else {
		out = `[${value.type}${value.subtype ? `:${value.subtype}` : ''}: not serializable — wrap the expression in JSON.stringify()]`;
	}
	return { tabId: tab.id, value: out, valueType: value.type };
}

/**
 * CDP `exceptionDetails` → 可读文本。
 *
 * 以前只取 `.text`，而 CDP 对页面内抛错常常只给 "Uncaught"，真正的错误信息在
 * `exception.description`（读老页面时正是最需要看到它的时候）。
 */
function pageExceptionText(details) {
	if (!details) return 'unknown exception';
	const exception = details.exception;
	const parts = [];
	if (exception && typeof exception.description === 'string') parts.push(exception.description);
	else if (exception && typeof exception.value === 'string') parts.push(exception.value);
	if (typeof details.text === 'string' && parts.indexOf(details.text) < 0) parts.push(details.text);
	return parts.join(' — ') || 'unknown exception';
}

/**
 * Injected helper (runs in the page): depth-first frame walk + frame picking.
 *
 * 存在的理由：老式管理页（路由器/光猫/交换机）大量使用 <frameset>。那种页面
 * **没有 document.body**，所以 `document.body.innerText` 恒为空——顶层读出来只有
 * 标题和 URL（实测 20 字符）。这里把 frame 枚举出来，同源帧的 document 就能直接取。
 */
/**
 * 穿透 open shadow root 的元素枚举与定位（2026-10-19 实测的缺口）。
 *
 * `document.querySelectorAll` 不进 shadow root：页面看得见、工具看不见，而且**不报错**。
 * 一个复刻症状的页面（表格与按钮都在 open shadow root 里）实测：`find` 0 命中、
 * `snapshot` 0 个可交互元素、`read` 读不到表内文字。下面这套函数在所有读/找/点的注入脚本里
 * 共用：先按选择器在 composed tree 里找，找不到再按快照留下的指纹重定位（重渲染会重建元素，
 * 打在旧元素上的 `data-dsh-ref` 随之消失）。
 *
 * 只走 **open** shadow root：closed 的取不到（`el.shadowRoot` 为 null），这是浏览器的边界，
 * 工具无法越过，也不该假装能。
 */
const DEEP_HELPER = `
function __dshIsOwnOverlay(el) {
	if (!el || !el.tagName) return false;
	try {
		if (el.id === '__dsh_hold_overlay__') return true;
		if (el.getAttribute && el.getAttribute('data-dsh-hold') === '1') return true;
	} catch (e) { return false; }
	return false;
}
function __dshDeepAll(sel) {
	var out = [];
	var walk = function (root) {
		var found = [];
		try { found = root.querySelectorAll(sel); } catch (e) { found = []; }
		for (var i = 0; i < found.length; i += 1) {
			if (!__dshIsOwnOverlay(found[i])) out.push(found[i]);
		}
		var all = [];
		try { all = root.querySelectorAll('*'); } catch (e) { all = []; }
		for (var j = 0; j < all.length; j += 1) {
			if (__dshIsOwnOverlay(all[j])) continue;
			if (all[j].shadowRoot) walk(all[j].shadowRoot);
		}
	};
	walk(document);
	return out;
}
function __dshNormText(el) {
	var raw = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || '';
	return String(raw).trim().replace(/\\s+/g, ' ').slice(0, 80);
}
function __dshPick(sel, fp) {
	var hits = __dshDeepAll(sel);
	if (hits.length > 0) return { el: hits[0], relocated: false };
	if (!fp) return { el: null, relocated: false };
	var pool = __dshDeepAll(fp.tag || '*');
	for (var i = 0; i < pool.length; i += 1) {
		var el = pool[i];
		if (fp.tag && el.tagName.toLowerCase() !== fp.tag) continue;
		if (fp.name && __dshNormText(el) !== fp.name) continue;
		if (fp.role && String(el.getAttribute('role') || '') !== fp.role) continue;
		try { el.setAttribute('data-dsh-ref', fp.ref || ''); } catch (e) { /* 只读节点，忽略 */ }
		return { el: el, relocated: true };
	}
	return { el: null, relocated: false };
}
/**
 * 把页面里所有 shadow root 的文字按文档顺序汇总（innerText 不含 shadow 内容）。
 * 常规页面没有 shadow root ⇒ 返回空串，正文与以前逐字节相同。
 */
function __dshShadowText() {
	var parts = [];
	var seen = 0;
	var walk = function (root) {
		var all = [];
		try { all = root.querySelectorAll('*'); } catch (e) { all = []; }
		for (var i = 0; i < all.length; i += 1) {
			var el = all[i];
			if (__dshIsOwnOverlay(el)) continue;
			if (!el.shadowRoot) continue;
			var text = '';
			try { text = String(el.shadowRoot.textContent || ''); } catch (e) { text = ''; }
			text = text.replace(/\\s+/g, ' ').trim();
			if (text.length > 0 && parts.length < 40 && seen < 20000) {
				parts.push(text);
				seen += text.length;
			}
			walk(el.shadowRoot);
		}
	};
	walk(document);
	return parts.join('\\n');
}
`;

const FRAME_HELPER = `
	const listFrames = (doc, out, depth) => {
		if (!doc || depth > 3 || out.length > 40) return out;
		let els = [];
		try { els = [...doc.querySelectorAll('frame,iframe')]; } catch (e) { return out; }
		for (const el of els) {
			let d = null;
			try { d = el.contentDocument || null; } catch (e) { d = null; }
			let url = '';
			try { url = d ? d.location.href : ''; } catch (e) { url = ''; }
			out.push({ el, doc: d, name: el.name || el.id || '', src: el.getAttribute('src') || '', url });
			if (d) listFrames(d, out, depth + 1);
		}
		return out;
	};
	const pickFrame = (frames, spec) => {
		if (spec === null || spec === undefined || spec === '') return null;
		const s = String(spec);
		if (/^#?\\d+$/.test(s)) return frames[Number(s.replace('#', ''))] || null;
		return frames.find((f) => f.name === s) || frames.find((f) => f.src.indexOf(s) >= 0)
			|| frames.find((f) => f.url.indexOf(s) >= 0) || null;
	};
	const textOf = (doc) => (doc && doc.body ? (doc.body.innerText || doc.body.textContent || '') : '');
	const htmlOf = (doc) => (doc && doc.documentElement ? doc.documentElement.outerHTML : '');
	const frameLabel = (f, i) => (f.name || f.url || f.src || ('frame' + i));
`;

/**
 * 构造 `content` 要注入页面的脚本（抽成独立函数，便于 `content.debug` 原样 dump 诊断）。
 *
 * ⚠️ 踩坑记录（2026-09-25，血泪）：**模板字面量内部绝不能出现反引号**——哪怕是在注释里。
 * 我曾在模板内写注释时用反引号强调 frameset 标签，那个反引号直接终止了模板字面量，
 * 其后的文字被当作代码解析，结果 `content` / `content.debug` 一律抛
 * `ReferenceError: frameset is not defined`；而 `node --check` 依旧通过，因为同一行里
 * 那对反引号又把模板"重新打开"，整体括号仍然平衡——所以静态检查抓不到。
 */
function buildContentScript(mode, frameSpec, flatten) {
	return `(() => {
		${FRAME_HELPER}
		${DEEP_HELPER}
		const frames = listFrames(document, [], 0);
		const meta = frames.map((f, i) => ({ index: i, name: f.name, src: f.src, url: f.url, sameOrigin: !!f.doc }));
		const one = (doc) => (${JSON.stringify(mode)} === 'html' ? htmlOf(doc) : textOf(doc));
		const target = pickFrame(frames, ${JSON.stringify(frameSpec)});
		if (${JSON.stringify(frameSpec)} !== null) {
			if (!target) throw new Error('frame not found: ' + ${JSON.stringify(frameSpec)} + ' (候选: ' + meta.map((m) => m.name || m.url || ('#' + m.index)).join(', ') + ')');
			if (!target.doc) throw new Error('frame 是跨域的，无法直接读: ' + (target.name || target.src || ('#' + target.index)));
			return JSON.stringify({ title: target.doc.title, url: target.doc.location.href, readyState: target.doc.readyState,
				content: one(target.doc), frames: meta, readFrame: ${JSON.stringify(frameSpec)} });
		}
		// innerText 不含 shadow root 里的文字（2026-10-19 实测）⇒ 汇总后接在正文后面。
		// 没有 shadow root 的页面这段是空串，正文与以前逐字节相同。
		const shadowText = ${JSON.stringify(mode)} === 'text' ? __dshShadowText() : '';
		const own = one(document) + (shadowText.length > 0 ? '\\n' + shadowText : '');
		// 判据：老页面常在 frameset 文档里夹 noframes/脚本文本，顶层并不为空（UTT 750W 实测 882 字符），
		// 所以"顶层非空"不能当作不拍平的理由。可靠信号是文档里存在 frameset 元素。
		const hasFrameset = document.getElementsByTagName('frameset').length > 0;
		if (${JSON.stringify(flatten)} && frames.length > 0 && (hasFrameset || own.trim().length === 0)) {
			const parts = [];
			if (own.trim().length > 0) parts.push('[document]\\n' + own.trim());
			frames.forEach((f, i) => {
				const label = '[' + frameLabel(f, i) + ']';
				if (!f.doc) { parts.push(label + ' (跨域帧，无法直接读取；可用 browser_frames 看结构)'); return; }
				const body = one(f.doc).trim();
				parts.push(label + (body.length > 0 ? '\\n' + body : ' (空)'));
			});
			return JSON.stringify({ title: document.title, url: location.href, readyState: document.readyState,
				content: parts.join('\\n\\n'), frames: meta, flattenedFrames: frames.length, hasFrameset });
		}
		return JSON.stringify({ title: document.title, url: location.href, readyState: document.readyState, content: own, frames: meta });
	})()`;
}

async function cmdContent(params) {
	const mode = params.mode === 'html' ? 'html' : 'text';
	const tab = await resolveTab(params.tabId);
	const frameSpec = params.frame === undefined ? null : String(params.frame);
	const flatten = params.flattenFrames !== false;
	const script = buildContentScript(mode, frameSpec, flatten);
	const payload = await withCDP(tab.id, async (send) => {
		await assertNotAborted(send, 'input')
		return await send('Runtime.evaluate', {
			expression: script,
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((res) => {
			if (res.exceptionDetails) throw new Error(`page exception: ${pageExceptionText(res.exceptionDetails)}`);
			return JSON.parse(res.result.value);
		});
	});
	// "页面还在变"与"页面就是空的"必须分得开（2026-10-19：读教务课表时读早了只拿到占位文本）。
	// 判据很便宜：跟同一标签页上一次读取的签名比。签名变了 ⇒ 页面在两次读取之间动过。
	const signature = `${payload.content.length}|${payload.content.slice(0, 120)}|${payload.content.slice(-120)}`;
	const previousSignature = lastReadSignature.get(tab.id);
	lastReadSignature.set(tab.id, signature);
	await persistRefState();
	const changedSinceLastRead = previousSignature === undefined ? undefined : previousSignature !== signature;
	return {
		tabId: tab.id, mode, ...payload,
		...(changedSinceLastRead === undefined ? {} : { changedSinceLastRead }),
		settled: payload.readyState === 'complete' && changedSinceLastRead !== true,
	};
}

/**
 * 诊断命令（`content.debug`）：把 `content` 将要注入页面的脚本**原样返回**，不执行。
 *
 * 用途：当 `content` 报出「某个标识符 is not defined」而页面侧 `window.onerror` 又没触发时，
 * 说明错误发生在 service worker 拼脚本的阶段（模板插值里引用了不存在的标识符）。
 * 此时唯一能定位的办法就是把真实脚本 dump 出来看。
 */
async function cmdContentDebug(params) {
	const mode = params.mode === 'html' ? 'html' : 'text';
	const frameSpec = params.frame === undefined ? null : String(params.frame);
	const flatten = params.flattenFrames !== false;
	const script = buildContentScript(mode, frameSpec, flatten);
	return {
		mode, frameSpec, flatten, scriptLength: script.length,
		hasBareFrameset: /(^|[^'"\w.])frameset\s*[),;]/.test(script),
		script,
	};
}

/**
 * Enumerate the frame tree of a tab: 老式 frameset 页面必须先看结构，才知道该读哪一帧。
 * 返回每个 frame 的 index/name/src/url/是否同源，以及一段文本预览。
 */
async function cmdFrames(params) {
	const tab = await resolveTab(params.tabId);
	return withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression: `(() => {
			${FRAME_HELPER}
			const frames = listFrames(document, [], 0);
			return JSON.stringify({
				title: document.title, url: location.href,
				isFrameset: !!document.querySelector('frameset'), hasBody: !!document.body,
				count: frames.length,
				frames: frames.map((f, i) => ({
					index: i, name: f.name, src: f.src, url: f.url, sameOrigin: !!f.doc,
					textPreview: textOf(f.doc).trim().replace(/\\s+/g, ' ').slice(0, 140) || undefined,
				})),
			});
		})()`,
		awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((res) => {
		if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
		return { tabId: tab.id, ...JSON.parse(res.result.value) };
	}));
}

async function cmdFind(params) {
	if (!params.selector) throw new Error('params.selector is required');
	const limit = Math.max(1, Math.min(50, Number(params.limit) || 10));
	const tab = await resolveTab(params.tabId);
	const payload = await withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression: `(() => {
			${DEEP_HELPER}
			const els = __dshDeepAll(${JSON.stringify(String(params.selector))});
			return JSON.stringify({
				count: els.length,
				items: els.slice(0, ${limit}).map((el) => {
					const r = el.getBoundingClientRect();
					return {
						tag: el.tagName.toLowerCase(), id: el.id || undefined,
						class: String(el.className || '').slice(0, 120) || undefined,
						text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 160) || undefined,
						href: el instanceof Element && el.hasAttribute('href') ? el.getAttribute('href') : undefined,
						rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
					};
				}),
			});
		})()`,
		awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((res) => JSON.parse(res.result.value)));
	return { tabId: tab.id, selector: params.selector, ...payload };
}

async function cmdClick(params) {
	if (!params.selector) throw new Error('params.selector is required');
	const tab = await resolveTab(params.tabId);
	// Mouse events land on whatever is under the viewport coordinates of the
	// focused tab; ensure our tab is frontmost so coordinates are meaningful.
	const activation = await activateTabWindow(tab.id);
	// 输入面前置检查：最小化且视口 0×0 才拒；窗口被改过大小会在回执里如实报出来。
	const surface = await withCDP(tab.id, (send) => inputSurface(tab.id, send, activation, '点击'));
	return withCDP(tab.id, async (send) => withHoldPassthrough(send, async (bypassed) => {
		await assertNotAborted(send, 'click')
		const hit = await send('Runtime.evaluate', {
			expression: `(() => {
				${DEEP_HELPER}
				const picked = __dshPick(${JSON.stringify(String(params.selector))}, ${JSON.stringify(fingerprintFor(params.selector))});
				const el = picked.el;
				if (!el) return null;
				el.scrollIntoView({ block: 'center', inline: 'center' });
				const r = el.getBoundingClientRect();
				// elementFromPoint at the intended hit point catches overlays
				// (sticky headers, ads) that would swallow the click.
				const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
				const topEl = document.elementFromPoint(x, y);
				// shadow 内的元素：elementFromPoint 只会返回宿主元素，命中判定要跨过 shadow 边界。
				const isTop = topEl === el || el.contains(topEl)
					|| (topEl !== null && topEl.shadowRoot !== null && topEl.shadowRoot.contains(el));
				return { x, y, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 120),
					hitTag: topEl ? topEl.tagName.toLowerCase() : null, isTop, relocated: picked.relocated === true };
			})()`,
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((res) => {
			if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
			return res.result.value;
		});
		if (!hit) throw new Error(`element not found: ${params.selector}`);
		const clickCount = params.doubleClick ? 2 : 1;
		await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.x, y: hit.y });
		await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount });
		await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', clickCount });
		return {
			tabId: tab.id,
			clicked: { x: hit.x, y: hit.y, tag: hit.tag, text: hit.text },
			hitVerified: hit.isTop,
			...(hit.isTop ? {} : { hitInstead: hit.hitTag }),
			// 浮层挡的是人、不是模型：这次点击是在「把自己的浮层临时对指针透明」的状态下派发的。
			...(bypassed ? { bypassedOwnOverlay: true } : {}),
			...(surface.windowState === undefined ? {} : { windowState: surface.windowState }),
			...(surface.restored ? { windowRestored: true } : {}),
			viewport: surface.viewport.size,
			...(surface.viewport.changed ? { viewportChanged: true, previousViewport: surface.viewport.previous } : {}),
			dialogsAnswered: dialogLog.filter((d) => d.tabId === tab.id && Date.now() - d.t < 5000).length,
		};
	}));
}

async function cmdInput(params) {
	if (!params.selector) throw new Error('params.selector is required');
	if (params.value === undefined) throw new Error('params.value is required');
	const tab = await resolveTab(params.tabId);
	// 'type' mode drives the real keyboard pipeline (Input.insertText per
	// keystroke) so stateful components (React-controlled, search bars with
	// internal suggestion state) observe every character. 'fill' (default)
	// sets the value directly — fast, but bypasses component keystroke logic.
	const mode = params.mode === 'type' ? 'type' : 'fill';
	// Real key events require the tab to have OS-level focus; activate first.
	let surface = undefined;
	if (mode === 'type') {
		const activation = await activateTabWindow(tab.id);
		surface = await withCDP(tab.id, (send) => inputSurface(tab.id, send, activation, '键盘输入'));
	}

	// Locate + focus + clear in one evaluate, shared by both modes.
	const located = await withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression: `(() => {
			${DEEP_HELPER}
			const picked = __dshPick(${JSON.stringify(String(params.selector))}, ${JSON.stringify(fingerprintFor(params.selector))});
			const el = picked.el;
			if (!el) return null;
			el.scrollIntoView({ block: 'center', inline: 'center' });
			el.focus();
			let tag = el.tagName.toLowerCase();
			let cleared = '';
			if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
				const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
				Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
				el.dispatchEvent(new Event('input', { bubbles: true }));
				tag = tag + '[' + (el.getAttribute('type') || 'text') + ']';
				cleared = '';
			} else if (el.isContentEditable) {
				el.textContent = '';
				el.dispatchEvent(new InputEvent('input', { bubbles: true }));
			} else if (el instanceof HTMLSelectElement) {
				tag = 'select';
			}
			return { tag, relocated: picked.relocated === true };
		})()`,
		awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((res) => {
		if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
		return res.result.value;
	}));
	if (!located) throw new Error(`element not found: ${params.selector}`);

	if (mode === 'fill') {
		const result = await withCDP(tab.id, (send) => send('Runtime.evaluate', {
			expression: `(() => {
				const el = document.querySelector(${JSON.stringify(String(params.selector))});
				const value = ${JSON.stringify(String(params.value))};
				if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
					const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
					Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				} else if (el.isContentEditable) {
					el.textContent = value;
					el.dispatchEvent(new InputEvent('input', { bubbles: true }));
				} else if (el instanceof HTMLSelectElement) {
					el.value = value;
					el.dispatchEvent(new Event('change', { bubbles: true }));
				} else {
					el.textContent = value;
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				}
				return { tag: el.tagName.toLowerCase(), value: String(el.value ?? el.textContent ?? '') };
			})()`,
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((res) => {
			if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
			return res.result.value;
		}));
		return { tabId: tab.id, mode, filled: result };
	}

	// 'type' mode: per-character real key events. dispatchKeyEvent with the
	// text field performs a full keyDown→char→keyUp; insertText would skip
	// per-key keydown handlers, so we use rawKeyDown+char for letters and
	// dispatchKeyEvent(text=…) for everything else.
	const text = String(params.value);
	return withCDP(tab.id, async (send) => {
		for (const ch of text) {
			if (ch === '\n') {
				await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', windowsVirtualKeyCode: 13, code: 'Enter', text: '\r' });
				await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13, code: 'Enter' });
				continue;
			}
			// Non-ASCII (CJK, emoji) cannot travel through keyEvent text — the
			// protocol mangles them to '?'. Route them through insertText which
			// performs a real composition-style insertion; ASCII keeps full
			// keyDown/char/keyUp so per-key handlers still fire.
			if (ch.charCodeAt(0) > 127 || ch.codePointAt(0) > 0xFFFF) {
				await send('Input.insertText', { text: ch });
				continue;
			}
			await send('Input.dispatchKeyEvent', {
				type: 'keyDown', key: ch, text: ch, unmodifiedText: ch,
				windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
			});
			// NOTE: no separate 'char' event — Chrome inserts the character from
			// keyDown's text field; an explicit char event duplicates the input.
			await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
		}
		// Read back what actually landed in the element.
		const readBack = await send('Runtime.evaluate', {
			expression: `(() => {
				const el = document.querySelector(${JSON.stringify(String(params.selector))});
				if (!el) return null;
				return { tag: el.tagName.toLowerCase(), value: String(el.value ?? el.textContent ?? '') };
			})()`,
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((res) => res.result.value);
		return { tabId: tab.id, mode, filled: readBack };
	});
}

const KEY_CODES = {
	Enter: [13, 'Enter'], Tab: [9, 'Tab'], Escape: [27, 'Escape'],
	Backspace: [8, 'Backspace'], Delete: [46, 'Delete'], Space: [32, 'Space'],
	ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'],
	ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
	Home: [36, 'Home'], End: [35, 'End'],
	PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'],
};
const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, command: 4, shift: 8 };

/**
 * 把 `key` 里写的组合键拆开：`"Ctrl+A"` / `"Shift+ArrowRight"` 与 `modifiers: ["ctrl"]` 等价。
 * 只有长度 > 1 且含 `+` 才当组合串 —— `+` 与 `=` 本身就是单字符键。
 * 来源：上游 v1.0.11（我们此前只认 `modifiers` 数组）。
 */
function parseKeySpec(key, rawModifiers) {
	const mods = new Set((Array.isArray(rawModifiers) ? rawModifiers : []).map((m) => String(m).toLowerCase()));
	const parts = key.length > 1 && key.includes('+') ? key.split('+') : [key];
	const finalKey = parts.pop();
	for (const part of parts) {
		const name = part.trim().toLowerCase();
		if (!(name in MODIFIER_BITS)) {
			throw new Error(`unknown modifier "${part.trim()}" in key "${key}". Valid: alt, ctrl/control, meta/command, shift —— 也可以分开写 modifiers: ["ctrl"] + key: "a"。`);
		}
		mods.add(name);
	}
	return { key: finalKey, modifiers: [...mods] };
}

async function cmdPress(params) {
	const rawKey = String(params.key ?? '');
	if (rawKey.length === 0) throw new Error('params.key is required');
	const parsed = parseKeySpec(rawKey, params.modifiers);
	const key = parsed.key;
	const modifierNames = parsed.modifiers;
	const tab = await resolveTab(params.tabId);
	// Key events need OS focus; a background tab swallows them silently.
	const activation = await activateTabWindow(tab.id);
	const surface = await withCDP(tab.id, (send) => inputSurface(tab.id, send, activation, '按键'));
	let keyCode, code;
	if (KEY_CODES[key]) { [keyCode, code] = KEY_CODES[key]; }
	else if (key.length === 1) {
		keyCode = key.toUpperCase().charCodeAt(0);
		if (/^[a-z]$/i.test(key)) code = `Key${key.toUpperCase()}`;
		else if (/^[0-9]$/.test(key)) code = `Digit${key}`;
	}
	const text = params.text !== undefined
		? String(params.text)
		: key === 'Enter' ? '\r' // '\r' makes keyDown perform implicit form submission
		: key.length === 1 && !modifierNames.some((m) => m in MODIFIER_BITS && m !== 'shift') ? key : undefined;
	let modifiers = 0;
	for (const m of modifierNames) modifiers |= MODIFIER_BITS[String(m).toLowerCase()] ?? 0;
	// 未知键名以前会**静默**把 undefined 的 keyCode/code 发出去：Chrome 什么都不做，调用方
	// 却收到成功 —— 静默失败比失败本身更糟（上游 v1.0.11 的教训）。
	if (keyCode === undefined) {
		throw new Error(`unknown key "${rawKey}". 可用 ${Object.keys(KEY_CODES).join(', ')}、单个字符，或 "Ctrl+A" / "Shift+ArrowRight" 这类组合。`);
	}
	return withCDP(tab.id, async (send) => {
		await assertNotAborted(send, 'press')
		// `type:'keyDown'` 带 `text` 时，Chrome 自己就会补一个 char/keypress —— 这里**不能再显式发
		// 一条 `char`**（`rawKeyDown` 才是不补 char 的那个）。多发一次的后果是每个字符插两遍：
		// 输入框里按一次 `x` 得到 `xx`，按一次 `Enter` 表单提交两次（`browser_type` 的
		// `submit:true` 走同一条通道，也一样）。真机前后对照见 NOTE.md「press 双倍输入」一节。
		await send('Input.dispatchKeyEvent', {
			type: 'keyDown', key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code, text, unmodifiedText: text, modifiers,
		});
		await send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code, modifiers });
		return {
			tabId: tab.id, key,
			...(surface.windowState === undefined ? {} : { windowState: surface.windowState }),
			...(surface.restored ? { windowRestored: true } : {}),
			viewport: surface.viewport.size,
			...(surface.viewport.changed ? { viewportChanged: true, previousViewport: surface.viewport.previous } : {}),
		};
	});
}

async function cmdScreenshot(params) {
	const tab = await resolveTab(params.tabId);
	const format = params.format === 'jpeg' ? 'jpeg' : 'png';
	const res = await withCDP(tab.id, async (send) => {
		// 截图时先把我们那层浮层藏起来：黑名单模式下它本来就在页面上，截出来会是一张暗图带卡片。
		const restoreOverlay = await send('Runtime.evaluate', {
			expression: '(() => { var el = document.getElementById("__dsh_hold_overlay__"); if (!el) return false; var prev = el.style.visibility; el.style.visibility = "hidden"; return prev === "" ? "\u0000" : prev; })()',
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((r) => (r && r.result && typeof r.result.value === 'string' ? r.result.value : null)).catch(() => null);
		try {
		// Element capture: resolve the selector to a CSS-pixel rect, then pass
		// it as clip. Page.captureScreenshot's clip is in CSS pixels and it
		// handles DPR internally (unlike raw base64 math).
		if (params.selector) {
			const rect = await send('Runtime.evaluate', {
				expression: `(() => {
					const el = document.querySelector(${JSON.stringify(String(params.selector))});
					if (!el) return null;
					el.scrollIntoView({ block: 'center', inline: 'center' });
					const r = el.getBoundingClientRect();
					return { x: r.left, y: r.top, width: r.width, height: r.height };
				})()`,
				awaitPromise: false, returnByValue: true, userGesture: true,
			}).then((r) => {
				if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
				return r.result.value;
			});
			if (!rect) throw new Error(`element not found: ${params.selector}`);
			return send('Page.captureScreenshot', {
				format,
				quality: format === 'jpeg' ? Math.min(100, Math.max(1, Number(params.quality) || 80)) : undefined,
				clip: { ...rect, scale: 1 },
			}).then((shot) => ({ shot, elementRect: rect }));
		}
		const shot = await send('Page.captureScreenshot', {
			format,
			quality: format === 'jpeg' ? Math.min(100, Math.max(1, Number(params.quality) || 80)) : undefined,
			captureBeyondViewport: Boolean(params.fullPage),
		});
		return { shot };
		} finally {
			if (restoreOverlay !== null) {
				await send('Runtime.evaluate', {
					expression: `(() => { var el = document.getElementById("__dsh_hold_overlay__"); if (el) el.style.visibility = ${JSON.stringify(restoreOverlay === '\u0000' ? '' : restoreOverlay)}; })()`,
					awaitPromise: false, returnByValue: true,
				}).catch(() => {});
			}
		}
	});
	return {
		tabId: tab.id,
		format,
		base64: res.shot.data,
		tabTitle: tab.title,
		tabUrl: tab.url,
		...(res.elementRect ? {
			elementRect: {
				x: Math.round(res.elementRect.x), y: Math.round(res.elementRect.y),
				w: Math.round(res.elementRect.width), h: Math.round(res.elementRect.height),
			},
		} : {}),
	};
}

async function cmdScroll(params) {
	const tab = await resolveTab(params.tabId);
	const dx = Number.isFinite(Number(params.x)) ? Number(params.x) : 0;
	const dy = Number.isFinite(Number(params.y)) ? Number(params.y) : 0;
	return withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression: `(() => {
			window.scrollBy({ left: ${JSON.stringify(dx)}, top: ${JSON.stringify(dy)}, behavior: 'instant' });
			return { tabId: ${tab.id}, scrollX: window.scrollX, scrollY: window.scrollY,
				pageHeight: document.documentElement.scrollHeight, viewportHeight: window.innerHeight };
		})()`,
		awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((res) => res.result.value));
}

/**
 * 快照给每个 ref 留一枚**指纹**（tag / 可访问名 / role）。重渲染会把元素整个换掉，
 * 打在旧元素上的 `data-dsh-ref` 随之消失 —— 只靠选择器必然"点了找不到"。点击/输入在前三种
 * 手段都不中时，用指纹在同一份快照的可交互元素里按名字重定位一次（`relocated: true` 回给调用方）。
 *
 * 只在 SW 内存里活：service worker 被回收后指纹表清空，此时退回"找不到就是找不到"，
 * 不做无根据的猜测。
 */
const refFingerprints = new Map()
/**
 * 指纹与"上次读取签名"同样逃不过 SW 回收。它们只在 MV3 的 session 区（浏览器关掉才清），
 * 所以快照 → 点击之间隔几分钟也能重定位。读不出来就退回内存版（不会报错）。
 */
const REF_FP_KEY = 'refFingerprints'
const LAST_READ_KEY = 'lastReadSignatures'
let refStateLoaded = false

async function persistRefState() {
	try {
		await chrome.storage.session.set({
			[REF_FP_KEY]: Object.fromEntries(refFingerprints),
			[LAST_READ_KEY]: Object.fromEntries(lastReadSignature),
		})
	} catch { /* session 区不可用就只留内存 */ }
}

async function ensureRefState() {
	if (refStateLoaded) return
	try {
		const got = await chrome.storage.session.get([REF_FP_KEY, LAST_READ_KEY])
		const fps = got && got[REF_FP_KEY]
		if (fps && typeof fps === 'object') {
			for (const [key, value] of Object.entries(fps)) {
				if (value && typeof value === 'object') refFingerprints.set(key, value)
			}
		}
		const reads = got && got[LAST_READ_KEY]
		if (reads && typeof reads === 'object') {
			for (const [key, value] of Object.entries(reads)) {
				const id = Number(key)
				if (Number.isInteger(id) && typeof value === 'string') lastReadSignature.set(id, value)
			}
		}
	} catch { /* 忽略：内存版照样能跑 */ }
	refStateLoaded = true
}
/** 从 `[data-dsh-ref="e7"]` 这种选择器里取出 ref 号。 */
function refOfSelector(selector) {
	const match = /^\[data-dsh-ref="(e\d+)"\]$/.exec(String(selector ?? '').trim())
	return match === null ? undefined : match[1]
}
/** 给注入脚本用的指纹（没有就返回 null，脚本按纯选择器处理）。 */
function fingerprintFor(selector) {
	const ref = refOfSelector(selector)
	if (ref === undefined) return null
	const fingerprint = refFingerprints.get(ref)
	return fingerprint === undefined ? null : fingerprint
}

/** tabId -> 上一次 `content` 的正文签名：用来回答"页面在这两次读取之间变过吗"。 */
const lastReadSignature = new Map()

/** All CDP message variants that mean "the page went away mid-evaluation". */
const CONTEXT_DESTROYED_RE = /Execution context was destroyed|Cannot find default execution context|Inspected target navigated or closed/i;

// 原生可交互判据（属性/标签层面）。
const SNAPSHOT_SELECTOR = 'a[href], button, input, select, textarea, [contenteditable="true"], [onclick], '
	+ '[role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="menuitem"], '
	+ '[role="option"], [role="switch"], [role="combobox"], [role="textbox"], [role="slider"], [role="spinbutton"], '
	+ '[tabindex]:not([tabindex="-1"])';

// 只带点击处理器、**没有任何可查询属性**的 div/span（淘宝 SKU 芯片、拼多多商品卡）只能靠样式识别：
// `cursor: pointer`。注意 CSS `cursor` 是**继承**属性 ⇒ 判定"可点容器"要用**样式边界**
// （自己 pointer、父级不是 pointer），否则容器的每个子节点都会被算成候选。
const SNAPSHOT_SCAN_SELECTOR = SNAPSHOT_SELECTOR
	+ ', div, span, li, td, th, p, label, i, b, em, strong, figure, dt, dd, section, article, header, footer, a, h1, h2, h3, h4';
const SNAPSHOT_SCAN_CAP = 12000;

/* --------------------------------------------------- snapshot：a11y（AX）模式 */

/**
 * Agent 真能操作的 role 白名单。Chrome 自己算这些角色与**可访问名**，所以它比选择器更抗
 * DOM 改版；同时这里刻意用允许列表：`GenericContainer` / `StaticText` / `InlineTextBox`
 * 这类内部节点会把整棵树的额度吃光。
 *
 * 来源：移植自上游 caob23 v1.0.11 的 `extension/background.js`（AGPL-3.0，同许可）。
 */
const AX_ACTIONABLE_ROLES = new Set([
	'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'menuitem',
	'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'checkbox', 'switch',
	'slider', 'spinbutton', 'tab', 'treeitem', 'gridcell', 'columnheader', 'rowheader',
]);

/**
 * 在页面里执行：不可见的返回 null（**不占 ref 号、也不留属性**），否则打上 ref 并把
 * 这个 DOM 节点究竟是什么报回来。每个保留的元素一次往返。
 */
const AX_STAMP_FN = 'function(ref){'
	+ 'var r = this.getBoundingClientRect();'
	+ 'if (r.width === 0 && r.height === 0) return null;'
	// 接管浮层里也有可操作节点（卡片上的「中止操作」是标准 button），但它属于扩展、
	// 不属于页面：放它进快照，模型读到的就是自己刚挂上去的那句话，还能按 ref 点到它。
	// 我们的浮层在 shadow root 里，`closest` 跨不过 shadow 边界，要顺着 getRootNode().host 找。
	+ 'var own = null;'
	+ 'try { own = this.closest ? this.closest("[data-dsh-hold]") : null; } catch (e) { own = null; }'
	+ 'if (!own && this.getRootNode) {'
	+ ' try { var root = this.getRootNode(); if (root && root.host && root.host.closest) own = root.host.closest("[data-dsh-hold]"); } catch (e) { own = null; }'
	+ '}'
	+ 'if (own) return { ownOverlay: true };'
	+ 'this.setAttribute("data-dsh-ref", ref);'
	+ 'return {'
	+ ' tag: this.tagName.toLowerCase(),'
	+ ' type: (this.type ? String(this.type) : undefined),'
	+ ' href: (this.href ? String(this.href) : undefined),'
	+ ' value: (this.value === undefined || this.value === null) ? undefined : String(this.value).slice(0, 60),'
	+ ' rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }'
	+ '};'
	+ '}';

/**
 * AX 模式：读 Chrome 的无障碍树，然后把**同一个** `data-dsh-ref` 属性打到每个可操作 a11y
 * 节点背后的真实 DOM 节点上 —— ref 契约因此保持不变（`browser_click` / `browser_type` 照样
 * 按 `[data-dsh-ref="e7"]` 解析），而模型拿到的是 `role` + 可访问名，不是猜出来的选择器。
 */
async function snapshotViaAx(send, tab, limit) {
	await send('DOM.enable').catch(() => {});
	await send('Accessibility.enable').catch(() => {});
	// 先清掉上一次快照留下的 ref：陈旧属性会让旧 ref 点到"此刻屏幕上别的东西"。
	await send('Runtime.evaluate', {
		expression: `(() => { ${DEEP_HELPER} __dshDeepAll('[data-dsh-ref]').forEach((el) => el.removeAttribute('data-dsh-ref')); return true; })()`,
		returnByValue: true,
	}).catch(() => {});
	const tree = await send('Accessibility.getFullAXTree');
	const nodes = (tree && tree.nodes) || [];
	if (!Array.isArray(nodes)) throw new Error('Accessibility.getFullAXTree 没有返回 nodes');
	const candidates = nodes.filter((node) => node
		&& node.ignored !== true
		&& node.backendDOMNodeId !== undefined
		&& AX_ACTIONABLE_ROLES.has(String(node.role && node.role.value || '').toLowerCase()));
	const items = [];
	const skipped = { unresolved: 0, invisible: 0 };
	/** 被跳过的「扩展自己的浮层」节点数：不占 ref、不计入 total，单独回报。 */
	let ownOverlay = 0;
	for (const node of candidates) {
		if (items.length >= limit) break;
		const ref = 'e' + (items.length + 1);
		let resolved = null;
		try {
			resolved = await send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId });
		} catch {
			resolved = null;
		}
		const objectId = resolved && resolved.object && resolved.object.objectId;
		if (!objectId) { skipped.unresolved += 1; continue; }
		let call = null;
		try {
			call = await send('Runtime.callFunctionOn', {
				objectId, functionDeclaration: AX_STAMP_FN, arguments: [{ value: ref }], returnByValue: true,
			});
		} catch {
			skipped.unresolved += 1;
			continue;
		}
		if (call && call.exceptionDetails) { skipped.unresolved += 1; continue; }
		const geo = call && call.result ? call.result.value : null;
		if (geo && geo.ownOverlay === true) { ownOverlay += 1; continue; }
		if (!geo) { skipped.invisible += 1; continue; }
		items.push({
			ref,
			tag: geo.tag,
			why: 'ax',
			role: String(node.role && node.role.value || '').toLowerCase() || undefined,
			name: String(node.name && node.name.value || '').replace(/\s+/g, ' ').slice(0, 80) || undefined,
			type: geo.type,
			href: geo.href,
			value: geo.value,
			rect: geo.rect,
		});
	}
	const meta = await send('Runtime.evaluate', {
		expression: 'JSON.stringify({ title: document.title, url: location.href })',
		returnByValue: true,
	}).then((r) => {
		try { return JSON.parse(String(r.result && r.result.value)); } catch { return {}; }
	}).catch(() => ({}));
	return {
		tabId: tab.id,
		mode: 'ax',
		title: meta.title,
		url: meta.url,
		total: candidates.length - ownOverlay,
		ax: { nodes: nodes.length, candidates: candidates.length, ownOverlay, ...skipped },
		items,
	};
}

async function cmdSnapshot(params) {
	const tab = await resolveTab(params.tabId);
	const limit = Math.min(200, Math.max(1, Number(params.limit) || 120));
	const wantAx = String(params.mode ?? params.source ?? 'dom').toLowerCase() === 'ax';
	return withCDP(tab.id, async (send) => {
		await send('Runtime.enable').catch(() => {});
		// AX 是可选项：页面给不出无障碍树时**不**让整次调用失败，而是落回 DOM 并报明原因
		// （上游 v1.0.11 的口径；插件侧还会再兜一层"旧扩展静默忽略 mode:ax"）。
		let axFallback;
		if (wantAx) {
			try {
				const ax = await snapshotViaAx(send, tab, limit);
				ax.limitedTo = limit;
				return ax;
			} catch (error) {
				axFallback = String((error && error.message) || error);
			}
		}
		const payload = await send('Runtime.evaluate', {
			expression: `(() => {
				const ATTR = 'data-dsh-ref';
				${DEEP_HELPER}
				__dshDeepAll('[' + ATTR + ']').forEach((el) => el.removeAttribute(ATTR));
				const NATIVE = ${JSON.stringify(SNAPSHOT_SELECTOR)};
				const scan = __dshDeepAll(${JSON.stringify(SNAPSHOT_SCAN_SELECTOR)});
				const truncated = scan.length > ${SNAPSHOT_SCAN_CAP};
				const nodes = truncated ? scan.slice(0, ${SNAPSHOT_SCAN_CAP}) : scan;
				const seen = new Set();
				const candidates = [];
				let cursorCount = 0;
				for (const el of nodes) {
					if (seen.has(el)) continue;
					let why = null;
					try { if (el.matches(NATIVE)) why = 'native'; } catch { /* 选择器不支持该元素，忽略 */ }
					if (why === null) {
						// 样式边界：自己 pointer、父级不是 pointer（cursor 继承）。
						let style = null;
						try { style = getComputedStyle(el); } catch { style = null; }
						if (style === null || style.cursor !== 'pointer') continue;
						if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') continue;
						const parent = el.parentElement;
						let parentCursor = '';
						try { parentCursor = parent === null ? '' : getComputedStyle(parent).cursor; } catch { parentCursor = ''; }
						if (parentCursor === 'pointer') continue;
						const box = el.getBoundingClientRect();
						if (box.width < 8 || box.height < 8) continue;                                   // 装饰性小点
						if (box.width * box.height > innerWidth * innerHeight * 0.8) continue;           // 整页壳子
						why = 'cursor';
					}
					seen.add(el);
					candidates.push({ el, why });
				}
				const items = [];
				let n = 0;
				for (const candidate of candidates) {
					if (items.length >= ${limit}) break;
					const el = candidate.el;
					const r = el.getBoundingClientRect();
					if (r.width === 0 && r.height === 0) continue;
					if (candidate.why === 'cursor') cursorCount += 1;
					const ref = 'e' + (++n);
					el.setAttribute(ATTR, ref);
					const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
					items.push({
						ref, tag: el.tagName.toLowerCase(), why: candidate.why,
						type: el.getAttribute('type') || undefined,
						role: el.getAttribute('role') || undefined,
						name: (el.getAttribute('aria-label') || el.getAttribute('placeholder')
							|| (el.textContent || '').trim().replace(/\\s+/g, ' ')).slice(0, 80) || undefined,
						value: isField || el instanceof HTMLSelectElement ? String(el.value ?? '').slice(0, 60) : undefined,
						href: el.hasAttribute('href') ? el.href : undefined,
						rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
					});
				}
				return { tabId: ${tab.id}, title: document.title, url: location.href,
					total: candidates.length, cursorCandidates: cursorCount, scanned: nodes.length, scanTruncated: truncated,
					deepScanned: __dshDeepAll('*').length > document.querySelectorAll('*').length ? true : undefined,
					items };
			})()`,
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((res) => {
			if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
			return res.result.value;
		});
		payload.mode = 'dom';
		// ref 指纹：给 click/input 在"元素被重建"时留一条重定位的路。
		refFingerprints.clear();
		for (const item of Array.isArray(payload.items) ? payload.items : []) {
			if (typeof item?.ref !== 'string') continue;
			refFingerprints.set(item.ref, {
				ref: item.ref,
				tag: typeof item.tag === 'string' ? item.tag : undefined,
				name: typeof item.name === 'string' ? item.name : undefined,
				role: typeof item.role === 'string' ? item.role : undefined,
			});
		}
		await persistRefState();
		if (axFallback !== undefined) payload.axFallback = axFallback;
		payload.limitedTo = limit;
		return payload;
	});
}

/* ------------------------------------------------------ 本地硬锁（panic switch） */

/**
 * 用户在扩展图标里按下的「锁定」开关：**扩展保持连接，但拒绝一切操作**，
 * 直到用户回到扩展图标解除。存在 `chrome.storage.local`，浏览器重启也还在。
 *
 * 为什么锁与解锁都在扩展侧：真正的边界要落在模型够不到的地方。DSH 设置页对模型是可达的
 * （「允许访问本 DSH 页面」开着时更是如此），把解锁放在页面里等于"跑偏的模型可以自己解锁"。
 */
const HARD_LOCK_KEY = 'hardLock';
/** 锁定期间仍放行的命令：只读的身份/状态查询，让用户与模型都看得到"锁着"。 */
const HARD_LOCK_ALLOWED = new Set(['ping', 'browser.info', 'lock.status']);

let hardLocked = false;
let hardLockLoaded = false;

async function readHardLock() {
	try {
		const got = await chrome.storage.local.get(HARD_LOCK_KEY);
		hardLocked = got && got[HARD_LOCK_KEY] === true;
	} catch { hardLocked = false; }
	hardLockLoaded = true;
	return hardLocked;
}

/**
 * 保证锁定状态已从 storage 读回（幂等）。
 *
 * 为什么必须这样：MV3 的 service worker 会被浏览器回收再唤醒，`let hardLocked` 会回到 false。
 * 早先的实现是在模块顶层 `void readHardLock()`，但那一行落在 `let hardLocked` **之前**，
 * 于是每次唤醒都抛 `Cannot access 'hardLocked' before initialization`，读也没读成 ——
 * 结果就是"重启一次浏览器/扩展后，锁看着还在、其实已经失效"。现在每次命令执行前都先确保读回。
 */
async function ensureHardLock() {
	if (hardLockLoaded) return hardLocked;
	return readHardLock();
}

async function setHardLock(next) {
	hardLocked = next === true;
	try { await chrome.storage.local.set({ [HARD_LOCK_KEY]: hardLocked }); } catch { /* 存不下也本次生效 */ }
	return hardLocked;
}

/* 浮层模式（白名单/黑名单）由桥下发；见 cmdHoldConfig 与 runCommand 里的 maybeAutoHold。
 * 白名单：只在模型主动调 browser_hold 时出现（行为与以前一致）。
 * 黑名单：模型**开始操作**某个标签页时自动补一层；用户双击接管或模型 hold.off 之后，
 *         这个标签页本会话不再自动加（否则用户刚接管完、模型下一步又盖上来，等于没接管）。 */
let holdMode = 'white';
let holdAutoSuppressedTabs = new Set();
/**
 * MV3 的 service worker 会被浏览器回收再唤醒：模块里的 `let` 会回到初值。
 * 如果模式只存在内存里，回收一次就退回白名单（2026-10-19 深夜实测：手动设成 black 后
 * 隔几分钟再点，浮层再也不出现）。所以模式与抑制表都落 chrome.storage.local，
 * 每次命令前按需读回（与硬锁同一套写法）。
 */
const HOLD_MODE_KEY = 'holdMode';
const HOLD_SUPPRESS_KEY = 'holdSuppressed';
let holdStateLoaded = false;

async function persistHoldState() {
	try {
		await chrome.storage.local.set({
			[HOLD_MODE_KEY]: holdMode,
			[HOLD_SUPPRESS_KEY]: [...holdAutoSuppressedTabs].slice(-50),
		});
	} catch { /* 存不下也本次生效 */ }
}

async function ensureHoldState() {
	if (holdStateLoaded) return;
	try {
		const got = await chrome.storage.local.get([HOLD_MODE_KEY, HOLD_SUPPRESS_KEY]);
		holdMode = got && got[HOLD_MODE_KEY] === 'black' ? 'black' : 'white';
		const list = got && Array.isArray(got[HOLD_SUPPRESS_KEY]) ? got[HOLD_SUPPRESS_KEY] : [];
		holdAutoSuppressedTabs = new Set(list.filter((id) => typeof id === 'number'));
	} catch {
		holdMode = 'white';
		holdAutoSuppressedTabs = new Set();
	}
	holdStateLoaded = true;
}
const HOLD_AUTO_COMMANDS = new Set(['click', 'input', 'press', 'scroll', 'nav', 'eval']);
const HOLD_AUTO_TEXT = '模型正在操作这个页面';

/**
 * 黑名单模式下，操作前补浮层。返回"这次动过哪个标签页"（没动就 undefined），
 * 供 runCommand 在命令结束后判断"浮层是不是被用户撤了"。
 */
/** 自动补层的诊断计数（`hold.status` 会带出来；排查"黑名单没生效"时不靠猜）。 */
const holdAutoStats = { attempts: 0, added: 0, skips: {}, lastError: null };
function noteHoldSkip(reason) {
	holdAutoStats.skips[reason] = (holdAutoStats.skips[reason] || 0) + 1;
}

async function maybeAutoHold(params) {
	if (holdMode !== 'black') { noteHoldSkip('mode-white'); return undefined; }
	holdAutoStats.attempts += 1;
	let tab;
	try { tab = await resolveTab(params && params.tabId); } catch (error) { noteHoldSkip('no-tab:' + String((error && error.message) || error).slice(0, 80)); return undefined; }
	if (!tab || typeof tab.id !== 'number') { noteHoldSkip('no-tab'); return undefined; }
	if (holdAutoSuppressedTabs.has(tab.id)) { noteHoldSkip('suppressed'); return undefined; }
	// 一次探测同时回答两件事：浮层在不在、以及**上一次是谁撤的**。
	// 用户双击接管后浮层是自己消失的（不走任何命令），所以只能在下一枪之前读页面的 `window.__dshHold`；
	// 若上一次是用户撤的（user/abort），这个标签页本会话就不再自动补 —— 否则接管等于没接管。
	const state = await withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression: '(() => { var s = window.__dshHold || null; return { active: !!document.getElementById("__dsh_hold_overlay__"), dismissedBy: s ? s.dismissedBy : null, aborted: s ? s.aborted === true : false, closedAt: s ? s.closedAt : null }; })()',
		awaitPromise: false, returnByValue: true, userGesture: true,
	})).then((res) => (res && res.result && res.result.value ? res.result.value : { active: true })).catch((error) => {
		holdAutoStats.lastError = 'probe: ' + String((error && error.message) || error).slice(0, 120);
		return { active: true };
	});
	if (state.active) { noteHoldSkip('already-present'); return undefined; }
	if (state.aborted === true) { noteHoldSkip('aborted'); return undefined; }
	if (state.dismissedBy === 'user' || state.dismissedBy === 'abort') {
		holdAutoSuppressedTabs.add(tab.id);
		noteHoldSkip('user-took-over');
		await persistHoldState();
		return undefined;
	}
	try {
		await cmdHoldOn({ tabId: tab.id, text: HOLD_AUTO_TEXT });
		holdAutoStats.added += 1;
		return tab.id;
	} catch (error) {
		holdAutoStats.lastError = 'inject: ' + String((error && error.message) || error).slice(0, 120);
		noteHoldSkip('inject-failed');
		return undefined;
	}
}

/** 命令跑完：浮层原本在、现在没了 ⇒ 用户双击/按 Esc 撤的 ⇒ 这个标签页别再自动加。 */
async function suppressAutoHoldIfTaken(tabId) {
	const present = await withCDP(tabId, (send) => send('Runtime.evaluate', {
		expression: '!!document.getElementById("__dsh_hold_overlay__")',
		awaitPromise: false, returnByValue: true, userGesture: true,
	})).then((res) => !!(res && res.result && res.result.value === true)).catch(() => true);
	if (!present) {
		holdAutoSuppressedTabs.add(tabId);
		await persistHoldState();
	}
}

/* ------------------------------------------------------------ 防误触浮层（hold） */

/**
 * 在页面里装一个"防误触浮层"：整页变暗 + 中央一张卡片写清"模型在做什么"，
 * **用户连续点两下任意处（600ms 内）即可撤掉浮层接管页面**。
 *
 * 设计原则（2026-10-17 按主人要求定）：**它是页面之上的一层，不改页面本身的逻辑。**
 *  - 只往 `<html>` 追加**一个**元素，撤掉时**只删它自己**；页面已有的元素、样式、事件监听一概不碰；
 *  - 内容全部装在 **Shadow DOM** 里 ⇒ 双向隔离：页面 CSS 进不来（不会被你的全局样式搞变形），
 *    我们的样式也漏不出去（不会命中页面的选择器）；
 *  - 指针/滚轮只在**我们自己这层**上拦（拦的是"点在浮层上"的那些事件），页面自己的监听照常存在；
 *  - **不抢焦点、不拦键盘**（默认）：键盘输入仍会落到当前焦点，这是为"零干扰"付的代价；
 *    真要连输入一起冻住，调用方可以传 `blockKeys: true`（那时才临时在 window 上加一个拦截器，撤销时移除）；
 *  - 用 shadow root 内的 `dataset` 记状态，导出一份只读的 `window.__dshHold` 供 `hold.status` 查"谁撤的"。
 */
function pageShowHold(payload) {
	const ID = '__dsh_hold_overlay__';
	const prev = document.getElementById(ID);
	if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
	const host = document.createElement('div');
	host.id = ID;
	host.setAttribute('data-dsh-hold', '1');
	host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;display:block';
	const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
	const wrap = document.createElement('div');
	// 页面只压暗（0.45），中央是**半透明面板、不做毛玻璃**；页面内容透过它看得见。
	wrap.style.cssText = [
		'position:fixed', 'inset:0', 'display:flex', 'align-items:center', 'justify-content:center',
		'background:rgba(8,10,14,0.45)', 'cursor:pointer', 'transition:background 120ms ease',
		'font:14px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif', 'color:#ffffff',
	].join(';');
	const card = document.createElement('div');
	card.style.cssText = [
		'max-width:min(620px,88vw)', 'padding:14px 20px', 'border-radius:14px',
		'background:rgba(10,12,16,0.58)', 'border:1px solid rgba(255,255,255,0.16)',
		'box-shadow:0 8px 28px rgba(0,0,0,0.28)',
		'text-align:center', 'pointer-events:none',
		'text-shadow:0 1px 2px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.6)',
	].join(';');
	const title = document.createElement('div');
	// 标题由扩展在调本函数前填成固定常量（模型传的 title 一律忽略）。
	// 注意：本函数是 stringify 后注入页面的，不能引用扩展作用域变量（会 ReferenceError）。
	title.textContent = payload.title;
	title.style.cssText = 'font-size:19px;font-weight:600;line-height:1.45;margin-bottom:6px';
	const body = document.createElement('div');
	body.textContent = payload.text || '';
	body.style.cssText = 'font-size:14px;opacity:0.96;white-space:pre-wrap;word-break:break-word';
	const hint = document.createElement('div');
	hint.textContent = payload.hint;
	hint.style.cssText = 'margin-top:12px;font-size:12.5px;opacity:0.9;'
		+ 'border-top:1px solid rgba(255,255,255,0.18);padding-top:10px';
	card.appendChild(title);
	if (payload.text) card.appendChild(body);
	card.appendChild(hint);

	// 底部身份行：由插件从运行时上下文填（会话标题 / 目录 / 桥端口 / 时间），不经过模型 ⇒ 伪造不了。
	const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : null;
	if (meta) {
		const parts = [];
		if (meta.session) parts.push('会话 ' + meta.session);
		if (meta.cwd) parts.push(meta.cwd);
		if (meta.port) parts.push('桥 ' + meta.port);
		if (meta.at) parts.push(new Date(meta.at).toLocaleTimeString());
		if (parts.length > 0) {
			const who = document.createElement('div');
			who.textContent = parts.join(' · ');
			who.style.cssText = 'margin-top:8px;font-size:11px;line-height:1.5;opacity:0.72;'
				+ 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all';
			card.appendChild(who);
		}
	}

	// 「中止操作」按钮：**双击确认**（点一次变「点击确认」，3 秒不点回默认态）。
	// 确认后撤掉浮层并把 aborted 记进页面状态 ⇒ 扩展在之后的 click/input/press 上会拦下模型，
	// 直到模型调 hold.off 解除（等于"确认继续"）。
	const abort = document.createElement('button');
	abort.type = 'button';
	abort.textContent = payload.abortLabel;
	abort.style.cssText = 'margin-top:12px;pointer-events:auto;cursor:pointer;border-radius:999px;'
		+ 'padding:6px 16px;font:12.5px/1.4 inherit;color:#fff;background:rgba(255,255,255,0.12);'
		+ 'border:1px solid rgba(255,255,255,0.28);transition:background 120ms ease,border-color 120ms ease;'
		+ 'outline:none';
	abort.addEventListener('focus', function () { abort.style.boxShadow = '0 0 0 3px rgba(120,180,255,0.85)' });
	abort.addEventListener('blur', function () { abort.style.boxShadow = 'none' });
	card.appendChild(abort);
	// 组装：wrap ← card ← 内容；host ← shadow root ← wrap（这几行漏了就等于浮层是空的，只压了一层黑）
	wrap.appendChild(card);
	root.appendChild(wrap);

	const state = { active: true, dismissedBy: null, aborted: false, at: Date.now(), text: payload.text || '' };
	let clicks = 0;
	let firstClickAt = 0;
	let timer = null;
	let armed = false;
	let armTimer = null;
	// 按钮上的点击必须能到达按钮自己：wrap 的捕获期监听如果无脑 stopPropagation，
	// 事件根本到不了 target ⇒ 按钮永远点不动（rig 实测踩到）。所以先看路径里有没有按钮。
	function fromAbort(e) {
		try { return typeof e.composedPath === 'function' && e.composedPath().indexOf(abort) !== -1 } catch (err) { return false }
	}
	function block(e) {
		if (fromAbort(e)) return;
		e.preventDefault();
		e.stopPropagation();
	}
	function resetArm() {
		armed = false;
		abort.textContent = payload.abortLabel;
		abort.style.background = 'rgba(255,255,255,0.12)';
		abort.style.borderColor = 'rgba(255,255,255,0.28)';
	}
	function cleanup(by) {
		try { window.removeEventListener('keydown', block, true); } catch (e) { /* 已移除 */ }
		if (timer) clearTimeout(timer);
		if (armTimer) clearTimeout(armTimer);
		if (host.parentNode) host.parentNode.removeChild(host);
		// 浮层没了就把全屏监听也摘掉，否则下一次页面进全屏会白跑一趟取 DOM
		try {
			if (window.__dshHoldFsWatch) document.removeEventListener('fullscreenchange', window.__dshHoldFsWatch, true);
		} catch (e) { /* 已移除 */ }
		window.__dshHoldFsWatch = null;
		state.active = false;
		state.dismissedBy = by;
		state.closedAt = Date.now();
		window.__dshHold = state;
	}
	// **双击**接管：两次点击的间隔必须 ≤ payload.dblMs，否则当新的第一次。
	function onTap(e) {
		if (fromAbort(e)) return;
		block(e);
		const now = Date.now();
		if (clicks === 0) {
			clicks = 1;
			firstClickAt = now;
			hint.textContent = payload.hintOne;
			if (timer) clearTimeout(timer);
			timer = setTimeout(function () { clicks = 0; hint.textContent = payload.hint; }, payload.dblMs + 300);
			return;
		}
		if (now - firstClickAt <= payload.dblMs) { cleanup('user'); return; }
		clicks = 1;
		firstClickAt = now;
		hint.textContent = payload.hintOne;
	}
	['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'dblclick', 'contextmenu', 'selectstart'].forEach(function (type) {
		wrap.addEventListener(type, block, true);
	});
	wrap.addEventListener('click', onTap, true);
	wrap.addEventListener('wheel', block, { passive: false, capture: true });
	abort.addEventListener('click', function (e) {
		e.preventDefault();
		e.stopPropagation();
		if (!armed) {
			armed = true;
			abort.textContent = payload.abortConfirmLabel;
			abort.style.background = 'rgba(214,58,58,0.6)';
			abort.style.borderColor = 'rgba(255,130,130,0.9)';
			armTimer = setTimeout(resetArm, payload.armMs);
			return;
		}
		if (armTimer) clearTimeout(armTimer);
		state.aborted = true;
		cleanup('abort');
	}, true);
	['pointerdown', 'mousedown', 'mouseup', 'pointerup'].forEach(function (type) {
		abort.addEventListener(type, function (e) { e.stopPropagation(); }, true);
	});
	if (payload.blockKeys) window.addEventListener('keydown', block, true);
	window.__dshHold = state;

	// 全屏元素进的是浏览器的 **top layer**：body 层的东西盖不过它，`z-index:2147483647` 也没用
	// （2026-10-20 真机量到：全屏时 `elementFromPoint` 命中的是全屏元素本身，浮层 rect 铺满视口
	// 却根本没画出来 —— 而 `hold on` 照样回报成功，用户屏幕上什么都没有，连「中止操作」也点不到）。
	// 做法：全屏时把宿主挂进全屏元素子树，并监听 `fullscreenchange` 跟着搬；挂不进去就如实回报。
	function holdMountTarget() {
		var fs = document.fullscreenElement;
		if (fs && fs.tagName !== 'IFRAME') return fs;
		return document.documentElement;
	}
	function holdCoverage() {
		if (!host.parentNode) return { covered: false, reason: 'not-in-dom' };
		var fs = document.fullscreenElement;
		if (fs) {
			if (fs.tagName === 'IFRAME') return { covered: false, reason: 'fullscreen-iframe' };
			if (!fs.contains(host)) return { covered: false, reason: 'fullscreen-behind-top-layer' };
		}
		var el = document.elementFromPoint(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2));
		return (el && (el === host || host.contains(el))) ? { covered: true } : { covered: false, reason: 'hit-test-miss' };
	}
	holdMountTarget().appendChild(host);
	if (!window.__dshHoldFsWatch) {
		window.__dshHoldFsWatch = function () {
			var h = document.getElementById(ID);
			if (!h) return;
			var fs = document.fullscreenElement;
			var target = (fs && fs.tagName !== 'IFRAME') ? fs : document.documentElement;
			if (h.parentNode !== target) target.appendChild(h);
		};
		document.addEventListener('fullscreenchange', window.__dshHoldFsWatch, true);
	}
	// 纯键盘可达：把焦点交给浮层里的按钮 ——
	//  · Tab 进不来也没关系（焦点已在浮层内），Enter/Space 触发按钮，Esc 直接接管；
	//  · 副作用是页面里原本聚焦的输入框失焦（这是"冻结输入"的意思，比全局拦键更干净）。
	try {
		const prevFocus = document.activeElement;
		abort.focus({ preventScroll: true });
		state.prevFocus = prevFocus && prevFocus !== document.body ? true : false;
	} catch (err) { /* 页面不允许聚焦就算了，鼠标照旧可用 */ }
	// Esc 也要"两下"或"长按"才算接管 —— 单次 Esc 在页面里太常见（关弹窗、取消输入、
	// 退出全屏），一下就交出控制权等于把误触从鼠标搬到了键盘。规则与双击一致：800ms 内
	// 连按两下，或按住 600ms。给没有鼠标的人留一条明确退路，但不给误触留。
	var escLastUp = 0
	var escLongPress = 0
	var escDown = false
	wrap.addEventListener('keydown', function (e) {
		if (e.key !== 'Escape') return
		e.preventDefault()
		if (escDown) return // 长按期间系统重复的 keydown 不算"第二下"
		escDown = true
		escLongPress = setTimeout(function () {
			escLongPress = 0
			escDown = false
			cleanup('user')
		}, 600)
	}, true)
	wrap.addEventListener('keyup', function (e) {
		if (e.key !== 'Escape') return
		e.preventDefault()
		escDown = false
		if (escLongPress) { clearTimeout(escLongPress); escLongPress = 0 }
		var now = Date.now()
		if (now - escLastUp <= 800) { escLastUp = 0; cleanup('user'); return }
		escLastUp = now
	}, true)
	var cov = holdCoverage();
	return {
		active: true, id: ID, shadow: host.shadowRoot !== null && host.shadowRoot !== undefined,
		blockKeys: payload.blockKeys === true, focused: true,
		covered: cov.covered === true,
		...(cov.reason === undefined ? {} : { reason: cov.reason }),
	};
}

/** 撤掉浮层（由 agent 主动解除时用；用户双击走页面内的 cleanup）。只删我们自己那个 host。 */
function pageHideHold(by) {
	const ID = '__dsh_hold_overlay__';
	const host = document.getElementById(ID);
	if (host && host.parentNode) host.parentNode.removeChild(host);
	// 浮层撤了就别继续盯 fullscreenchange（只在浮层存在期间有意义）
	try {
		if (window.__dshHoldFsWatch) document.removeEventListener('fullscreenchange', window.__dshHoldFsWatch, true);
	} catch (e) { /* 已移除 */ }
	window.__dshHoldFsWatch = null;
	const prev = window.__dshHold || { at: Date.now() };
	// agent 主动 off = **确认继续**：把"用户已中止"的标记清掉（否则之后的点击都会被拦）。
	window.__dshHold = {
		active: false,
		dismissedBy: prev.active === true ? (by || 'agent') : (prev.dismissedBy || null),
		aborted: false,
		at: prev.at, closedAt: Date.now(), text: prev.text || '',
	};
	return window.__dshHold;
}

/**
 * 读浮层状态。**以 DOM 是否存在为准** —— 页面导航/刷新会把浮层一起带走，这时不能继续报"还在锁着"。
 * `dismissedBy: 'user'` 表示用户双击接管过（这是模型继续驱动页面前该知道的）。
 */
function pageHoldStatus() {
	const host = document.getElementById('__dsh_hold_overlay__');
	const st = window.__dshHold || null;
	// 覆盖情况**现场量**，不信"我挂上去了"这件事：全屏元素在 top layer 上，body 层的浮层
	// 会被它整个盖住（真机量过），这时必须如实说 covered:false 而不是继续报"已锁住"。
	var cov = { covered: false, reason: 'not-in-dom' };
	if (host !== null) {
		var fs = document.fullscreenElement;
		if (fs && fs.tagName === 'IFRAME') {
			cov = { covered: false, reason: 'fullscreen-iframe' };
		} else if (fs && !fs.contains(host)) {
			cov = { covered: false, reason: 'fullscreen-behind-top-layer' };
		} else {
			var el = typeof document.elementFromPoint === 'function'
				? document.elementFromPoint(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2))
				: null;
			cov = (el && (el === host || host.contains(el))) ? { covered: true } : { covered: false, reason: 'hit-test-miss' };
		}
	}
	return {
		active: host !== null,
		dismissedBy: st ? st.dismissedBy : null,
		aborted: st ? st.aborted === true : false,
		text: st ? st.text : '',
		at: st ? st.at : null,
		closedAt: st ? st.closedAt : null,
		shadow: host !== null && host.shadowRoot !== null && host.shadowRoot !== undefined,
		covered: cov.covered === true,
		...(cov.reason === undefined ? {} : { reason: cov.reason }),
	};
}

/** 浮层标题写死在这里，**不接受模型输入**。 */
const HOLD_FIXED_TITLE = '模型正在操作此标签页';

const HOLD_PASSTHROUGH_ON = '(() => { var el = document.getElementById("__dsh_hold_overlay__"); if (!el) return false; el.style.pointerEvents = "none"; return true; })()';
const HOLD_PASSTHROUGH_OFF = '(() => { var el = document.getElementById("__dsh_hold_overlay__"); if (!el) return false; el.style.pointerEvents = ""; return true; })()';

/**
 * 在有浮层时执行一次"模型自己的"输入：先把浮层临时设为 `pointer-events:none` 再派发，
 * 派发完（留 120ms 让事件走完）恢复。没有浮层时就是直通。
 *
 * 为什么必须这样做：CDP 派发的鼠标事件走的是**真实命中测试**，浮层盖在上面就会被打中 ——
 * 那等于"锁住之后模型自己也不能动了"。用户的手动点击不受影响（浮层对人是实心的）。
 */
/**
 * 「用户按了中止操作」的闸门：浮层上的『中止操作』双击确认后会把 `aborted: true` 记进页面状态，
 * 之后模型对这个标签页的 click / input / press / nav 一律**先拒**，并把用户填的说明带回去 ——
 * 直到模型调 `hold.off`（＝确认继续，会清掉这个标记）。
 *
 * 为什么放在扩展这一层：中止是"用户对着页面按的"，模型无从得知；让它下一次动手时立刻撞上错误，
 * 比等它在状态里自己发现要可靠。
 */
const HOLD_ABORT_PROBE = '(() => { var s = window.__dshHold; return (s && s.aborted === true) ? JSON.stringify({ text: String(s.text || "") }) : ""; })()';

/**
 * 中止期间拒绝再挂浮层时用的错误前缀。插件侧（`errors.ts`）按它把失败归类成
 * `held_by_user`，模型读到的下一步就不会是「重试」——重试只会再被拦一次。
 */
const HOLD_ABORTED_MARKER = 'browser-hold-aborted:';

/** 窗口没显示出来（输入无处可落）时的错误前缀：core 侧按它归类成 `window_not_shown`。 */
const WINDOW_NOT_SHOWN_MARKER = 'browser-window-not-shown:';

/**
 * 中止闸门：浮层上的『中止操作』双击确认后会把 `aborted: true` 记进页面状态，
 * 之后模型对这个标签页的 click / input / press / nav 一律**先拒**，并把用户填的说明带回去 ——
 * 直到模型调 `hold.off`（＝确认继续，会清掉这个标记）。
 *
 * 为什么放在扩展这一层：中止是"用户对着页面按的"，模型无从得知；让它下一次动手时立刻撞上错误，
 * 比等它在状态里自己发现要可靠。
 */
async function assertNotAborted(send, action) {
	const raw = await send('Runtime.evaluate', { expression: HOLD_ABORT_PROBE, returnByValue: true })
		.then((r) => String((r && r.result) ? (r.result.value ?? '') : ''))
		.catch(() => '');
	if (raw === '') return;
	let text = '';
	try { text = String((JSON.parse(raw) || {}).text || '') } catch { text = '' }
	throw new Error(`用户终止控制（${action} 已拦下）。`
		+ '请与用户沟通确认后再调用 browser_hold action=off 解除中止。');
}

async function withHoldPassthrough(send, fn) {
	let had = false;
	try {
		const res = await send('Runtime.evaluate', { expression: HOLD_PASSTHROUGH_ON, returnByValue: true });
		had = res && res.result ? res.result.value === true : false;
	} catch { had = false; }
	if (!had) return await fn(false);
	try {
		return await fn(true);
	} finally {
		await new Promise((r) => setTimeout(r, 120));
		await send('Runtime.evaluate', { expression: HOLD_PASSTHROUGH_OFF, returnByValue: true }).catch(() => {});
	}
}

async function cmdLockStatus() {
	return { locked: hardLocked === true };
}

/** 设置硬锁（popup 用；桥也能调，但真正的解锁走用户在扩展图标里的动作）。 */
async function cmdLockSet(params) {
	const locked = await setHardLock(params && params.locked === true);
	return { locked };
}

/**
 * `hold.config {mode:'white'|'black'}`：桥把设置项推下来（启动、配置变更、扩展重连时各推一次）。
 * 旧版本扩展不认识这条命令 —— 桥侧按白名单行为对待，不当作错误。
 */
async function cmdHoldConfig(params) {
	const mode = String(params && params.mode ? params.mode : '');
	if (mode === 'white' || mode === 'black') {
		holdMode = mode;
		if (mode === 'white') holdAutoSuppressedTabs.clear();
		await persistHoldState();
	}
	return { mode: holdMode, supported: true };
}

async function cmdHoldOn(params) {
	const tab = await resolveTab(params.tabId);
	const payload = {
		// 标题在这里写死：模型的 title 参数不被转发（防止伪造"系统提示"）
		title: HOLD_FIXED_TITLE,
		text: typeof params.text === 'string' ? params.text : '',
		meta: params.meta && typeof params.meta === 'object' ? params.meta : null,
		hint: typeof params.hint === 'string' && params.hint.length > 0 ? params.hint : '双击任意处接管页面（键盘：连按两下 Esc 或长按 Esc 接管，Enter 中止）',
		hintOne: typeof params.hintOne === 'string' && params.hintOne.length > 0 ? params.hintOne : '再双击一次接管页面（或按 Esc）',
		dblMs: Number.isFinite(Number(params.dblMs)) && Number(params.dblMs) >= 120 && Number(params.dblMs) <= 1200 ? Number(params.dblMs) : 500,
		abortLabel: typeof params.abortLabel === 'string' && params.abortLabel.length > 0 ? params.abortLabel : '中止操作',
		abortConfirmLabel: typeof params.abortConfirmLabel === 'string' && params.abortConfirmLabel.length > 0 ? params.abortConfirmLabel : '点击确认',
		armMs: Number.isFinite(Number(params.armMs)) && Number(params.armMs) >= 800 ? Number(params.armMs) : 3000,
		blockKeys: params.blockKeys === true,
	};
	return withCDP(tab.id, async (send) => {
		// 中止只有 `off`（＝确认继续）能解。若 `on` 能静默清掉中止，模型就有一条
		// 不必问用户、也不必说「继续」的旁路：被拦一次 → 再挂一层 → 照常点。
		const live = await send('Runtime.evaluate', {
			expression: HOLD_ABORT_PROBE, awaitPromise: false, returnByValue: true,
		}).then((r) => String((r && r.result) ? (r.result.value ?? '') : '')).catch(() => '');
		if (live !== '') {
			throw new Error(`${HOLD_ABORTED_MARKER} 用户已在浮层上按下「中止操作」，不能再挂一层把它盖掉：`
				+ '命令 hold.on 被拦下，没有向页面注入任何东西。请先与用户确认；用户同意继续后'
				+ '调用 browser_hold action=off（这一步等于确认继续），之后才能重新挂层。不要重试本命令。');
		}
		await send('Runtime.enable').catch(() => {});
		const res = await send('Runtime.evaluate', {
			expression: `(${pageShowHold.toString()})(${JSON.stringify(payload)})`,
			awaitPromise: false, returnByValue: true, userGesture: true,
		});
		if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
		holdAutoSuppressedTabs.delete(tab.id);
		await persistHoldState();
		return { tabId: tab.id, ...(res.result && res.result.value ? res.result.value : { active: true }) };
	});
}

async function cmdHoldOff(params) {
	const tab = await resolveTab(params.tabId);
	// 模型明确按掉的标签页：黑名单模式下本会话不再自动补浮层（否则 off 完下一枪又盖回来）。
	holdAutoSuppressedTabs.add(tab.id);
	await persistHoldState();
	return withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression: `(${pageHideHold.toString()})('agent')`,
		awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((res) => ({ tabId: tab.id, ...(res.result && res.result.value ? res.result.value : { active: false }) })));
}

async function cmdHoldStatus(params) {
	const tab = await resolveTab(params.tabId);
	return withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression: `(${pageHoldStatus.toString()})()`,
		awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((res) => ({
		tabId: tab.id,
		...(res.result && res.result.value ? res.result.value : { active: false }),
		mode: holdMode,
		autoSuppressed: holdAutoSuppressedTabs.has(tab.id),
		autoStats: { ...holdAutoStats, skips: { ...holdAutoStats.skips } },
	})));
}

const COMMANDS = {
	ping: cmdPing, 'browser.info': cmdBrowserInfo,
	'tabs.list': cmdTabsList, 'tabs.open': cmdTabsOpen, 'tabs.close': cmdTabsClose, 'tabs.closeMany': cmdTabsCloseMany, 'tabs.activate': cmdTabsActivate,
	'tabs.group': cmdTabGroup, 'tabs.ungroup': cmdTabUngroup,
	nav: cmdNav, eval: cmdEval, content: cmdContent, 'content.debug': cmdContentDebug, find: cmdFind, frames: cmdFrames,
	click: cmdClick, input: cmdInput, press: cmdPress, scroll: cmdScroll,
	snapshot: cmdSnapshot, screenshot: cmdScreenshot,
	wait: cmdWait, dialog: cmdDialogPolicy,
	'console.log': cmdConsoleLog, 'network.log': cmdNetworkLog, 'network.clear': cmdNetworkClear,
	pdf: cmdPdf, emulate: cmdEmulate,
	'window.ensure': cmdEnsureWindow,
	'hold.on': cmdHoldOn, 'hold.off': cmdHoldOff, 'hold.status': cmdHoldStatus,
	'hold.config': cmdHoldConfig,
	'focus.config': cmdFocusConfig,
	'lock.status': cmdLockStatus, 'lock.set': cmdLockSet,
};

/**
 * Explicit wait primitive: poll until a selector appears, page text contains
 * a string, or a predicate function returns truthy. Polls inside the page via
 * requestAnimationFrame-ish loop (50ms interval) — no bridge round-trips.
 */
async function cmdWait(params) {
	const tab = await resolveTab(params.tabId);
	const timeoutMs = Math.min(120_000, Math.max(100, Number(params.timeoutMs) || 15_000));
	let condition;
	const stableMs = Number(params.stableMs);
	if (Number.isFinite(stableMs) && stableMs > 0) {
		// 等"正文稳定下来"：每 50ms 采样一次正文签名，连续 stableMs 毫秒没变才算等到。
		// 这是给"页面会反复重渲染 / 内容晚到"的场景用的（2026-10-19 读教务课表时缺的那个判据）。
		const hold = Math.min(60_000, Math.max(50, Math.trunc(stableMs)));
		condition = `(() => {
			${DEEP_HELPER}
			const text = (document.body ? document.body.innerText : '') + '\\n' + __dshShadowText();
			const sig = text.length + '|' + text.slice(0, 200) + '|' + text.slice(-200);
			const state = window.__dshStableProbe;
			const now = Date.now();
			if (!state || state.sig !== sig) { window.__dshStableProbe = { sig: sig, since: now }; return false; }
			return now - state.since >= ${hold};
		})()`;
	} else if (params.selector) {
		condition = `(() => { ${DEEP_HELPER} return __dshDeepAll(${JSON.stringify(String(params.selector))}).length > 0; })()`;
	} else if (typeof params.text === 'string') {
		condition = `(() => { ${DEEP_HELPER} const body = document.body ? document.body.innerText : ''; return (body + '\\n' + __dshShadowText()).includes(${JSON.stringify(String(params.text))}); })()`;
	} else if (typeof params.fn === 'string' && params.fn.length > 0) {
		// Accept both a predicate function ("() => x.ready") and a bare boolean
		// expression ("x.ready === true"): call function values, evaluate
		// everything else as-is.
		condition = `(() => { const f = (${params.fn}); return typeof f === 'function' ? Boolean(f()) : Boolean(f); })()`;
	} else {
		throw new Error('provide one of selector, text, fn, or stableMs');
	}
	return withCDP(tab.id, async (send) => {
		const started = Date.now();
		// 「页面已经落到浏览器错误页」时条件**不可能**成立：再等下去只是白烧预算
		// （2026-10-10 实测：navigate 到连不上的站点后，wait 把 30s 预算烧光，模型读到的
		//  是"等待条件未成立"，跟"页面慢"完全分不开）。判据用真机实测过的结构：
		//  location.href = chrome-error://… 或 #main-frame-error 存在（Edge 155 的 body.className 是空的）。
		const errorProbeExpression = 'JSON.stringify({ href: location.href, err: !!document.getElementById("main-frame-error"), text: (document.body ? document.body.innerText : "").slice(0, 300) })';
		/** 只比较"文档身份"（scheme+host+path，忽略尾斜杠/查询/锚点）——重定向后的两侧会一致。 */
		const sameDocUrl = (a, b) => {
			try {
				const A = new URL(a), B = new URL(b);
				return A.origin === B.origin && A.pathname.replace(/\/+$/, '') === B.pathname.replace(/\/+$/, '');
			} catch {
				return a === b;
			}
		};
		const probeDocument = async () => {
			const probe = await send('Runtime.evaluate', {
				expression: errorProbeExpression, awaitPromise: false, returnByValue: true, userGesture: true,
			}).catch(() => null);
			if (probe === null || probe.exceptionDetails) return null;
			try { return JSON.parse(String(probe.result?.value ?? '')); } catch { return null; }
		};
		/**
		 * 「显示出来的文档还没跟上来」——
		 * 导航在途时 `chrome.tabs` 报的 `tab.url` **已经是目标 URL**，而页内 `location.href`
		 * 还是**旧文档**。两者不一致 ⇒ 现在评估条件就是在旧页面上评估，命中是**假绿**
		 * （2026-10-10 真机实测：navigate 后 waitSelector 在 11ms 内命中旧页面的 `<a href>`，
		 *  结果同时打印"页面仍在加载"和"等待条件成立"）。此时一律不采信命中，继续等新文档。
		 */
		const documentIsStale = async (docHref) => {
			const live = await chrome.tabs.get(tab.id).catch(() => null);
			if (live === null || live === undefined) return false;
			if (live.status !== 'loading') return false;
			const target = typeof live.url === 'string' ? live.url : '';
			if (target.length === 0) return false;
			return !sameDocUrl(target, docHref);
		};
		let polls = 0;
		let staleSkips = 0;
		for (;;) {
			if (polls % 8 === 0) {
				const doc = await probeDocument();
				if (doc === null) {
					/* 读不到（标签页没了/扩展被卸载）——继续按条件轮询，超时自会报错 */
				} else {
					if (doc.err === true || /^chrome-error:/.test(String(doc.href ?? ''))) {
						const code = /(ERR_[A-Z_]+)/.exec(String(doc.text ?? ''))?.[1] ?? 'unknown';
						const firstLine = String(doc.text ?? '').split('\n').map((s) => s.trim()).filter((s) => s.length > 0)[1] ?? '';
						throw new Error(`页面加载失败（浏览器错误页）：${code}`
							+ `${firstLine.length > 0 ? ` — ${firstLine}` : ''}`
							+ `；等待条件在这个页面上不可能成立（等了 ${Date.now() - started}ms）。先确认站点可达，或改用另一个域名/入口。`);
					}
					if (await documentIsStale(String(doc.href ?? ''))) {
						staleSkips += 1;
						if (Date.now() - started >= timeoutMs) {
							throw new Error(`wait timeout after ${timeoutMs}ms —— 页面**仍在加载/导航还没落到新文档**（期间跳过了 ${staleSkips} 次"旧文档上的命中"）；`
								+ '这不是"条件不成立"，加大预算，或先确认目标站点可达。');
						}
						await new Promise((r) => setTimeout(r, 50));
						polls += 1;
						continue; // ← 关键：不在旧文档上评估条件
					}
				}
			}
			polls += 1;
			const res = await send('Runtime.evaluate', {
				expression: condition,
				awaitPromise: false, returnByValue: true, userGesture: true,
			}).catch(() => ({ result: { value: false } }));
			if (res.exceptionDetails) throw new Error(`wait condition error: ${res.exceptionDetails.text}`);
			if (res.result.value === true) return { tabId: tab.id, waited: Date.now() - started, ...(staleSkips > 0 ? { skippedStaleHits: staleSkips } : {}) };
			if (Date.now() - started >= timeoutMs) throw new Error(`wait timeout after ${timeoutMs}ms`);
			await new Promise((r) => setTimeout(r, 50));
		}
	});
}

/**
 * Read or set the native-dialog auto-answer policy. GET: {action:'get'} →
 * {policy, recent}. SET: {action:'set', policy:'accept'|'dismiss'|'manual'}.
 * Recent dialogs (last 50) are returned so callers can verify what happened.
 */
async function cmdDialogPolicy(params) {
	if (params?.policy !== undefined) {
		const p = String(params.policy);
		if (!['accept', 'dismiss', 'manual'].includes(p)) throw new Error(`invalid dialog policy: ${p}`);
		applyDialogPolicy(p);
		// persist=true 时写进 storage 当作用户偏好；默认只改本次运行。
		if (params.persist === true) {
			cfg.dialogPolicy = p;
			try { await chrome.storage.local.set({ dialogPolicy: p }); } catch { /* 存不下不影响本次 */ }
		}
	}
	// 回答"当前已打开"的对话框：manual 档下页面会被卡死，这是唯一的退路（否则只能关标签页）。
	// 等价于 CDP 的 Page.handleJavaScriptDialog —— 与自动应答走的是同一个 API。
	if (params?.answer !== undefined) {
		const want = String(params.answer);
		if (want !== 'accept' && want !== 'dismiss') throw new Error(`invalid dialog answer: ${want}（accept|dismiss）`);
		let tabId = params.tabId === undefined ? undefined : Number(params.tabId);
		if (tabId === undefined && dialogLog.length > 0) tabId = dialogLog[dialogLog.length - 1].tabId;
		if (tabId === undefined) throw new Error('answer 需要 tabId，或先有一次对话框记录');
		await new Promise((resolve, reject) => {
			chrome.debugger.sendCommand(
				{ tabId },
				'Page.handleJavaScriptDialog',
				{ accept: want === 'accept', promptText: typeof params.promptText === 'string' ? params.promptText : '' },
				() => {
					const err = chrome.runtime.lastError;
					if (err) reject(new Error(`回答对话框失败：${err.message}（该标签页可能没有打开的对话框，或未 attach）`));
					else resolve();
				},
			);
		});
		const entry = { tabId, type: 'answer', message: '(手动回答)', defaultPrompt: '', answeredAs: want, t: Date.now() };
		dialogLog.push(entry);
		if (dialogLog.length > 50) dialogLog.shift();
		return { policy: dialogPolicy, answered: { tabId, as: want }, recent: dialogLog.slice(-10) };
	}
	return { policy: dialogPolicy, recent: dialogLog.slice(-10) };
}

/* ------------------------------------------------------------ popup link */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (msg?.type === 'bridgeStatus') {
		void ensureHardLock().then(() => sendResponse({
			state: wsState,
			cfg,
			helloInfo,
			lastError,
			locked: hardLocked === true,
			discoveredPort,
			lastProbeNote,
			scanRange: `${PORT_SCAN_BASE}–${PORT_SCAN_BASE + PORT_SCAN_COUNT - 1}`,
		}));
		return true;
	}
	if (msg?.type === 'lockSet') {
		void setHardLock(msg.locked === true).then((locked) => sendResponse({ locked }));
		return true;
	}
	if (msg?.type === 'reconnect') {
		manualDisconnect = false;
		backoffAttempt = 0;
		disconnectNow();
		loadConfig().then(() => { connect(); sendResponse({ started: true }); });
		return true;
	}
	if (msg?.type === 'rescan') {
		// 用户改了端口 / 换了桥之后的“立刻重新扫描”：清掉本次命中结果再走一遍探测。
		manualDisconnect = false;
		backoffAttempt = 0;
		discoveredPort = null;
		lastProbeNote = null;
		disconnectNow();
		loadConfig().then(() => { connect(); sendResponse({ started: true }); });
		return true;
	}
	if (msg?.type === 'disconnect') {
		manualDisconnect = true;
		disconnectNow();
		sendResponse({ started: true });
		return false;
	}
	return false;
});

/* -------------------------------------------------------------- lifecycle */

async function init() {
	await loadConfig();
	connect();
}

chrome.runtime.onInstalled.addListener(() => init());
chrome.runtime.onStartup.addListener(() => init());
init();
