import { createHash } from 'node:crypto'
import http, { type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ComfyClient } from '../../src/server/providers/runpod/comfy'
import { ComfyProxy, withActivityScript } from '../../src/server/providers/runpod/comfyProxy'
import { EventBus } from '../../src/server/services/events'
import type { GpuSessionDTO } from '../../src/shared/types/runpod'

/** Stands in for the pod (Caddy + ComfyUI): records what reaches it. */
let upstream: http.Server
let upstreamUrl: string
let seen: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[]
let upgrades: IncomingHttpHeaders[]
const upstreamSockets = new Set<Duplex>()
let ready: boolean
let touches: number
let starts: number
let tracked: string[]
let events: EventBus
let proxy: ComfyProxy
let port: number

const INDEX = '<!doctype html><html><head><title>ComfyUI</title></head><body><div id="app"></div></body></html>'

function wsFrame(text: string): Buffer {
  const payload = Buffer.from(text)
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
}

beforeEach(async () => {
  seen = []
  upgrades = []
  ready = true
  touches = 0
  starts = 0
  tracked = []
  upstream = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body })
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(INDEX) })
        return res.end(INDEX)
      }
      if (req.url === '/api/prompt') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ prompt_id: 'p-42', number: 3, node_errors: {} }))
      }
      if (req.url === '/prompt') {
        // A server that compresses although asked not to (ComfyUI gzips JSON when the browser allows it).
        const gz = gzipSync(JSON.stringify({ prompt_id: 'p-gz', number: 4, node_errors: {} }))
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': gz.length })
        return res.end(gz)
      }
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'x-comfy': 'yes' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  upstream.on('upgrade', (req, socket: Duplex) => {
    upgrades.push(req.headers)
    upstreamSockets.add(socket)
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.on('error', () => {})
    // Like a real server: read the connection, and close when the proxy does.
    socket.resume()
    socket.on('end', () => socket.destroy())
    socket.on('close', () => upstreamSockets.delete(socket))
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.write(wsFrame('{"type":"status"}'))
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`

  events = new EventBus()
  proxy = new ComfyProxy({
    session: {
      client: () => (ready ? new ComfyClient({ baseUrl: upstreamUrl, token: 'secret-token' }) : undefined),
      dto: () => ({ state: ready ? 'ready' : 'off', busy: false }) as GpuSessionDTO,
      touch: () => void touches++,
      requestStart: () => void starts++,
    },
    inbox: { track: (id) => void tracked.push(id) },
    events,
  })
  port = Number(new URL(await proxy.ensureListening()).port)
})

afterEach(async () => {
  await proxy.close()
  for (const socket of upstreamSockets) socket.destroy()
  upstream.closeAllConnections()
  await new Promise<void>((r) => upstream.close(() => r()))
})

/** A raw request (fetch can't set Host, and normalizes the request line). */
function request(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => (body += c.toString()))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

describe('ComfyUI proxy', () => {
  it('adds the token and leaves out what would identify the page', async () => {
    const res = await request('/api/object_info?x=1', {
      headers: { origin: `http://127.0.0.1:${port}`, referer: `http://127.0.0.1:${port}/`, cookie: 'a=b', authorization: 'Bearer forged', 'user-agent': 'test' },
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    expect(res.headers['x-comfy']).toBe('yes')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    const got = seen.at(-1)!
    expect(got.url).toBe('/api/object_info?x=1')
    expect(got.headers.authorization).toBe('Bearer secret-token')
    expect(got.headers.host).toBe(new URL(upstreamUrl).host)
    expect(got.headers['user-agent']).toBe('test')
    expect(got.headers.origin).toBeUndefined()
    expect(got.headers.referer).toBeUndefined()
    expect(got.headers.cookie).toBeUndefined()
  })

  it('refuses other hosts, other sites and absolute URLs', async () => {
    expect((await request('/', { headers: { host: 'evil.example' } })).status).toBe(403)
    expect((await request('/', { headers: { host: `attacker.example:${port}` } })).status).toBe(403)
    expect((await request('/api/prompt', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' })).status).toBe(403)
    expect((await request('http://evil.example/steal')).status).toBe(400)
    expect(seen).toHaveLength(0)
  })

  it('shows a waiting page while the GPU is not running', async () => {
    ready = false
    const page = await request('/', { headers: { accept: 'text/html' } })
    expect(page.status).toBe(503)
    expect(page.body).toContain('ComfyUI runs on the rented GPU')
    const api = await request('/api/queue')
    expect(api.status).toBe(503)
    expect(JSON.parse(api.body)).toEqual({ error: 'The GPU is not running' })
    expect(seen).toHaveLength(0)
  })

  it('adds the activity script to ComfyUI’s page', async () => {
    const res = await request('/')
    expect(res.body).toBe(withActivityScript(INDEX))
    expect(res.body).toContain('<script src="/__wildroom/activity.js"></script></head>')
    expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(res.body))
    expect(seen.at(-1)!.headers['accept-encoding']).toBe('identity')
    const script = await request('/__wildroom/activity.js')
    expect(script.body).toContain("fetch('/__wildroom/activity'")
  })

  it('reports prompts queued from the page to the inbox', async () => {
    const own = { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'accept-encoding': 'gzip, deflate, br' }
    const res = await request('/api/prompt', { method: 'POST', headers: own, body: '{"prompt":{}}' })
    expect(JSON.parse(res.body)).toMatchObject({ prompt_id: 'p-42' })
    expect(seen.at(-1)!.body).toBe('{"prompt":{}}')
    // The proxy reads this reply itself: it asks for it uncompressed.
    expect(seen.at(-1)!.headers['accept-encoding']).toBe('identity')
    expect(tracked).toEqual(['p-42'])

    // Compressed anyway: still read (and passed on to the page as sent).
    const gz = await request('/prompt', { method: 'POST', headers: own, body: '{"prompt":{}}' })
    expect(gz.headers['content-encoding']).toBe('gzip')
    expect(tracked).toEqual(['p-42', 'p-gz'])
  })

  it('counts clicks in ComfyUI as use and starts the GPU from the waiting page, only from its own pages', async () => {
    const own = { origin: `http://127.0.0.1:${port}` }
    expect((await request('/__wildroom/activity', { method: 'POST', headers: own })).status).toBe(204)
    expect((await request('/__wildroom/activity', { method: 'POST' })).status).toBe(403)
    expect((await request('/__wildroom/activity', { method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect(touches).toBe(1)
    expect((await request('/__wildroom/start', { method: 'POST', headers: own })).status).toBe(204)
    expect(starts).toBe(1)
    expect(JSON.parse((await request('/__wildroom/status')).body)).toMatchObject({ state: 'ready' })
  })

  it('passes ComfyUI’s websocket through with the token, and closes it when the GPU stops', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?clientId=abc`)
    const first = await new Promise<string>((resolve, reject) => {
      ws.onmessage = (e) => resolve(String(e.data))
      ws.onerror = () => reject(new Error('websocket failed'))
    })
    expect(first).toBe('{"type":"status"}')
    expect(upgrades[0]!.authorization).toBe('Bearer secret-token')
    expect(upgrades[0]!.origin).toBeUndefined()

    const closed = new Promise<void>((resolve) => (ws.onclose = () => resolve()))
    events.publish({ type: 'gpu.session', session: { state: 'stopping', busy: false } })
    await closed
    // The pod's side goes too.
    await expect.poll(() => upstreamSockets.size).toBe(0)
  })

  it('refuses a websocket from another site', async () => {
    const res = await request('/ws', {
      headers: { connection: 'Upgrade', upgrade: 'websocket', origin: 'https://evil.example', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' },
    })
    expect(res.status).toBe(403)
    expect(upgrades).toHaveLength(0)
  })
})
