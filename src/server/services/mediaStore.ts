import { createHash } from 'node:crypto'
import { constants as fsConstants, createReadStream, existsSync } from 'node:fs'
import { copyFile, mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { nanoid } from 'nanoid'
import type { AssetDTO, AssetGenerationInfo, AssetKind, AssetSource, AssetVariant } from '../../shared/types/assets'
import type { RoleId } from '../../shared/types/project-doc'
import type { Env } from '../env'
import { ApiError, badRequest, notFound } from '../http'
import type { DerivedCache } from '../storage/derivedCache'
import type { ProjectStore } from '../storage/projectStore'
import { type AssetRecord, type AssetRow, type AssetStatusValue, isSafeSha } from '../storage/records'
import type { ProjectRegistry } from '../storage/registry'
import type { EventBus } from './events'
import { derivedPath, IngestQueue, probeColumns, VARIANT_STEP } from './ingest'
import { probeFile, timeOrigin } from './probe'
import { isSvgFile, rasterizeSvg, UnsafeSvgError } from './svg'

export interface ImportOptions {
  name: string
  source: AssetSource
  /** The (open) project the asset is imported into: the file is copied into its bundle. */
  projectId: string
  generationId?: string
  /** Generation summary shown in the browser (stored in meta.generation). */
  generation?: AssetGenerationInfo
  parentIds?: string[]
  role?: RoleId
  /** Initial keywords (e.g. marking a temp voice). */
  keywords?: string[]
  meta?: Record<string, unknown>
  /** Move the file into the bundle instead of copying it (the source path is gone afterwards). */
  move?: boolean
}

export interface AssetUpdate {
  name?: string
  rating?: -1 | 0 | 1
  keywords?: string[]
  role?: RoleId | null
}

export interface MediaStoreOptions {
  env: Env
  events: EventBus
  registry: ProjectRegistry
  cache: DerivedCache
  /** Parallel ingest jobs (default 2). */
  ingestConcurrency?: number
}

const MIME_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/mp2t': 'ts',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/webm': 'webm',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
}

function normalizeExt(ext: string): string {
  return ext.replace(/^\./, '').toLowerCase()
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 }) as AsyncIterable<Buffer>) hash.update(chunk)
  return hash.digest('hex')
}

let lastCreatedMs = 0
/** ISO timestamps that never repeat within the process, so "newest first" lists have a stable order. */
function monotonicNow(): string {
  lastCreatedMs = Math.max(Date.now(), lastCreatedMs + 1)
  return new Date(lastCreatedMs).toISOString()
}

/**
 * The media of open projects. Every project bundle stores its originals content-addressed in its own `Media/`
 * folder (so a bundle is self-contained) and one JSON record per asset. Derived files (proxy, poster, filmstrip,
 * waveform…) and their ingest state are machine-local and keyed by content hash in the cache, so the same file in
 * several projects is processed once.
 */
export class MediaStore {
  readonly env: Env
  private readonly events: EventBus
  private readonly registry: ProjectRegistry
  private readonly cache: DerivedCache
  private readonly queue: IngestQueue
  private closed = false

  constructor(opts: MediaStoreOptions) {
    this.env = opts.env
    this.events = opts.events
    this.registry = opts.registry
    this.cache = opts.cache
    this.queue = new IngestQueue({
      env: this.env,
      cache: this.cache,
      concurrency: opts.ingestConcurrency,
      onChange: (sha) => this.publishSha(sha),
      // A project whose close waited for this ingest (see isIngesting) can unmount now.
      onSettled: (sha) => {
        for (const id of new Set(this.registry.assetsWithSha(sha).map(([store]) => store.id))) this.registry.idle(id)
      },
    })
    this.registry.onMount((store) => this.resume(store))
    this.registry.addBusyCheck((projectId) => this.isIngesting(projectId))
  }

  // ------------------------------------------------------------------------------------------
  // Import
  // ------------------------------------------------------------------------------------------

