import { createWriteStream, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import { flicksToSeconds } from '../../shared/time/flicks'
import { type AssetKind, IMPORTABLE_FILE } from '../../shared/types/assets'
import type { AppDeps } from '../app'
import { badRequest, notFound, readJson } from '../http'
import { revealInFinder } from '../services/desktopBridge'
import { extractFrame } from '../services/ffmpeg'

/**
 * Scratch folders of requests and jobs (uploads, frame grabs, exports, tool outputs, Kling element stills, job
 * downloads): anything left there at startup is from an interrupted request or a previous run. No job resumes from
 * its `jobs/<id>` folder — a resumed job polls its provider again, a local one renders again. Not swept: `mock-tasks`
 * (demo tasks resume from it) and `comfy` (ComfyUI imports).
 */
export const UPLOAD_TEMP_DIRS = ['uploads', 'frames', 'exports', 'tools', 'kling-elements', 'jobs'] as const

/** Deletes those leftovers (the server holds the app lock, so none of them is in use). */
export function sweepUploadTemp(tmpDir: string): number {
  let removed = 0
  for (const sub of UPLOAD_TEMP_DIRS) {
    const dir = join(tmpDir, sub)
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      rmSync(join(dir, name), { recursive: true, force: true })
      removed++
    }
  }
  return removed
}

export function assetRoutes(deps: AppDeps) {
  const { media, env, registry } = deps
  const r = new Hono()

  const load = (id: string) => {
    const row = media.get(id)
    if (!row || row.deletedAt) throw notFound('Asset')
    return row
  }

  r.get('/projects/:projectId/assets', (c) => {
    const kind = c.req.query('kind') as AssetKind | undefined
    const search = c.req.query('q') || undefined
    const store = registry.require(c.req.param('projectId'))
    return c.json(media.list(store.id, { kind, search }))
  })

  /**
   * One file per request, streamed straight to disk (no multipart buffering for multi-GB files). `parents` (comma-
   * separated asset ids of this project) marks the file as made from them, e.g. a crop or an exported canvas frame.
   */
  r.post('/projects/:projectId/assets/upload', async (c) => {
    const name = basename(c.req.query('name') ?? '')
    if (!name || !IMPORTABLE_FILE.test(name)) throw badRequest('Unsupported file type')
    const body = c.req.raw.body
    if (!body) throw badRequest('Empty upload')
    const project = registry.require(c.req.param('projectId'))
    const parentIds = [...new Set((c.req.query('parents') ?? '').split(',').map((x) => x.trim()).filter(Boolean))].slice(0, 50)
    for (const id of parentIds) {
      const parent = media.get(id)
      if (!parent || parent.deletedAt || !media.toDTO(parent).projectIds.includes(project.id)) throw badRequest(`Unknown source asset ${id}`)
    }
    const source = parentIds.length ? 'derived' : 'import'
    const label = c.req.query('label')?.trim().slice(0, 200)
    // Held from the first byte: the editor closing mid-upload must not unmount the project under the import.
    const asset = await registry.holdDuring(project.id, async () => {
      const dir = join(env.tmpDir, 'uploads')
      mkdirSync(dir, { recursive: true })
      const tmp = join(dir, `${nanoid(8)}${extname(name).toLowerCase()}`)
      try {
        await pipeline(Readable.fromWeb(body as unknown as WebReadableStream), createWriteStream(tmp))
        return await media.importFile(tmp, {
          name: label || name.replace(/\.[^.]+$/, ''),
          source,
          projectId: project.id,
          ...(parentIds.length ? { parentIds } : {}),
          move: true,
        })
      } finally {
        // Moved into the bundle on success; an aborted upload or a file that can't be imported is dropped here.
        await rm(tmp, { force: true }).catch(() => {})
      }
    })
    return c.json(asset, 201)
  })

  r.get('/assets/:id', (c) => c.json(media.toDTO(load(c.req.param('id')))))

  r.patch('/assets/:id', async (c) => {
    const row = load(c.req.param('id'))
    const body = await readJson<{ name?: string; rating?: -1 | 0 | 1; keywords?: string[]; role?: string }>(c)
    return c.json(media.update(row.id, body))
  })

  /** Restores a removed asset, or copies an asset of another open project into this one (returns that asset). */
  r.post('/projects/:projectId/assets/:id/link', async (c) => {
    const row = media.get(c.req.param('id'))
    if (!row) throw notFound('Asset')
    const project = registry.require(c.req.param('projectId'))
    return c.json(await media.linkToProject(row.id, project.id))
  })

  r.delete('/projects/:projectId/assets/:id', (c) => {
    const row = load(c.req.param('id'))
    media.removeFromProject(row.id, c.req.param('projectId'))
    return c.json({ ok: true })
  })

  /** "Use frame": grab an exact frame of a video as a new image asset (e.g. start frame for image→video). */
  r.post('/projects/:projectId/assets/:id/frame', async (c) => {
    const row = load(c.req.param('id'))
    if (row.kind !== 'video') throw badRequest('Frames can only be taken from video assets')
    const body = await readJson<{ seconds: number; label?: string }>(c)
    const duration = flicksToSeconds(row.durationFlicks ?? 0)
    const seconds = Math.max(0, Math.min(Number(body.seconds) || 0, Math.max(0, duration - 0.001)))
    const dir = join(env.tmpDir, 'frames')
    mkdirSync(dir, { recursive: true })
    const out = join(dir, `${nanoid(8)}.png`)
    const project = registry.require(c.req.param('projectId'))
    const asset = await registry.holdDuring(project.id, async () => {
      try {
        await extractFrame(media.originalPath(row), seconds + (row.timeOffset ?? 0), out)
        return await media.importFile(out, {
          name: body.label ?? `${row.name} @ ${seconds.toFixed(2)}s`,
          source: 'derived',
          projectId: project.id,
          parentIds: [row.id],
          meta: { frameOf: { assetId: row.id, seconds } },
          move: true,
        })
      } finally {
        await rm(out, { force: true }).catch(() => {})
      }
    })
    return c.json(asset, 201)
  })

  r.post('/assets/:id/reveal', (c) => {
    const row = load(c.req.param('id'))
    const vector = c.req.query('vector') ? media.vectorPath(row) : undefined
    revealInFinder(vector ?? media.originalPath(row))
    return c.json({ ok: true })
  })

  return r
}
