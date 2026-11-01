import { resolve } from 'node:path'
import { Hono } from 'hono'
import type { McpIntegrationInfo } from '../../shared/types/api'
import type { AppDeps } from '../app'
import { ApiError, readJson } from '../http'
import { mcpToken, regenerateMcpToken } from '../services/mcpAccess'

/**
 * Settings → Integrations: the MCP endpoint, its token and how to start the stdio bridge, for the copy-ready
 * `claude mcp add …` and Claude Desktop snippets. The desktop app says where its bundled bridge and Electron (run as
 * Node) are; in development it is the repo's script and `node`.
 */
export function integrationRoutes(deps: AppDeps) {
  const r = new Hono()

  const info = (): McpIntegrationInfo => {
    const bridgePath = process.env.STUDIO_MCP_BRIDGE || resolve('scripts/studio-mcp.mjs')
    const electron = process.env.STUDIO_MCP_NODE
    return {
      enabled: deps.settings.get().mcp.enabled,
      url: `http://${deps.env.host}:${deps.env.port}/mcp`,
      token: mcpToken(deps.env),
      bridge: {
        command: electron || 'node',
        args: [bridgePath],
        env: { ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}), STUDIO_APP_DATA: deps.env.appDataDir },
      },
      appDataDir: deps.env.appDataDir,
    }
  }

  // The token is a secret: read only by the app's own pages (a cross-site page can't send X-Studio without a preflight).
  r.use('/integrations/*', async (c, next) => {
    if (c.req.header('x-studio') !== '1') throw new ApiError(403, 'Missing X-Studio header')
    await next()
  })

  r.get('/integrations/mcp', (c) => c.json(info()))

  /** A new token: clients set up with the old one have to be set up again. */
  r.post('/integrations/mcp/token', (c) => {
    regenerateMcpToken(deps.env)
    return c.json(info())
  })

  /** A page takes a request to the app's window (only the first one gets it). */
  r.post('/app-requests/:id/claim', (c) => c.json({ granted: deps.appRequests.claim(c.req.param('id')) }))

  /** The page that took it is done: `{ ok: true, result }` or `{ ok: false, error }`. */
  r.post('/app-requests/:id/done', async (c) => {
    const body = await readJson<{ ok?: boolean; result?: unknown; error?: unknown }>(c)
    const outcome = body.ok ? { ok: true as const, result: body.result } : { ok: false as const, error: typeof body.error === 'string' && body.error ? body.error : 'The app could not do it' }
    return c.json({ accepted: deps.appRequests.done(c.req.param('id'), outcome) })
  })

  return r
}