  /**
   * Imports a file into a project: probe, hash, copy/move into the bundle, write the record, publish, ingest.
   * The project stays mounted (and can't be renamed or trashed) until the import is done.
   */
  async importFile(srcPath: string, opts: ImportOptions): Promise<AssetDTO> {
    this.assertOpen()
    const store = this.requireStore(opts.projectId)
    return this.registry.holdDuring(store.id, () => this.importInto(store, srcPath, opts))
  }

  private async importInto(store: ProjectStore, srcPath: string, opts: ImportOptions): Promise<AssetDTO> {
    if (await isSvgFile(srcPath)) return this.importVector(store, srcPath, opts)
    const probe = await probeFile(srcPath)
    const ext = normalizeExt(extname(srcPath)) || MIME_EXT[probe.mime.toLowerCase()] || 'bin'
    const sha256 = await hashFile(srcPath)
    const { size } = await stat(srcPath)
    await placeInBundle(store, srcPath, store.mediaPath(sha256, ext), !!opts.move)

    const now = monotonicNow()
    const meta: Record<string, unknown> = { ...opts.meta }
    if (opts.generation) meta.generation = opts.generation
    if (probe.font) meta.font = probe.font
    const rec: AssetRecord = {
      id: nanoid(),
      name: opts.name.trim() || 'Untitled',
      source: opts.source,
      sha256,
      ext,
      ...probeColumns(probe),
      role: opts.role ?? null,
      sizeBytes: size,
      timeOffset: probe.kind === 'image' ? null : timeOrigin(probe),
      generationId: opts.generationId ?? opts.generation?.generationId ?? null,
      parentIds: opts.parentIds ?? [],
      rating: 0,
      keywords: [...new Set((opts.keywords ?? []).map((k) => k.trim()).filter(Boolean))],
      meta,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    store.putAsset(rec, 'now')
    this.registry.indexAsset(store, rec.id)
    this.publish(rec.id)
    const state = this.cache.state(sha256)
    if (!state || state.status !== 'ready' || state.pending) void this.ensure(sha256)
    return this.mustDTO(rec.id)
  }

  /**
   * SVGs are stored as they are, next to a PNG rendering that becomes the asset: posters, the player and exports need
   * pixels (neither ffmpeg nor createImageBitmap decodes SVG).
   */
  private async importVector(store: ProjectStore, svgPath: string, opts: ImportOptions): Promise<AssetDTO> {
    const sha256 = await hashFile(svgPath)
    const png = join(this.env.tmpDir, `vector-${nanoid(10)}.png`)
    try {
      await rasterizeSvg(svgPath, png).catch((err: unknown) => {
        if (err instanceof UnsafeSvgError) throw new ApiError(400, `This SVG can’t be imported safely: ${err.message}`)
        throw err
      })
      await placeInBundle(store, svgPath, store.mediaPath(sha256, 'svg'), !!opts.move)
      return await this.importInto(store, png, { ...opts, move: true, meta: { ...opts.meta, vector: { sha256, ext: 'svg' } } })
    } finally {
      await rm(png, { force: true })
    }
  }

  /** Imports in-memory data (e.g. a provider response) by writing it to the tmp dir and moving it in. */
  async importBuffer(data: Uint8Array, ext: string, opts: ImportOptions): Promise<AssetDTO> {
    this.assertOpen()
    const tmp = join(this.env.tmpDir, `import-${nanoid(10)}.${normalizeExt(ext) || 'bin'}`)
    await writeFile(tmp, data)
    try {
      return await this.importFile(tmp, { ...opts, move: true })
    } finally {
      await rm(tmp, { force: true })
    }
  }

  // ------------------------------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------------------------------

  /** An asset of an open project. */
  get(id: string): AssetRow | undefined {
    const store = this.registry.assetOwner(id)
    const rec = store?.assets.get(id)
    return store && rec ? this.toRow(store, rec) : undefined
  }

  getDTO(id: string): AssetDTO | undefined {
    const row = this.get(id)
    return row ? this.toDTO(row) : undefined
  }

  toDTO(row: AssetRow): AssetDTO {
    return rowToDTO(row)
  }

  toDTOs(rows: AssetRow[]): AssetDTO[] {
    return rows.map(rowToDTO)
  }

  /** A project's assets that are not deleted, newest first. `search` matches the name and the generation prompt. */
  list(projectId: string, filter: { kind?: AssetKind; search?: string } = {}): AssetDTO[] {
    const store = this.registry.mounted(projectId)
    if (!store) return []
    const search = filter.search?.trim().toLowerCase()
    const rows = [...store.assets.values()]
      .filter((rec) => {
        if (rec.deletedAt) return false
        if (filter.kind && rec.kind !== filter.kind) return false
        if (!search) return true
        const prompt = (rec.meta.generation as { prompt?: unknown } | undefined)?.prompt
        return rec.name.toLowerCase().includes(search) || (typeof prompt === 'string' && prompt.toLowerCase().includes(search))
      })
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
      .map((rec) => this.toRow(store, rec))
    return this.toDTOs(rows)
  }

  /** Absolute path of the original file (inside the project bundle). */
  originalPath(row: AssetRow): string {
    if (!row.sha256) throw new Error(`Asset ${row.id} has no stored file`)
    return this.storeOf(row).mediaPath(row.sha256, row.ext ?? 'bin')
  }

  /** The original SVG of an imported vector (its asset file is the PNG rendering). */
  vectorPath(row: AssetRow): string | undefined {
    const sha = vectorSha(row.meta)
    return sha ? this.storeOf(row).mediaPath(sha, 'svg') : undefined
  }

  private storeOf(row: AssetRow): ProjectStore {
    const store = this.registry.mounted(row.projectId) ?? this.registry.assetOwner(row.id)
    if (!store) throw new ApiError(409, 'The project of this asset is not open')
    return store
  }

  /**
   * Absolute path of a variant, only if it has been produced and is on disk. On a ready asset, a variant that is
   * flagged but missing (cache cleared, step version bumped) schedules a re-ingest and returns undefined meanwhile.
   */
  variantPath(row: AssetRow, variant: AssetVariant): string | undefined {
    if (!row.sha256) return undefined
    if (variant === 'original') {
      const path = this.originalPath(row)
      return existsSync(path) ? path : undefined
    }
    if (!row.variants[variant]) return undefined
    const path = derivedPath(this.env, row.sha256, VARIANT_STEP[variant])
    if (existsSync(path)) return path
    // Only ready assets self-heal: error/missing ones would otherwise re-fail on every request.
    if (!this.closed && row.status === 'ready' && !this.queue.pending(row.sha256)) {
      this.cache.setState(row.sha256, { status: 'processing', error: undefined })
      this.publishSha(row.sha256)
      void this.ensure(row.sha256)
    }
    return undefined
  }

  /** Resolves once the asset's ingest has finished (or failed); immediately if nothing is pending. */
  async whenReady(id: string): Promise<AssetDTO> {
    const row = this.mustRow(id)
    if (row.sha256) {
      let pending = this.queue.pending(row.sha256)
      if (!pending && !this.closed && row.status === 'processing') pending = this.ensure(row.sha256)
      if (pending) await pending
    }
    return this.mustDTO(id)
  }

  // ------------------------------------------------------------------------------------------
  // Mutations
  // ------------------------------------------------------------------------------------------

  update(id: string, patch: AssetUpdate): AssetDTO {
    const [store, rec] = this.mustRecord(id)
    const next: AssetRecord = { ...rec }
    if (patch.name !== undefined) {
      const name = typeof patch.name === 'string' ? patch.name.trim() : ''
      if (!name) throw badRequest('Name cannot be empty')
      next.name = name
    }
    if (patch.rating !== undefined) {
      if (![-1, 0, 1].includes(patch.rating)) throw badRequest('Rating must be -1, 0 or 1')
      next.rating = patch.rating
    }
    if (patch.keywords !== undefined) {
      if (!Array.isArray(patch.keywords) || patch.keywords.some((k) => typeof k !== 'string')) throw badRequest('Keywords must be a list of words')
      next.keywords = [...new Set(patch.keywords.map((k) => k.trim()).filter(Boolean))]
    }
    if (patch.role !== undefined) {
      if (patch.role !== null && typeof patch.role !== 'string') throw badRequest('Invalid role')
      next.role = patch.role
    }
    next.updatedAt = new Date().toISOString()
    store.putAsset(next, 'soon')
    return this.publish(id)!
  }

  /**
   * Adds the asset to a project. In its own project that restores it (undo of a removal); into another open project
   * the original is copied into that bundle as a new asset (bundles stay self-contained). Returns the asset in the
   * target project.
   */
  async linkToProject(assetId: string, projectId: string): Promise<AssetDTO> {
    const [owner, rec] = this.mustRecord(assetId)
    if (owner.id === projectId) {
      if (rec.deletedAt) owner.putAsset({ ...rec, deletedAt: null, updatedAt: new Date().toISOString() }, 'now')
      return this.publish(assetId)!
    }
    const target = this.requireStore(projectId)
    if (!rec.sha256) throw new Error(`Asset ${assetId} has no stored file`)
    const sha256 = rec.sha256
    const ext = rec.ext ?? 'bin'
    const vector = vectorSha(rec.meta)
    return this.registry.holdDuring(target.id, async () => {
      await placeInBundle(target, owner.mediaPath(sha256, ext), target.mediaPath(sha256, ext), false)
      // A vector's SVG travels with its PNG rendering.
      if (vector && existsSync(owner.mediaPath(vector, 'svg'))) {
        await placeInBundle(target, owner.mediaPath(vector, 'svg'), target.mediaPath(vector, 'svg'), false)
      }
      return this.addCopy(target, owner, rec)
    })
  }

  private addCopy(target: ProjectStore, owner: ProjectStore, rec: AssetRecord): AssetDTO {
    const now = monotonicNow()
    const copy: AssetRecord = {
      ...rec,
      id: nanoid(),
      generationId: null,
      parentIds: [],
      meta: { ...rec.meta, copiedFrom: { assetId: rec.id, projectId: owner.id, projectName: owner.name } },
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    target.putAsset(copy, 'now')
    this.registry.indexAsset(target, copy.id)
    return this.publish(copy.id)!
  }

  /** Removes the asset from its project (soft delete). Files are never deleted here. */
  removeFromProject(assetId: string, projectId: string): void {
    const [store, rec] = this.mustRecord(assetId)
    if (store.id !== projectId) return
    store.putAsset({ ...rec, deletedAt: new Date().toISOString() }, 'soon')
    this.events.publish({ type: 'asset.removed', assetId, projectId })
  }

  /** Shallow-merges keys into meta (undefined values delete keys). */
  setMeta(id: string, patch: Record<string, unknown>): AssetDTO {
    const [store, rec] = this.mustRecord(id)
    const meta = { ...rec.meta }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete meta[key]
      else meta[key] = value
    }
    store.putAsset({ ...rec, meta, updatedAt: new Date().toISOString() }, 'soon')
    return this.publish(id)!
  }

  /** Runs ingest again (e.g. retry after an error); cached derived files are reused. */
  reingest(id: string): Promise<AssetDTO> {
    this.assertOpen()
    const row = this.mustRow(id)
    if (!row.sha256) return Promise.resolve(this.toDTO(row))
    if (!this.queue.pending(row.sha256)) {
      this.cache.setState(row.sha256, { status: 'processing', error: undefined })
      this.publishSha(row.sha256)
    }
    return this.ensure(row.sha256).then(() => this.mustDTO(id))
  }

  /** After the cache was cleared: re-ingest every asset of the open projects. */
  reingestAll() {
    const shas = new Set<string>()
    for (const store of this.registry.all) {
      for (const rec of store.assets.values()) if (rec.sha256 && !rec.deletedAt) shas.add(rec.sha256)
    }
    for (const sha of shas) {
      this.publishSha(sha)
      // One running while the cache was cleared fails (its folder went away) or finishes into the cleared cache:
      // queue it again once it has settled, or its asset would stay in error.
      const running = this.queue.pending(sha)
      if (running) void running.then(() => this.ensure(sha))
      else void this.ensure(sha)
    }
  }

  /** Stops ingest (running ffmpeg processes are killed; interrupted assets resume on the next start). */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.queue.close()
  }

