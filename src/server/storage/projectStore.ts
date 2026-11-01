import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectDoc } from '../../shared/types/project-doc'
import { ApiError } from '../http'
import {
  BundleGoneError,
  type FileStamp,
  listRecordFiles,
  readJsonFile,
  removeTempFiles,
  sameStamp,
  stampOf,
  writeJsonSync,
} from './atomicFile'
import type { Lock } from './lock'
import {
  ASSETS_DIR,
  type AssetRecord,
  CONFLICTS_DIR,
  GENERATIONS_DIR,
  type GenerationRecord,
  type GenerationRow,
  generationToRecord,
  MEDIA_DIR,
  RECORD_ID_RE,
  isSafeExt,
  isSafeSha,
  normalizeAssetRecord,
  PROJECT_FILE,
  PROJECT_FORMAT,
  type ProjectFile,
  type ProjectSummaryInfo,
  recordToGeneration,
  type SavedBy,
} from './records'
import { replayReidentify } from './reidentify'

export type SuspendReason = 'missing' | 'lock-lost'

export interface StoreContext {
  machineId: string
  host: string
  /** `<appData>/Backups`: rotating copies of project.json, outside the bundle (sync services resolve conflicts silently). */
  backupsDir: string
  onSuspend(store: ProjectStore, reason: SuspendReason): void
  onConflict(store: ProjectStore, file: string): void
}

export class ProjectFormatError extends Error {
  constructor(
    readonly code: 'not-a-project' | 'newer-format' | 'unreadable',
    message: string,
  ) {
    super(message)
    this.name = 'ProjectFormatError'
  }
}

const SAVE_SOON_MS = 500
/** A coalesced write that failed (disk full, I/O error) is retried after this delay. */
const SAVE_RETRY_MS = 5_000
const BACKUP_EVERY_MS = 10 * 60_000
const BACKUPS_KEPT = 20
const GONE_MESSAGE = 'The project folder is gone (moved or deleted?) — reopen it from the Projects page'

/** Reads and validates `<root>/project.json` without opening the project. */
export function readProjectFile(root: string): { file: ProjectFile; stamp: FileStamp } {
  let read: { value: ProjectFile; stamp: FileStamp } | undefined
  try {
    read = readJsonFile<ProjectFile>(join(root, PROJECT_FILE))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') throw new ProjectFormatError('not-a-project', `${root} is not a project folder`)
    throw new ProjectFormatError('unreadable', `project.json is damaged: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!read) throw new ProjectFormatError('not-a-project', `${root} is not a Wildroom project (no project.json)`)
  const file = read.value
  // The id names the project's backups folder (`Backups/<id>`): a record id, never a path.
  if (!file || typeof file !== 'object' || typeof file.id !== 'string' || !RECORD_ID_RE.test(file.id) || !file.doc) {
    throw new ProjectFormatError('unreadable', 'project.json is not a valid project file')
  }
  // A record folder that is a link leads outside the bundle: records would be read, written and (re-identifying a
  // copy) deleted wherever it points.
  for (const dir of [ASSETS_DIR, GENERATIONS_DIR, CONFLICTS_DIR]) {
    if (lstatSync(join(root, dir), { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new ProjectFormatError('unreadable', `The project's ${dir} folder is a link — open the original project instead`)
    }
  }
  if (typeof file.format === 'number' && file.format > PROJECT_FORMAT) {
    throw new ProjectFormatError('newer-format', 'This project was saved by a newer version of Wildroom — update the app to open it')
  }
  file.summary ??= { durationFrames: 0 }
  file.revision = typeof file.revision === 'number' ? file.revision : 1
  return { file, stamp: read.stamp }
}

/**
 * One open project bundle. Records live in memory and are written to their own JSON files: `now` writes are
 * synchronous and durable before the call returns (job state transitions, new assets), `soon` writes are coalesced
 * (renames, ratings, progress). A bundle that disappears while open (moved, deleted, sync removed it) suspends the
 * store instead of being re-created somewhere: edits then fail loudly until the project is reopened.
 */
