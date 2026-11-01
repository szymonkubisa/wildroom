import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AssetVariant, FilmstripInfo } from '../../shared/types/assets'
import type { Env } from '../env'
import { readJsonFile, writeJsonSync } from './atomicFile'

/** Ingest results for one original (by content hash) on this machine. */
export interface DerivedState {
  status: 'processing' | 'ready' | 'error'
  error?: string
  variants: Partial<Record<AssetVariant, boolean>>
  filmstrip?: FilmstripInfo
  waveformRate?: number
  loudness?: { integratedLufs: number; truePeakDb: number } | null
  /** Ready, but later steps (filmstrip, waveform, loudness) haven't run yet: resume them on the next start. */
  pending?: boolean
  warnings?: string[]
}

const STATE_FILE = 'state.json'

/**
 * Machine-local ingest state, stored next to the derived files it describes:
 * `<derivedDir>/<sha[0:2]>/<sha256>/state.json`. Keyed by content, so every asset (in any project) whose original
 * has that hash shares it, and clearing the cache simply makes everything re-ingest.
 */
export class DerivedCache {
  private readonly memo = new Map<string, DerivedState | null>()

  constructor(private readonly env: Env) {}

  dir(sha: string): string {
    return join(this.env.derivedDir, sha.slice(0, 2), sha)
  }

  state(sha: string): DerivedState | undefined {
    let value = this.memo.get(sha)
    if (value === undefined) {
      try {
        value = readJsonFile<DerivedState>(join(this.dir(sha), STATE_FILE))?.value ?? null
      } catch {
        value = null
      }
      this.memo.set(sha, value)
    }
    return value ?? undefined
  }

  /** Merges `patch` into the state (undefined values remove keys) and writes it. */
  setState(sha: string, patch: Partial<DerivedState>): DerivedState {
    const next: DerivedState = { status: 'processing', variants: {}, ...this.state(sha) }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (next as unknown as Record<string, unknown>)[key]
      else (next as unknown as Record<string, unknown>)[key] = value
    }
    writeJsonSync(join(this.dir(sha), STATE_FILE), next)
    this.memo.set(sha, next)
    return next
  }

  /** Deletes every derived file. Assets re-ingest when next used. */
  async clear(): Promise<void> {
    this.memo.clear()
    const shards = await readdir(this.env.derivedDir).catch(() => [] as string[])
    await Promise.all(shards.map((s) => rm(join(this.env.derivedDir, s), { recursive: true, force: true })))
    this.memo.clear()
  }

  /** Total size of the derived files in bytes. */
  async sizeBytes(): Promise<number> {
    return dirSize(this.env.derivedDir)
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += await dirSize(path)
    else total += (await stat(path).catch(() => ({ size: 0 }))).size
  }
  return total
}
