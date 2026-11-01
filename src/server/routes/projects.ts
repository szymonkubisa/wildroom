import { existsSync } from 'node:fs'
import type { MotionImportResult } from '../../shared/motion/importSchema'
import { parseMotionImport, runMotionImport } from '../services/motionImport'
import { applyTimelineOps, timelineOpsSchema } from '../services/timelineOps'
import { Hono } from 'hono'
import { isProjectKind } from '../../shared/projects/meta'
import type { OpenProjectRequest, ProjectDetail, ProjectSummary, SaveDocRequest, SaveDocResponse, SetProjectTagsRequest } from '../../shared/types/api'
import { spineGeometry } from '../../shared/timeline'
import { timelineExportName, timelinesProblem } from '../../shared/timeline/timelines'
import { flicksToSeconds } from '../../shared/time/flicks'
import type { ProjectDoc, ProjectSettings } from '../../shared/types/project-doc'
import type { AppDeps } from '../app'
import { ApiError, badRequest, readJson } from '../http'
import { revealInFinder } from '../services/desktopBridge'
import { type FcpAsset, writeFcpxml } from '../services/fcpxml'
import { derivedPath, ensurePoster } from '../services/ingest'
import type { ProjectStore } from '../storage/projectStore'
import type { ProjectSummaryInfo } from '../storage/records'
import { serveFile } from './files'

const FPS_OPTIONS = [24, 25, 30, 48, 50, 60]

function toSummary(store: ProjectStore): ProjectSummary {
  const { project } = store
  return {
    id: project.id,
    name: project.name,
    settings: project.doc.settings,
    posterAssetId: project.summary.posterAssetId,
    durationFrames: project.summary.durationFrames,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    path: store.root,
  }
}

function toDetail(store: ProjectStore): ProjectDetail {
  return { ...toSummary(store), doc: store.project.doc, revision: store.project.revision }
}

function firstPosterAsset(doc: ProjectDoc): string | undefined {
  for (const item of doc.spine) {
    if (item.kind === 'media') {
      const take = item.takes[item.active] ?? item.takes[0]
      if (take?.assetId) return take.assetId
    }
  }
  // Projects made on the canvas have no timeline: their first board image becomes the card.
  for (const board of doc.canvas?.boards ?? []) {
    for (const item of board.items) if (item.kind === 'asset' && item.assetId) return item.assetId
  }
  return doc.brand?.logoAssetIds[0]
}

/** The project card's facts, readable without opening the project. */
function summaryFor(doc: ProjectDoc, store: ProjectStore): ProjectSummaryInfo {
  const posterAssetId = firstPosterAsset(doc) ?? store.project.summary.posterAssetId
  const poster = posterAssetId ? store.assets.get(posterAssetId) : undefined
  return {
    // Transitions overlap only as far as the editor plays them (clamped to the clips they join): the card matches it.
    durationFrames: spineGeometry(doc.spine).end,
    posterAssetId,
    posterSha: poster?.sha256 ?? undefined,
    posterExt: poster?.ext ?? undefined,
  }
}

function validateDoc(doc: unknown): ProjectDoc {
  const d = doc as ProjectDoc
  if (!d || typeof d !== 'object' || d.version !== 1 || !Array.isArray(d.spine) || !Array.isArray(d.connected)) {
    throw badRequest('Invalid project document')
  }
  if (!FPS_OPTIONS.includes(d.settings?.fps)) throw badRequest('Unsupported frame rate')
  if (d.canvas !== undefined && (typeof d.canvas !== 'object' || !Array.isArray(d.canvas?.boards))) throw badRequest('Invalid canvas')
  const timelines = timelinesProblem(d)
  if (timelines) throw badRequest(timelines)
  return d
}

