/**
 * __pr-d-rig/apply-fix-D.mjs — idempotent, EOL-agnostic patch for commit D.
 *
 * usage: node apply-fix-D.mjs <path/to/extension/background.js> [--dry]
 *
 * The same script is used for (a) the throwaway rig copy used to produce
 * before/after evidence in a real browser and (b) the git clone that carries
 * the PR branch. It normalizes CRLF, asserts every anchor once, and refuses to
 * write anything unless every anchor matched (fail-closed).
 */
import fs from 'node:fs'

const target = process.argv[2]
const dry = process.argv.includes('--dry')
if (!target) { console.error('usage: apply-fix-D.mjs <background.js> [--dry]'); process.exit(2) }

const raw = fs.readFileSync(target, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
const src = raw.replace(/\r\n/g, '\n')

const OLD_WAIT = `function waitTabComplete(tabId, timeoutMs) {
	return new Promise((resolve) => {
		let done = false;
		const finish = () => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); };
		const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
		chrome.tabs.onUpdated.addListener(listener);
		chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') finish(); }).catch(finish);
		setTimeout(finish, timeoutMs);
	});
}`

const NEW_WAIT = `/**
 * Wait until the navigation that is about to start has actually settled, and
 * say whether it did.
 *
 * Two mistakes this avoids, both of which let \`nav\` / \`tabs.open\` report a
 * settled page that was not there:
 *   - arming the listener AFTER \`tabs.update\` / \`tabs.create\` races the
 *     document swap: the tab still answers \`status:'complete'\` for the PREVIOUS
 *     document (a brand-new tab answers \`complete\` for about:blank), so a single
 *     \`chrome.tabs.get\` resolves the wait instantly against the old page;
 *   - a timeout that resolves silently is indistinguishable from success.
 * So: poll, insist on having seen the new document load (\`status:'loading'\`),
 * and report the outcome — \`false\` means the budget ran out while the new
 * document was still not in place.
 */
function waitForNavigationComplete(tabId, timeoutMs) {
	const started = Date.now();
	return new Promise((resolve) => {
		let sawLoading = false;
		const tick = async () => {
			const tab = await chrome.tabs.get(tabId).catch(() => null);
			if (tab) {
				if (tab.status === 'loading') sawLoading = true;
				else if (tab.status === 'complete') {
					if (sawLoading) return resolve(true);
					// No loading phase observed: either the previous document is
					// still sitting in its complete state (the race above), or the
					// new page was genuinely too fast to ever show one.
					if (Date.now() - started > 1200) return resolve(true);
				}
			}
			if (Date.now() - started >= timeoutMs) return resolve(false);
			setTimeout(tick, 120);
		};
		void tick();
	});
}

/**
 * Await \`promise\`, but never longer than \`ms\`; resolve \`fallback\` on timeout or
 * rejection. CDP does not answer \`Runtime.evaluate\` while a navigation is stuck
 * before commit, so the post-navigation probes must not be able to outlive the
 * caller's budget (measured: an unbounded probe left \`nav\` unanswered for >40 s
 * while its own wait budget was 15 s).
 */
function withBudget(promise, ms, fallback) {
	return Promise.race([
		promise.catch(() => fallback),
		new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
	]);
}`

const OLD_OPEN = `	if (params.wait !== false) await waitTabComplete(created.id, Number(params.timeoutMs) || 15_000);
	const fresh = await chrome.tabs.get(created.id).catch(() => null);
	return { tabId: created.id, url: fresh?.url, title: fresh?.title };`

const NEW_OPEN = `	const timeoutMs = Number(params.timeoutMs) || 15_000;
	// Arm the waiter before the tab starts loading: a created tab is born on
	// about:blank and reports \`complete\` immediately, so a waiter armed
	// afterwards can conclude "already settled" while the requested URL has not
	// even started.
	const settled = params.wait === false ? true : await waitForNavigationComplete(created.id, timeoutMs);
	const fresh = await chrome.tabs.get(created.id).catch(() => null);
	// A pending navigation is not visible in \`url\` (a tab that has not committed
	// anything yet reports an empty url); \`pendingUrl\` is where it is heading.
	const pendingUrl = fresh?.pendingUrl && fresh.pendingUrl !== fresh?.url ? fresh.pendingUrl : undefined;
	return {
		tabId: created.id,
		url: fresh?.url,
		title: fresh?.title,
		...(pendingUrl === undefined ? {} : { pendingUrl }),
		...(settled === true ? {} : { loadPending: true }),
	};`

const OLD_NAV = `	const tab = await resolveTab(params.tabId);
	await chrome.tabs.update(tab.id, { url: params.url });
	if (params.wait !== false) await waitTabComplete(tab.id, Number(params.timeoutMs) || 15_000);
	const fresh = await chrome.tabs.get(tab.id).catch(() => null);
	// Chrome lands dead navigations on an internal error page, but tabs.get()
	// keeps reporting the ORIGINAL url — only in-page location.href reveals
	// chrome-error://. Probe it so callers can react structurally.
	let landedUrl = '';
	try {
		landedUrl = await withCDP(tab.id, (send) => send('Runtime.evaluate', {
			expression: 'location.href', awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((r) => String(r.result?.value ?? '')));
	} catch { /* no debugger possible (e.g. chrome:// pages) — fall through */ }
	let siteUnreachable;
	if (/^chrome-error:/.test(landedUrl)) {
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
		const dns = /ERR_NAME_NOT_RESOLVED|ERR_DNS_TIMED_OUT|\\bDNS\\b|无法找到.{0,40}(DNS|服务器)/i.test(errText)
			|| /ERR_NAME_NOT_RESOLVED|dns/i.test(fresh?.title ?? '');
		siteUnreachable = { reason: dns ? 'dns' : 'unreachable' };
	}
	return {
		tabId: tab.id,
		url: siteUnreachable ? params.url : (fresh?.url ?? params.url),
		title: siteUnreachable ? undefined : fresh?.title,
		...(siteUnreachable ? { siteUnreachable } : {}),
	};`

const NEW_NAV = `	const tab = await resolveTab(params.tabId);
	const timeoutMs = Number(params.timeoutMs) || 15_000;
	// Arm the waiter BEFORE triggering the navigation — see
	// waitForNavigationComplete for why the order decides the answer.
	const settling = params.wait === false ? Promise.resolve(true) : waitForNavigationComplete(tab.id, timeoutMs);
	await chrome.tabs.update(tab.id, { url: params.url });
	const settled = await settling;
	const fresh = await chrome.tabs.get(tab.id).catch(() => null);
	// Chrome lands dead navigations on an internal error page, but tabs.get()
	// keeps reporting the ORIGINAL url — only in-page location.href reveals
	// chrome-error://. Probe it so callers can react structurally. Both probes
	// are budgeted: CDP stays silent while a navigation is stuck before commit,
	// and an unbounded await there outlives the command's own timeout.
	const landedUrl = await withBudget(withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression: 'location.href', awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((r) => String(r.result?.value ?? ''))), 2000, '');
	let siteUnreachable;
	if (/^chrome-error:/.test(landedUrl)) {
		const errText = await withBudget(withCDP(tab.id, (send) => send('Runtime.evaluate', {
			expression: 'document.body ? document.body.innerText.slice(0, 4000) : ""',
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((r) => String(r.result?.value ?? ''))), 2000, '');
		// Error-page copy is localized (zh-CN shows 无法找到 … 的 DNS 地址,
		// en-US shows ERR_NAME_NOT_RESOLVED); match either plus any bare DNS
		// mention such as DNS_PROBE_STARTED.
		const dns = /ERR_NAME_NOT_RESOLVED|ERR_DNS_TIMED_OUT|\\bDNS\\b|无法找到.{0,40}(DNS|服务器)/i.test(errText)
			|| /ERR_NAME_NOT_RESOLVED|dns/i.test(fresh?.title ?? '');
		siteUnreachable = { reason: dns ? 'dns' : 'unreachable' };
	}
	// While a navigation is pending, \`url\` is still the OLD document (or empty for
	// a tab that has not committed anything yet) and the destination only exists
	// in \`pendingUrl\` — report it so "still going to X" is visible.
	const pendingUrl = fresh?.pendingUrl && fresh.pendingUrl !== fresh?.url ? fresh.pendingUrl : undefined;
	return {
		tabId: tab.id,
		url: siteUnreachable ? params.url : (fresh?.url ?? params.url),
		title: siteUnreachable ? undefined : fresh?.title,
		...(pendingUrl === undefined ? {} : { pendingUrl }),
		...(siteUnreachable ? { siteUnreachable } : {}),
		// A timed-out wait must never read as "the page is there": loadPending
		// says the new document was still not in place when the budget ran out.
		...(siteUnreachable === undefined && settled !== true ? { loadPending: true } : {}),
	};`

const edits = [
	['waitTabComplete -> waitForNavigationComplete', OLD_WAIT, NEW_WAIT],
	['cmdTabsOpen', OLD_OPEN, NEW_OPEN],
	['cmdNav', OLD_NAV, NEW_NAV],
]

if (src.includes('waitForNavigationComplete(') && !src.includes('function waitTabComplete(')) {
	console.log('already applied — nothing to do')
	process.exit(0)
}

let out = src
for (const [name, from, to] of edits) {
	const hits = out.split(from).length - 1
	if (hits !== 1) { console.error(`ANCHOR FAIL ${name}: ${hits} matches (expected 1) — aborting, no file written`); process.exit(1) }
	out = out.replace(from, to)
}
if (out.includes('waitTabComplete')) { console.error('leftover waitTabComplete reference — aborting'); process.exit(1) }
if (!dry) fs.writeFileSync(target, eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out, 'utf8')
console.log(`${dry ? 'DRY OK' : 'applied'} 3 edits to ${target} (eol=${eol === '\r\n' ? 'CRLF' : 'LF'})`)
