import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import type { GpuSessionDTO } from '../../../shared/types/runpod'
import type { EventBus } from '../../services/events'
import type { ComfyClient } from './comfy'

/**
 * The pod's ComfyUI, served on its own loopback port (http://127.0.0.1:<port>/) for the app's ComfyUI window and for
 * a normal browser tab. The pod only lets in requests that carry the app's token (Caddy); this proxy adds it, so the
 * token never reaches a page. Its own origin keeps ComfyUI's page (and the custom nodes' scripts it loads) apart
 * from the app's API.
 *
 * - Host and Origin must be this proxy's (no DNS rebinding, no other site driving it — WebSockets included).
 * - Requests and responses stream through unchanged, except: the token is added, Origin/Referer/Cookie are dropped
 *   (ComfyUI would refuse a foreign Origin), CORS headers are dropped, and ComfyUI's index.html gets a small script
 *   that reports clicks and keys — using ComfyUI keeps the GPU on (see GpuSession.touch).
 * - Prompts queued from the page are reported to the inbox, which saves their outputs to the project.
 */

export interface ComfyProxyDeps {
  session: {
    client(): ComfyClient | undefined
    dto(): GpuSessionDTO
    touch(): void
    requestStart(): void
  }
  inbox: { track(promptId: string): void }
  events: EventBus
}

export interface ComfyProxyOptions {
  host?: string
  /** Tried first (a stable port keeps ComfyUI's settings in the browser); any free port otherwise. */
  port?: number
}

const DROP_REQUEST = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'origin',
  'referer',
  'cookie',
  'authorization',
])
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'alt-svc', 'strict-transport-security'])
const MAX_BUFFERED = 8 * 1024 * 1024

export class ComfyProxy {
  private readonly server: http.Server
  private readonly sockets = new Set<Duplex>()
  private port = 0
  private hosts = new Set<string>()
  private origins = new Set<string>()
  private listening: Promise<string> | undefined

