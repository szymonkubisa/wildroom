import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Env } from '../env'

/**
 * What an MCP client (Claude Code, Claude Desktop) needs to reach this server, kept in the app data folder:
 * - `mcp-token`: the per-install bearer token `/mcp` asks for (only this user can read it);
 * - `server.json`: where the running server listens, so the stdio bridge (scripts/studio-mcp.mjs) finds it when the
 *   desktop app had to pick a port other than 7777. Written once listening, removed on a clean quit.
 */

export const MCP_TOKEN_FILE = 'mcp-token'
export const SERVER_INFO_FILE = 'server.json'

export interface ServerInfo {
  url: string
  port: number
  pid: number
  startedAt: string
}

const tokens = new Map<string, string>()

/** Written whole (a new temp file, then rename) and readable only by this user from the start. */
function writePrivate(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
}

/** The install's MCP token, made on first use. */
export function mcpToken(env: Pick<Env, 'appDataDir'>): string {
  const cached = tokens.get(env.appDataDir)
  if (cached) return cached
  const path = join(env.appDataDir, MCP_TOKEN_FILE)
  let token = existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
  if (token.length < 32) {
    token = randomBytes(32).toString('base64url')
    writePrivate(path, `${token}\n`)
  }
  tokens.set(env.appDataDir, token)
  return token
}

/** A new token: clients set up with the old one stop working. */
export function regenerateMcpToken(env: Pick<Env, 'appDataDir'>): string {
  const token = randomBytes(32).toString('base64url')
  writePrivate(join(env.appDataDir, MCP_TOKEN_FILE), `${token}\n`)
  tokens.set(env.appDataDir, token)
  return token
}

/** `Authorization: Bearer <token>` with this install's token (compared in constant time). */
export function bearerMatches(env: Pick<Env, 'appDataDir'>, header: string | undefined): boolean {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')
  if (!m) return false
  const given = Buffer.from(m[1]!)
  const expected = Buffer.from(mcpToken(env))
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export function writeServerInfo(env: Pick<Env, 'appDataDir' | 'host'>, port: number) {
  const info: ServerInfo = { url: `http://${env.host}:${port}`, port, pid: process.pid, startedAt: new Date().toISOString() }
  writePrivate(join(env.appDataDir, SERVER_INFO_FILE), `${JSON.stringify(info, null, 2)}\n`)
}

/** Removed only by the server that wrote it. */
export function removeServerInfo(env: Pick<Env, 'appDataDir'>) {
  const path = join(env.appDataDir, SERVER_INFO_FILE)
  try {
    const info = JSON.parse(readFileSync(path, 'utf8')) as Partial<ServerInfo>
    if (info.pid === process.pid) rmSync(path, { force: true })
  } catch {
    // not there, or not ours to read
  }
}