export class ProjectStore {
  project: ProjectFile
  readonly assets = new Map<string, AssetRecord>()
  readonly generations = new Map<string, GenerationRow>()
  suspended: SuspendReason | undefined
  /** Who saved project.json before this mount (tells whether the project comes from another machine). */
  readonly previousSavedBy: SavedBy | undefined
  private projectStamp: FileStamp | undefined
  private readonly dirtyAssets = new Set<string>()
  private readonly dirtyGenerations = new Set<string>()
  private flushTimer: NodeJS.Timeout | undefined
  private lastBackupAt = 0
  /** Unmounted: the lock is released, nothing may be written any more. */
  private closed = false

  private constructor(
    public root: string,
    readonly lock: Lock,
    private readonly ctx: StoreContext,
    loaded: { file: ProjectFile; stamp: FileStamp },
  ) {
    this.project = loaded.file
    this.projectStamp = loaded.stamp
    this.previousSavedBy = loaded.file.savedBy
  }

  /** Loads a bundle the caller has locked. */
  static load(root: string, lock: Lock, ctx: StoreContext): ProjectStore {
    replayReidentify(root)
    for (const dir of [root, join(root, ASSETS_DIR), join(root, GENERATIONS_DIR)]) removeTempFiles(dir)
    const store = new ProjectStore(root, lock, ctx, readProjectFile(root))
    store.moveSyncConflictCopies()
    mkdirSync(join(root, MEDIA_DIR), { recursive: true })
    for (const name of listRecordFiles(join(root, ASSETS_DIR))) {
      try {
        const rec = readJsonFile<AssetRecord>(join(root, ASSETS_DIR, name))?.value
        if (rec?.id && RECORD_ID_RE.test(rec.id)) store.assets.set(rec.id, normalizeAssetRecord(rec))
        else if (rec?.id) console.warn(`[project] skipping asset record ${name}: unexpected id`)
      } catch (err) {
        console.warn(`[project] skipping unreadable asset record ${name}:`, err instanceof Error ? err.message : err)
      }
    }
    for (const name of listRecordFiles(join(root, GENERATIONS_DIR))) {
      try {
        const rec = readJsonFile<GenerationRecord>(join(root, GENERATIONS_DIR, name))?.value
        // The id becomes the record's file name when the job is saved (resuming it on mount does).
        if (rec?.id && RECORD_ID_RE.test(rec.id)) store.generations.set(rec.id, recordToGeneration(rec, store.id))
        else if (rec?.id) console.warn(`[project] skipping generation record ${name}: unexpected id`)
      } catch (err) {
        console.warn(`[project] skipping unreadable generation record ${name}:`, err instanceof Error ? err.message : err)
      }
    }
    store.backup(true)
    return store
  }

  get id(): string {
    return this.project.id
  }

  get name(): string {
    return this.project.name
  }

  /** project.json was last saved by another machine (the project was copied or synced here). */
  get lastSavedElsewhere(): boolean {
    return !!this.previousSavedBy && this.previousSavedBy.machineId !== this.ctx.machineId
  }

  /** This machine (recorded on generation jobs it runs). */
  get machine(): { machineId: string; host: string } {
    return { machineId: this.ctx.machineId, host: this.ctx.host }
  }

  get mediaDir(): string {
    return join(this.root, MEDIA_DIR)
  }

  mediaPath(sha256: string, ext: string): string {
    // Never a path outside Media/: both parts come from records, which come from a folder the user may have been sent.
    if (!isSafeSha(sha256) || !isSafeExt(ext)) throw new Error('Invalid media file reference')
    return join(this.root, MEDIA_DIR, `${sha256}.${ext}`)
  }

  // ------------------------------------------------------------------------------------------
  // project.json
  // ------------------------------------------------------------------------------------------

  saveDoc(doc: ProjectDoc, baseRevision: number, summary: ProjectSummaryInfo): { revision: number; updatedAt: string } {
    this.assertWritable()
    if (baseRevision !== this.project.revision) {
      throw new ApiError(409, 'Project was changed elsewhere', { revision: this.project.revision })
    }
    const updatedAt = new Date().toISOString()
    this.writeProject({ ...this.project, doc, summary, revision: this.project.revision + 1, updatedAt })
    return { revision: this.project.revision, updatedAt }
  }

