import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { remapIds } from '../../shared/types/remapIds'
import { listRecordFiles, readJsonFile, writeJsonSync } from './atomicFile'
import { ProjectFormatError } from './projectStore'
import { ASSETS_DIR, GENERATIONS_DIR, type GenerationRecord, PROJECT_FILE, type ProjectFile, RECORD_ID_RE } from './records'

const JOURNAL = '.reidentify.json'
const UNFINISHED = new Set(['queued', 'submitting', 'running', 'downloading', 'ingesting'])

interface Journal {
  /**
   * old id → new id. `copy`: the project and every asset and generation of the bundle. `ids`: only some records
   * (ids that collide with another open project); the project keeps its id and its jobs.
   */
  map: Record<string, string>
  mode?: 'copy' | 'ids'
  name?: string
  at: string
}

/**
 * Gives a copied bundle its own identity: a new project id and new asset and generation ids, so the copy and the
 * original can be open at the same time (media URLs and job lookups use ids). Only exact string values and object
 * keys equal to one of the bundle's own ids are replaced, never substrings, and external ids (provider tasks,
 * voices) are untouched. Jobs that were unfinished in the original are canceled in the copy, so a copy never
 * submits or polls the same paid generation a second time.
 *
 * Crash-safe: the id map is journaled first; new record files are written next to the old ones; writing
 * project.json with the new id commits; old files and the journal are removed last. `replayReidentify` (run on
 * every open) finishes an interrupted run.
 */
export function reidentifyBundle(root: string, opts: { name?: string } = {}): { projectId: string; map: Record<string, string> } {
  const project = readJsonFile<ProjectFile>(join(root, PROJECT_FILE))?.value
  if (!project) throw new Error(`${root} has no project.json`)
  const map: Record<string, string> = { [project.id]: nanoid(10) }
  for (const id of recordIds(join(root, ASSETS_DIR))) map[id] = nanoid()
  for (const id of recordIds(join(root, GENERATIONS_DIR))) map[id] = nanoid(12)
  const journal: Journal = { map, mode: 'copy', name: opts.name, at: new Date().toISOString() }
  writeJsonSync(join(root, JOURNAL), journal, { root })
  apply(root, journal)
  return { projectId: map[project.id]!, map }
}

/**
 * Gives only the listed asset/generation ids of a bundle new values (references in every record and project.json
 * follow). For bundles that merely share some ids with another open project — e.g. migrated projects that shared
 * an asset in the old library — where a full copy treatment would wrongly change the project id and cancel its
 * jobs. Crash-safe like `reidentifyBundle` (same journal, replayed on open).
 */
export function reidentifyIds(root: string, ids: readonly string[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const id of ids) map[id] = nanoid()
  const journal: Journal = { map, mode: 'ids', at: new Date().toISOString() }
  writeJsonSync(join(root, JOURNAL), journal, { root })
  apply(root, journal)
  return map
}

/** Finishes a re-identification that was interrupted (no-op without a journal). */
export function replayReidentify(root: string) {
  let journal: Journal | undefined
  try {
    journal = readJsonFile<Journal>(join(root, JOURNAL))?.value
  } catch {
    journal = undefined
  }
  if (!journal?.map) {
    if (existsSync(join(root, JOURNAL))) rmSync(join(root, JOURNAL), { force: true })
    return
  }
  // The journal comes with the bundle, and its new ids become file names: a crafted one ({"a1": "../../x"}) must
  // never make opening a project write or delete files outside it.
  if (!isIdMap(journal.map)) {
    rmSync(join(root, JOURNAL), { force: true })
    throw new ProjectFormatError('unreadable', 'The project folder has a damaged re-identification journal')
  }
  apply(root, journal)
}

function isIdMap(map: unknown): map is Record<string, string> {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return false
  return Object.entries(map).every(([from, to]) => RECORD_ID_RE.test(from) && typeof to === 'string' && RECORD_ID_RE.test(to))
}

/** Ids of a folder's record files — only those the store loads (and the journal accepts). */
function recordIds(dir: string): string[] {
  return listRecordFiles(dir)
    .map((name) => name.slice(0, -5))
    .filter((id) => RECORD_ID_RE.test(id))
}

