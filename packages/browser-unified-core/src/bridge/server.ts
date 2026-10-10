/**
 * Vendored from @caob23/dsh-browser-control v1.0.7 (AGPL-3.0), file src/server.ts.
 * Part of the AGPL-3.0-licensed browser-unified-core merge; two mechanical
 * adaptations for this package's NodeNext emit: the internal import was
 * rewritten to './ws.js', and `import type net` became a namespace import.
 * Upstream: https://github.com/caob23/dsh-browser-control
 *
 * 2026-10-10：并入上游 **v1.0.8**（`43e6325`，同 AGPL-3.0）的安全强化 —— WebSocket
 * 升级加 `Host` 回环校验与 `Origin` 校验（挡 DNS-rebinding 与网页直接拨号）、HTTP 面
 * 鉴权接受 `Authorization: Bearer` / `X-Token` / `?token=` 并用 `timingSafeEqual`、
 * 状态页不再把 token 内嵌进 HTML（改 sessionStorage + 现问）。我们保留的差异：
 * ① `guardCommand` 策略钩子（X18）；② 空 token = 不校验的向后兼容；③ `/api/status`
 * 仍对**回环来源**回显 CORS（GUI 设置页的只读探测依赖它，`ACAO: *` 已收窄成回环回显）。
 *
 * Local WebSocket+HTTP bridge between one browser extension and dsh. The
 * extension connects OUT to `ws://127.0.0.1:<port>/ws?token=...`, so no
 * native-messaging host or registry setup exists; dsh drives commands through
 * {@link BridgeServer.execute} and reads link state through {@link BridgeServer.status}.
 * A small HTTP face (`/api/status`, `/api/command`, `/api/cleanup`, `/`) keeps
 * the bridge usable from curl while the server runs.
 *
 * Wire protocol (text frames, one JSON object each):
 * - extension → server: `{type:'hello',…}`, `{type:'pong',t}`, `{type:'result',id,ok,result?|error}`
 * - server → extension: `{type:'ping',t}`, `{type:'command',id,command,params}`
 *
 * Command names (sent in `command`) include: `ping`, `browser.info`, `tabs.list/open/close/activate`,
 * `nav`, `eval`, `content`, `find`, `click`, `input`, `press`, `scroll`, `snapshot`, `screenshot`,
 * `wait`, `dialog`, `console.log`, `network.log`, `network.clear`, `pdf`, `emulate`.
 * @module @deepseek-ai/dsh-browser-bridge/server
 */

import http from 'node:http'
import type * as net from 'node:net'
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { encodeCloseFrame, encodeControlFrame, encodeTextFrame, FrameReader } from './ws.js'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** Per-command ceiling when the caller passes none. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000
/** Hard ceiling accepted from callers; longer waits cannot be expressed. */
export const MAX_COMMAND_TIMEOUT_MS = 300_000
const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024

/** Identity the extension announces right after the handshake completes. */
export interface BridgeHello {
  readonly client: string
  readonly version: string
  readonly browser: { readonly name: string; readonly version: string; readonly ua: string }
  /**
   * Extension id (`chrome.runtime.id`), when the extension reports it.
   *
   * 这是桥唯一能拿到"扩展是谁"的稳定标识 —— 浏览器侧没有"我在哪个 profile"的接口，
   * 更读不了 `edge://version`（scheme 被拦），所以插件要拿这个 id 去磁盘上
   * 反查"哪个 profile 装了它"。旧版扩展不带此字段，故可选。
   */
  readonly extensionId?: string
}

/** Snapshot of the link and in-flight work, served verbatim on `/api/status`. */
export interface BridgeServerStatus {
  readonly listening: boolean
  readonly port: number | undefined
  readonly extensionConnected: boolean
  readonly connectedAt: string | undefined
  readonly hello: BridgeHello | undefined
  readonly pendingCommands: number
  readonly lastError: string | undefined
  /**
   * Token 还是内置默认值（`dsh-local`）或短于 16 字符 —— 状态面据此标红，
   * 因为**回环绑定不是边界，token 才是**（上游 v1.0.8 的口径）。
   */
  readonly insecureToken: boolean
}