  setName(name: string) {
    this.writeProject({ ...this.project, name, updatedAt: new Date().toISOString() })
  }

  /** Tags are about the project, not an edit of it: "last edited" stays as it was. */
  setTags(tags: string[]) {
    const next: ProjectFile = { ...this.project, tags }
    if (!tags.length) delete next.tags
    this.writeProject(next)
  }

  /** Writes project.json; an unexpected change on disk (another machine, a sync service) is kept in Conflicts/. */
  writeProject(next: ProjectFile = this.project) {
    this.assertWritable()
    const path = join(this.root, PROJECT_FILE)
    const current = stampOf(path)
    if (current && this.projectStamp && !sameStamp(current, this.projectStamp)) {
      const name = `project ${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      try {
        mkdirSync(join(this.root, CONFLICTS_DIR), { recursive: true })
        copyFileSync(path, join(this.root, CONFLICTS_DIR, name))
        this.ctx.onConflict(this, name)
      } catch (err) {
        console.warn('[project] could not keep the conflicting project.json:', err)
      }
    }
    const file: ProjectFile = { ...next, savedBy: { machineId: this.ctx.machineId, host: this.ctx.host, at: new Date().toISOString() } }
    try {
      this.projectStamp = writeJsonSync(path, file, { root: this.root })
    } catch (err) {
      throw this.writeFailed(err)
    }
    this.project = file
    this.backup(false)
  }

  // ------------------------------------------------------------------------------------------
  // Records
  // ------------------------------------------------------------------------------------------

  /** Stores an asset record. `now` throws when the bundle can't be written (e.g. an import into a vanished bundle). */
  putAsset(rec: AssetRecord, when: 'now' | 'soon' = 'soon') {
    if (when === 'soon' && (this.closed || this.suspended)) this.assertWritable()
    if (when === 'now') {
      this.assertWritable()
      try {
        writeJsonSync(join(this.root, ASSETS_DIR, `${rec.id}.json`), rec, { root: this.root })
      } catch (err) {
        throw this.writeFailed(err)
      }
      this.dirtyAssets.delete(rec.id)
      this.assets.set(rec.id, rec)
      return
    }
    this.assets.set(rec.id, rec)
    this.dirtyAssets.add(rec.id)
    this.scheduleFlush()
  }

  /**
   * Stores a generation row. `now` is durable before returning, or the store is suspended — it never throws, since
   * the job engine calls it from its error paths. `memory` only changes machine-local fields and writes nothing.
   * Returns false when the change could not be persisted.
   */
  putGeneration(row: GenerationRow, when: 'now' | 'soon' | 'memory' = 'soon'): boolean {
    this.generations.set(row.id, row)
    if (when === 'memory') return true
    if (when === 'soon') {
      this.dirtyGenerations.add(row.id)
      this.scheduleFlush()
      return !this.suspended && !this.closed
    }
    this.dirtyGenerations.delete(row.id)
    return this.writeGeneration(row)
  }

  /** Writes pending `soon` changes. A failed write stays pending and is retried (unless the store is suspended). */
  flushSync() {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    if (!this.canWrite()) return
    for (const id of [...this.dirtyAssets]) {
      const rec = this.assets.get(id)
      if (rec) {
        try {
          writeJsonSync(join(this.root, ASSETS_DIR, `${id}.json`), rec, { root: this.root })
        } catch (err) {
          console.error(`[project] could not save asset ${id}:`, this.writeFailed(err).message)
          this.scheduleFlush(SAVE_RETRY_MS)
          return
        }
      }
      this.dirtyAssets.delete(id)
    }
    for (const id of [...this.dirtyGenerations]) {
      const row = this.generations.get(id)
      if (row && !this.writeGeneration(row)) {
        this.scheduleFlush(SAVE_RETRY_MS)
        return
      }
      this.dirtyGenerations.delete(id)
    }
  }

  /** Flushes and releases the lock. */
  close() {
    this.flushSync()
    this.closed = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    this.lock.release()
  }

  /** Throws (409) unless the bundle is still there and still ours; suspends the store otherwise. */
  ensureWritable() {
    this.assertWritable()
  }

  /** The folder was renamed (by us): paths follow. */
  moved(root: string) {
    this.root = root
    this.lock.dir = root
    this.projectStamp = stampOf(join(root, PROJECT_FILE))
  }

  // ------------------------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------------------------

  private writeGeneration(row: GenerationRow): boolean {
    if (!this.canWrite()) return false
    try {
      writeJsonSync(join(this.root, GENERATIONS_DIR, `${row.id}.json`), generationToRecord(row), { root: this.root })
      return true
    } catch (err) {
      console.error(`[project] could not save generation ${row.id}:`, this.writeFailed(err).message)
      return false
    }
  }

  private scheduleFlush(delay = SAVE_SOON_MS) {
    if (this.flushTimer || this.suspended || this.closed) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.flushSync()
    }, delay)
    this.flushTimer.unref?.()
  }

  /**
   * Whether the bundle can be written: open, still on disk and still locked by us. Every write checks it — job
   * state included — so a project another machine took over ("Open anyway") is never written by two servers.
   */
  private canWrite(): boolean {
    if (this.closed || this.suspended) return false
    if (!existsSync(this.root)) {
      this.suspend('missing')
      return false
    }
    if (!this.lock.isHeld()) {
      this.suspend('lock-lost')
      return false
    }
    return true
  }

  private assertWritable() {
    if (this.closed) throw new ApiError(409, 'The project is not open — open it again from the Projects page', { code: 'missing' })
    if (this.canWrite()) return
    if (this.suspended === 'lock-lost') {
      throw new ApiError(409, 'Another app instance or machine opened this project — reopen it to continue', { code: 'lock-lost' })
    }
    throw new ApiError(409, GONE_MESSAGE, { code: 'missing' })
  }

  private writeFailed(err: unknown): Error {
    if (err instanceof BundleGoneError || !existsSync(this.root)) {
      this.suspend('missing')
      return new ApiError(409, GONE_MESSAGE, { code: 'missing' })
    }
    return err instanceof Error ? err : new Error(String(err))
  }

  private suspend(reason: SuspendReason) {
    if (this.suspended) return
    this.suspended = reason
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    console.warn(`[project] ${this.name} suspended: ${reason}`)
    this.ctx.onSuspend(this, reason)
  }

  /** project.json copies a sync service made ("project 2.json", "project (conflicted copy).json") go to Conflicts/. */
  private moveSyncConflictCopies() {
    let names: string[] = []
    try {
      names = readdirSync(this.root)
    } catch {
      return
    }
    for (const name of names) {
      if (name === PROJECT_FILE || !/^project\b.*\.json$/i.test(name)) continue
      try {
        mkdirSync(join(this.root, CONFLICTS_DIR), { recursive: true })
        renameSync(join(this.root, name), join(this.root, CONFLICTS_DIR, name))
        this.ctx.onConflict(this, name)
      } catch {
        // leave it
      }
    }
  }

  /**
   * Rotating copies of project.json in app data (never inside the bundle, where a sync service could drop them).
   * A copy identical to the newest backup is skipped, so opening a project again and again never rotates real
   * history out.
   */
  private backup(force: boolean) {
    const now = Date.now()
    if (!force && now - this.lastBackupAt < BACKUP_EVERY_MS) return
    this.lastBackupAt = now
    try {
      const dir = join(this.ctx.backupsDir, this.id)
      mkdirSync(dir, { recursive: true })
      const existing = readdirSync(dir)
        .filter((n) => n.startsWith('project-') && n.endsWith('.json'))
        .sort()
        .reverse()
      const current = readFileSync(join(this.root, PROJECT_FILE))
      if (existing[0] && current.equals(readFileSync(join(dir, existing[0])))) return
      copyFileSync(join(this.root, PROJECT_FILE), join(dir, `project-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`))
      for (const name of existing.slice(BACKUPS_KEPT - 1)) rmSync(join(dir, name), { force: true })
    } catch (err) {
      console.warn('[project] backup failed:', err instanceof Error ? err.message : err)
    }
  }
}
