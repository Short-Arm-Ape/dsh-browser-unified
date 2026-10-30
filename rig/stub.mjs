/**
 * __pr-d-rig/stub.mjs — a minimal stand-in for the DSH browser bridge.
 *
 * Why: to get REAL-browser evidence for upstream commit candidates that live in
 * `extension/background.js`, without touching the user's live Edge profile
 * (Profile 3 / extension 1.0.19 on port 9777). This stub speaks the same wire
 * protocol as the bridge (see the project's src/ws.ts + extension/background.js):
 *
 *   extension --ws--> ws://127.0.0.1:PORT/ws?token=T
 *     extension sends {type:'hello',...} once, then {type:'ping'} every 20 s
 *     we send        {type:'command', id, command, params}
 *     it replies     {type:'result', id, ok, result|error}
 *
 * It also serves the test pages, so a navigation can be made slow on purpose.
 *
 *   GET  /fast                 -> completes immediately
 *   GET  /press                -> keyboard scenario page (event counters + form submit)
 *   GET  /api/status           -> what the *unified* extension's port discovery probes
 *   GET  /slow?ms=3000         -> headers + body start now, response ends in ms
 *   GET  /ctl/state            -> {connected, hello}
 *   POST /ctl/cmd              -> body {command, params, timeoutMs}; runs it and
 *                                 returns {elapsedMs, ok, result|error}
 *
 * The frame codec below is a compact adaptation of the project's src/ws.ts
 * (FrameReader / encodeTextFrame), so the stub has zero npm dependencies.
 */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'

const PORT = Number(process.env.RIG_PORT || 9781)
const LOG = process.env.RIG_LOG || new URL('./stub.log', import.meta.url).pathname

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`
  process.stdout.write(line + '\n')
  try { fs.appendFileSync(LOG, line + '\n') } catch { /* log is best effort */ }
}

/* ---------------------------------------------------------------- ws codec */

class FrameReader {
  constructor() { this.buffer = Buffer.alloc(0) }
  push(chunk) { this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]) }
  drain(onFrame) { for (;;) { const f = this.read(); if (!f) return; onFrame(f) } }
  read() {
    const buf = this.buffer
    if (buf.length < 2) return null
    const fin = (buf[0] & 0x80) !== 0
    const opcode = buf[0] & 0x0f
    const masked = (buf[1] & 0x80) !== 0
    let length = buf[1] & 0x7f
    let offset = 2
    if (length === 126) { if (buf.length < offset + 2) return null; length = buf.readUInt16BE(offset); offset += 2 }
    else if (length === 127) { if (buf.length < offset + 8) return null; length = Number(buf.readBigUInt64BE(offset)); offset += 8 }
    let maskKey = null
    if (masked) { if (buf.length < offset + 4) return null; maskKey = buf.subarray(offset, offset + 4); offset += 4 }
    if (buf.length < offset + length) return null
    const payload = Buffer.from(buf.subarray(offset, offset + length))
    if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3]
    this.buffer = buf.subarray(offset + length)
    return { fin, opcode, payload }
  }
}

function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  if (payload.length < 126) return Buffer.from([0x81, payload.length, ...payload])
  if (payload.length < 65536) {
    const header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2)
  return Buffer.concat([header, payload])
}

/* ------------------------------------------------------------ extension link */

let link = null
let hello = null
const pending = new Map()
let seq = 0

function sendToExtension(msg) { if (link) { try { link.write(encodeTextFrame(JSON.stringify(msg))) } catch (err) { log('send failed:', err.message) } } }

function runCommand(command, params, timeoutMs = 25000) {
  return new Promise((resolve) => {
    if (!link) { resolve({ ok: false, error: 'no extension connected' }); return }
    const id = `rig-${++seq}`
    const started = Date.now()
    const timer = setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      resolve({ ok: false, error: `rig timeout after ${timeoutMs}ms`, elapsedMs: Date.now() - started })
    }, timeoutMs)
    pending.set(id, (msg) => { clearTimeout(timer); resolve({ ...msg, elapsedMs: Date.now() - started }) })
    sendToExtension({ type: 'command', id, command, params: params ?? {} })
  })
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const p = url.pathname

  if (p === '/fast') {
    const stamp = Date.now() % 1000000
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<title>FAST-${stamp}</title><h1>fast page ${stamp}</h1>`)
    log('GET /fast -> FAST-' + stamp)
    return
  }

  if (p === '/slow') {
    const ms = Number(url.searchParams.get('ms') || '3000')
    const stamp = Date.now() % 1000000
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.write(`<title>SLOW-${stamp}</title><h1>slow page ${stamp}</h1>`)
    log(`GET /slow ms=${ms} -> SLOW-${stamp} (response held open)`)
    setTimeout(() => { try { res.end('<p>done</p>') ; log(`/slow ${stamp} finished`) } catch { /* closed */ } }, ms)
    return
  }

  if (p === '/hang') {
    // Accept the connection and never answer: the browser's navigation is stuck
    // between "started" and "committed" for as long as we like.
    log('GET /hang -> holding the response open, no bytes sent')
    setTimeout(() => { try { res.end('too late') } catch { /* closed */ } }, 60000)
    return
  }

  if (p === '/press') {
    // Keyboard scenario page: counts the page-side events and form submits so a
    // "typed once vs twice" defect is visible as numbers, not as a screenshot.
    const stamp = Date.now() % 1000000
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>PRESS-${stamp}</title>
<input id="i" autocomplete="off" />
<form id="f"><input id="j" autocomplete="off" /><button type="submit">go</button></form>
<script>
  window.__c = { keydown: 0, keypress: 0, input: 0, submit: 0, beforeinput: 0 };
  const i = document.getElementById('i');
  i.addEventListener('keydown', () => window.__c.keydown++);
  i.addEventListener('keypress', () => window.__c.keypress++);
  i.addEventListener('beforeinput', () => window.__c.beforeinput++);
  i.addEventListener('input', () => window.__c.input++);
  document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); window.__c.submit++ });
  window.__reset = () => {
    window.__c = { keydown: 0, keypress: 0, input: 0, submit: 0, beforeinput: 0 };
    i.value = ''; document.getElementById('j').value = ''; i.focus();
    return document.activeElement === i;
  };
  window.__resetForm = () => {
    window.__c = { keydown: 0, keypress: 0, input: 0, submit: 0, beforeinput: 0 };
    const j = document.getElementById('j'); j.value = ''; j.focus();
    return document.activeElement === j;
  };
  window.__state = () => ({ value: i.value, formValue: document.getElementById('j').value, ...window.__c });
