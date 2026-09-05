// ============================================================
// dsh-browser-control · Client 端源码（开源版）
// ------------------------------------------------------------
// 本文件是 cordis_define 的 code.client 参数内容（函数体，勿直接运行）。
// 在 GUI 对话中的运行卡片上渲染"实时浏览器画面"面板：
//   - 状态栏（运行中/错误/… + 当前网址 + 工具数）
//   - 网址输入框 + 前往 / 刷新画面 / 重启 / 关闭按钮
//   - 实时截图（从宿主挂的 /dsh-browser/shot.png?rev=N 加载，动作后自动刷新）
// 本文件不涉及任何本机路径，跨平台通用。
// ============================================================

return {
  inject: ['timer', 'slots'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (!slots) return
    styles.insert(`
.dshbrowser { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--ds-color-border, rgba(128,128,128,.35)); border-radius: 12px; background: var(--ds-color-surface, rgba(128,128,128,.04)); }
.dshbrowser-bar { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ds-color-text-secondary, #888); flex-wrap: wrap; }
.dshbrowser-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex: none; }
.dshbrowser-dot.ok { background: #34d399; }
.dshbrowser-dot.bad { background: #f87171; }
.dshbrowser-dot.wait { background: #fbbf24; }
.dshbrowser-status { font-weight: 600; color: var(--ds-color-text, #222); }
.dshbrowser-url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 55%; opacity: .85; }
.dshbrowser-tools { margin-left: auto; opacity: .7; }
.dshbrowser-row { display: flex; gap: 6px; flex-wrap: wrap; }
.dshbrowser-input { flex: 1; min-width: 140px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--ds-color-border, rgba(128,128,128,.35)); background: var(--ds-color-input-bg, transparent); color: inherit; font-size: 13px; }
.dshbrowser-btn { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--ds-color-border, rgba(128,128,128,.35)); background: var(--ds-color-button-bg, rgba(128,128,128,.08)); color: inherit; cursor: pointer; font-size: 13px; }
.dshbrowser-btn:hover { background: rgba(128,128,128,.18); }
.dshbrowser-btn.danger { color: #f87171; }
.dshbrowser-stage { border-radius: 8px; overflow: hidden; border: 1px solid var(--ds-color-border, rgba(128,128,128,.25)); background: #fff; }
.dshbrowser-img { display: block; width: 100%; height: auto; }
.dshbrowser-empty { padding: 40px 10px; text-align: center; color: var(--ds-color-text-secondary, #888); font-size: 13px; }
.dshbrowser-error { color: #f87171; font-size: 12px; white-space: pre-wrap; }
.dshbrowser-hint { font-size: 11px; opacity: .65; }
`)
    slots.inject('tool.view.cordis', () => slots.register(
      { name: 'tool.view.cordis', key: 'self' },
      (props) => {
        const [view, setView] = React.useState({ status: 'starting', url: '', rev: 0, error: '', toolCount: 0 })
        const [urlInput, setUrlInput] = React.useState('')
        React.useEffect(() => {
          let disposed = false
          let failCount = 0
          const poll = () => {
            host.call('browser/state', {}).then((s) => {
              if (disposed || !s) return
              failCount = 0
              setView({ status: s.status, url: s.url || '', rev: s.rev || 0, error: s.error || '', toolCount: s.toolCount || 0 })
            }).catch(() => {
              failCount += 1
              if (failCount >= 3) setView((v) => ({ ...v, status: 'error', error: '无法连接宿主端（插件可能未运行）' }))
            })
          }
          poll()
          const dis = ctx.interval(poll, 1200)
          return () => { disposed = true; dis() }
        }, [])
        const go = () => {
          const u = urlInput.trim()
          if (!u) return
          host.call('browser/navigate', { url: u }).then((r) => {
            if (r && r.ok === false) setView((s) => ({ ...s, error: r.error || '导航失败' }))
          }).catch((e) => setView((s) => ({ ...s, error: String(e) })))
        }
        const shotNow = () => { host.call('browser/shot', {}).catch(() => {}) }
        const closeBrowser = () => { host.call('browser/close', {}).catch(() => {}) }
        const restartBrowser = () => { host.call('browser/restart', {}).catch(() => {}) }
        const statusText = { idle: '未启动', starting: '正在启动…', running: '运行中', stopped: '已停止', error: '出错' }[view.status] || view.status
        const imgSrc = view.rev > 0 ? '/dsh-browser/shot.png?rev=' + view.rev : null
        return React.createElement('div', { className: 'dshbrowser' },
          React.createElement('div', { className: 'dshbrowser-bar' },
            React.createElement('span', { className: 'dshbrowser-dot ' + (view.status === 'running' ? 'ok' : (view.status === 'error' || view.status === 'stopped') ? 'bad' : 'wait') }),
            React.createElement('span', { className: 'dshbrowser-status' }, statusText),
            React.createElement('span', { className: 'dshbrowser-url' }, view.url ? String(view.url) : ''),
            React.createElement('span', { className: 'dshbrowser-tools' }, view.toolCount ? view.toolCount + ' 个浏览器工具' : '')
          ),
          React.createElement('div', { className: 'dshbrowser-row' },
            React.createElement('input', { className: 'dshbrowser-input', placeholder: '输入网址后回车，如 https://www.baidu.com', value: urlInput, onChange: (e) => setUrlInput(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') go() } }),
            React.createElement('button', { className: 'dshbrowser-btn', onClick: go }, '前往'),
            React.createElement('button', { className: 'dshbrowser-btn', onClick: shotNow }, '刷新画面'),
            React.createElement('button', { className: 'dshbrowser-btn', onClick: restartBrowser }, '重启'),
            React.createElement('button', { className: 'dshbrowser-btn danger', onClick: closeBrowser }, '关闭')
          ),
          React.createElement('div', { className: 'dshbrowser-stage' },
            imgSrc
              ? React.createElement('img', { className: 'dshbrowser-img', src: imgSrc, alt: '浏览器实时画面' })
              : React.createElement('div', { className: 'dshbrowser-empty' }, view.status === 'running' ? '等待浏览器画面…' : '浏览器未启动')
          ),
          view.error ? React.createElement('div', { className: 'dshbrowser-error' }, String(view.error)) : null,
          React.createElement('div', { className: 'dshbrowser-hint' }, 'AI 通过 Playwright 控制真实 Chrome：你的桌面上会弹出浏览器窗口；下方画面每次 AI 操作后自动刷新，截图里的数字方框是 AI 可点击的元素编号。')
        )
      }
    ))
  },
}
