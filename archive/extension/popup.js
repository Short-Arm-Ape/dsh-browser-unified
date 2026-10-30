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
	$('scan').textContent = status.lastProbeNote ?? '（尚未扫描）';
	if (document.activeElement !== $('port')) $('port').value = status.cfg.port ?? 9777;
	if (document.activeElement !== $('token')) $('token').value = status.cfg.token;
	$('auto').checked = Boolean(status.cfg.autoConnect);
	if (document.activeElement !== $('dlg')) $('dlg').value = status.cfg.dialogPolicy ?? 'accept';
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
		: '锁定后仍保持连接，但拒绝一切操作，只能在这个弹窗里解锁';
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
	await chrome.runtime.sendMessage({ type: 'lockSet', locked: !locked })
	setTimeout(refresh, 200)
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

$('gear').addEventListener('click', () => {
	const panel = $('advanced');
	const opening = !panel.classList.contains('open');
	panel.classList.toggle('open', opening);
	$('gear').textContent = opening ? '高级 ▴' : '高级 ▾';
});

$('rescan').addEventListener('click', async () => {
	await chrome.runtime.sendMessage({ type: 'rescan' });
	setTimeout(refresh, 1200);
});

$('save').addEventListener('click', async () => {
	await chrome.storage.local.set({
		port: Number($('port').value) || 9777,
		token: $('token').value.trim(),
		autoConnect: $('auto').checked,
		dialogPolicy: $('dlg').value,
	});
	await chrome.runtime.sendMessage({ type: 'reconnect' });
	setTimeout(refresh, 1200);
});

$('ver').textContent = chrome.runtime.getManifest().version;
refresh();
setInterval(refresh, 1500);
