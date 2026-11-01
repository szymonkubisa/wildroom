import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import type { AppDeps } from '../app'
import { badRequest } from '../http'
import { listElevenLabsVoices } from '../providers/elevenlabs'
import { readCredentials } from '../services/keychain'

const TTL_MS = 5 * 60_000

export function voiceRoutes(deps: AppDeps) {
  const r = new Hono()
  const cache = new Map<string, { at: number; value: unknown }>()

  r.get('/voices', async (c) => {
    const creds = readCredentials(deps.secrets, 'elevenlabs', ['apiKey'])
    if (!creds.apiKey) throw badRequest('Add your ElevenLabs key in Settings → Providers to browse voices')
    const search = c.req.query('search') ?? ''
    const pageToken = c.req.query('pageToken') || undefined
    // Per key: after switching to another ElevenLabs account, the voices of the old one must not come back.
    const account = createHash('sha256').update(creds.apiKey).digest('hex').slice(0, 16)
    const key = `${account}|${search}|${pageToken ?? ''}`
    const hit = cache.get(key)
    if (c.req.query('fresh') === '1') cache.clear()
    else if (hit && Date.now() - hit.at < TTL_MS) return c.json(hit.value)
    const value = await listElevenLabsVoices(creds, { search: search || undefined, pageToken })
    cache.set(key, { at: Date.now(), value })
    return c.json(value)
  })

  return Object.assign(r, { clearCache: () => cache.clear() })
}
