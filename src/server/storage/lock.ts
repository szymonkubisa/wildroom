import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

/**
 * Advisory owner locks: a small JSON file naming the process (and machine) that uses a folder.
 *
 * - The app data folder is locked by the running server: two servers would both run the job worker and could submit
 *   the same paid generation twice.
 * - Every open project bundle is locked by the server that mounted it. Bundles travel between Macs (copied by hand
 *   or synced), so the lock records a stable machine id: a lock from another machine can't be checked for liveness
 *   and is reported as "open on <host>" — the user may open the project anyway (force).
 *
 * A lock whose owner is gone on this machine (crash, kill -9, reboot) is stale and taken over.
 */

export interface LockOwner {
  pid: number
  /** When the owner took the lock (ISO). Used to tell a live owner from a recycled PID. */
  startedAt: string
  host?: string
  machineId?: string
  /** "desktop" when the server runs inside the Electron app, "server" otherwise. */
  via?: string
}

export class LockedError extends Error {
  constructor(
    readonly dir: string,
    readonly lockPath: string,
    readonly owner: LockOwner,
    /** Held by another machine (liveness unknown). */
    readonly foreign: boolean,
    message: string,
  ) {
    super(message)
    this.name = 'LockedError'
  }
}

export interface Lock {
  readonly file: string
  /** The locked folder (updated when the folder is renamed while locked). */
  dir: string
  /** True while the lock file on disk is still ours. */
  isHeld(): boolean
  /** Removes the lock file if it is still ours. Also runs automatically when the process exits. */
  release(): void
}

export interface AcquireOptions {
  file: string
  machineId: string
  via?: string
  /** Take the lock even when another live owner (or another machine) holds it. */
  force?: boolean
  /** Builds the error message for a held lock. */
  describe?: (owner: LockOwner, foreign: boolean, lockPath: string) => string
}

export function acquireLock(dir: string, opts: AcquireOptions): Lock {
  const owner: LockOwner = { pid: process.pid, startedAt: new Date().toISOString(), host: hostname(), machineId: opts.machineId, via: opts.via }
  const content = `${JSON.stringify(owner)}\n`

  for (let attempt = 0; attempt < 10; attempt++) {
    const lockPath = join(dir, opts.file)
    let fd: number
    try {
      fd = openSync(lockPath, 'wx', 0o644)
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err
      const raw = readLock(lockPath)
      if (raw === undefined) continue // released meanwhile
      const current = parseOwner(raw)
      if (!current && attempt < 3) {
        // Empty or partial: the owner may be between creating and writing the file.
        sleep(100)
        continue
      }
      if (current && !opts.force && !isOurs(current, opts.machineId)) {
        const foreign = isForeign(current, opts.machineId)
        if (foreign || isAlive(current)) {
          const message = opts.describe?.(current, foreign, lockPath) ?? `${dir} is in use (PID ${current.pid} on ${current.host ?? 'unknown host'})`
          throw new LockedError(dir, lockPath, current, foreign, message)
        }
      }
      // Stale, ours from an earlier mount, or forced: take it over, unless someone replaced it in the meantime.
      if (readLock(lockPath) === raw) removeLock(lockPath)
      continue
    }
    try {
      writeSync(fd, content)
    } finally {
      closeSync(fd)
    }
    let released = false
    const lock: Lock = {
      file: opts.file,
      dir,
      isHeld: () => !released && readLock(join(lock.dir, opts.file)) === content,
      release: () => {
        if (released) return
        released = true
        heldLocks.delete(lock)
        const path = join(lock.dir, opts.file)
        if (readLock(path) === content) removeLock(path)
      },
    }
    holdUntilExit(lock)
    return lock
  }
  throw new Error(`Could not acquire the lock ${join(dir, opts.file)}`)
}

/** Locks this process holds: released together by one exit hook (not one listener per lock). */
const heldLocks = new Set<Lock>()
let exitHookInstalled = false

function holdUntilExit(lock: Lock) {
  heldLocks.add(lock)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const held of [...heldLocks]) {
      try {
        held.release()
      } catch {
        // best effort while exiting
      }
    }
  })
}

/** The current owner of a lock and whether it blocks this process, without taking it. */
export function inspectLock(dir: string, file: string, machineId: string): { owner: LockOwner; foreign: boolean; held: boolean } | undefined {
  const raw = readLock(join(dir, file))
  const owner = raw === undefined ? undefined : parseOwner(raw)
  if (!owner) return undefined
  const foreign = isForeign(owner, machineId)
  if (foreign) return { owner, foreign, held: true }
  return { owner, foreign, held: owner.pid === process.pid || isAlive(owner) }
}

/** This very process (same machine, same pid) — e.g. a lock left by a project mounted earlier. */
function isOurs(owner: LockOwner, machineId: string): boolean {
  return owner.pid === process.pid && !isForeign(owner, machineId)
}

function isForeign(owner: LockOwner, machineId: string): boolean {
  if (owner.machineId) return owner.machineId !== machineId
  // Locks without a machine id (older versions): host names gain or lose ".local" with the network.
  const short = (host: string) => host.toLowerCase().split('.')[0]
  return !!owner.host && short(owner.host) !== short(hostname())
}

function isAlive(owner: LockOwner): boolean {
  try {
    process.kill(owner.pid, 0)
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return errorCode(err) === 'EPERM'
  }
  // The PID exists, but after a crash (and especially a reboot) it may belong to an unrelated process
  // that started after the lock was written.
  const lockedAt = Date.parse(owner.startedAt)
  const startedAt = processStartTime(owner.pid)
  if (Number.isFinite(lockedAt) && startedAt !== undefined && startedAt > lockedAt + 5_000) return false
  return true
}

/** Start time (ms since epoch) of a process via `ps -o etime=`, or undefined when unknown. */
function processStartTime(pid: number): number | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim()
    // [[dd-]hh:]mm:ss
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(out)
    if (!m) return undefined
    const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = m
    const elapsed = ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)
    return Date.now() - elapsed * 1000
  } catch {
    return undefined
  }
}

function parseOwner(raw: string): LockOwner | undefined {
  const text = raw.trim()
  // A bare PID (e.g. written by hand) is accepted too.
  if (/^\d+$/.test(text)) return Number(text) > 0 ? { pid: Number(text), startedAt: '' } : undefined
  try {
    const value = JSON.parse(text) as Partial<LockOwner> | null
    if (!value || typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0) return undefined
    return {
      pid: value.pid,
      startedAt: String(value.startedAt ?? ''),
      host: value.host,
      machineId: typeof value.machineId === 'string' ? value.machineId : undefined,
      via: value.via,
    }
  } catch {
    return undefined
  }
}

function readLock(lockPath: string): string | undefined {
  try {
    return readFileSync(lockPath, 'utf8')
  } catch (err) {
    if (errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR') return undefined
    throw err
  }
}

function removeLock(lockPath: string) {
  try {
    unlinkSync(lockPath)
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') throw err
  }
}

function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}
