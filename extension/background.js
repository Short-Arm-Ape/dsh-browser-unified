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
	const handler = COMMANDS[command];
	if (!handler) throw new Error(`unknown command: ${command}`);
	return handler(params);
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

function waitForNavigationComplete(tabId, timeoutMs, expectedUrl) {
	const started = Date.now();
	return new Promise((resolve) => {
		let sawLoading = false;
		const tick = async () => {
			const tab = await chrome.tabs.get(tabId).catch(() => null);
			if (tab !== null && tab !== undefined) {
				if (tab.status === 'loading') sawLoading = true;
				else if (tab.status === 'complete') {
					if (sawLoading) return resolve(true);
					// 没见过 loading 有两种完全不同的情形：新文档快到没被采样到，和**根本没导航**
					// （链接变成下载、Chrome 拒绝的目标、同 URL 空操作）。地址能区分它们 ——
					// 标签不在我们要去的地方，就不能说"已到达"。
					if (Date.now() - started > 1200) return resolve(landsAt(tab.url, expectedUrl));
				}
			}
			if (Date.now() - started >= timeoutMs) return resolve(false);
			setTimeout(tick, 120);
		};
		void tick();
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
		return; // tab or window is closing; the command reports it downstream
	}
	if (win.state === 'minimized') {
		const err = new Error('browser window is minimized — real keyboard/mouse input cannot reach a 0x0 viewport; restore the window manually (automation never changes window size or position)');
		err.code = 'window_minimized';
		throw err;
	}
	try {
		await chrome.windows.update(win.id, { focused: true });
		await chrome.tabs.update(tabId, { active: true });
	} catch { /* tab may be closing; input will fail downstream anyway */ }
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
	const settled = params.wait === false ? true : await waitForNavigationComplete(created.id, Number(params.timeoutMs) || 15_000, params.url);
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
	const timeoutMs = Number(params.timeoutMs) || 15_000;
	// 先把"等新导航完成"的轮询挂上，**再**触发导航（顺序反了就会读到旧文档的 complete）。
	const settling = params.wait === false ? Promise.resolve(true) : waitForNavigationComplete(tab.id, timeoutMs, params.url);
	await chrome.tabs.update(tab.id, { url: params.url });
	const settled = await settling;
	const fresh = await chrome.tabs.get(tab.id).catch(() => null);
	// Chrome lands dead navigations on an internal error page, but tabs.get()
	// keeps reporting the ORIGINAL url — only in-page location.href reveals
	// chrome-error://. Probe it so callers can react structurally.
	// 2026-10-10 补：Edge 155 的错误页 `body.className` 是空的（不能按 .neterror 判），
	// 但 `#main-frame-error` 一定在（本机真机实测：location.href=chrome-error://chromewebdata/、
	// getElementById('main-frame-error')=true、文案含 ERR_CONNECTION_TIMED_OUT）。两个判据都试。
	let landedUrl = '';
	let errorPageMarker = false;
	try {
		// bi-036：文档卡在 commit 之前时 CDP **不回** `Runtime.evaluate`，这个探针会把整条
		// `nav` 拖过调用方的预算（rig 实测：/hang 上 25s 都没回答）。给它一个自己的小预算，
		// 超时就当作"探不到落地地址"往下走 —— 后面的 loadPending 会如实说"没等完"。
		const probe = await withBudget(withCDP(tab.id, (send) => send('Runtime.evaluate', {
			expression: 'JSON.stringify({ href: location.href, mainFrameError: !!document.getElementById("main-frame-error") })',
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((r) => String(r.result?.value ?? ''))), 2500, null);
		if (probe !== null) {
			try {
				const parsed = JSON.parse(probe);
				landedUrl = typeof parsed.href === 'string' ? parsed.href : '';
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
		...(siteUnreachable === undefined && settled !== true
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
		const own = one(document);
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
	const payload = await withCDP(tab.id, (send) =>
		send('Runtime.evaluate', {
			expression: script,
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((res) => {
			if (res.exceptionDetails) throw new Error(`page exception: ${pageExceptionText(res.exceptionDetails)}`);
			return JSON.parse(res.result.value);
		}));
	return { tabId: tab.id, mode, ...payload };
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
			const els = [...document.querySelectorAll(${JSON.stringify(String(params.selector))})];
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
	await activateTabWindow(tab.id);
	return withCDP(tab.id, async (send) => {
		const hit = await send('Runtime.evaluate', {
			expression: `(() => {
				const el = document.querySelector(${JSON.stringify(String(params.selector))});
				if (!el) return null;
				el.scrollIntoView({ block: 'center', inline: 'center' });
				const r = el.getBoundingClientRect();
				// elementFromPoint at the intended hit point catches overlays
				// (sticky headers, ads) that would swallow the click.
				const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
				const topEl = document.elementFromPoint(x, y);
				const isTop = topEl === el || el.contains(topEl);
				return { x, y, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 120),
					hitTag: topEl ? topEl.tagName.toLowerCase() : null, isTop };
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
			dialogsAnswered: dialogLog.filter((d) => d.tabId === tab.id && Date.now() - d.t < 5000).length,
		};
	});
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
	if (mode === 'type') await activateTabWindow(tab.id);

	// Locate + focus + clear in one evaluate, shared by both modes.
	const located = await withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression: `(() => {
			const el = document.querySelector(${JSON.stringify(String(params.selector))});
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
			return { tag };
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
	await activateTabWindow(tab.id);
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
		// `type:'keyDown'` 带 `text` 时，Chrome 自己就会补一个 char/keypress —— 这里**不能再显式发
		// 一条 `char`**（`rawKeyDown` 才是不补 char 的那个）。多发一次的后果是每个字符插两遍：
		// 输入框里按一次 `x` 得到 `xx`，按一次 `Enter` 表单提交两次（`browser_type` 的
		// `submit:true` 走同一条通道，也一样）。真机前后对照见 NOTE.md「press 双倍输入」一节。
		await send('Input.dispatchKeyEvent', {
			type: 'keyDown', key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code, text, unmodifiedText: text, modifiers,
		});
		await send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code, modifiers });
		return { tabId: tab.id, key };
	});
}

async function cmdScreenshot(params) {
	const tab = await resolveTab(params.tabId);
	const format = params.format === 'jpeg' ? 'jpeg' : 'png';
	const res = await withCDP(tab.id, async (send) => {
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
		expression: 'document.querySelectorAll("[data-dsh-ref]").forEach((el) => el.removeAttribute("data-dsh-ref")); void 0;',
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
		total: candidates.length,
		ax: { nodes: nodes.length, candidates: candidates.length, ...skipped },
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
				document.querySelectorAll('[' + ATTR + ']').forEach((el) => el.removeAttribute(ATTR));
				const NATIVE = ${JSON.stringify(SNAPSHOT_SELECTOR)};
				const scan = [...document.querySelectorAll(${JSON.stringify(SNAPSHOT_SCAN_SELECTOR)})];
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
					total: candidates.length, cursorCandidates: cursorCount, scanned: nodes.length, scanTruncated: truncated, items };
			})()`,
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((res) => {
			if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
			return res.result.value;
		});
		payload.mode = 'dom';
		if (axFallback !== undefined) payload.axFallback = axFallback;
		payload.limitedTo = limit;
		return payload;
	});
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
	if (params.selector) {
		condition = `!!document.querySelector(${JSON.stringify(String(params.selector))})`;
	} else if (typeof params.text === 'string') {
		condition = `(document.body && document.body.innerText.includes(${JSON.stringify(params.text)}))`;
	} else if (typeof params.fn === 'string' && params.fn.length > 0) {
		// Accept both a predicate function ("() => x.ready") and a bare boolean
		// expression ("x.ready === true"): call function values, evaluate
		// everything else as-is.
		condition = `(() => { const f = (${params.fn}); return typeof f === 'function' ? Boolean(f()) : Boolean(f); })()`;
	} else {
		throw new Error('provide one of selector, text, or fn');
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
		sendResponse({
			state: wsState,
			cfg,
			helloInfo,
			lastError,
			discoveredPort,
			lastProbeNote,
			scanRange: `${PORT_SCAN_BASE}–${PORT_SCAN_BASE + PORT_SCAN_COUNT - 1}`,
		});
		return false;
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
