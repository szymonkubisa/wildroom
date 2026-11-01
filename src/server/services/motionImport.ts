import { realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, sep } from 'node:path'
import { nanoid } from 'nanoid'
import { fillPlaceholders, type MotionImport, type MotionImportResult, motionImportSchema } from '../../shared/motion/importSchema'
import { sanitizeMotionClip } from '../../shared/motion/sanitize'
import { shotLabel } from '../../shared/story/structure'
import * as ops from '../../shared/timeline'
import { layoutTimeline } from '../../shared/timeline/layout'
import { mapMotionTime } from '../../shared/timeline/util'
import type { AssetDTO } from '../../shared/types/assets'
import { sanitizeBrand } from '../../shared/types/brand'
import { type CanvasItem, sanitizeCanvas } from '../../shared/types/canvas'
import type { Clip, MotionClip, ProjectDoc } from '../../shared/types/project-doc'
import type { Env } from '../env'
import { badRequest } from '../http'
import type { MediaStore } from './mediaStore'

/**
 * Motion import: one JSON file (see `shared/motion/importSchema.ts`) becomes boards, motion clips, sound and markers in
 * a project — media and fonts imported from local paths first, `"@@key"` placeholders filled with what they became.
 * The result is a new document for the caller to save as one revision.
 */

/** Folders files may be imported from: the user's own folders, the projects folder, the temp folder (and any in `STUDIO_IMPORT_DIRS`). */
export function importRoots(env: Env): string[] {
  const home = homedir()
  const extra = (process.env.STUDIO_IMPORT_DIRS ?? '').split(':').filter(Boolean)
  const roots = [env.projectsDir, env.tmpDir, tmpdir(), ...['Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures', 'Projects'].map((d) => join(home, d)), ...extra]
  return [
    ...new Set(
      roots.filter(Boolean).flatMap((r) => {
        try {
          return [realpathSync(r)]
        } catch {
          return []
        }
      }),
    ),
  ]
}

/** The real path of a file to import, if it is a file inside one of `roots`. */
export function allowedFile(path: string, roots: readonly string[]): string {
  if (!isAbsolute(path)) throw badRequest(`Not an absolute path: ${path}`)
  let real: string
  try {
    real = realpathSync(path)
    if (!statSync(real).isFile()) throw new Error('not a file')
  } catch {
    throw badRequest(`No such file: ${path}`)
  }
  if (!roots.some((r) => real === r || real.startsWith(r + sep))) throw badRequest(`Files can only be imported from your home folders or the projects folder: ${path}`)
  return real
}

export interface ImportDeps {
  env: Env
  media: MediaStore
}

