#!/usr/bin/env node
/**
 * stdio ↔ Wildroom's MCP endpoint, for MCP clients that only start commands (Claude Desktop):
 *
 *   node scripts/studio-mcp.mjs
 *
 * Reads newline-delimited JSON-RPC on stdin, posts each message to the running app's `/mcp` with the install's token,
 * and writes the answers to stdout. Where the app listens and the token come from its app data folder (`server.json`,
 * `mcp-token`), so it finds the desktop app on whatever port it got. When the app restarts, the session is set up
 * again by itself. No dependencies: the desktop app runs it with its own Electron as Node (ELECTRON_RUN_AS_NODE=1).
 *
 * STUDIO_APP_DATA (or STUDIO_HOME) points at another app data folder; STUDIO_MCP_URL and STUDIO_MCP_TOKEN override both.
 */
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const appData =
  process.env.STUDIO_APP_DATA ||
  (process.env.STUDIO_HOME ? join(process.env.STUDIO_HOME, 'AppData') : join(homedir(), 'Library', 'Application Support', 'Wildroom'))

const log = (...args) => process.stderr.write(`[studio-mcp] ${args.join(' ')}\n`)
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

/** Read for every message: the app may have restarted on another port, or its token been renewed. */
function target() {
  let url = process.env.STUDIO_MCP_URL
  if (!url) {
    const info = JSON.parse(readFileSync(join(appData, 'server.json'), 'utf8'))
    url = `${info.url}/mcp`
  }
  const token = process.env.STUDIO_MCP_TOKEN || readFileSync(join(appData, 'mcp-token'), 'utf8').trim()
  return { url, token }
}

/**
 * One HTTP request, with no time limit: a tool answers when it is done, and an export can take half an hour (fetch
 * gives up on a response whose headers take more than 5 minutes).
 */
function send(url, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body)
  })
}

let sessionId
let protocolVersion
/** The client's initialize request, replayed when the app restarted and forgot the session. */
let initialize
let ready
let reconnecting

/**
 * Posts one message; its answers (JSON or an SSE stream of messages) go to stdout unless quiet. A refusal (wrong
 * token, Claude access turned off) has no request id: it isn't passed on, the caller answers the request instead.
 */
async function post(message, { quiet = false } = {}) {
  const { url, token } = target()
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }
  if (sessionId) headers['mcp-session-id'] = sessionId
  if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion
  const res = await send(url, { method: 'POST', headers, body: JSON.stringify(message) })
  if (res.status === 404 && sessionId) return { status: 404 }
  const sid = res.headers['mcp-session-id']
  if (typeof sid === 'string' && sid) sessionId = sid
  const type = res.headers['content-type'] ?? ''
  const messages = []
  if (type.includes('text/event-stream')) {
    let data = []
    const flush = () => {
      if (data.length) messages.push(JSON.parse(data.join('\n')))
      data = []
    }
    for (const line of res.text.split(/\r?\n/)) {
      if (line === '') flush()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    flush()
  } else if (type.includes('application/json') && res.text) {
    const body = JSON.parse(res.text)
    messages.push(...(Array.isArray(body) ? body : [body]))
  }
  if (!quiet) for (const m of messages) if (res.status < 400 || m?.id != null) write(m)
  return { status: res.status, messages }
}

/** What the app said when it refused a message: a JSON-RPC error, or the API's `{ error }`. */
function refusal(r) {
  for (const m of r.messages ?? []) {
    if (typeof m?.error?.message === 'string') return m.error.message
    if (typeof m?.error === 'string') return m.error
  }
  return `Wildroom answered ${r.status}`
}

/** The request got no answer of its own from the app (it refused it): answer it here. */
const unanswered = (message, r) => r.status >= 400 && !r.messages?.some((m) => m?.id != null && m.id === message.id)

/** Sets the session up again after the app restarted (the client never knows); calls that hit it together share one. */
function reconnect() {
  reconnecting ??= (async () => {
    sessionId = undefined
    const { messages } = await post({ ...initialize, id: `studio-mcp-reinit-${Date.now()}` }, { quiet: true })
    if (!sessionId || !messages?.some((m) => m.result)) throw new Error('the app did not accept the session again')
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { quiet: true })
    log('reconnected to the app')
  })().finally(() => {
    reconnecting = undefined
  })
  return reconnecting
}

function fail(message, text) {
  if (message.id !== undefined) write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: text } })
  else log(text)
}

function unreachable(err) {
  if (err?.code === 'ENOENT') return `Wildroom isn't running (no ${err.path}). Open the app, then try again.`
  return `Wildroom doesn't answer: ${err instanceof Error ? err.message : String(err)}. Is the app open?`
}

async function forward(message) {
  if (message.method === 'initialize') {
    initialize = message
    sessionId = undefined
    ready = post(message).then((r) => {
      protocolVersion = r.messages?.find((m) => m.id === message.id)?.result?.protocolVersion
      return r
    })
    try {
      const r = await ready
      if (unanswered(message, r)) fail(message, refusal(r))
    } catch (err) {
      fail(message, unreachable(err))
    }
    return
  }
  try {
    await ready?.catch(() => {})
    const used = sessionId
    let r = await post(message)
    if (r.status === 404 && initialize) {
      // Another call may have set the session up again already.
      if (sessionId === used) await reconnect()
      else await reconnecting
      r = await post(message)
    }
    if (unanswered(message, r)) fail(message, refusal(r))
  } catch (err) {
    fail(message, unreachable(err))
  }
}

const pending = new Set()
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    log('not JSON:', line.slice(0, 200))
    return
  }
  const p = forward(message).finally(() => pending.delete(p))
  pending.add(p)
})
rl.on('close', async () => {
  await Promise.allSettled(pending)
  // Ends the session in the app (it closes the projects it opened), then leaves.
  if (sessionId) {
    try {
      const { url, token } = target()
      await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'mcp-session-id': sessionId } })
    } catch {
      // the app is gone already
    }
  }
  process.exit(0)
})
