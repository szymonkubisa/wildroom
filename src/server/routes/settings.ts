import { createWriteStream, existsSync, linkSync, lstatSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import type { AppSettings, CredentialField, ProviderStatus, ProviderTestResult } from '../../shared/types/api'
import type { ProviderId } from '../../shared/types/jobs'
import type { AppDeps } from '../app'
import { badRequest, readJson } from '../http'
import { CONFIGURABLE_PROVIDERS } from '../providers'
import { chooseFolder, revealInFinder } from '../services/desktopBridge'
import { readCredentials, secretHint } from '../services/keychain'

/** File types the canvas exports. */
const EXPORT_FILE = /\.(png|jpe?g|webp|svg|ico|json|webmanifest|html|txt)$/i
const MAX_EXPORT_BYTES = 512 * 1024 * 1024

export function settingsRoutes(deps: AppDeps) {
  const { settings, secrets, adapters, events, cache, media } = deps
  const r = new Hono()

  const status = (id: ProviderId): ProviderStatus => {
    const adapter = adapters[id]
    const fields: ProviderStatus['fields'] = {}
    for (const field of adapter.credentialFields) {
      const value = secrets.get(id, field)
      fields[field] = { set: Boolean(value), hint: secretHint(value) }
    }
    const local = adapter.status?.()
    const configured = local ? local.configured : adapter.requiredFields.every((f) => fields[f]?.set)
    return { id, label: adapter.label, configured, fields, enabled: configured, detail: local?.detail, models: local?.models }
  }

  const provider = (id: string): ProviderId => {
    if (!CONFIGURABLE_PROVIDERS.includes(id as ProviderId)) throw badRequest(`Unknown provider ${id}`)
    return id as ProviderId
  }

  r.get('/settings', (c) => c.json(settings.get()))
  r.patch('/settings', async (c) => c.json(settings.update(await readJson<Partial<AppSettings>>(c))))

  r.get('/settings/providers', (c) => c.json(CONFIGURABLE_PROVIDERS.map(status)))

  /** Size of the regenerable cache (proxies, posters, waveforms). */
  r.get('/settings/cache', async (c) => c.json({ bytes: await cache.sizeBytes(), path: deps.env.derivedDir }))

  /** Deletes every derived file; open projects re-process their media in the background. */
  r.post('/settings/cache/clear', async (c) => {
    await cache.clear()
    media.reingestAll()
    return c.json({ bytes: await cache.sizeBytes() })
  })

  r.post('/system/reveal', async (c) => {
    const { which } = await readJson<{ which: 'projects' | 'cache' | 'appData' | 'models' }>(c)
    const paths = {
      projects: settings.get().projectsDir,
      cache: deps.env.cacheDir,
      appData: deps.env.appDataDir,
      models: deps.env.modelsDir,
    }
    const path = paths[which]
    if (!path) throw badRequest('Unknown folder')
    revealInFinder(path)
    return c.json({ ok: true })
  })

  /** Native folder picker for the web version (the desktop app uses its own dialog). */
  r.post('/system/choose-folder', async (c) => {
    const body = await readJson<{ prompt?: string; defaultPath?: string }>(c)
    return c.json({ path: (await chooseFolder({ prompt: body.prompt, defaultPath: body.defaultPath })) ?? null })
  })

  /**
   * Writes one exported file (canvas frames, favicon packs) into a folder the user picked. Only export file types,
   * only into an existing folder, and never over an existing file unless asked: "name (2).png" instead.
   */
  r.put('/system/write-file', async (c) => {
    const dir = c.req.query('dir') ?? ''
    const name = basename(c.req.query('name') ?? '')
    if (!isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) throw badRequest('Choose an existing folder')
    if (!name || name.startsWith('.') || !EXPORT_FILE.test(name)) throw badRequest('Unsupported file name')
    // Never into the app's own files or a project bundle (exports go to folders the user owns).
    const real = realpathSync(dir)
    const owned = [deps.env.clientDist, deps.env.appDataDir, deps.env.cacheDir, deps.env.modelsDir].filter(Boolean).map((p) => (existsSync(p) ? realpathSync(p) : p))
    if (owned.some((p) => real === p || real.startsWith(`${p}${sep}`)) || /\.(wildroom|app)(\/|$)/i.test(real)) {
      throw badRequest('Choose a folder outside the app and its projects')
    }
    const body = c.req.raw.body
    if (!body) throw badRequest('Empty file')
    // Written to a private temp file first, then published atomically: no partial files, no writing through symlinks.
    const tmp = join(real, `.${name}.part-${nanoid(8)}`)
    let written = 0
    const limit = new Transform({
      transform(chunk: Buffer, _enc, done) {
        written += chunk.length
        done(written > MAX_EXPORT_BYTES ? new Error('File too large') : null, chunk)
      },
    })
    try {
      await pipeline(Readable.fromWeb(body as unknown as WebReadableStream), limit, createWriteStream(tmp, { flags: 'wx' }))
      let path = join(real, name)
      if (c.req.query('overwrite') === '1') {
        if (existsSync(path) && lstatSync(path).isDirectory()) throw badRequest('A folder has that name')
        renameSync(tmp, path)
      } else {
        const ext = extname(name)
        const stem = name.slice(0, name.length - ext.length)
        for (let n = 2; ; n++) {
          try {
            linkSync(tmp, path) // fails with EEXIST instead of replacing anything (symlinks included)
            break
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n > 999) throw err
            path = join(real, `${stem} (${n})${ext}`)
          }
        }
        rmSync(tmp, { force: true })
      }
      return c.json({ path })
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
  })

  /** Which of these export file names already exist in a folder, so the page can ask before replacing them. */
  r.post('/system/existing-files', async (c) => {
    const body = await readJson<{ dir?: string; names?: unknown }>(c)
    const dir = typeof body.dir === 'string' ? body.dir : ''
    if (!isAbsolute(dir) || !existsSync(dir)) return c.json({ existing: [] })
    const names = (Array.isArray(body.names) ? body.names : []).filter((n): n is string => typeof n === 'string' && n === basename(n) && EXPORT_FILE.test(n))
    return c.json({ existing: names.slice(0, 50).filter((n) => existsSync(join(dir, n))) })
  })

  /** Shows an exported file or folder in Finder. */
  r.post('/system/reveal-path', async (c) => {
    const body = await readJson<{ path?: string }>(c)
    if (!body.path || !isAbsolute(body.path) || !existsSync(body.path)) throw badRequest('Nothing to show there')
    revealInFinder(body.path)
    return c.json({ ok: true })
  })

  r.put('/settings/providers/:id', async (c) => {
    const id = provider(c.req.param('id'))
    const body = await readJson<Partial<Record<CredentialField, string | null>>>(c)
    const allowed = adapters[id].credentialFields
    for (const [field, value] of Object.entries(body)) {
      if (!allowed.includes(field as CredentialField)) continue
      const trimmed = typeof value === 'string' ? value.trim() : ''
      if (trimmed) secrets.set(id, field as CredentialField, trimmed)
      else secrets.delete(id, field as CredentialField)
    }
    events.publish({ type: 'settings.changed' })
    return c.json(status(id))
  })

  r.post('/settings/providers/:id/test', async (c) => {
    const id = provider(c.req.param('id'))
    const adapter = adapters[id]
    const creds = readCredentials(secrets, id, adapter.credentialFields)
    const missing = adapter.requiredFields.filter((f) => !creds[f])
    if (missing.length) {
      return c.json({ ok: false, message: `Missing ${missing.join(', ')}` } satisfies ProviderTestResult)
    }
    try {
      return c.json(await adapter.test(creds))
    } catch (err) {
      return c.json({ ok: false, message: err instanceof Error ? err.message : String(err) } satisfies ProviderTestResult)
    }
  })

  return r
}
