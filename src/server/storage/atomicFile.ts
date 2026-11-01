import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { nanoid } from 'nanoid'

/**
 * Small synchronous file helpers for the JSON files of project bundles and app state.
 *
 * Every write goes to a temp file next to the target (named `.….nosync` so iCloud never uploads a partial file),
 * is fsync'd, then renamed over the target, and the directory is fsync'd: readers (and sync services) only ever see
 * a complete old or a complete new file. Writes are synchronous on purpose: the files are small, and it rules out
 * interleaved writes of the same file.
 */

export interface FileStamp {
  mtimeMs: number
  size: number
}

/** The bundle (or other root) a write targets is gone: moved, renamed or deleted behind our back. */
export class BundleGoneError extends Error {
  constructor(readonly root: string) {
    super(`The folder ${root} no longer exists`)
    this.name = 'BundleGoneError'
  }
}

export interface WriteOptions {
  /**
   * Directory that must already exist. Subfolders below it are created, it is never re-created itself. Nothing
   * outside it is ever written: file names inside a bundle come from the bundle (record ids, journals), and a bundle
   * is a folder anyone can hand you.
   */
  root?: string
}

export function writeFileAtomicSync(path: string, data: string | Uint8Array, opts: WriteOptions = {}): FileStamp {
  if (opts.root) {
    const rel = relative(opts.root, path)
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Refusing to write ${path}: it is outside ${opts.root}`)
    if (!existsSync(opts.root)) throw new BundleGoneError(opts.root)
  }
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${basename(path)}.tmp-${nanoid(6)}.nosync`)
  const fd = openSync(tmp, 'w', 0o644)
  let closed = false
  try {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    fsyncSync(fd)
    closeSync(fd)
    closed = true
    renameSync(tmp, path)
  } catch (err) {
    if (!closed) closeSync(fd)
    rmSync(tmp, { force: true })
    if (opts.root && !existsSync(opts.root)) throw new BundleGoneError(opts.root)
    throw err
  }
  syncDir(dir)
  return stampOf(path)!
}

export function writeJsonSync(path: string, value: unknown, opts: WriteOptions = {}): FileStamp {
  return writeFileAtomicSync(path, `${JSON.stringify(value, null, 2)}\n`, opts)
}

/** Parsed JSON with the file's stamp, or undefined when the file does not exist. Throws on invalid JSON. */
export function readJsonFile<T>(path: string): { value: T; stamp: FileStamp } | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  const stamp = stampOf(path) ?? { mtimeMs: 0, size: text.length }
  return { value: JSON.parse(text) as T, stamp }
}

export function stampOf(path: string): FileStamp | undefined {
  try {
    const s = statSync(path)
    return { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return undefined
  }
}

export function sameStamp(a: FileStamp | undefined, b: FileStamp | undefined): boolean {
  return !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size
}

/**
 * `<id>.json` record files of a folder. Skips hidden and temp files, AppleDouble (`._x`) files from non-Mac volumes,
 * iCloud placeholders (`.x.icloud`) and sync-conflict copies ("x (conflicted copy).json", "x 2.json").
 */
export function listRecordFiles(dir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.filter((n) => n.endsWith('.json') && !n.startsWith('.') && isRecordName(n.slice(0, -5)))
}

/** Record ids are nanoids: letters, digits, `_` and `-` only — anything else is a copy a sync service made. */
export function isRecordName(id: string): boolean {
  return /^[\w-]+$/.test(id)
}

/** Removes leftover `.…tmp-….nosync` files of interrupted writes. */
export function removeTempFiles(dir: string) {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) if (n.startsWith('.') && n.includes('.tmp-') && n.endsWith('.nosync')) rmSync(join(dir, n), { force: true })
}

function syncDir(dir: string) {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    // Not supported everywhere (e.g. some network volumes); the rename itself is still atomic.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