  constructor(
    private readonly deps: ComfyProxyDeps,
    private readonly opts: ComfyProxyOptions = {},
  ) {
    this.server = http.createServer((req, res) => this.handle(req, res))
    this.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head))
    deps.events.subscribe((event) => {
      // ComfyUI's live connection ends with the pod (the page reconnects once a new one is ready).
      if (event.type === 'gpu.session' && event.session.state !== 'ready') this.dropSockets()
    })
  }

  /** Starts listening (once); resolves to the address pages open. */
  ensureListening(): Promise<string> {
    this.listening ??= this.listen().catch((err) => {
      this.listening = undefined
      throw err
    })
    return this.listening
  }

  get url(): string | undefined {
    return this.port ? `http://127.0.0.1:${this.port}/` : undefined
  }

  async close(): Promise<void> {
    this.dropSockets()
    if (!this.server.listening) return
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  // ---------------------------------------------------------------- listening

  private async listen(): Promise<string> {
    const host = this.opts.host ?? '127.0.0.1'
    const ports = this.opts.port ? [this.opts.port, 0] : [0]
    for (const port of ports) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error) => {
            this.server.off('listening', onListening)
            reject(err)
          }
          const onListening = () => {
            this.server.off('error', onError)
            resolve()
          }
          this.server.once('error', onError)
          this.server.once('listening', onListening)
          this.server.listen(port, host)
        })
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port === 0) throw err
      }
    }
    this.port = (this.server.address() as AddressInfo).port
    this.hosts = new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`])
    this.origins = new Set([`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`])
    return this.url!
  }

  // ---------------------------------------------------------------- requests

  private allowed(req: IncomingMessage): boolean {
    const host = req.headers.host
    if (!host || !this.hosts.has(host)) return false
    const origin = req.headers.origin
    return !origin || this.origins.has(origin)
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    if (!this.allowed(req)) return send(res, 403, 'text/plain', 'Forbidden')
    const url = req.url ?? ''
    if (!url.startsWith('/')) return send(res, 400, 'text/plain', 'Bad request')
    const path = url.split('?', 1)[0] ?? url
    if (path.startsWith('/__wildroom/')) return this.local(req, res, path)
    const client = this.deps.session.client()
    const target = client && upstreamUrl(client, url)
    if (!client || !target) {
      req.resume()
      return (req.headers.accept ?? '').includes('text/html')
        ? send(res, 503, 'text/html; charset=utf-8', WAITING_PAGE)
        : send(res, 503, 'application/json', JSON.stringify({ error: 'The GPU is not running' }))
    }
    this.forward(req, res, client, target, path)
  }

  /** The proxy's own little API, used by the injected script and the waiting page. */
  private local(req: IncomingMessage, res: ServerResponse, path: string) {
    req.resume()
    const post = req.method === 'POST'
    // State-changing calls only from this proxy's own pages (a page elsewhere sends its own Origin and is refused).
    if (post && !req.headers.origin) return send(res, 403, 'text/plain', 'Missing origin')
    if (path === '/__wildroom/activity.js' && req.method === 'GET') return send(res, 200, 'text/javascript; charset=utf-8', ACTIVITY_SCRIPT)
    if (path === '/__wildroom/activity' && post) {
      this.deps.session.touch()
      return send(res, 204)
    }
    if (path === '/__wildroom/status' && req.method === 'GET') {
      const s = this.deps.session.dto()
      return send(res, 200, 'application/json', JSON.stringify({ state: s.state, detail: s.detail, fatal: s.fatal }))
    }
    if (path === '/__wildroom/start' && post) {
      this.deps.session.requestStart()
      return send(res, 204)
    }
    send(res, 404, 'text/plain', 'Not found')
  }

  private forward(req: IncomingMessage, res: ServerResponse, client: ComfyClient, target: URL, path: string) {
    const inject = req.method === 'GET' && (path === '/' || path === '/index.html')
    const tap = req.method === 'POST' && (path === '/prompt' || path === '/api/prompt')
    const headers = forwardHeaders(req.headers, client, target)
    // Bodies the proxy reads itself come back uncompressed (the page would get gzip otherwise).
    if (inject || tap) headers['accept-encoding'] = 'identity'
    const up = requester(target).request(target, { method: req.method, headers })
    up.on('response', (upRes) => void this.respond(upRes, res, { inject, tap }))
    up.on('error', (err) => {
      if (!res.headersSent) send(res, 502, 'text/plain', `Cannot reach the GPU: ${err.message}`)
      else res.destroy()
    })
    res.on('close', () => {
      if (!res.writableFinished) up.destroy()
    })
    req.pipe(up)
  }

  private async respond(upRes: IncomingMessage, res: ServerResponse, how: { inject: boolean; tap: boolean }) {
    const status = upRes.statusCode ?? 502
    const headers = responseHeaders(upRes.headers)
    const html = String(upRes.headers['content-type'] ?? '').includes('text/html') && !upRes.headers['content-encoding']
    if (!(how.inject && status === 200 && html) && !how.tap) {
      res.writeHead(status, upRes.statusMessage, headers)
      upRes.pipe(res)
      return
    }
    let body: Buffer
    try {
      body = await readAll(upRes, MAX_BUFFERED)
    } catch {
      return void res.destroy()
    }
    if (how.inject && status === 200 && html) {
      body = Buffer.from(withActivityScript(body.toString('utf8')))
      headers['content-length'] = String(body.length)
    }
    res.writeHead(status, upRes.statusMessage, headers)
    res.end(body)
    if (how.tap && status === 200) {
      try {
        const text = decoded(body, String(upRes.headers['content-encoding'] ?? '')).toString('utf8')
        const promptId = (JSON.parse(text) as { prompt_id?: unknown }).prompt_id
        if (typeof promptId === 'string' && promptId) this.deps.inbox.track(promptId)
      } catch {
        // not JSON: nothing was queued
      }
    }
  }

  // ---------------------------------------------------------------- websockets

  /** ComfyUI's live connection (progress, previews): the handshake goes through with the token, then bytes flow. */
  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on('error', () => socket.destroy())
    if (!this.allowed(req)) return refuse(socket, 403, 'Forbidden')
    const url = req.url ?? ''
    const client = this.deps.session.client()
    const target = client && url.startsWith('/') ? upstreamUrl(client, url) : undefined
    if (!client || !target) return refuse(socket, 503, 'Service Unavailable')
    const headers = forwardHeaders(req.headers, client, target)
    headers.connection = 'Upgrade'
    headers.upgrade = req.headers.upgrade ?? 'websocket'
    const up = requester(target).request(target, { method: 'GET', headers })
    up.on('upgrade', (upRes, upSocket: Duplex, upHead: Buffer) => {
      if (socket.destroyed) return void upSocket.destroy()
      const lines = [`HTTP/1.1 ${upRes.statusCode ?? 101} ${upRes.statusMessage ?? 'Switching Protocols'}`]
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upHead.length) socket.write(upHead)
      if (head.length) upSocket.write(head)
      upSocket.on('error', () => upSocket.destroy())
      upSocket.on('close', () => socket.destroy())
      socket.on('close', () => {
        upSocket.destroy()
        this.sockets.delete(socket)
      })
      this.sockets.add(socket)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
    })
    up.on('response', (upRes) => {
      upRes.resume()
      refuse(socket, upRes.statusCode ?? 502, upRes.statusMessage ?? 'Bad Gateway')
    })
    up.on('error', () => refuse(socket, 502, 'Bad Gateway'))
    up.end()
  }

  private dropSockets() {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }
}

// ---------------------------------------------------------------- helpers

/** The same path on the pod; never another host (an absolute URL in the request line is refused by the caller). */
function upstreamUrl(client: ComfyClient, url: string): URL | undefined {
  const base = new URL(client.baseUrl)
  const target = new URL(`${base.origin}${url}`)
  return target.origin === base.origin ? target : undefined
}

function requester(target: URL) {
  return target.protocol === 'https:' ? https : http
}

function forwardHeaders(incoming: IncomingHttpHeaders, client: ComfyClient, target: URL): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(incoming)) {
    if (value !== undefined && !DROP_REQUEST.has(name)) headers[name] = value
  }
  return { ...headers, ...client.authHeaders, host: target.host }
}

function responseHeaders(incoming: IncomingHttpHeaders): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || DROP_RESPONSE.has(name) || name.startsWith('access-control-')) continue
    headers[name] = value
  }
  return headers
}

function send(res: ServerResponse, status: number, type?: string, body?: string) {
  res.writeHead(status, type ? { 'content-type': type, 'cache-control': 'no-store' } : { 'cache-control': 'no-store' })
  res.end(body)
}

function refuse(socket: Duplex, status: number, reason: string) {
  if (!socket.writable) return void socket.destroy()
  // end() sends the answer before closing (destroy() right after a write can drop it).
  socket.once('finish', () => socket.destroy())
  socket.end(`HTTP/1.1 ${status} ${reason.replace(/[\r\n]/g, ' ')}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