  // ------------------------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------------------------

  private toRow(store: ProjectStore, rec: AssetRecord): AssetRow {
    const original = rec.sha256 ? store.mediaPath(rec.sha256, rec.ext ?? 'bin') : undefined
    const state = rec.sha256 ? this.cache.state(rec.sha256) : undefined
    const present = !!original && existsSync(original)
    const status: AssetStatusValue = !present ? 'missing' : (state?.status ?? 'processing')
    const variants = { ...(state?.variants ?? {}) }
    if (present) variants.original = true
    else delete variants.original
    return {
      ...rec,
      projectId: store.id,
      status,
      error: status === 'missing' ? 'The original media file is missing' : status === 'error' ? (state?.error ?? 'Processing failed') : null,
      variants,
      filmstrip: state?.filmstrip ?? null,
      waveformRate: state?.waveformRate ?? null,
      loudness: state?.loudness ?? null,
    }
  }

  /** Ingests a hash from any reachable copy of its original. */
  private ensure(sha: string): Promise<void> {
    return this.queue.ensure(sha, () => {
      for (const [store, rec] of this.registry.assetsWithSha(sha)) {
        const path = store.mediaPath(sha, rec.ext ?? 'bin')
        if (existsSync(path)) return path
      }
      return undefined
    })
  }

