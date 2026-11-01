import { api } from './api'

/** What the desktop app's preload exposes (absent in the browser). */
export interface StudioDesktop {
  isDesktop: true
  platform: string
  /** Native "Open project" dialog (project bundles show as single files on macOS). Null when canceled. */
  chooseProject?: (opts?: { defaultPath?: string }) => Promise<string | null>
  /** Native folder picker. Null when canceled. */
  chooseFolder?: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  /** Project bundles opened from Finder (double-click, Open Recent, drag onto the Dock icon). */
  onOpenPath?: (handler: (path: string) => void) => () => void
  /** Paths the app was asked to open before the page was ready. */
  takePendingOpens?: () => Promise<string[]>
  /** App-menu commands (File → Open Project…, Close Project…, Edit → Undo / Redo). */
  onMenuCommand?: (handler: (command: DesktopMenuCommand) => void) => () => void
  /** The file-system path of a dropped file or folder. */
  pathForFile?: (file: File) => string
  /** Adds the project to macOS's Open Recent menu. */
  addRecentDocument?: (path: string) => void
  /** Matches the native window chrome (menus, dialogs, window background) to the app's theme. */
  setTheme?: (theme: 'dark' | 'light' | 'system') => void
}

export type DesktopMenuCommand = 'open-project' | 'new-project' | 'close-project' | 'reveal-project' | 'undo' | 'redo' | 'settings'

declare global {
  interface Window {
    studioDesktop?: StudioDesktop
  }
}

export const desktop: StudioDesktop | undefined = typeof window === 'undefined' ? undefined : window.studioDesktop

/** Lets the user pick a project bundle (desktop dialog, or the local server's macOS picker in the browser). */
export async function chooseProjectPath(defaultPath?: string): Promise<string | null> {
  if (desktop?.chooseProject) return desktop.chooseProject({ defaultPath })
  return (await api.system.chooseFolder('Choose a project (a folder ending in .wildroom)', defaultPath)).path
}

export async function chooseFolderPath(title: string, defaultPath?: string): Promise<string | null> {
  if (desktop?.chooseFolder) return desktop.chooseFolder({ title, defaultPath })
  return (await api.system.chooseFolder(title, defaultPath)).path
}

/** Path of a file or folder dropped on the page — only known inside the desktop app. */
export function droppedPath(file: File): string | undefined {
  try {
    return desktop?.pathForFile?.(file) || undefined
  } catch {
    return undefined
  }
}