/** Caller controls for one {@link BridgeServer.execute} round-trip. */
export interface BridgeExecuteOptions {
  /** Fail the command after this many milliseconds; defaults to 60s, capped at 300s. */
  readonly timeoutMs?: number
  /** Cancellation from the tool execution; aborting fails the in-flight command. */
  readonly signal?: AbortSignal
}

/** What {@link BridgeServer.cleanup} removed. */
export interface CleanupResult {
  /** Files deleted directly inside the screenshots directory. */
  readonly shotsRemoved: number
  /** Scratch files deleted (agent temp scripts/artifacts matched by convention). */
  readonly scratchRemoved: readonly string[]
}

interface PendingEntry {
  readonly command: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  onAbort?: () => void
}

export interface BridgeServerOptions {
  readonly port: number
  readonly token: string
  /** Directory whose direct contents `cleanup()` clears; created on demand. */
  readonly shotsDir: string
  /** Directory scanned for agent scratch files by `cleanup()`; defaults to the process working directory. */
  readonly scratchDir?: string
  /** Optional line logger for lifecycle diagnostics. */
  readonly log?: (line: string) => void
  /**
   * Optional policy hook for the HTTP command face (`POST /api/command`).
   *
   * 为什么需要它（X18，2026-10-10）：WS 面向扩展；宿主工具走 `GuardedBridge`（导航过
   * `UrlPolicy`）＋工具层的"已开标签页红线"；而 **HTTP 命令面**是第三条通道
   * （同伴件的 browser_frames / browser_frame_eval 就走它），它此前**完全不过策略** ——
   * 等于"带 token 就能对任意标签页 eval / nav"。这个钩子让宿主把策略接回来。
   * @returns 拒绝原因（非空字符串即拒绝 → HTTP 403）；undefined 表示放行。
   */
  readonly guardCommand?: (command: string, params: Record<string, unknown>) => string | undefined | Promise<string | undefined>
}

/** Agent scratch-file convention: `__name.mjs`-style temp artifacts at the top level only. */
const SCRATCH_FILE_PATTERN = /^__[^/\\]+\.(mjs|cjs|js|png|jpg|jpeg)$/i

/**
 * Clear the screenshots directory and delete agent scratch files. Only the
 * top level of each location is touched; nested trees stay untouched.
 * @param options - `shotsDir` is cleared of direct file children; `scratchDir`
 *   defaults to the process working directory and loses only scratch-named files.
 * @returns counts and names of what was removed.
 */
export async function cleanupArtifacts(options: { shotsDir: string; scratchDir?: string }): Promise<CleanupResult> {
	await mkdir(options.shotsDir, { recursive: true })
	const shotsEntries = await readdir(options.shotsDir, { withFileTypes: true })
	let shotsRemoved = 0
	for (const entry of shotsEntries) {
		if (!entry.isFile()) continue
		await rm(path.join(options.shotsDir, entry.name))
		shotsRemoved += 1
	}
	const scratchDir = options.scratchDir ?? process.cwd()
	const scratchEntries = await readdir(scratchDir, { withFileTypes: true }).catch(() => [])
	const scratchRemoved: string[] = []
	for (const entry of scratchEntries) {
		if (!entry.isFile() || !SCRATCH_FILE_PATTERN.test(entry.name)) continue
		await rm(path.join(scratchDir, entry.name))
		scratchRemoved.push(entry.name)
	}
	return { shotsRemoved, scratchRemoved }
}

/**
 * One live bridge endpoint. Start/stop may cycle repeatedly on one instance;
 * a fresh listener is built per start so a changed config reuses the class
 * without re-allocation concerns. Exactly one extension link is held at a
 * time; a newer WebSocket replaces the older one.
 */
export class BridgeServer {
  private readonly options: BridgeServerOptions
  private httpServer: http.Server | undefined
  private clientSocket: net.Socket | undefined
  private hello: BridgeHello | undefined
  private connectedAt: Date | undefined
  private readonly pending = new Map<string, PendingEntry>()
  private lastError: string | undefined
  private continuationRemainder = ''
  private continuationOpen = false