  /** On mount: queue what this machine hasn't (fully) processed yet. */
  private resume(store: ProjectStore) {
    if (this.closed) return
    for (const rec of store.assets.values()) {
      if (!rec.sha256 || rec.deletedAt) continue
      const state = this.cache.state(rec.sha256)
      if (!state || state.status === 'processing' || state.pending) void this.ensure(rec.sha256)
    }
  }

  private isIngesting(projectId: string): boolean {
    const store = this.registry.mounted(projectId)
    if (!store) return false
    const pending = this.queue.pendingShas()
    if (!pending.size) return false
    for (const rec of store.assets.values()) if (rec.sha256 && pending.has(rec.sha256)) return true
    return false
  }

  private publishSha(sha: string) {
    for (const [, rec] of this.registry.assetsWithSha(sha)) this.publish(rec.id)
  }

  private publish(id: string): AssetDTO | undefined {
    const dto = this.getDTO(id)
    if (dto) this.events.publish({ type: 'asset.upserted', asset: dto })
    return dto
  }

  /** An open project whose bundle is still on disk (its Media folder must never be re-created elsewhere). */
  private requireStore(projectId: string): ProjectStore {
    const store = this.registry.mounted(projectId)
    if (!store) throw new ApiError(409, 'The project is not open')
    if (store.suspended || !existsSync(store.root)) {
      throw new ApiError(409, 'The project folder is gone (moved or deleted?) — reopen it from the Projects page', { code: 'missing' })
    }
    return store
  }

