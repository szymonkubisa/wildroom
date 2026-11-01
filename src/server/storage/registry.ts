import { constants as fsConstants, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { nanoid } from 'nanoid'
import { type ProjectKind, normalizeTags, projectKindOf, projectStatus } from '../../shared/projects/meta'
import type { DuplicateProjectResponse, ProjectEntry, ProjectLockInfo } from '../../shared/types/api'
import { createEmptyDoc, type ProjectSettings } from '../../shared/types/project-doc'
import type { Env } from '../env'
import { ApiError } from '../http'
import { moveToTrash } from '../services/desktopBridge'
import type { EventBus } from '../services/events'
import type { AppState, RecentProject } from './appState'
import { listRecordFiles, writeJsonSync } from './atomicFile'
import { acquireLock, inspectLock, type Lock, LockedError } from './lock'
import { ProjectFormatError, ProjectStore, readProjectFile, type StoreContext } from './projectStore'
import {
  ASSETS_DIR,
  type AssetRecord,
  BUNDLE_APP,
  BUNDLE_EXT,
  CONFLICTS_DIR,
  GENERATIONS_DIR,
  isSafeExt,
  isSafeSha,
  LOCK_FILE,
  MEDIA_DIR,
  PROJECT_FILE,
  PROJECT_FORMAT,
  type ProjectFile,
  safeBundleBaseName,
} from './records'
import { reidentifyBundle, reidentifyIds } from './reidentify'

export interface RegistryDeps {
  env: Env
  appState: AppState
  events: EventBus
  /** "desktop" inside the Electron app, "server" otherwise (recorded in locks). */
  via?: string
}

type MountHook = (store: ProjectStore) => void
type BusyCheck = (projectId: string) => boolean

/**
 * The open ("mounted") project bundles and the operations on bundles: open, create, duplicate, rename, trash.
 *
 * Invariant: ids are unique among mounted projects — project ids, and the asset and generation ids inside them —
 * so `/media/<assetId>/…` URLs and job lookups need no project scope. Opening a bundle that is a copy of an open or
 * recent project (same id, different folder) gives the copy new ids first (see reidentify.ts).
 *
 * A project stays mounted while an editor has it open (each editor page attaches with its own session id) or it
 * still has work running (generation jobs, exports, imports, ingest); closing it while busy defers the unmount
 * until it is idle.
 */
export class ProjectRegistry {
  private readonly stores = new Map<string, ProjectStore>()
  private readonly assetIndex = new Map<string, ProjectStore>()
  private readonly generationIndex = new Map<string, ProjectStore>()
  private readonly mountHooks: MountHook[] = []
  private readonly busyChecks: BusyCheck[] = []
  private readonly holds = new Map<string, number>()
  /** Editor pages that have the project open (session ids): a close from one never unmounts it under another. */
  private readonly sessions = new Map<string, Set<string>>()
  private readonly closeWhenIdle = new Set<string>()
  /** Poster originals of listed (possibly closed) projects, by content hash. */
  private readonly posterSources = new Map<string, string>()
  private readonly ctx: StoreContext

  constructor(private readonly deps: RegistryDeps) {
    const { appState, env, events } = deps
    this.ctx = {
      machineId: appState.machineId,
      host: appState.host,
      backupsDir: join(env.appDataDir, 'Backups'),
      onSuspend: (store, reason) => {
        events.publish({ type: 'project.suspended', projectId: store.id, reason })
        // Its jobs stop counting as work (see isBusy): a close that waited for them completes now.
        queueMicrotask(() => this.idle(store.id))
      },
      onConflict: (store, file) => events.publish({ type: 'project.conflict', projectId: store.id, file }),
    }
  }

  /** Runs for every bundle as it is mounted, before anything else sees its records (job resume, ingest). */
  onMount(hook: MountHook) {
    this.mountHooks.push(hook)
  }

  /** Work that keeps a project mounted (and blocks rename/trash) while it reports busy. */
  addBusyCheck(check: BusyCheck) {
    this.busyChecks.push(check)
  }

  // ------------------------------------------------------------------------------------------
  // Lookups
  // ------------------------------------------------------------------------------------------

  get all(): ProjectStore[] {
    return [...this.stores.values()]
  }

  mounted(id: string): ProjectStore | undefined {
    return this.stores.get(id)
  }

  assetOwner(assetId: string): ProjectStore | undefined {
    return this.assetIndex.get(assetId)
  }

  generationOwner(generationId: string): ProjectStore | undefined {
    return this.generationIndex.get(generationId)
  }

  indexAsset(store: ProjectStore, assetId: string) {
    this.assetIndex.set(assetId, store)
  }

  indexGeneration(store: ProjectStore, generationId: string) {
    this.generationIndex.set(generationId, store)
  }

  /** Every mounted asset whose original has this content hash. */
  assetsWithSha(sha: string): Array<[ProjectStore, AssetRecord]> {
    const out: Array<[ProjectStore, AssetRecord]> = []
    for (const store of this.stores.values()) {
      for (const rec of store.assets.values()) if (rec.sha256 === sha) out.push([store, rec])
    }
    return out
  }

  /** Original file to draw a (closed) project's poster from. */
  posterSource(sha: string): string | undefined {
    for (const [store, rec] of this.assetsWithSha(sha)) {
      const path = store.mediaPath(sha, rec.ext ?? 'bin')
      if (existsSync(path)) return path
    }
    const path = this.posterSources.get(sha)
    return path && existsSync(path) ? path : undefined
  }

  // ------------------------------------------------------------------------------------------
  // Listing
  // ------------------------------------------------------------------------------------------

  /** Recent projects plus every bundle in the projects folder, most recently used first. */
  list(): ProjectEntry[] {
    const entries = new Map<string, ProjectEntry>()
    for (const recent of this.deps.appState.recents) {
      if (!entries.has(recent.path)) entries.set(recent.path, this.entryFor(recent.path, recent))
    }
    for (const path of scanBundles(this.deps.appState.projectsDir)) {
      if (entries.has(path)) continue
      const entry = this.entryFor(path)
      if (entry.state !== 'missing') entries.set(path, entry)
    }
    for (const store of this.stores.values()) {
      if (!entries.has(store.root)) entries.set(store.root, this.entryFor(store.root))
    }
    const time = (e: ProjectEntry) => Date.parse(e.lastOpenedAt ?? e.updatedAt ?? '') || 0
    return [...entries.values()].sort((a, b) => time(b) - time(a))
  }

  private entryFor(path: string, recent?: RecentProject): ProjectEntry {
    const store = [...this.stores.values()].find((s) => s.root === path)
    const base: ProjectEntry = {
      path,
      id: recent?.id,
      name: recent?.name ?? basename(path, BUNDLE_EXT),
      state: 'ok',
      open: !!store,
      durationFrames: 0,
      lastOpenedAt: recent?.lastOpenedAt,
      recent: !!recent,
    }
    let file: ProjectFile
    if (store) {
      file = store.project
    } else {
      if (!existsSync(path)) return { ...base, state: 'missing' }
      try {
        file = readProjectFile(path).file
      } catch (err) {
        if (err instanceof ProjectFormatError) {
          const state = err.code === 'newer-format' ? 'newer-format' : err.code === 'not-a-project' ? 'missing' : 'unreadable'
          return { ...base, state, message: err.message }
        }
        return { ...base, state: 'unreadable', message: err instanceof Error ? err.message : String(err) }
      }
    }
    const entry: ProjectEntry = {
      ...base,
      id: file.id,
      name: store ? file.name : displayName(path, file.name),
      settings: file.doc?.settings,
      durationFrames: file.summary?.durationFrames ?? 0,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      kind: projectKindOf(file),
      tags: normalizeTags(file.tags),
      status: projectStatus(file.doc),
    }
    const { posterSha, posterExt } = file.summary ?? {}
    // Both come from the bundle's project.json and make a file path.
    if (isSafeSha(posterSha) && isSafeExt(posterExt)) {
      this.posterSources.set(posterSha, join(path, MEDIA_DIR, `${posterSha}.${posterExt}`))
      entry.posterUrl = `/api/projects/posters/${posterSha}`
    }
    if (!store) {
      const lock = inspectLock(path, LOCK_FILE, this.ctx.machineId)
      if (lock?.held && (lock.foreign || lock.owner.pid !== process.pid)) {
        entry.state = 'locked'
        entry.lockedBy = lockInfo(lock.owner, lock.foreign)
      }
    }
    return entry
  }

  // ------------------------------------------------------------------------------------------
  // Open / close
  // ------------------------------------------------------------------------------------------

  /**
   * Opens (mounts) the bundle at `path`. A bundle that is a copy of an open or recent project gets its own ids
   * first; a recent project found at a new path (moved in Finder) is simply followed.
   */
  open(path: string, opts: { force?: boolean } = {}): ProjectStore {
    const root = canonicalPath(path)
    if (!existsSync(root)) {
      throw new ApiError(404, 'The project folder was not found — it may have been moved or deleted', { code: 'missing', path: root })
    }
    if (isInsideBundle(root)) throw new ApiError(400, 'Choose the project folder itself (the .wildroom folder)', { code: 'not-a-project' })
    const file = this.readOrThrow(root)

    let existing = this.stores.get(file.id)
    if (existing && existing.root === root && !existing.suspended) {
      this.closeWhenIdle.delete(existing.id)
      this.touch(existing)
      return existing
    }
    if (existing && (existing.suspended || !existsSync(existing.root))) {
      // The open project was moved in Finder: this is the same project at its new place. Or its store was suspended
      // (the folder vanished, another machine took it over), and stays so for good: opening it again reads it anew.
      this.unmount(existing)
      existing = undefined
    }
    let isCopy = !!existing
    if (!isCopy) {
      const recent = this.deps.appState.recentById(file.id)
      if (recent && recent.path !== root) {
        let sameIdElsewhere = false
        try {
          sameIdElsewhere = existsSync(recent.path) && readProjectFile(recent.path).file.id === file.id
        } catch {
          sameIdElsewhere = false
        }
        if (sameIdElsewhere) isCopy = true
        else this.deps.appState.forgetRecent(recent.path) // moved: follow it
      }
    }
    let sharedAssetIds: string[] = []
    if (!isCopy) {
      const ids = (dir: string) => listRecordFiles(join(root, dir)).map((n) => n.slice(0, -5))
      // Jobs are never shared between projects: the same job id means a copy (of a copy).
      isCopy = ids(GENERATIONS_DIR).some((id) => this.generationIndex.has(id))
      // Assets can be (projects migrated from the old library shared them): only those get new ids — the project
      // keeps its id and its jobs keep running.
      if (!isCopy) sharedAssetIds = ids(ASSETS_DIR).filter((id) => this.assetIndex.has(id))
    }

    const lock = this.lock(root, opts.force)
    let store: ProjectStore
    try {
      if (isCopy) reidentifyBundle(root)
      else if (sharedAssetIds.length) reidentifyIds(root, sharedAssetIds)
      store = ProjectStore.load(root, lock, this.ctx)
      // Like a Final Cut library, the folder name is the project's name: a rename (or copy) in Finder carries over.
      const name = displayName(root, store.name)
      if (name !== store.name) store.setName(name)
    } catch (err) {
      lock.release()
      if (err instanceof ProjectFormatError) throw formatError(err)
      throw err
    }
    this.touch(store)
    this.mount(store)
    return store
  }

  /** A mounted project, mounting it from its recent path (or the projects folder) when needed. */
  require(id: string): ProjectStore {
    const mounted = this.stores.get(id)
    if (mounted) return mounted
    const recent = this.deps.appState.recentById(id)
    if (recent && existsSync(recent.path)) {
      let found = false
      try {
        found = readProjectFile(recent.path).file.id === id
      } catch (err) {
        if (err instanceof ProjectFormatError) throw formatError(err)
        throw err
      }
      if (found) return this.open(recent.path)
    }
    // Renamed or moved inside the projects folder: find it by id.
    for (const path of scanBundles(this.deps.appState.projectsDir)) {
      let found = false
      try {
        found = readProjectFile(path).file.id === id
      } catch {
        // not this one
      }
      if (found) return this.open(path)
    }
    throw new ApiError(404, 'Project not found — it may have been moved or deleted', { code: 'missing', path: recent?.path })
  }

  /** An editor page has the project open: it stays mounted until that session closes it. */
  attach(id: string, session: string) {
    if (!this.stores.has(id)) return
    let set = this.sessions.get(id)
    if (!set) this.sessions.set(id, (set = new Set()))
    set.add(session)
    this.closeWhenIdle.delete(id)
  }

  /**
   * An editor page left the project (`session`), or a one-off action is done with it (no session). Unmounts it once
   * no other editor has it open and no work runs in it.
   */
  close(id: string, session?: string): boolean {
    const store = this.stores.get(id)
    if (!store) return true
    const attached = this.sessions.get(id)
    if (session) attached?.delete(session)
    if (attached?.size) return false
    this.sessions.delete(id)
    if (this.isBusy(id)) {
      this.closeWhenIdle.add(id)
      return false
    }
    this.unmount(store)
    return true
  }

  isBusy(id: string): boolean {
    if ((this.holds.get(id) ?? 0) > 0) return true
    // A suspended project's jobs never run again (nothing of it can be written): they must not keep it open, or
    // block rename and trash, forever.
    if (this.stores.get(id)?.suspended) return false
    return this.busyChecks.some((check) => check(id))
  }

  /** Runs `work` while holding the project (see `hold`). */
  async holdDuring<T>(id: string, work: () => Promise<T>): Promise<T> {
    const release = this.hold(id)
    try {
      return await work()
    } finally {
      release()
    }
  }

  /** Keeps the project mounted (and blocks rename/trash) until the returned release function is called. */
  hold(id: string): () => void {
    this.holds.set(id, (this.holds.get(id) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const n = (this.holds.get(id) ?? 1) - 1
      if (n > 0) this.holds.set(id, n)
      else this.holds.delete(id)
      this.idle(id)
    }
  }

  /** Called when work on a project finished: completes a deferred close. */
  idle(id: string) {
    if (!this.closeWhenIdle.has(id) || this.isBusy(id) || this.sessions.get(id)?.size) return
    const store = this.stores.get(id)
    if (store) this.unmount(store)
  }

  /** Records whether this machine left unfinished jobs in the project (so the next start mounts it again). */
  setActiveJobs(id: string, active: boolean) {
    this.deps.appState.patchRecent(id, { hasActiveJobs: active || undefined })
  }

  /** On start: reopen projects that had unfinished jobs here when the app last quit. */
  autoMount() {
    for (const recent of [...this.deps.appState.recents]) {
      if (!recent.hasActiveJobs || this.stores.has(recent.id)) continue
      try {
        this.open(recent.path)
      } catch (err) {
        console.warn(`[projects] could not reopen ${recent.path}:`, err instanceof Error ? err.message : err)
      }
    }
  }

  closeAll() {
    for (const store of [...this.stores.values()]) {
      try {
        store.close()
      } catch (err) {
        console.error(`[projects] closing ${store.root} failed:`, err)
      }
    }
    this.stores.clear()
    this.assetIndex.clear()
    this.generationIndex.clear()
  }

  // ------------------------------------------------------------------------------------------
  // Bundle operations
  // ------------------------------------------------------------------------------------------

  create(opts: { name: string; settings?: Partial<ProjectSettings>; dir?: string; kind?: ProjectKind }): ProjectStore {
    const parent = resolve(opts.dir ?? this.deps.appState.projectsDir)
    if (isInsideBundle(join(parent, 'x'))) {
      throw new ApiError(400, 'Projects cannot be created inside another project', { code: 'not-a-project' })
    }
    mkdirSync(parent, { recursive: true })
    const name = opts.name.trim() || 'Untitled Project'
    const root = uniqueBundlePath(parent, safeBundleBaseName(name))
    mkdirSync(root)
    for (const dir of [MEDIA_DIR, ASSETS_DIR, GENERATIONS_DIR]) mkdirSync(join(root, dir))
    const now = new Date().toISOString()
    const file: ProjectFile = {
      app: BUNDLE_APP,
      format: PROJECT_FORMAT,
      id: nanoid(10),
      name,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      ...(opts.kind ? { kind: opts.kind } : {}),
      summary: { durationFrames: 0 },
      doc: createEmptyDoc(opts.settings),
    }
    writeJsonSync(join(root, PROJECT_FILE), file)
    return this.open(root)
  }

  /** Renames the project and its folder. */
  rename(id: string, name: string): ProjectStore {
    const store = this.require(id)
    const clean = name.trim()
    if (!clean) throw new ApiError(400, 'Name cannot be empty')
    const base = safeBundleBaseName(clean)
    if (base !== basename(store.root, BUNDLE_EXT) || !store.root.endsWith(BUNDLE_EXT)) {
      // Never rename the folder of a project this store lost (another machine has it open now).
      store.ensureWritable()
      if (this.isBusy(id)) {
        throw new ApiError(409, 'Wait for running generations and exports of this project to finish before renaming it', { code: 'busy' })
      }
      const oldRoot = store.root
      const target = uniqueBundlePath(dirname(oldRoot), base, oldRoot)
      if (basename(target, BUNDLE_EXT) !== base) {
        // Like Finder: a taken name is refused (a " 2" folder would rename the project again on its next open).
        throw new ApiError(409, `A project named “${base}” already exists in ${dirname(oldRoot)}`, { code: 'exists' })
      }
      if (target !== oldRoot) {
        renameSync(oldRoot, target)
        store.moved(target)
        this.deps.appState.forgetRecent(oldRoot)
      }
    }
    store.setName(clean)
    this.touch(store, false)
    return store
  }

  /** Copies the bundle next to the original (APFS clones: instant, no extra space) with new ids. */
  async duplicate(id: string): Promise<DuplicateProjectResponse> {
    const store = this.require(id)
    store.flushSync()
    const source = store.root
    const parent = dirname(source)
    const name = `${store.name} copy`
    const target = uniqueBundlePath(parent, safeBundleBaseName(name))
    const staging = join(parent, `.${basename(target)}.partial-${nanoid(6)}`)
    try {
      await cp(source, staging, {
        recursive: true,
        mode: fsConstants.COPYFILE_FICLONE,
        filter: (src) => {
          const rel = src.slice(source.length + 1)
          return rel !== LOCK_FILE && rel !== CONFLICTS_DIR && !rel.startsWith(`${CONFLICTS_DIR}${sep}`) && !/\.tmp-[^/]*\.nosync$/.test(rel)
        },
      })
      const { projectId, map } = reidentifyBundle(staging, { name })
      renameSync(staging, target)
      this.deps.appState.touchRecent({ path: target, id: projectId, name })
      this.deps.events.publish({ type: 'projects.changed' })
      return { ...this.entryFor(target, this.deps.appState.recentByPath(target)), idMap: map }
    } catch (err) {
      rmSync(staging, { recursive: true, force: true })
      throw err
    }
  }

  /** Moves the bundle at `path` to the Trash — never one that another machine or app instance has open. */
  async trash(path: string): Promise<void> {
    const root = canonicalPath(path)
    let store = [...this.stores.values()].find((s) => s.root === root)
    if (existsSync(root)) assertProjectFolder(root)
    if (store?.suspended) {
      // Lost (e.g. another machine took it over): no longer ours — the lock below decides, as for a closed project.
      this.unmount(store)
      store = undefined
    }
    if (store) {
      if (this.isBusy(store.id)) {
        throw new ApiError(409, 'Wait for running generations and exports of this project to finish first', { code: 'busy' })
      }
    } else if (existsSync(root)) {
      const lock = inspectLock(root, LOCK_FILE, this.ctx.machineId)
      if (lock?.held && (lock.foreign || lock.owner.pid !== process.pid)) {
        const where = lock.foreign ? (lock.owner.host ?? 'another computer') : 'another Wildroom'
        throw new ApiError(409, `This project is open on ${where} — close it there first`, {
          code: 'locked',
          lockedBy: lockInfo(lock.owner, lock.foreign),
        })
      }
    }
    if (store) this.unmount(store)
    if (existsSync(root)) await moveToTrash(root)
    this.deps.appState.forgetRecent(root)
    this.deps.events.publish({ type: 'projects.changed' })
  }

  /**
   * Sets the tags of the project at `path` (in its project.json, so they go wherever the folder goes). A closed project
   * is written under its lock without being opened: tagging doesn't count as opening it (recents, "last opened") and
   * never runs its jobs. Refused for a project open on another computer, like any other write.
   */
  setTags(path: string, tags: unknown): string[] {
    const clean = normalizeTags(tags)
    const root = canonicalPath(path)
    const store = [...this.stores.values()].find((s) => s.root === root && !s.suspended)
    if (store) {
      store.setTags(clean)
    } else {
      if (!existsSync(root)) throw new ApiError(404, 'The project folder was not found', { code: 'missing', path: root })
      if (isInsideBundle(root)) throw new ApiError(400, 'Choose the project folder itself (the .wildroom folder)', { code: 'not-a-project' })
      // Only a project folder gets a lock file.
      this.readOrThrow(root)
      const lock = this.lock(root)
      try {
        // Read under the lock: no other app writes it between this read and the write below.
        const file = this.readOrThrow(root)
        const next: ProjectFile = { ...file, tags: clean }
        if (!clean.length) delete next.tags
        writeJsonSync(join(root, PROJECT_FILE), next, { root })
      } finally {
        lock.release()
      }
    }
    this.deps.events.publish({ type: 'projects.changed' })
    return clean
  }

  /** Removes the project from the recents list (the folder is untouched). */
  forget(path: string) {
    const root = canonicalPath(path)
    const store = [...this.stores.values()].find((s) => s.root === root)
    if (store && !this.isBusy(store.id) && !this.sessions.get(store.id)?.size) this.unmount(store)
    this.deps.appState.forgetRecent(root)
    this.deps.events.publish({ type: 'projects.changed' })
  }

  // ------------------------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------------------------

  private mount(store: ProjectStore) {
    this.stores.set(store.id, store)
    for (const id of store.assets.keys()) this.assetIndex.set(id, store)
    for (const id of store.generations.keys()) this.generationIndex.set(id, store)
    for (const hook of this.mountHooks) {
      try {
        hook(store)
      } catch (err) {
        console.error(`[projects] mount hook failed for ${store.root}:`, err)
      }
    }
  }

  private unmount(store: ProjectStore) {
    this.closeWhenIdle.delete(store.id)
    this.sessions.delete(store.id)
    store.close()
    if (this.stores.get(store.id) === store) this.stores.delete(store.id)
    for (const [id, owner] of this.assetIndex) if (owner === store) this.assetIndex.delete(id)
    for (const [id, owner] of this.generationIndex) if (owner === store) this.generationIndex.delete(id)
    this.deps.events.publish({ type: 'project.closed', projectId: store.id })
    this.deps.events.publish({ type: 'projects.changed' })
  }

  private touch(store: ProjectStore, reorder = true) {
    if (reorder || !this.deps.appState.recentById(store.id)) {
      this.deps.appState.touchRecent({ path: store.root, id: store.id, name: store.name })
    } else {
      this.deps.appState.patchRecent(store.id, { path: store.root, name: store.name })
    }
    this.deps.events.publish({ type: 'projects.changed' })
  }

  private lock(root: string, force?: boolean): Lock {
    try {
      return acquireLock(root, {
        file: LOCK_FILE,
        machineId: this.ctx.machineId,
        via: this.deps.via,
        force,
        describe: (owner, foreign) =>
          foreign
            ? `This project is open on ${owner.host ?? 'another computer'}${owner.startedAt ? ` (since ${owner.startedAt})` : ''}`
            : `This project is open in another Wildroom window or server (PID ${owner.pid})`,
      })
    } catch (err) {
      if (err instanceof LockedError) throw new ApiError(409, err.message, { code: 'locked', lockedBy: lockInfo(err.owner, err.foreign) })
      throw err
    }
  }

  private readOrThrow(root: string): ProjectFile {
    try {
      return readProjectFile(root).file
    } catch (err) {
      if (err instanceof ProjectFormatError) throw formatError(err)
      throw err
    }
  }
}

function formatError(err: ProjectFormatError): ApiError {
  const status = err.code === 'not-a-project' ? 400 : err.code === 'newer-format' ? 409 : 422
  return new ApiError(status, err.message, { code: err.code })
}

function lockInfo(owner: { host?: string; startedAt?: string }, foreign: boolean): ProjectLockInfo {
  return { host: owner.host, since: owner.startedAt || undefined, foreign }
}

/** The project's name: its folder's name, unless that is just the folder-safe spelling of the stored name. */
function displayName(root: string, stored: string): string {
  if (!root.endsWith(BUNDLE_EXT)) return stored
  const folder = basename(root, BUNDLE_EXT).normalize('NFC')
  return safeBundleBaseName(stored) === folder ? stored : folder
}

/** Absolute path with the on-disk spelling (case, Unicode normalization) when it exists. */
export function canonicalPath(path: string): string {
  const abs = resolve(path).replace(/\/+$/, '') || '/'
  try {
    return realpathSync.native(abs)
  } catch {
    return abs.normalize('NFC')
  }
}

/** Only project folders go to the Trash: a `.wildroom` bundle, or a folder whose project.json is one of ours. */
function assertProjectFolder(root: string) {
  if (root.endsWith(BUNDLE_EXT) && existsSync(join(root, PROJECT_FILE))) return
  let app: unknown
  try {
    app = readProjectFile(root).file.app
  } catch {
    app = undefined
  }
  if (app !== BUNDLE_APP) throw new ApiError(400, 'Not a Wildroom project folder', { code: 'not-a-project' })
}

/** True when `path` lies inside a project bundle (projects can't nest). */
function isInsideBundle(path: string): boolean {
  let dir = dirname(resolve(path))
  while (dir !== dirname(dir)) {
    if (dir.endsWith(BUNDLE_EXT) && existsSync(join(dir, PROJECT_FILE))) return true
    dir = dirname(dir)
  }
  return false
}

/** `<parent>/<base>.wildroom`, or `<base> 2.wildroom`… when taken (compared case-insensitively, like APFS does). */
export function uniqueBundlePath(parent: string, base: string, allow?: string): string {
  let taken: Set<string>
  try {
    taken = new Set(readdirSync(parent).map((n) => n.normalize('NFC').toLowerCase()))
  } catch {
    taken = new Set()
  }
  const allowed = allow ? basename(allow).normalize('NFC').toLowerCase() : undefined
  for (let n = 1; ; n++) {
    const name = `${n === 1 ? base : `${base} ${n}`}${BUNDLE_EXT}`
    const key = name.normalize('NFC').toLowerCase()
    if (!taken.has(key) || key === allowed) return join(parent, name)
  }
}

/** `*.wildroom` folders directly inside `dir`. */
function scanBundles(dir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.filter((n) => n.endsWith(BUNDLE_EXT) && !n.startsWith('.')).map((n) => canonicalPath(join(dir, n)))
}
