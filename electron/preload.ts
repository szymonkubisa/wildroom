/**
 * Preload for the app window (sandboxed, context-isolated). The web app runs unchanged in the desktop
 * shell; this exposes a small, typed bridge (see src/client/lib/desktop.ts) for what a page can't do itself —
 * native Open dialogs, Finder's "open this project", dropped-file paths, Open Recent — and fills one gap left
 * by the app menu.
 */
import { contextBridge, type IpcRendererEvent, ipcRenderer, webUtils } from 'electron'

function subscribe<T>(channel: string, handler: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T) => handler(value)
  ipcRenderer.on(channel, listener)
  return () => void ipcRenderer.off(channel, listener)
}

contextBridge.exposeInMainWorld(
  'studioDesktop',
  Object.freeze({
    isDesktop: true,
    platform: process.platform,
    chooseProject: (opts?: { defaultPath?: string }) => ipcRenderer.invoke('studio:choose-project', opts ?? {}),
    chooseFolder: (opts?: { title?: string; defaultPath?: string }) => ipcRenderer.invoke('studio:choose-folder', opts ?? {}),
    takePendingOpens: () => ipcRenderer.invoke('studio:take-pending-opens'),
    onOpenPath: (handler: (path: string) => void) => subscribe('studio:open-path', handler),
    onMenuCommand: (handler: (command: string) => void) => subscribe('studio:menu', handler),
    pathForFile: (file: File) => webUtils.getPathForFile(file),
    addRecentDocument: (path: string) => ipcRenderer.send('studio:add-recent', path),
    setTheme: (theme: string) => ipcRenderer.send('studio:set-theme', theme),
  }),
)

/**
 * Undo / redo inside text fields. The Edit menu's Undo/Redo don't register ⌘Z / ⇧⌘Z (they would compete with
 * the timeline's own undo), so on macOS nothing would undo typing. Only text fields are handled here; everywhere
 * else the keystroke reaches the web app as before.
 */
window.addEventListener('keydown', (event) => {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
  if (event.key.toLowerCase() !== 'z' || !isTextField(event.target)) return
  event.preventDefault()
  document.execCommand(event.shiftKey ? 'redo' : 'undo')
})

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number'])

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement) return !target.readOnly && !target.disabled
  if (target instanceof HTMLInputElement) return !target.readOnly && !target.disabled && TEXT_INPUT_TYPES.has(target.type)
  return false
}