/** `map[id]`, never an inherited property ("constructor.json" is a valid record file name). */
function mapped(map: Record<string, string>, id: string): string | undefined {
  return Object.hasOwn(map, id) ? map[id] : undefined
}

function apply(root: string, journal: Journal) {
  if (journal.mode === 'ids') return applyIds(root, journal.map)
  const { map } = journal
  const newIds = new Set(Object.values(map))
  const project = readJsonFile<ProjectFile>(join(root, PROJECT_FILE))?.value
  if (!project) throw new Error(`${root} has no project.json`)
  const committed = newIds.has(project.id)

  if (!committed) {
    const now = new Date().toISOString()
    for (const name of listRecordFiles(join(root, ASSETS_DIR))) {
      const next = mapped(map, name.slice(0, -5))
      if (!next) continue
      const rec = readJsonFile<Record<string, unknown>>(join(root, ASSETS_DIR, name))?.value
      if (rec) writeJsonSync(join(root, ASSETS_DIR, `${next}.json`), remapJson(rec, map), { root })
    }
    for (const name of listRecordFiles(join(root, GENERATIONS_DIR))) {
      const next = mapped(map, name.slice(0, -5))
      if (!next) continue
      const rec = readJsonFile<GenerationRecord>(join(root, GENERATIONS_DIR, name))?.value
      if (!rec) continue
      let copy = remapJson(rec, map) as GenerationRecord
      if (UNFINISHED.has(copy.status)) {
        const submitted = copy.status !== 'queued'
        copy = {
          ...copy,
          status: 'canceled',
          finishedAt: now,
          updatedAt: now,
          error: {
            code: 'canceled',
            message: submitted
              ? 'Unfinished when the project was copied — it completes in the original project only.'
              : 'Queued when the project was copied — retry it here to run it.',
            retryable: true,
            maybeCharged: false,
          },
        }
      }
      writeJsonSync(join(root, GENERATIONS_DIR, `${next}.json`), copy, { root })
    }
    const nextProject = remapJson(project, map) as ProjectFile
    if (journal.name) nextProject.name = journal.name
    nextProject.createdAt = now
    nextProject.updatedAt = now
    nextProject.revision = 1
    delete nextProject.savedBy
    // Commit point.
    writeJsonSync(join(root, PROJECT_FILE), nextProject, { root })
  }

  for (const dir of [ASSETS_DIR, GENERATIONS_DIR]) {
    for (const name of listRecordFiles(join(root, dir))) {
      if (mapped(map, name.slice(0, -5))) rmSync(join(root, dir, name), { force: true })
    }
  }
  rmSync(join(root, JOURNAL), { force: true })
}

/** Idempotent: re-running it after a crash rewrites the same content, then removes what is left of the old ids. */
function applyIds(root: string, map: Record<string, string>) {
  for (const dir of [ASSETS_DIR, GENERATIONS_DIR]) {
    for (const name of listRecordFiles(join(root, dir))) {
      const id = name.slice(0, -5)
      const rec = readJsonFile<Record<string, unknown>>(join(root, dir, name))?.value
      if (!rec) continue
      const next = remapJson(rec, map)
      const nextId = mapped(map, id)
      if (nextId) writeJsonSync(join(root, dir, `${nextId}.json`), next, { root })
      else if (JSON.stringify(next) !== JSON.stringify(rec)) writeJsonSync(join(root, dir, name), next, { root })
    }
  }
  const project = readJsonFile<ProjectFile>(join(root, PROJECT_FILE))?.value
  if (!project) throw new Error(`${root} has no project.json`)
  const nextProject = remapJson(project, map)
  if (JSON.stringify(nextProject) !== JSON.stringify(project)) writeJsonSync(join(root, PROJECT_FILE), nextProject, { root })
  for (const dir of [ASSETS_DIR, GENERATIONS_DIR]) {
    for (const name of listRecordFiles(join(root, dir))) {
      if (mapped(map, name.slice(0, -5))) rmSync(join(root, dir, name), { force: true })
    }
  }
  rmSync(join(root, JOURNAL), { force: true })
}

export const remapJson = remapIds