export function projectRoutes(deps: AppDeps) {
  const { registry } = deps
  const r = new Hono()

  /** Recent projects and the bundles in the projects folder. */
  r.get('/', (c) => c.json(registry.list()))

  r.post('/', async (c) => {
    const body = await readJson<{ name?: string; settings?: Partial<ProjectSettings>; dir?: string; kind?: string }>(c)
    if (body.settings?.fps !== undefined && !FPS_OPTIONS.includes(body.settings.fps)) throw badRequest('Unsupported frame rate')
    if (body.kind !== undefined && !isProjectKind(body.kind)) throw badRequest('Unknown project kind')
    const store = registry.create({ name: body.name ?? '', settings: body.settings, dir: body.dir || undefined, kind: body.kind })
    return c.json(toDetail(store), 201)
  })

  /** Opens a project bundle by path (Open…, a recent or found project, a copy from another machine). */
  r.post('/open', async (c) => {
    const body = await readJson<OpenProjectRequest>(c)
    if (!body.path) throw badRequest('path is required')
    return c.json(toDetail(registry.open(body.path, { force: !!body.force })))
  })

  r.post('/trash', async (c) => {
    const { path } = await readJson<{ path: string }>(c)
    if (!path) throw badRequest('path is required')
    await registry.trash(path)
    return c.json({ ok: true })
  })

  /** The project's tags (Projects page), by folder like trash and reveal: open or closed, it isn't opened for it. */
  r.post('/tags', async (c) => {
    const body = await readJson<SetProjectTagsRequest>(c)
    if (!body.path) throw badRequest('path is required')
    if (!Array.isArray(body.tags)) throw badRequest('tags must be a list')
    return c.json({ tags: registry.setTags(body.path, body.tags) })
  })

  /** Removes a project from the recents list; its folder is untouched. */
  r.post('/forget', async (c) => {
    const { path } = await readJson<{ path: string }>(c)
    if (!path) throw badRequest('path is required')
    registry.forget(path)
    return c.json({ ok: true })
  })

  r.post('/reveal', async (c) => {
    const { path } = await readJson<{ path: string }>(c)
    if (!path || !existsSync(path)) throw new ApiError(404, 'The project folder was not found', { code: 'missing', path })
    revealInFinder(path)
    return c.json({ ok: true })
  })

  /** Project-card poster by content hash (works for projects that are not open). */
  r.get('/posters/:sha', async (c) => {
    const sha = c.req.param('sha')
    if (!/^[a-f0-9]{64}$/.test(sha)) throw badRequest('Invalid poster id')
    let path = derivedPath(deps.env, sha, 'poster')
    if (!existsSync(path)) {
      const source = registry.posterSource(sha)
      if (!source) return c.json({ error: 'Poster not found' }, 404)
      try {
        path = await ensurePoster(deps.env, sha, source, c.req.raw.signal)
      } catch {
        return c.json({ error: 'Poster not available' }, 404)
      }
    }
    return serveFile(c, path, 'image/jpeg')
  })

  /** Loads a project; an editor page passes its `session` so the project stays open until that page closes it. */
  r.get('/:id', (c) => {
    const store = registry.require(c.req.param('id'))
    const session = c.req.query('session')
    if (session) registry.attach(store.id, session)
    return c.json(toDetail(store))
  })

  r.patch('/:id', async (c) => {
    const body = await readJson<{ name?: string }>(c)
    const name = body.name?.trim()
    const store = name ? registry.rename(c.req.param('id'), name) : registry.require(c.req.param('id'))
    return c.json(toSummary(store))
  })

  r.put('/:id/doc', async (c) => {
    const store = registry.require(c.req.param('id'))
    const body = await readJson<SaveDocRequest>(c)
    const doc = validateDoc(body.doc)
    return c.json(store.saveDoc(doc, body.baseRevision, summaryFor(doc, store)) satisfies SaveDocResponse)
  })

  /**
   * Motion import (docs/motion-import.md): media and fonts from local paths, boards, motion clips, sound, markers and
   * brand from one JSON file, saved as one new revision; an editor that has the project open reloads it.
   */
  r.post('/:id/motion-import', async (c) => {
    const store = registry.require(c.req.param('id'))
    const input = parseMotionImport(await readJson<unknown>(c))
    // Held for the whole import (copying, then saving), not only while each file copies.
    const saved = await registry.holdDuring(store.id, async () => {
      const { doc, baseRevision, result } = await runMotionImport(deps, store.id, () => ({ doc: store.project.doc, revision: store.project.revision }), input)
      return { ...result, revision: store.saveDoc(validateDoc(doc), baseRevision, summaryFor(doc, store)).revision }
    })
    deps.events.publish({ type: 'project.doc.saved', projectId: store.id, revision: saved.revision, source: 'import' })
    return c.json(saved satisfies MotionImportResult)
  })

  /**
   * Timeline edits by clip id (remove, move, trim, blade, speed, clip properties, markers), applied in order with the
   * editor's own ops and saved as one revision; an editor that has the project open reloads it.
   */
  r.post('/:id/timeline-ops', async (c) => {
    const store = registry.require(c.req.param('id'))
    const parsed = timelineOpsSchema.safeParse(await readJson<unknown>(c))
    if (!parsed.success) throw badRequest('Invalid timeline ops', { issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`) })
    const saved = await registry.holdDuring(store.id, async () => {
      const { doc: before, revision } = store.project
      const doc = applyTimelineOps(before, parsed.data.ops, deps.media, store.id)
      return store.saveDoc(validateDoc(doc), revision, summaryFor(doc, store))
    })
    deps.events.publish({ type: 'project.doc.saved', projectId: store.id, revision: saved.revision, source: 'import' })
    return c.json(saved satisfies SaveDocResponse)
  })

  /** An editor page (`session`) or a one-off action is done with the project: unmount it once nothing uses it. */
  r.post('/:id/close', async (c) => {
    const body = await readJson<{ session?: string }>(c).catch(() => ({}) as { session?: string })
    return c.json({ closed: registry.close(c.req.param('id'), body.session || undefined) })
  })

  r.post('/:id/duplicate', async (c) => c.json(await registry.duplicate(c.req.param('id')), 201))

  /** Final Cut Pro XML of the saved timeline (media referenced by absolute paths inside the project bundle). */
  r.get('/:id/fcpxml', (c) => {
    const store = registry.require(c.req.param('id'))
    const doc = store.project.doc
    const assets = new Map<string, FcpAsset>()
    const clips = [...doc.spine, ...doc.connected.map((x) => x.clip)]
    for (const clip of clips) {
      if (clip.kind !== 'media') continue
      for (const take of clip.takes) {
        if (!take.assetId || assets.has(take.assetId)) continue
        const a = deps.media.get(take.assetId)
        if (!a) continue
        assets.set(a.id, {
          id: a.id,
          name: a.name,
          kind: a.kind as FcpAsset['kind'],
          path: deps.media.originalPath(a),
          durationSeconds: a.durationFlicks ? flicksToSeconds(a.durationFlicks) : undefined,
          fps: a.fps ?? undefined,
          width: a.width ?? undefined,
          height: a.height ?? undefined,
          hasVideo: a.hasVideo,
          hasAudio: a.hasAudio,
          channels: a.channels ?? undefined,
          sampleRate: a.sampleRate ?? undefined,
          timeOffset: a.timeOffset ?? undefined,
        })
      }
    }
    // The open timeline is the one exported; with several, the sequence is named after it too.
    const { xml, warnings } = writeFcpxml(doc, timelineExportName(store.name, doc), assets)
    const filename = `${store.name.replace(/[^\w\- ]+/g, '').trim() || 'project'}.fcpxml`
    return c.body(xml, 200, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Fcpxml-Warnings': encodeURIComponent(JSON.stringify(warnings)),
    })
  })

  /** Moves the project to the Trash. */
  r.delete('/:id', async (c) => {
    const store = registry.require(c.req.param('id'))
    await registry.trash(store.root)
    return c.json({ ok: true })
  })

  return r
}