  constructor(options: BridgeServerOptions) {
    this.options = options
  }

  /** Current link state, also served verbatim as `/api/status`. */
  get status(): BridgeServerStatus {
    return {
      listening: this.httpServer !== undefined,
      port: this.httpServer !== undefined ? this.options.port : undefined,
      extensionConnected: this.clientSocket !== undefined,
      connectedAt: this.connectedAt?.toISOString(),
      hello: this.hello,
      pendingCommands: this.pending.size,
      lastError: this.lastError,
      insecureToken: isWeakToken(this.options.token ?? ''),
    }
  }

  /** Bind `127.0.0.1:<port>` and start accepting the extension plus HTTP calls. */
  async start(): Promise<void> {
    if (this.httpServer !== undefined) return
    const server = http.createServer((req, res) => {
      try {
        this.handleHttp(req, res)
      } catch (error) {
        this.log(`http handler failed: ${errorMessage(error)}`)
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'internal error' }))
      }
    })
    server.on('upgrade', (req, socket) => {
      try {
        this.handleUpgrade(req, socket as net.Socket)
      } catch (error) {
        this.log(`upgrade failed: ${errorMessage(error)}`)
        socket.destroy()
      }
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        this.lastError = errorMessage(error)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.options.port, '127.0.0.1')
    })
    this.httpServer = server
    this.log(`listening on ws://127.0.0.1:${this.options.port}/ws`)
    if (isWeakToken(this.options.token ?? '')) {
      // 告警而非拒绝启动（上游 v1.0.8 同口径）：拒绝启动会让所有现存配对当场断连。
      this.log('warning: bridge token is the built-in default or shorter than 16 chars — the token is the only real boundary; set a strong one in the bridge config')
    }
  }

  /** Close the extension link, fail every pending command, and release the port. Idempotent. */
  async stop(): Promise<void> {
    const server = this.httpServer
    if (server === undefined) return
    this.httpServer = undefined
    this.closeClientSocket(1001, 'server stopping')
    this.failAllPending(new Error('browser-bridge stopped'))
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    this.log('stopped')
  }

  /**
   * Send one command to the connected extension and await its result.
   * Throws while no extension is linked; the rejection message names the fix.
   */
  async execute(command: string, params: Record<string, unknown>, options: BridgeExecuteOptions = {}): Promise<unknown> {
    const socket = this.clientSocket
    if (socket === undefined) {
      throw new Error('no browser extension connected — open the browser that has the DSH Browser Control extension installed')
    }
    const timeoutMs = Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS))
    const signal = options.signal
    if (signal?.aborted) throw new Error(`browser command cancelled before send: ${command}`)
    const id = randomUUID()
    const entry: PendingEntry = {
      command,
      resolve: () => {},
      reject: () => {},
      timer: setTimeout(() => {
        if (!this.pending.delete(id)) return
        entry.reject(new Error(`browser command timed out after ${timeoutMs}ms: ${command}`))
      }, timeoutMs),
    }
    const result = new Promise<unknown>((resolve, reject) => {
      entry.resolve = resolve
      entry.reject = reject
    })
    if (signal !== undefined) {
      entry.onAbort = (): void => {
        if (!this.pending.delete(id)) return
        entry.reject(new Error(`browser command cancelled: ${command}`))
      }
      signal.addEventListener('abort', entry.onAbort, { once: true })
    }
    this.pending.set(id, entry)
    this.log(`-> ${command} (${id})`)
    socket.write(encodeTextFrame(JSON.stringify({ type: 'command', id, command, params })))
    try {
      return await result
    } finally {
      clearTimeout(entry.timer)
      if (entry.onAbort !== undefined && signal !== undefined) signal.removeEventListener('abort', entry.onAbort)
    }
  }

  /**
   * Delete generated screenshots and agent scratch files via
   * {@link cleanupArtifacts} using this server's configured directories.
   */
  async cleanup(): Promise<CleanupResult> {
    const result = await cleanupArtifacts({
      shotsDir: this.options.shotsDir,
      ...(this.options.scratchDir === undefined ? {} : { scratchDir: this.options.scratchDir }),
    })
    this.log(`cleanup: ${result.shotsRemoved} screenshot(s), ${result.scratchRemoved.length} scratch file(s)`)
    return result
  }

  private log(line: string): void {
    this.options.log?.(line)
  }

  /* ------------------------------------------------------------- HTTP face */

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const origin = String(req.headers.origin ?? '')
    if (req.method === 'OPTIONS') {
      // 2026-10-10（上游 v1.0.8 口径）：预检不再回任何 CORS 头。网页想发 JSON POST 必先
      // 过预检，预检不给 ACAO ⇒ 真请求根本不会发出。只读的 `/api/status` 是简单 GET，
      // 不经过预检，它的跨域可读性由 respondJson 的**回环来源回显**负责（GUI 探测靠那条）。
      res.writeHead(204)
      res.end()
      return
    }
    if (url.pathname === '/api/status' && req.method === 'GET') {
      this.respondJson(
        res,
        200,
        {
          ok: true,
          ...this.status,
          wsUrl: `ws://127.0.0.1:${this.options.port}/ws`,
          shotsDir: path.resolve(this.options.shotsDir),
        },
        { corsOrigin: loopbackCorsOrigin(origin) },
      )
      return
    }
    if (url.pathname === '/api/cleanup' && req.method === 'POST') {
      // 安全（2026-09-25）：写操作必须带 token（以前任意网页都能触发清理）。
      if (!this.authorized(req, url)) {
        this.rejectUnauthenticated(res, 'POST /api/cleanup')
        return
      }
      void this.cleanup().then(
        (result) => this.respondJson(res, 200, { ok: true, ...result }),
        (error) => this.respondJson(res, 500, { ok: false, error: errorMessage(error) }),
      )
      return
    }
    if (url.pathname === '/api/command' && req.method === 'POST') {
      // 安全（2026-09-25，重要）：该端点能执行任意桥命令（含 eval），以前既不校验 token
      // 又回 `ACAO: *` ⇒ 任意网页都能驱动这台已登录的浏览器。两道一起收。
      if (!this.authorized(req, url)) {
        this.rejectUnauthenticated(res, 'POST /api/command')
        return
      }
      this.handleCommandRequest(req, res)
      return
    }
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(statusPageHtml(this.options.port))
      return
    }
    this.respondJson(res, 404, { ok: false, error: `no route: ${req.method} ${url.pathname}` })
  }

  /**
   * 请求是否携带桥的 token —— 与 WebSocket 升级同一个凭据。接受三种形式：
   * `Authorization: Bearer <token>`、`X-Token` / `X-DSH-Token: <token>`、`?token=<token>`
   * （查询串形式留给 curl 与状态页）。
   *
   * 空 token 视为不校验：配置显式关掉 token 时保持旧行为（本仓库相对上游的差异点）。
   * @returns 凭据是否有效。
   */
  private authorized(req: http.IncomingMessage, url: URL): boolean {
    const authorization = req.headers.authorization
    const header = typeof authorization === 'string' && /^bearer\s+/i.test(authorization)
      ? authorization.replace(/^bearer\s+/i, '')
      : typeof req.headers['x-token'] === 'string'
        ? (req.headers['x-token'] as string)
        : typeof req.headers['x-dsh-token'] === 'string'
          ? (req.headers['x-dsh-token'] as string)
          : ''
    const presented = header.length > 0 ? header : (url.searchParams.get('token') ?? '')
    return tokenMatches(presented, this.options.token ?? '')
  }

  private rejectUnauthenticated(res: http.ServerResponse, route: string): void {
    this.log(`http ${route}: rejected (missing or wrong token)`)
    this.respondJson(res, 401, {
      ok: false,
      error: 'unauthorized: pass the bridge token as "Authorization: Bearer <token>", "X-Token: <token>" or ?token=<token>',
    })
  }

  /**
   * 唯一的 JSON 出口。默认**不发任何 CORS 头**；只有显式给出 `corsOrigin`
   * （只在 `/api/status` 且来源是回环时）才回显该来源。
   */
  private respondJson(
    res: http.ServerResponse,
    statusCode: number,
    body: unknown,
    options: { corsOrigin?: string | undefined } = {},
  ): void {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    }
    if (options.corsOrigin !== undefined && options.corsOrigin.length > 0) {
      headers['Access-Control-Allow-Origin'] = options.corsOrigin
      headers.Vary = 'Origin'
    }
    res.writeHead(statusCode, headers)
    res.end(JSON.stringify(body))
  }

  private handleCommandRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) return // keep discarding so the client sees the 413 instead of a reset
      size += chunk.length
      if (size > MAX_HTTP_BODY_BYTES) {
        aborted = true
        chunks.length = 0
        this.respondJson(res, 413, { ok: false, error: 'body too large' })
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (aborted) return
      let parsed: { command?: unknown; params?: unknown; timeoutMs?: unknown }
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof parsed
      } catch (error) {
        this.respondJson(res, 400, { ok: false, error: `invalid JSON body: ${errorMessage(error)}` })
        return
      }
      if (typeof parsed.command !== 'string' || parsed.command.length === 0) {
        this.respondJson(res, 400, { ok: false, error: 'body must be {"command": "...", "params": {...}}' })
        return
      }
      const timeoutMs = typeof parsed.timeoutMs === 'number' ? parsed.timeoutMs : undefined
      const params = (parsed.params ?? {}) as Record<string, unknown>
      // X18：HTTP 命令面也要过宿主策略（hook 由插件注入；缺省=不拦，保持旧行为）。
      const guard = this.options.guardCommand
      if (guard !== undefined) {
        void Promise.resolve()
          .then(() => guard(parsed.command as string, params))
          .catch((error: unknown) => `guardCommand 抛错：${errorMessage(error)}`)
          .then((reason) => {
            if (typeof reason === 'string' && reason.length > 0) {
              this.log(`[bridge] /api/command 被策略拒绝：${parsed.command} — ${reason}`)
              this.respondJson(res, 403, { ok: false, error: `blocked: ${reason}` })
              return
            }
            this.execute(parsed.command as string, params, timeoutMs === undefined ? {} : { timeoutMs }).then(
              (result) => this.respondJson(res, 200, { ok: true, result }),
              (error) => {
                const message = errorMessage(error)
                const code = message.startsWith('no browser extension') ? 503 : 502
                this.respondJson(res, code, { ok: false, error: message })
              },
            )
          })
        return
      }
      this.execute(parsed.command, params, timeoutMs === undefined ? {} : { timeoutMs }).then(
        (result) => this.respondJson(res, 200, { ok: true, result }),
        (error) => {
          const message = errorMessage(error)
          const code = message.startsWith('no browser extension') ? 503 : 502
          this.respondJson(res, code, { ok: false, error: message })
        },
      )
    })
  }

  /* ------------------------------------------------------- websocket link */

  private handleUpgrade(req: http.IncomingMessage, socket: net.Socket): void {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    if (!tokenMatches(url.searchParams.get('token') ?? '', this.options.token ?? '')) {
      this.log('websocket rejected: bad token')
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    // 2026-10-10（上游 v1.0.8）：WS 握手不受 CORS 约束 —— 网页只要拿到 token 就能直接
    // 拨 127.0.0.1。`Host` 必须是回环（挡 DNS-rebinding：公网域名解析回 127.0.0.1），
    // `Origin` 必须不是网页来源（扩展 scheme 与不带 Origin 的本机客户端放行）。
    if (!isLoopbackHost(String(req.headers.host ?? ''))) {
      this.log(`websocket rejected: host ${String(req.headers.host ?? '')}`)
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    const upgradeOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
    if (!isTrustedUpgradeOrigin(upgradeOrigin)) {
      this.log(`websocket rejected: origin ${upgradeOrigin}`)
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string' || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n`
      + '\r\n',
    )
    this.closeClientSocket(1000, 'replaced by a newer connection')
    this.clientSocket = socket
    this.hello = undefined
    this.connectedAt = new Date()
    this.continuationRemainder = ''
    this.continuationOpen = false
    this.log(`extension connected from ${socket.remoteAddress}:${socket.remotePort}`)
    const reader = new FrameReader()
    socket.on('data', (chunk: Buffer) => {
      reader.push(chunk)
      try {
        reader.drain((frame) => this.handleFrame(frame))
      } catch (error) {
        this.log(`protocol error: ${errorMessage(error)}`)
        this.lastError = errorMessage(error)
        this.closeClientSocket(1002, 'protocol error')
      }
    })
    socket.on('error', (error) => {
      this.logVerbose(`socket error: ${errorMessage(error)}`)
      this.closeClientSocket(1011, 'server error')
    })
    socket.on('close', () => {
      if (this.clientSocket !== socket) return
      this.closeClientSocket(1000, '')
    })
  }

  private handleFrame(frame: { fin: boolean; opcode: number; payload: Buffer }): void {
    switch (frame.opcode) {
      case 0x1:
      case 0x0:
        this.handleText(frame.payload.toString('utf8'), frame.fin, frame.opcode)
        return
      case 0x8:
        this.closeClientSocket(1000, '')
        return
      case 0x9:
        this.clientSocket?.write(encodeControlFrame(0xA, frame.payload))
        return
      default:
        return // pong or binary: nothing to do
    }
  }

  private handleText(text: string, fin: boolean, opcode: number): void {
    if (opcode === 0x0 && !this.continuationOpen) return // stray continuation
    if (opcode === 0x1) this.continuationRemainder = ''
    this.continuationOpen = opcode === 0x0 || !fin
    this.continuationRemainder += text
    if (!fin) return
    const full = this.continuationRemainder
    this.continuationRemainder = ''
    this.continuationOpen = false
    let msg: { type?: unknown; id?: unknown; ok?: unknown; result?: unknown; error?: unknown; t?: unknown; client?: unknown; version?: unknown; browser?: unknown; extensionId?: unknown }
    try {
      msg = JSON.parse(full) as typeof msg
    } catch {
      this.logVerbose('dropped a non-JSON extension message')
      return
    }
    if (msg.type === 'hello') {
      this.hello = {
        client: typeof msg.client === 'string' ? msg.client : 'unknown',
        version: typeof msg.version === 'string' ? msg.version : 'unknown',
        browser: (msg.browser ?? { name: 'unknown', version: 'unknown', ua: '' }) as BridgeHello['browser'],
        ...(typeof msg.extensionId === 'string' && msg.extensionId.length > 0 ? { extensionId: msg.extensionId } : {}),
      }
      this.log(`hello: client=${this.hello.client} v${this.hello.version} browser=${this.hello.browser.name} ${this.hello.browser.version}`
        + `${this.hello.extensionId !== undefined ? ` id=${this.hello.extensionId}` : ''}`)
      return
    }
    if (msg.type === 'pong') return
    if (msg.type === 'result' && typeof msg.id === 'string') {
      const entry = this.pending.get(msg.id)
      if (entry === undefined) {
        this.logVerbose(`result for unknown id ${msg.id}`)
        return
      }
      this.pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.ok === true) entry.resolve(msg.result)
      else entry.reject(new Error(typeof msg.error === 'string' && msg.error.length > 0 ? msg.error : 'unknown extension error'))
    }
  }

  private closeClientSocket(code: number, reason: string): void {
    const socket = this.clientSocket
    if (socket === undefined) return
    this.clientSocket = undefined
    this.hello = undefined
    this.connectedAt = undefined
    this.failAllPending(new Error('the browser extension disconnected mid-command'))
    try {
      socket.write(encodeCloseFrame(code, reason))
      socket.end()
      setTimeout(() => socket.destroy(), 500).unref()
    } catch {
      socket.destroy()
    }
    if (reason.length > 0) this.log(`extension disconnected (${reason})`)
  }

  private failAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  private logVerbose(line: string): void {
    // Verbose chatter stays available under the same line logger; lifecycle logs matter most.
    this.options.log?.(line)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 常量时间比较 token：只有"长度不同"会泄露。空 `expected` 视为不校验 —— 配置显式
 * 关掉 token 时保留旧行为（本仓库相对上游 v1.0.8 的差异点；上游则一律要求相等）。
 * @param presented - 请求携带的凭据。
 * @param expected - 配置里的 token。
 * @returns 是否匹配。
 */
function tokenMatches(presented: string, expected: string): boolean {
  if (expected.length === 0) return true
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Token 是内置默认值或短于 16 字符 ⇒ 状态面标红、启动时告警（不拒绝启动）。 */
function isWeakToken(token: string): boolean {
  return token === 'dsh-local' || token.length < 16
}

/**
 * `Host` 必须指向本机回环地址。这是挡 DNS-rebinding 的那一半：公网域名解析回
 * 127.0.0.1 时，浏览器发来的 `Host` 是那个域名而不是回环名。
 * @param host - 请求的 `Host` 头（含端口）。
 * @returns 是否为回环主机名。
 */
function isLoopbackHost(host: string): boolean {
  const withoutPort = host.replace(/:\d+$/, '')
  return withoutPort === '127.0.0.1' || withoutPort === 'localhost' || withoutPort === '[::1]' || withoutPort === '::1'
}

/**
 * WebSocket 握手不受 CORS 约束，所以"来源是不是网页"必须在这里判：网页 scheme 一律拒
 * （`http(s)://` 只放行回环，供本机自研客户端），扩展 scheme 与**不带 Origin** 的
 * 本机客户端（扩展在部分版本不发送 Origin、curl/测试台也不发）放行。
 * @param origin - 请求的 `Origin` 头，缺失时为空串。
 * @returns 是否可信。
 */
function isTrustedUpgradeOrigin(origin: string): boolean {
  if (origin === '') return true
  if (/^(?:chrome|moz|ms|safari)-extension:\/\//.test(origin)) return true
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(origin)
}

/**
 * 只对**回环来源**回显 CORS：DSH 控制页（`http://127.0.0.1:<port>`）的设置分区要读
 * `/api/status` 做端口/扩展探测。其余来源（含任意公网网页）一律不回 ACAO。
 * @param origin - 请求的 `Origin` 头。
 * @returns 可回显的来源，或 undefined 表示不回。
 */
function loopbackCorsOrigin(origin: string): string | undefined {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(origin) ? origin : undefined
}

/**
 * 最小状态页（自刷新 + 清理按钮）。**不再把 token 内嵌进 HTML**（上游 v1.0.8 口径）：
 * 内嵌等于任何能 GET `/` 的本机程序都能读到唯一凭据，把 token 边界变成摆设。
 * @param port - 监听端口，只用于页脚展示。
 * @returns 完整 HTML 文本。
 */
function statusPageHtml(port: number): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Browser Control — 状态</title>
<style>
  :root{--bg:#0f172a;--card:#1e293b;--border:#334155;--text:#e2e8f0;--dim:#94a3b8;
        --green:#22c55e;--green-bg:rgba(34,197,94,.12);--red:#ef4444;--red-bg:rgba(239,68,68,.10)}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);
       color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:16px;max-width:440px;width:100%;overflow:hidden}
  .head{padding:20px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px}
  .dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;background:var(--red)}
  .dot.on{background:var(--green);box-shadow:0 0 6px var(--green)}
  .head h1{font-size:15px;font-weight:600}.head small{color:var(--dim);font-size:11px}
  .rows{padding:16px 24px}
  .row{display:flex;justify-content:space-between;align-items:baseline;padding:7px 0;
       border-bottom:1px solid var(--border);font-size:13px}
  .row:last-child{border-bottom:none}
  .row .k{color:var(--dim)}.row .v{font-weight:500;text-align:right;max-width:260px;word-break:break-all}
  .badge{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600}
  .badge.on{background:var(--green-bg);color:var(--green)}.badge.off{background:var(--red-bg);color:var(--red)}
  .actions{padding:8px 24px;display:flex;gap:8px}
  .btn{padding:7px 14px;border:1px solid var(--border);border-radius:9px;background:var(--card);
       color:var(--text);font-size:12px;cursor:pointer}.btn:hover{background:#334155}
  .btn.danger{border-color:var(--red);color:var(--red)}.btn.danger:hover{background:var(--red-bg)}
  .hint{color:var(--dim);font-size:11px;padding:4px 24px 8px}
  .tok{padding:0 24px 8px;display:flex;gap:8px;align-items:center}
  .tok input{flex:1;min-width:0;padding:6px 10px;border:1px solid var(--border);border-radius:9px;
       background:var(--bg);color:var(--text);font-size:12px}
  .pre{background:var(--bg);border-top:1px solid var(--border);padding:12px 24px}
  .pre code{color:var(--dim);font-size:11px;white-space:pre-wrap;word-break:break-all}
  .foot{text-align:center;padding:12px;font-size:11px;color:var(--dim)}
</style>
</head>
<body>
<div class="card">
  <div class="head">
    <div class="dot" id="dot"></div>
    <div><h1>DSH Browser Control</h1><small id="sub">加载中…</small></div>
  </div>
  <div class="rows" id="rows"></div>
  <div class="actions">
    <button class="btn" onclick="refresh()">刷新</button>
    <button class="btn danger" id="cleanup">🧹 清理截图 + 脚本草稿</button>
  </div>
  <div class="tok">
    <input id="token" type="password" autocomplete="off" placeholder="桥接 Token（仅本页会话内存，不写盘）">
  </div>
  <div class="hint">
    清理会删除截图目录下的全部文件，以及工作目录顶层的 __ 开头草稿脚本；<b>需要 Token</b>。
    Token 不在本页内嵌（内嵌＝任何本机程序 GET / 就能拿到），只在 sessionStorage 里留到关页。
  </div>
  <div class="pre"><code id="raw"> </code></div>
  <div class="foot">DSH Browser Bridge · 127.0.0.1:${port}</div>
</div>
<script>
async function refresh(){
  try{
    const r=await fetch('/api/status');const j=await r.json();
    const connected=j.extensionConnected;
    document.getElementById('dot').className='dot'+(connected?' on':'');
    document.getElementById('sub').textContent=connected
      ?(j.hello?j.hello.client+' '+j.hello.browser.name+' '+j.hello.browser.version:'已连接')
      :'等待浏览器扩展连接…';
    const rows=[
      ['监听端口','<span class="badge on">'+j.port+'</span>'],
      ['扩展状态',connected?'<span class="badge on">已连接</span>':'<span class="badge off">未连接</span>'],
      ['扩展类型',j.hello?(j.hello.client+' v'+j.hello.version):'—'],
      ['浏览器',j.hello?(j.hello.browser.name+' '+j.hello.browser.version):'—'],
      ['等待命令',String(j.pendingCommands??0)],
      ['连接时间',j.connectedAt?new Date(j.connectedAt).toLocaleString():'—'],
      ['截图目录',j.shotsDir||'—'],
      ['令牌强度',j.insecureToken?'<span class="badge off">默认/过短，建议改了</span>':'<span class="badge on">已自定义</span>'],
    ];
    document.getElementById('rows').innerHTML=rows.map(([k,v])=>'<div class="row"><span class="k">'+k+'</span><span class="v">'+v+'</span></div>').join('');
    document.getElementById('raw').textContent=JSON.stringify(j,null,2);
  }catch(e){document.getElementById('sub').textContent='连接失败: '+e.message}
}
function bridgeToken(){
  const el=document.getElementById('token');
  let t=(el.value||'').trim()||sessionStorage.getItem('dshBridgeToken')||'';
  if(!t){ t=(prompt('桥接 Token（在 profile 的 browser-bridge 配置里，token 字段）')||'').trim(); el.value=t; }
  if(t) sessionStorage.setItem('dshBridgeToken',t);
  return t;
}
document.getElementById('cleanup').onclick=async()=>{
  if(!confirm('确认清理截图与临时脚本？'))return;
  const r=await fetch('/api/cleanup',{method:'POST',headers:{'Authorization':'Bearer '+bridgeToken()}});
  const j=await r.json();
  if(r.status===401){alert('Token 不对，清理没有执行。');return;}
  alert(j.ok?('已删除 '+j.shotsRemoved+' 个截图，'+j.scratchRemoved.length+' 个草稿'):('失败：'+j.error));
  refresh();
};
refresh();setInterval(refresh,2000);
</script>
</body></html>`;
}
