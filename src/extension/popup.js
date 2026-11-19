/** Popup for DSH Browser Control: big status hero, config tucked under 高级. */
'use strict';

const $ = (id) => document.getElementById(id);

const STATE_TEXT = {
	open: '已连接',
	connecting: '连接中…',
	idle: '未连接',
};
const STATE_SUB = {
	open: () => '桥接服务运行中，随时听候调用',
	connecting: () => '正在扫描端口并与 dsh 桥接服务握手',
	idle: () => '在 dsh 设置 → 插件 里开启浏览器控制',
};

/** 表单里那一份「待保存」的值（端口非法时退回 9777，和其它两处保持同一个口径）。 */
function readForm() {
	return {
		port: Number($('port').value) || 9777,
		token: $('token').value.trim(),
		autoConnect: $('auto').checked,
		dialogPolicy: $('dlg').value,
	};
}

/** 两份配置在「这几个表单字段」上是否一致。 */
function sameConfig(a, b) {
	if (!a || !b) return false;
	return Number(a.port) === Number(b.port)
		&& String(a.token ?? '') === String(b.token ?? '')
		&& Boolean(a.autoConnect) === Boolean(b.autoConnect)
		&& String(a.dialogPolicy ?? '') === String(b.dialogPolicy ?? '');
}

/** 把一份配置写进表单（**只在下面两个时机调用**，见 render 里的注释）。 */
function applyForm(value) {
	if (!value) return;
	$('port').value = value.port ?? 9777;
	$('token').value = value.token ?? '';
	$('auto').checked = Boolean(value.autoConnect);
	$('dlg').value = value.dialogPolicy ?? 'accept';
}

const panelOpen = () => $('advanced').classList.contains('open');

/** 上一次「重新扫描本地桥」是否用了表单里尚未保存的值（用于在扫描结论后加一句说明）。 */
let lastTestUsedForm = false;

function render(status) {
	const ring = $('ring');
	ring.className = `ring ${status.state}`;
	$('state').textContent = STATE_TEXT[status.state] ?? status.state;
	$('hello').textContent = status.helloInfo
		? `${status.helloInfo.name} ${status.helloInfo.version}`
		: (STATE_SUB[status.state]?.() ?? '');
	// 实际端口 + 最近一次扫描结论（端口自动发现）
	const connBits = [];
	if (status.discoveredPort) connBits.push(`实际端口 ${status.discoveredPort}`);
	else if (status.state !== 'open') connBits.push('未命中本地桥');
	$('conn').textContent = connBits.join(' · ');
	const probeNote = status.lastProbeNote ?? '（尚未扫描）';
	$('scan').textContent = lastTestUsedForm ? `${probeNote}（这次用的是表单里填的值，尚未保存）` : probeNote;

	// ── 表单回填规则（2026-11-01 主人指出后改）───────────────────────────────
	// 以前：每 1.5s 刷新一次，把除「当前聚焦那个」以外的字段全部按生效值回填 ⇒
	//   「先改 token、再改端口、最后一起保存」时，先改的那个被静默刷回旧值；
	//   「重新扫描本地桥」被当测试项用时更是如此 —— 测完看着值还在，其实早被回填过。
	// 现在：**只在面板收起时回填**（收起 = 以已保存的值为准，未保存的填写被丢弃）；
	//   面板开着时，只有「表单内容与已保存值一致」才跟随刷新（那时没什么可丢的）。
	//   注意这里比的是**持久化的值**（cfgPersisted，重启后还在的那份），不是运行中的
	//   cfg —— 用表单值做过测试后，两者会短暂不同。
	const persisted = status.cfgPersisted ?? status.cfg ?? null;
	const effective = status.cfg ?? persisted;
	const pending = !panelOpen() ? false : !sameConfig(readForm(), persisted);
	if (!panelOpen()) {
		applyForm(persisted);
		lastTestUsedForm = false;
	} else if (!pending) {
		applyForm(effective);
	}
	$('save').textContent = pending ? '保存并重连 · 有改动' : '保存并重连';

	const connected = status.state === 'open';
	const btn = $('reconnect');
	btn.textContent = connected ? '断开连接' : (status.state === 'connecting' ? '连接中…' : '立即连接');
	btn.classList.toggle('danger', connected);
	btn.dataset.connected = String(connected);
	// 本地硬锁：按钮与状态页同款样式，锁着时变红
	const locked = status.locked === true;
	$('lockbtn').textContent = locked ? '解除锁定' : '锁定';
	$('lockbtn').classList.toggle('locked', locked);
	$('locksub').textContent = locked
		? '已锁定：模型的任何调用都会被拒绝；只有在这个弹窗里能解锁'
		: '锁定后仍保持连接，只是拒绝模型的全部浏览器命令；只能在这个弹窗里解锁';
	const errorBox = $('error');
	errorBox.textContent = status.lastError ?? '';
	errorBox.className = errorBox.textContent.length > 0 ? 'error show' : 'error';
}

async function refresh() {
	try {
		render(await chrome.runtime.sendMessage({ type: 'bridgeStatus' }));
	} catch (err) {
		const box = $('error');
		box.textContent = `扩展未响应: ${err.message}`;
		box.className = 'error show';
	}
}

// 单次点击即可锁定：**打开这个弹窗本身就是一次明确的用户动作**（要点图标才看得到这一行），
// 再要一次"点击确认"只是给误触加了一层，并不增加真实的安全性；解锁同样一次点击（救人优先）。
$('lockbtn').addEventListener('click', async () => {
	const locked = $('lockbtn').classList.contains('locked')
	await chrome.runtime.sendMessage({ type: 'lockSet', locked: !locked });
	setTimeout(refresh, 200);
});

$('reconnect').addEventListener('click', async () => {
	const connected = $('reconnect').dataset.connected === 'true';
	await chrome.runtime.sendMessage({ type: connected ? 'disconnect' : 'reconnect' });
	setTimeout(refresh, 600);
});

$('openStatus').addEventListener('click', async () => {
	const port = Number($('port').value) || 9777;
	await chrome.tabs.create({ url: `http://127.0.0.1:${port}/` });
	window.close();
});

// 展开/收起：两个方向都回到「已保存的值」——
//   展开 = 从已保存值开始改；收起 = 丢弃没保存的填写（想留下就点保存）。
$('gear').addEventListener('click', async () => {
	const panel = $('advanced');
	const opening = !panel.classList.contains('open');
	panel.classList.toggle('open', opening);
	$('gear').textContent = opening ? '高级 ▴' : '高级 ▾';
	lastTestUsedForm = false;
	await refresh();
});

// 「重新扫描本地桥」是**测试项**：用表单里当前填的值去试连，不落盘。
// 测通了再点「保存并重连」才是持久化 —— 这两个动作分开，谁也不会替谁做决定。
$('rescan').addEventListener('click', async () => {
	lastTestUsedForm = true;
	await chrome.runtime.sendMessage({ type: 'rescan', tryConfig: readForm() });
	setTimeout(refresh, 1200);
});

$('save').addEventListener('click', async () => {
	await chrome.storage.local.set(readForm());
	lastTestUsedForm = false;
	await chrome.runtime.sendMessage({ type: 'reconnect' });
	setTimeout(refresh, 1200);
});

$('ver').textContent = chrome.runtime.getManifest().version;
refresh();
setInterval(refresh, 1500);
