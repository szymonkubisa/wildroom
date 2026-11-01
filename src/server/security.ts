import type { MiddlewareHandler } from 'hono'
import type { Env } from './env'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const MCP_PATH = '/mcp'

/**
 * The API only listens on 127.0.0.1, but any web page in the user's browser can still try to reach it.
 * - Host must be one of ours (blocks DNS-rebinding).
 * - A foreign Origin is rejected on every route, SSE included.
 * - State-changing requests need an allowed Origin plus the X-Studio header, which cross-origin pages
 *   cannot send without a CORS preflight — and we never answer preflights (no cors()).
 */
export function localOnly(env: Pick<Env, 'allowedHosts' | 'allowedOrigins'>): MiddlewareHandler {
  const hosts = new Set(env.allowedHosts)
  const origins = new Set(env.allowedOrigins)
  return async (c, next) => {
    const host = c.req.header('host')
    if (!host || !hosts.has(host)) return c.json({ error: 'Forbidden host' }, 403)
    const origin = c.req.header('origin')
    if (origin && !origins.has(origin)) return c.json({ error: 'Forbidden origin' }, 403)
    // MCP clients aren't browsers: they send no Origin and no X-Studio, and prove themselves with the install's
    // bearer token instead (checked in mcp/routes). A page can't send Authorization cross-site without a preflight.
    if (c.req.path === MCP_PATH) return next()
    if (!SAFE_METHODS.has(c.req.method)) {
      if (!origin) return c.json({ error: 'Missing origin' }, 403)
      if (c.req.header('x-studio') !== '1') return c.json({ error: 'Missing X-Studio header' }, 403)
    }
    await next()
  }
}
