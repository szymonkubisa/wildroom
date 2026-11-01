import { createWriteStream, mkdirSync } from 'node:fs'
import { open, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import type { AppDeps } from '../app'
import { badRequest, notFound, readJson } from '../http'
import { finalizeExport } from '../services/exporter'

interface ExportSession {
  id: string
  projectId: string
  name: string
  fps: number
  frames: number
  dir: string
  videoPath: string
  audioPath: string
  writing: Promise<unknown>
  controller: AbortController
  /** Keeps the project open (and its folder in place) until the render is imported. */
  release: () => void
  /** Last request for this export (Date.now()). */
  lastActivity: number
  /** Muxing and importing: can take a while without any request. */
  finalizing: boolean
}

/**
 * An export nothing has been sent for this long was abandoned (its tab closed or crashed mid-export): without this its
 * hold kept the project from closing, renaming and the Trash for good, and its frames (gigabytes) stayed in Tmp/.
 */
const IDLE_EXPORT_MS = 30 * 60_000
const SWEEP_EVERY_MS = 5 * 60_000

export function exportRoutes(deps: AppDeps) {
  const r = new Hono()
  const sessions = new Map<string, ExportSession>()

  const load = (id: string) => {
    const s = sessions.get(id)
    if (!s) throw notFound('Export')
    s.lastActivity = Date.now()
    return s
  }

  const cleanup = async (s: ExportSession) => {
    sessions.delete(s.id)
    s.controller.abort()
    s.release()
    await rm(s.dir, { recursive: true, force: true }).catch(() => {})
  }

  setInterval(() => {
    const cutoff = Date.now() - IDLE_EXPORT_MS
    for (const s of sessions.values()) {
      if (s.finalizing || s.lastActivity > cutoff) continue
      console.warn(`[export] dropping export ${s.id} of project ${s.projectId}: nothing was sent for it in ${IDLE_EXPORT_MS / 60_000} minutes`)
      void cleanup(s)
    }
  }, SWEEP_EVERY_MS).unref()

  r.post('/exports', async (c) => {
    const body = await readJson<{ projectId: string; name?: string; fps: number; frames: number }>(c)
    if (!body.projectId || !(body.fps > 0) || !(body.frames > 0)) throw badRequest('Invalid export request')
    const project = deps.registry.require(body.projectId)
    const id = nanoid(10)
    const dir = join(deps.env.tmpDir, 'exports', id)
    mkdirSync(dir, { recursive: true })
    const videoPath = join(dir, 'video.mp4')
    // Create the file up front so chunks can be written at any position — before the project is held, so a failure
    // here can't leave a hold behind.
    try {
      await (await open(videoPath, 'w')).close()
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
    const session: ExportSession = {
      id,
      projectId: project.id,
      name: (body.name ?? 'Export').trim() || 'Export',
      fps: body.fps,
      frames: Math.round(body.frames),
      dir,
      videoPath,
      audioPath: join(dir, 'mix.wav'),
      writing: Promise.resolve(),
      controller: new AbortController(),
      release: deps.registry.hold(project.id),
      lastActivity: Date.now(),
      finalizing: false,
    }
    sessions.set(id, session)
    return c.json({ id }, 201)
  })

  /** Muxer chunks may arrive at arbitrary positions — write each exactly where it belongs. */
  r.put('/exports/:id/video', async (c) => {
    const s = load(c.req.param('id'))
    const position = Number(c.req.query('position'))
    if (!Number.isFinite(position) || position < 0) throw badRequest('Invalid position')
    const data = Buffer.from(await c.req.arrayBuffer())
    const write = s.writing.then(async () => {
      const fh = await open(s.videoPath, 'r+')
      try {
        await fh.write(data, 0, data.length, position)
      } finally {
        await fh.close()
      }
    })
    s.writing = write.catch(() => {})
    await write
    return c.json({ ok: true, bytes: data.length })
  })

  r.put('/exports/:id/audio', async (c) => {
    const s = load(c.req.param('id'))
    const body = c.req.raw.body
    if (!body) throw badRequest('Empty audio upload')
    await pipeline(Readable.fromWeb(body as unknown as WebReadableStream), createWriteStream(s.audioPath))
    return c.json({ ok: true })
  })

  r.post('/exports/:id/finalize', async (c) => {
    const s = load(c.req.param('id'))
    const body = await readJson<{ loudness: number | null }>(c)
    await s.writing
    const size = (await stat(s.videoPath)).size
    if (size === 0) throw badRequest('No video data was uploaded')
    const outPath = join(s.dir, 'render.mp4')
    const publish = (progress: number, message?: string) =>
      deps.events.publish({ type: 'export.progress', exportId: s.id, stage: 'finalize', progress, message })
    publish(0, 'Muxing and normalising audio')
    s.finalizing = true
    try {
      await finalizeExport({
        videoPath: s.videoPath,
        audioPath: s.audioPath,
        outPath,
        fps: s.fps,
        frames: s.frames,
        loudness: typeof body.loudness === 'number' ? body.loudness : null,
        signal: s.controller.signal,
        onProgress: (p) => publish(p),
      })
      const asset = await deps.media.importFile(outPath, {
        name: s.name,
        source: 'render',
        projectId: s.projectId,
        move: true,
      })
      publish(1, 'Done')
      await cleanup(s)
      return c.json(asset, 201)
    } catch (err) {
      await cleanup(s)
      throw err
    }
  })

  r.delete('/exports/:id', async (c) => {
    const s = sessions.get(c.req.param('id'))
    if (s) await cleanup(s)
    return c.json({ ok: true })
  })

  return r
}
