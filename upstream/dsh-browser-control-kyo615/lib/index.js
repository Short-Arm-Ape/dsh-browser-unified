// ============================================================
// dsh-browser-control · 宿主端入口（正式 bundle 插件版）
// ------------------------------------------------------------
// 本文件是标准 Cordis 插件模块（ESM），供 `dsh plugin add` 安装后
// 作为插件的 host 半加载（package.json 的 "main" / exports["."] 指向这里）。
// 也可作为 cordis_define 的 code.host 参考（去掉 `export default` 即为函数体）。
//
// 与动态版本一致：所有本机路径均已参数化 / 自动探测，无硬编码。
// 配置解析顺序：
//   1. 插件配置 config.workspace（patch 或运行时可传）
//   2. 当前会话工作区 sandboxPolicy.workspaceRoot
//   3. 空 → 相对当前目录解析（fallback）
// ============================================================

export default {
  inject: ['timer'],
  apply(ctx, config) {
    const cfg = config && typeof config === 'object' ? config : {}
    // —— 配置解析（全部可覆盖，无硬编码本机路径）——
    const sp = ctx.get('sandboxPolicy')
    const sessionWorkspace = sp && sp.workspaceRoot ? String(sp.workspaceRoot) : ''
    const workspace = String(cfg.workspace || sessionWorkspace || '')
    const START_URL = cfg.startUrl || 'https://www.bing.com'
    const PROTOCOL = cfg.protocol || '2025-03-26'
    const SHOT_REL = cfg.shotPath || '.playwright-mcp/live.png'
    const VIEWPORT = cfg.viewport || '1280x800'
    const RUN_CWD = workspace || '.'

    const state = { status: 'idle', mcpReady: false, lastError: '', url: '', shotRev: 0, toolCount: 0 }
    const disposers = []
    let handle = null
    let started = null
    let seq = 0
    let buf = ''
    let queueTail = Promise.resolve()
    const pending = new Map()

    function send(line) {
      if (!handle || !handle.stdin) throw new Error('浏览器服务未运行')
      handle.stdin.write(line + '\n')
    }
    function onData(chunk) {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) } catch (e) { continue }
        if (msg && msg.id !== undefined && msg.id !== null) {
          const p = pending.get(msg.id)
          if (p) {
            pending.delete(msg.id)
            if (msg.error) p.reject(new Error((msg.error && msg.error.message) || 'MCP 错误'))
            else p.resolve(msg.result)
          }
        }
      }
    }
    function request(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve, reject })
        try { send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} })) }
        catch (e) { pending.delete(id); reject(e) }
      })
    }
    function notify(method, params) {
      send(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }))
    }
    function enqueue(fn) {
      const run = queueTail.then(fn, fn)
      queueTail = run.then(() => {}, () => {})
      return run
    }
    function withTimeout(promise, ms, label) {
      return new Promise((resolve, reject) => {
        let settled = false
        const cancel = ctx.timeout(() => { if (!settled) { settled = true; reject(new Error(label + ' 超时')) } }, ms)
        promise.then((v) => { if (!settled) { settled = true; cancel(); resolve(v) } }, (e) => { if (!settled) { settled = true; cancel(); reject(e) } })
      })
    }
    function withAbort(promise, signal, label) {
      if (!signal) return promise
      const fail = () => { const e = new Error(label + ' 已取消'); e.aborted = true; return e }
      if (signal.aborted) return Promise.reject(fail())
      return new Promise((resolve, reject) => {
        let settled = false
        const cleanup = () => { try { signal.removeEventListener('abort', onAbort) } catch (e) {} }
        const onAbort = () => { if (!settled) { settled = true; cleanup(); reject(fail()) } }
        signal.addEventListener('abort', onAbort)
        promise.then((v) => { if (!settled) { settled = true; cleanup(); resolve(v) } }, (e) => { if (!settled) { settled = true; cleanup(); reject(e) } })
      })
    }
    function sanitizeSchema(node, root) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return { type: 'json' }
      const out = {}
      for (const k of ['description', 'title', 'default', 'examples']) {
        if (node[k] !== undefined) out[k] = node[k]
      }
      if (Array.isArray(node.oneOf) && node.oneOf.length >= 2) {
        out.oneOf = node.oneOf.map((c) => sanitizeSchema(c, false))
        return out
      }
      if (Array.isArray(node.anyOf) && node.anyOf.length >= 2) {
        out.oneOf = node.anyOf.map((c) => sanitizeSchema(c, false))
        return out
      }
      let type = node.type
      if (Array.isArray(type)) type = type[0]
      if (typeof type !== 'string' || !['string', 'number', 'integer', 'boolean', 'null', 'object', 'array'].includes(type)) {
        out.type = 'json'
        return out
      }
      out.type = type
      if (type === 'object') {
        const props = node.properties
        if (props && typeof props === 'object' && !Array.isArray(props)) {
          const keys = Object.keys(props)
          out.properties = {}
          for (const key of keys) out.properties[key] = sanitizeSchema(props[key], false)
          if (Array.isArray(node.required)) {
            out.required = node.required.filter((n) => typeof n === 'string' && Object.prototype.hasOwnProperty.call(props, n))
          }
        }
        if (!root && typeof node.additionalProperties === 'boolean') out.additionalProperties = node.additionalProperties
      } else if (type === 'array' && node.items) {
        out.items = sanitizeSchema(node.items, false)
      }
      return out
    }
    function extractResult(res) {
      let text = ''
      const content = (res && res.content) || []
      for (const block of content) {
        if (!block) continue
        if (block.type === 'text') text += (text ? '\n' : '') + block.text
        else if (block.type === 'resource' && block.resource && block.resource.text) text += (text ? '\n' : '') + block.resource.text
      }
      return { text: text, isError: !!(res && res.isError) }
    }
    // —— 路径解析（自动探测，绝不写死本机路径）——
    async function resolveCli() {
      const fs = ctx.get('fs')
      const candidates = []
      if (cfg.cli) candidates.push(String(cfg.cli))
      if (workspace) candidates.push(workspace + '/node_modules/@playwright/mcp/cli.js')
      candidates.push('node_modules/@playwright/mcp/cli.js')
      if (fs) {
        for (const c of candidates) {
          try {
            const target = await fs.resolve(c, { cwd: workspace || undefined })
            const info = await fs.stat(target)
            if (info) return fs.processPath(target)
          } catch (e) {}
        }
      }
      const subprocess = ctx.get('subprocess')
      if (subprocess) { try { return await subprocess.resolveExecutable('playwright-mcp') } catch (e) {} }
      throw new Error('未找到 @playwright/mcp。请先在工作区执行 npm install @playwright/mcp（或通过配置指定 cli 路径）。')
    }
    async function shotTarget() {
      const fs = ctx.get('fs')
      if (!fs) return null
      try { return await fs.resolve(SHOT_REL, { cwd: workspace || undefined }) } catch (e) { return null }
    }
    async function refreshShot() {
      if (!state.mcpReady || !handle) return
      try {
        await request('tools/call', { name: 'browser_take_screenshot', arguments: { filename: SHOT_REL, scale: 'css', type: 'png' } })
        state.shotRev += 1
      } catch (e) {}
    }
    async function toolCall(name, args) {
      const res = await request('tools/call', { name, arguments: args || {} })
      const out = extractResult(res)
      if (out.isError) throw new Error((out.text || '浏览器操作失败').slice(0, 1200))
      if (name !== 'browser_close' && name !== 'browser_take_screenshot') {
        const p = enqueue(() => refreshShot())
        p.catch(() => {})
      }
      return out
    }
    async function mcpCall(name, args, signal) {
      if (!state.mcpReady) await ensureStarted()
      const run = () => withTimeout(toolCall(name, args), 180000, name)
      const p = enqueue(run)
      return withAbort(p, signal, name)
    }
    async function resolveNode() {
      const subprocess = ctx.get('subprocess')
      if (subprocess) {
        for (const name of ['node', 'node.exe']) {
          try { return await subprocess.resolveExecutable(name) } catch (e) {}
        }
      }
      return 'node'
    }
    function onExit(reason, h) {
      if (handle !== h) return
      state.mcpReady = false
      if (state.status !== 'error') { state.status = 'stopped'; state.lastError = '浏览器服务退出: ' + reason }
      handle = null
      started = null
    }
    async function ensureStarted() {
      if (started) return started
      started = (async () => {
        state.status = 'starting'
        state.lastError = ''
        try {
          const subprocess = ctx.get('subprocess')
          if (!subprocess) throw new Error('subprocess 服务不可用')
          const node = await resolveNode()
          const cli = await resolveCli()
          const h = subprocess.spawn({
            argv: [node, cli, '--browser', 'chrome', '--viewport-size', VIEWPORT, '--isolated', '--image-responses', 'allow', '--snapshot-boxes'],
            cwd: RUN_CWD,
            stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
            graceMs: 5000,
          })
          handle = h
          h.stdout.setEncoding('utf8')
          h.stdout.on('data', onData)
          if (h.stderr) { h.stderr.setEncoding('utf8'); h.stderr.on('data', () => {}) }
          h.done.then((o) => onExit('退出码 ' + o.exitCode, h), (e) => onExit(String(e), h))
          await withTimeout(request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'dsh-browser-control', version: '1.0.0' } }), 30000, 'initialize')
          notify('notifications/initialized', {})
          const toolsRes = await withTimeout(request('tools/list', {}), 30000, 'tools/list')
          const tools = (toolsRes && toolsRes.tools) || []
          state.toolCount = tools.length
          for (const d of disposers) { try { d() } catch (e) {} }
          disposers.length = 0
          for (const t of tools) {
            if (!t || !t.name) continue
            const toolName = t.name
            const params = sanitizeSchema(t.inputSchema, true)
            const def = harness.defineTool({
              name: toolName,
              description: String(t.description || ''),
              parameters: params.type === 'object' ? params : { type: 'object', properties: {} },
              output: {
                schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } } },
                render(args, value) {
                  const v = value && value.text !== undefined ? value.text : String(value)
                  return [{ type: 'text', text: String(v) }]
                },
              },
              async execute(args, exec) {
                const out = await mcpCall(toolName, args || {}, exec && exec.signal)
                return { text: out.text }
              },
            })
            disposers.push(harness.registerTool(ctx, def))
          }
          state.mcpReady = true
          state.status = 'running'
          try {
            await toolCall('browser_navigate', { url: START_URL })
            state.url = START_URL
          } catch (e) {
            state.lastError = '打开起始页失败: ' + String(e)
          }
        } catch (e) {
          state.status = 'error'
          state.lastError = String(e)
          state.mcpReady = false
        }
      })()
      return started
    }

    // 停止时终止子进程
    ctx.effect(() => () => {
      if (handle) { try { handle.terminate() } catch (e) {} }
    })

    // 实时画面 HTTP 路由：把最新截图文件直接喂给 GUI 页面
    const webServer = ctx.get('webServer')
    if (webServer) {
      webServer.register({
        kind: 'exact',
        path: '/dsh-browser/shot.png',
        async handler(req, res) {
          try {
            const fs = ctx.get('fs')
            const target = await shotTarget()
            if (!fs || !target) { res.writeHead(404); res.end('no screenshot yet'); return }
            const info = await fs.stat(target)
            if (!info) { res.writeHead(404); res.end('no screenshot yet'); return }
            const bytes = await fs.readBytes(target, undefined, 12 * 1024 * 1024)
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
            res.end(bytes)
          } catch (e) {
            try { res.writeHead(500); res.end('screenshot error') } catch (e2) {}
          }
        },
      })
    }

    // 状态查询工具（始终注册，供模型诊断/启动）
    disposers.push(harness.registerTool(ctx, harness.defineTool({
      name: 'browser_status',
      description: '查询浏览器控制服务状态（是否运行、当前网址、可用工具数、错误）。若浏览器未运行，传入 { start: true } 会启动它。',
      parameters: { type: 'object', properties: { start: { type: 'boolean', description: '设为 true 时启动浏览器服务' } } },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } } },
        render(args, value) { return [{ type: 'text', text: String(value.text) }] },
      },
      async execute(args, exec) {
        if (args && args.start && !state.mcpReady) { try { await ensureStarted() } catch (e) {} }
        return { text: JSON.stringify({ status: state.status, url: state.url, rev: state.shotRev, tools: state.toolCount, error: state.lastError }) }
      },
    })))

    // Client RPC
    harness.handle('browser/state', (args) => {
      return { status: state.status, url: state.url, rev: state.shotRev, toolCount: state.toolCount, error: state.lastError }
    })
    harness.handle('browser/navigate', async (args) => {
      const url = String((args && args.url) || '').trim()
      if (!url) return { ok: false, error: '请输入网址' }
      const out = await mcpCall('browser_navigate', { url })
      state.url = url
      return { ok: true, text: out.text.slice(0, 3000) }
    })
    harness.handle('browser/shot', async () => {
      await enqueue(() => refreshShot())
      return { ok: true }
    })
    harness.handle('browser/close', async () => {
      try { await mcpCall('browser_close', {}) } catch (e) {}
      return { ok: true }
    })
    harness.handle('browser/restart', async () => {
      try { if (handle) handle.terminate() } catch (e) {}
      started = null
      state.url = ''
      state.shotRev = 0
      const p = ensureStarted()
      return { ok: true }
    })

    // 后台启动浏览器
    const p = ensureStarted()
  },
}