</script>`)
    log('GET /press -> PRESS-' + stamp)
    return
  }

  if (p === '/api/status') {
    // What the *unified* extension's port auto-discovery probes. Served here so the
    // rig works with the local (port-discovering) extension line too, not just
    // upstream's hard-coded-port one.
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    })
    res.end(JSON.stringify({
      ok: true,
      port: PORT,
      wsUrl: `ws://127.0.0.1:${PORT}/ws?token=rig-local`,
      extensionConnected: link !== null,
      rig: true,
    }))
    return
  }

  if (p === '/ctl/state') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ connected: link !== null, hello, pending: pending.size }))
    return
  }

  if (p === '/ctl/cmd') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      let parsed
      try { parsed = JSON.parse(body || '{}') } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'bad json: ' + err.message })); return
      }
      const { command, params, timeoutMs } = parsed
      log(`CTL ${command} ${JSON.stringify(params ?? {})}`)
      const out = await runCommand(command, params, timeoutMs)
      log(`CTL ${command} -> elapsed=${out.elapsedMs}ms ok=${out.ok} ${out.ok ? JSON.stringify(out.result).slice(0, 400) : out.error}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    })
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found')
})

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname !== '/ws') { socket.destroy(); return }
  const key = req.headers['sec-websocket-key']
  if (!key) { socket.destroy(); return }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
  log('extension connected from', req.socket.remoteAddress, 'token=' + (url.searchParams.get('token') ? 'present' : 'absent'))
  link = socket
  const reader = new FrameReader()
  socket.on('data', (chunk) => {
    reader.push(chunk)
    try {
      reader.drain((frame) => {
        if (frame.opcode === 0x8) { log('extension sent close'); socket.end(); return }
        if (frame.opcode === 0x9) { socket.write(Buffer.from([0x8a, frame.payload.length, ...frame.payload])); return }
        if (frame.opcode !== 0x1 && frame.opcode !== 0x0) return
        let msg
        try { msg = JSON.parse(frame.payload.toString('utf8')) } catch { return }
        if (msg.type === 'hello') { hello = msg; log('hello:', JSON.stringify(msg)) }
        else if (msg.type === 'ping') sendToExtension({ type: 'pong', t: msg.t })
        else if (msg.type === 'result') { const cb = pending.get(msg.id); if (cb) { pending.delete(msg.id); cb(msg) } }
      })
    } catch (err) { log('frame error:', err.message) }
  })
  socket.on('close', () => { if (link === socket) { link = null; hello = null } ; log('extension disconnected') })
  socket.on('error', () => { /* close follows */ })
})

server.listen(PORT, '0.0.0.0', () => log(`rig stub listening on 0.0.0.0:${PORT} (ws /ws, pages /fast /slow, ctl /ctl/state /ctl/cmd)`))