  private mustRecord(id: string): [ProjectStore, AssetRecord] {
    const store = this.registry.assetOwner(id)
    const rec = store?.assets.get(id)
    if (!store || !rec) throw notFound(`Asset ${id}`)
    return [store, rec]
  }

  private mustRow(id: string): AssetRow {
    const row = this.get(id)
    if (!row) throw notFound(`Asset ${id}`)
    return row
  }

  private mustDTO(id: string): AssetDTO {
    return this.toDTO(this.mustRow(id))
  }

  private assertOpen() {
    if (this.closed) throw new Error('Media store is closed')
  }
}

function rowToDTO(row: AssetRow): AssetDTO {
  const meta = row.meta
  const rating = row.rating === 1 || row.rating === -1 ? row.rating : 0
  const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v)
  return {
    id: row.id,
    kind: row.kind as AssetKind,
    name: row.name,
    status: row.status,
    error: opt(row.error),
    source: row.source as AssetSource,
    role: opt(row.role),
    mime: opt(row.mime),
    sizeBytes: opt(row.sizeBytes),
    durationFlicks: opt(row.durationFlicks),
    width: opt(row.width),
    height: opt(row.height),
    fps: opt(row.fps),
    rotation: opt(row.rotation),
    hasVideo: row.hasVideo,
    hasAudio: row.hasAudio,
    sampleRate: opt(row.sampleRate),
    channels: opt(row.channels),
    videoCodec: opt(row.videoCodec),
    audioCodec: opt(row.audioCodec),
    timeOffset: opt(row.timeOffset),
    loudness: row.loudness ?? undefined,
    variants: row.variants,
    filmstrip: row.filmstrip ?? undefined,
    waveformRate: opt(row.waveformRate),
    generation: (meta.generation as AssetGenerationInfo | undefined) ?? undefined,
    alignment: (meta.alignment as AssetDTO['alignment']) ?? undefined,
    transcriptLanguage: typeof meta.transcriptLanguage === 'string' ? meta.transcriptLanguage : undefined,
    beats: (meta.beats as AssetDTO['beats']) ?? undefined,
    description: typeof meta.description === 'string' ? meta.description : undefined,
    aiTags: Array.isArray(meta.aiTags) ? (meta.aiTags as string[]) : undefined,
    vector: meta.vector ? true : undefined,
    font: (meta.font as AssetDTO['font']) ?? undefined,
    parentIds: row.parentIds,
    rating,
    keywords: row.keywords,
    projectIds: [row.projectId],
    createdAt: row.createdAt,
  }
}

