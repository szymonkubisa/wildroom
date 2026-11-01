import { execFile, spawn } from 'node:child_process'
import { existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'

/**
 * Finder operations of the local server (macOS). Inside the desktop app, Electron can do some of them better
 * (index.ts installs `desktopTrash` when running in the app's utility process).
 */

type TrashFn = (path: string) => Promise<void>
let desktopTrash: TrashFn | undefined

export function setDesktopTrash(fn: TrashFn | undefined) {
  desktopTrash = fn
}

/** Moves a file or folder to the Trash (recoverable). */
export async function moveToTrash(path: string): Promise<void> {
  if (desktopTrash) return desktopTrash(path)
  if (process.platform === 'darwin' && existsSync('/usr/bin/trash')) {
    await new Promise<void>((resolve, reject) =>
      execFile('/usr/bin/trash', [path], { timeout: 60_000 }, (err, _stdout, stderr) =>
        err ? reject(new Error(`Could not move to Trash: ${String(stderr || err.message).trim()}`)) : resolve(),
      ),
    )
    return
  }
  // Same-volume fallback: a plain rename into ~/.Trash.
  const ext = extname(path)
  const target = join(homedir(), '.Trash', `${basename(path, ext)} ${new Date().toISOString().replace(/[:.]/g, '-')}${ext}`)
  renameSync(path, target)
}

/** Selects the path in a Finder window. */
export function revealInFinder(path: string) {
  spawn('open', ['-R', path], { stdio: 'ignore', detached: true }).unref()
}

/**
 * Native "choose folder" dialog for the web version (the desktop app uses Electron's dialog instead).
 * Project bundles show as folders here, so a bundle can be picked directly. Resolves undefined when canceled.
 */
export function chooseFolder(opts: { prompt?: string; defaultPath?: string } = {}): Promise<string | undefined> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('The folder picker is only available on macOS'))
  const prompt = (opts.prompt ?? 'Choose a folder').replace(/["\\]/g, '')
  const location =
    opts.defaultPath && existsSync(opts.defaultPath) ? ` default location POSIX file "${opts.defaultPath.replace(/["\\]/g, '')}"` : ''
  const script = `POSIX path of (choose folder with prompt "${prompt}"${location} with showing package contents)`
  return new Promise((resolve, reject) =>
    execFile('osascript', ['-e', script], { timeout: 10 * 60_000 }, (err, stdout, stderr) => {
      if (err) {
        // -128: the user canceled.
        if (/-128/.test(String(stderr))) return resolve(undefined)
        return reject(new Error(String(stderr || err.message).trim()))
      }
      const path = stdout.trim().replace(/\/$/, '')
      resolve(path || undefined)
    }),
  )
}
