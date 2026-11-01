import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Context, Hono } from 'hono'
import { Hono as HonoApp } from 'hono'
import type { AppDeps } from '../app'
import { bearerMatches } from '../services/mcpAccess'
import { type McpSessionState, registerStudioTools, SERVER_INSTRUCTIONS, type StudioApi } from './tools'

interface Session {
  transport: WebStandardStreamableHTTPServerTransport
  server: McpServer
  state: McpSessionState
  lastUsed: number
}

/** A session nobody has called for this long is dropped (its client is gone without saying so). */
const IDLE_SESSION_MS = 6 * 60 * 60_000
const SWEEP_EVERY_MS = 10 * 60_000

const rpcError = (c: Context, status: 400 | 401 | 403 | 404 | 405, code: number, message: string, headers?: Record<string, string>) =>
  c.json({ jsonrpc: '2.0', error: { code, message }, id: null }, status, headers)

/**
 * MCP over Streamable HTTP at `/mcp` (docs/mcp.md): Claude Code, Claude Desktop (through scripts/studio-mcp.mjs) or
 * any MCP client drives the app with the tools in ./tools. Loopback only (the server binds 127.0.0.1 and checks Host),
 * and every request needs `Authorization: Bearer <token>` — the install's token, shown in Settings → Integrations.
 * The tools call the app's own API in-process, so they validate, lock and notify open editors like the app's pages.
 */
export function mcpRoutes(deps: AppDeps, app: Hono) {
  const sessions = new Map<string, Session>()
  const host = `${deps.env.host}:${deps.env.port}`
  const origin = `http://${host}`

  const api: StudioApi = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await app.request(`${origin}${path}`, {
      method,
      headers: { host, origin, 'x-studio': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string; details?: { issues?: unknown } }
    if (!res.ok) {
      const issues = Array.isArray(data.details?.issues) ? `\n${(data.details.issues as unknown[]).map((i) => `· ${String(i)}`).join('\n')}` : ''
      throw new Error(`${data.error ?? res.statusText}${issues}`)
    }
    return data as T
  }

  /** The session's projects are closed again unless an editor has them open (or a render still runs in them). */
  async function end(id: string) {
    const s = sessions.get(id)
    if (!s) return
    sessions.delete(id)
    for (const projectId of s.state.projects) {
      try {
        deps.registry.close(projectId)
      } catch {
        // already gone
      }
    }
    await s.server.close().catch(() => {})
  }

  setInterval(() => {
    const cutoff = Date.now() - IDLE_SESSION_MS
    for (const [id, s] of sessions) if (s.lastUsed < cutoff) void end(id)
  }, SWEEP_EVERY_MS).unref()

  const r = new HonoApp()
  r.all('/', async (c) => {
    if (!deps.settings.get().mcp.enabled) return rpcError(c, 403, -32000, 'Claude access is turned off in Wildroom (Settings → Integrations)')
    if (!bearerMatches(deps.env, c.req.header('authorization'))) {
      return rpcError(c, 401, -32001, 'Missing or wrong token: copy it from Wildroom → Settings → Integrations', { 'WWW-Authenticate': 'Bearer' })
    }
    const sessionId = c.req.header('mcp-session-id')
    if (sessionId) {
      const s = sessions.get(sessionId)
      if (!s) return rpcError(c, 404, -32001, 'Session not found (the app restarted?): reconnect')
      s.lastUsed = Date.now()
      return s.transport.handleRequest(c.req.raw)
    }
    if (c.req.method !== 'POST') return rpcError(c, 405, -32000, 'Start a session with an initialize request (POST)')

    // A new session: one server and transport per client, with its own spend.
    const state: McpSessionState = { spentUsd: 0, projects: new Set() }
    const server = new McpServer({ name: 'wildroom', title: 'Wildroom', version: '1.0.0' }, { instructions: SERVER_INSTRUCTIONS })
    registerStudioTools(server, { deps, api, session: state })
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, state, lastUsed: Date.now() })
      },
      onsessionclosed: (id) => end(id),
    })
    await server.connect(transport)
    const res = await transport.handleRequest(c.req.raw)
    // Not an initialize request: nothing was started.
    if (!transport.sessionId) await server.close().catch(() => {})
    return res
  })
  return r
}