/** Parses an import file (400 with the problems when it doesn't fit the schema). */
export function parseMotionImport(raw: unknown): MotionImport {
  const parsed = motionImportSchema.safeParse(raw)
  if (!parsed.success) throw badRequest('Invalid motion import', { issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`) })
  return parsed.data
}

/**
 * Imports the file's media and fonts into the project, then builds the document with everything else added — on the
 * project as it is once the files are in (`current`: an edit saved while they were copying is kept), returning the
 * revision it was built on. A file that fails leaves none of this request's media in the project.
 */
export async function runMotionImport(
  deps: ImportDeps,
  projectId: string,
  current: () => { doc: ProjectDoc; revision: number },
  input: MotionImport,
): Promise<{ doc: ProjectDoc; baseRevision: number; result: Omit<MotionImportResult, 'revision'> }> {
  const roots = importRoots(deps.env)
  const warnings: string[] = []
  const keys = [...input.media.map((m) => m.key), ...input.fonts.map((f) => f.key)]
  const dup = keys.find((k, i) => keys.indexOf(k) !== i)
  if (dup) throw badRequest(`Key "${dup}" is used twice`)
  // Paths are all checked before anything is imported.
  const mediaFiles = input.media.map((m) => ({ ...m, file: allowedFile(m.path, roots) }))
  const fontFiles = input.fonts.map((f) => ({ ...f, file: allowedFile(f.path, roots) }))
  // So are the placeholders: a typo must not leave the files imported.
  const unknown = new Set<string>()
  fillPlaceholders({ boards: input.boards, timeline: input.timeline, markers: input.markers, brand: input.brand, shots: input.shots }, Object.fromEntries(keys.map((k) => [k, k])), unknown)
  if (unknown.size) throw badRequest(`Unknown placeholders: ${[...unknown].map((k) => `@@${k}`).join(', ')}`)
  const added: string[] = []
  try {
    return await build()
  } catch (err) {
    for (const id of added) {
      try {
        deps.media.removeFromProject(id, projectId)
      } catch {
        // already gone
      }
    }
    throw err
  }

  async function build(): Promise<{ doc: ProjectDoc; baseRevision: number; result: Omit<MotionImportResult, 'revision'> }> {
    const assets: Record<string, string> = {}
    const fonts: Record<string, string> = {}
    const imported = new Map<string, AssetDTO>()
    for (const m of mediaFiles) {
      const meta = m.words?.length ? { alignment: { words: m.words, source: 'import' } } : undefined
      const asset = await deps.media.importFile(m.file, { name: m.name ?? basename(m.file).replace(/\.[^.]+$/, ''), source: 'import', projectId, role: m.role, meta })
      added.push(asset.id)
      if (asset.kind === 'font') throw badRequest(`"${m.key}" is a font: list it under "fonts"`)
      assets[m.key] = asset.id
      imported.set(asset.id, asset)
    }
    for (const f of fontFiles) {
      const asset = await deps.media.importFile(f.file, { name: basename(f.file).replace(/\.[^.]+$/, ''), source: 'import', projectId })
      added.push(asset.id)
      if (asset.kind !== 'font') throw badRequest(`"${f.key}" is not a font file`)
      fonts[f.key] = asset.font?.family ?? asset.name
      if (!asset.font) warnings.push(`Font "${f.key}": its name table could not be read; using "${asset.name}"`)
    }

    const missing = new Set<string>()
    const filled = fillPlaceholders(
      { boards: input.boards, timeline: input.timeline, markers: input.markers, brand: input.brand, shots: input.shots },
      { ...assets, ...fonts },
      missing,
    )
    if (missing.size) throw badRequest(`Unknown placeholders: ${[...missing].map((k) => `@@${k}`).join(', ')}`)

    const { doc, revision: baseRevision } = current()
    const fps = doc.settings.fps
    // Frames written at another rate are converted.
    const ratio = input.fps && input.fps !== fps ? fps / input.fps : 1
    const frames = (n: number) => Math.round(n * ratio)

    const boardIds: string[] = []
    const clips: Record<string, string> = {}
    const shotIds: string[] = []
    const mediaInfo = (id: string) => {
      const a = imported.get(id) ?? deps.media.getDTO(id)
      if (!a || a.kind === 'font' || !a.projectIds.includes(projectId)) return undefined
      return { kind: a.kind, durationFlicks: a.durationFlicks, hasVideo: a.hasVideo, hasAudio: a.hasAudio, fps: a.fps }
    }
    const ctx = { newId: () => nanoid(10), media: mediaInfo }

    const result = ops.applyOp(
      doc,
      (draft, rctx) => {
        // ---- boards
        if (filled.boards.length) draft.canvas ??= { boards: [] }
        for (const b of filled.boards) {
          const existing = b.id ? draft.canvas!.boards.find((x) => x.id === b.id) : undefined
          if (existing && !b.replace) throw badRequest(`Board "${b.id}" already exists: set "replace": true to replace its contents`)
          const items = b.items as unknown as CanvasItem[]
          if (existing) {
            existing.name = b.name
            existing.items = items
            boardIds.push(existing.id)
          } else {
            const id = b.id ?? nanoid(10)
            draft.canvas!.boards.push({ id, name: b.name, items })
            boardIds.push(id)
          }
        }
        if (draft.canvas) {
          const before = new Map(draft.canvas.boards.map((b) => [b.id, b.items.length]))
          draft.canvas = sanitizeCanvas(JSON.parse(JSON.stringify(draft.canvas))) ?? { boards: [] }
          for (const b of draft.canvas.boards) {
            const lost = (before.get(b.id) ?? 0) - b.items.length
            if (boardIds.includes(b.id) && lost > 0) warnings.push(`Board "${b.name}": ${lost} element(s) were not valid and were left out`)
          }
        }
        if (filled.brand) {
          const brand = sanitizeBrand({ ...draft.brand, ...filled.brand })
          if (brand) draft.brand = brand
        }

        // ---- the timeline, entry by entry (a later one can start at an earlier one)
        const startOf = (key: string) => {
          const id = clips[key]
          const l = layoutTimeline(draft)
          const entry = (id && (l.spine.find((s) => s.id === id) ?? l.connected.find((c) => c.id === id))) || undefined
          if (!entry) throw badRequest(`"at" refers to "${key}", which isn't an earlier clip of this file`)
          return entry.start
        }
        const where = (at: MotionImport['timeline'][number]['at']) => (at === 'end' ? 'end' : typeof at === 'number' ? frames(at) : startOf(at.clip) + frames(at.offset))
        filled.timeline.forEach((e, i) => {
          let clip: Clip
          if (e.type === 'motion') {
            const board = draft.canvas?.boards.find((b) => b.id === e.board) ?? draft.canvas?.boards.find((b) => b.name === e.board)
            const frame = board?.items.find((it) => it.kind === 'frame' && it.id === e.frame) ?? board?.items.find((it) => it.kind === 'frame' && it.name === e.frame)
            if (!board || !frame) throw badRequest(`Timeline entry ${i + 1}: no frame "${e.frame}" on a board "${e.board}"`)
            const made: MotionClip = sanitizeMotionClip({
              ...ops.makeMotion({ boardId: board.id, frameId: frame.id, newId: rctx.newId, duration: frames(e.duration), name: e.name ?? frame.name ?? 'Motion' }),
              tracks: e.tracks as MotionClip['tracks'],
              ...(e.camera ? { camera: e.camera as MotionClip['camera'] } : {}),
              ...(e.span ? { span: e.span } : {}),
            })
            if (ratio !== 1) mapMotionTime(made, frames)
            clip = made
          } else {
            const media = mediaInfo(e.media)
            if (!media) throw badRequest(`Timeline entry ${i + 1}: no media "${e.media}" in this project`)
            clip = ops.makeMediaClip({
              assetId: e.media,
              media,
              fps,
              role: e.role ?? (e.type === 'audio' ? (imported.get(e.media)?.role ?? 'dialogue') : 'effects'),
              newId: rctx.newId,
              name: e.name ?? imported.get(e.media)?.name ?? deps.media.getDTO(e.media)?.name ?? 'Media',
              ...(e.duration ? { durationFrames: frames(e.duration) } : {}),
            })
          }
          const span = clip.kind === 'motion' && clip.span === 'timeline'
          const at = where(e.at)
          if (span) ops.connectAt(0, [clip], 1)(draft, rctx)
          else if (at === 'end' && e.lane === undefined) ops.appendToSpine([clip])(draft, rctx)
          else ops.connectAt(at === 'end' ? layoutTimeline(draft).duration : at, [clip], e.lane ?? (e.type === 'audio' ? -1 : 1))(draft, rctx)
          clips[e.key ?? String(i)] = clip.id
        })

        for (const m of filled.markers) {
          const at = where(m.at)
          ops.addMarker(at === 'end' ? layoutTimeline(draft).duration : at, m.kind, m.name)(draft, rctx)
        }

        // ---- Blender previs on story shots: by id, label ("2.3") or number in story order
        for (const [i, s] of filled.shots.entries()) {
          const story = draft.story
          const shot =
            typeof s.shot === 'number'
              ? story?.shots[s.shot - 1]
              : (story?.shots.find((x) => x.id === s.shot) ?? story?.shots.find((x) => shotLabel(story, x) === s.shot))
          if (!story || !shot) throw badRequest(`Shot entry ${i + 1}: no story shot "${s.shot}" in this project`)
          const asset = (id: string | undefined, what: string, kind: 'video' | 'image') => {
            if (!id) return undefined
            if (mediaInfo(id)?.kind !== kind) throw badRequest(`Shot entry ${i + 1}: its ${what} "${id}" is not ${kind === 'video' ? 'a video' : 'an image'} in this project`)
            return id
          }
          shot.previs = {
            assetId: asset(s.previs.layout, 'layout', 'video')!,
            ...(s.previs.depth ? { depthAssetId: asset(s.previs.depth, 'depth', 'video') } : {}),
            ...(s.previs.firstFrame ? { firstFrameAssetId: asset(s.previs.firstFrame, 'first frame', 'image') } : {}),
            ...(s.previs.frames ? { frames: s.previs.frames, ...(input.fps ? { fps: input.fps } : {}) } : {}),
            ...(s.previs.source ? { source: s.previs.source } : {}),
            ...(s.previs.figures?.length ? { figures: s.previs.figures } : {}),
          }
          shotIds.push(shot.id)
        }
      },
      ctx,
    )
    return { doc: result.doc, baseRevision, result: { assets, fonts, boards: boardIds, clips, shots: shotIds, warnings } }
  }
}