/** Content hash of the original SVG kept beside a vector asset's PNG rendering (`meta.vector`). */
function vectorSha(meta: Record<string, unknown>): string | undefined {
  const sha = (meta.vector as { sha256?: unknown } | undefined)?.sha256
  return isSafeSha(sha) ? sha : undefined
}

/**
 * Puts a file into the bundle's Media folder. Checks that the bundle is still there and still ours first, and never
 * re-creates it: if it vanished meanwhile (moved or trashed during a long import), the store is suspended instead of
 * a half bundle appearing at the old path.
 */
async function placeInBundle(store: ProjectStore, src: string, dest: string, move: boolean): Promise<void> {
  store.ensureWritable()
  try {
    await placeFile(src, dest, move)
  } catch (err) {
    if (!existsSync(store.root)) store.ensureWritable()
    throw err
  }
}

/**
 * Puts a file at `dest` (content-addressed, so an existing file is already the same content): copied as an APFS
 * clone where possible, or moved. Written to a hidden temp name first so a sync service never sees a partial file.
 * Only the last folder of `dest` is created (the bundle's Media folder), never its parents.
 */
async function placeFile(src: string, dest: string, move: boolean): Promise<void> {
  if (existsSync(dest)) {
    // Content already stored: a moved source is simply dropped (unless it *is* the stored original).
    if (move && resolve(src) !== resolve(dest)) await rm(src, { force: true })
    return
  }
  await mkdir(dirname(dest)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EEXIST') throw err
  })
  const tmp = join(dirname(dest), `.${basename(dest)}.tmp-${nanoid(8)}.nosync`)
  try {
    if (move) await moveFile(src, tmp)
    else await copyFile(src, tmp, fsConstants.COPYFILE_FICLONE)
    await rename(tmp, dest)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

/** rename(), falling back to copy + unlink across devices. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await copyFile(from, to)
    await unlink(from)
  }
}