function readAll(stream: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        stream.destroy()
        reject(new Error('response too large'))
      } else chunks.push(chunk)
    })
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

/** A body as sent, made readable (a server may compress although asked not to). */
function decoded(body: Buffer, encoding: string): Buffer {
  const e = encoding.trim().toLowerCase()
  if (e === 'gzip' || e === 'x-gzip') return gunzipSync(body)
  if (e === 'br') return brotliDecompressSync(body)
  if (e === 'deflate') return inflateSync(body)
  return body
}

export function withActivityScript(html: string): string {
  const tag = '<script src="/__wildroom/activity.js"></script>'
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${tag}</head>`) : `${tag}${html}`
}

/** Reports that someone uses ComfyUI (at most every 30 s, never from a hidden tab): it keeps the GPU on. */
const ACTIVITY_SCRIPT = `(() => {
  let last = 0
  const ping = () => {
    const now = Date.now()
    if (document.hidden || now - last < 30000) return
    last = now
    fetch('/__wildroom/activity', { method: 'POST', keepalive: true }).catch(() => {})
  }
  for (const type of ['pointerdown', 'keydown', 'wheel']) addEventListener(type, ping, { capture: true, passive: true })
  ping()
})()
`

/** Shown instead of ComfyUI while the GPU is off or starting; reloads once ComfyUI answers. */
const WAITING_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ComfyUI — waiting for the GPU</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1d1d1b; --muted: #6b6b66; --accent: #e8590c; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ececea; --muted: #9a9a94; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
  main { max-width: 26rem; padding: 0 16px; text-align: center; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { color: var(--muted); margin: 0 0 16px; }
  button { font: inherit; border: 0; border-radius: 999px; padding: 8px 18px; background: var(--accent); color: #fff; cursor: pointer; }
  button[hidden] { display: none; }
</style>
</head>
<body>
<main>
  <h1>ComfyUI runs on the rented GPU</h1>
  <p id="detail">Checking the GPU…</p>
  <button id="start" type="button" hidden>Start GPU</button>
</main>
<script>
  const detail = document.getElementById('detail')
  const start = document.getElementById('start')
  start.onclick = () => fetch('/__wildroom/start', { method: 'POST' }).then(check)
  async function check() {
    try {
      const s = await (await fetch('/__wildroom/status')).json()
      if (s.state === 'ready') return location.reload()
      const off = s.state === 'off' || (s.state === 'error' && !s.fatal)
      detail.textContent = s.detail || (off ? 'The GPU is off. It is billed per second while on.' : 'The GPU is starting…')
      start.hidden = !off
    } catch {
      detail.textContent = 'The app is not answering.'
    }
  }
  check()
  setInterval(check, 3000)
</script>
</body>
</html>
`
