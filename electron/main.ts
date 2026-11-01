/**
 * Electron main process for the Wildroom desktop app.
 *
 * Production: runs the bundled API server (`server/index.mjs`) in a utilityProcess on a free local port
 * and loads the SPA that server serves. Dev (`pnpm electron:dev`): loads the Vite dev server; the API
 * server is the one `pnpm dev` runs, nothing runs inside Electron.
 */
import { createWriteStream, mkdirSync, readFileSync, renameSync, writeFileSync, type WriteStream } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeTheme,
  type OpenDialogOptions,
  type Rectangle,
  screen,
  session,
  shell,
  utilityProcess,
  type UtilityProcess,
} from 'electron'

/** Replaced at build time: true in the `electron:dev` bundle. */
declare const __STUDIO_DEV__: boolean

/** Also the on-disk name: userData, logs and the server's app-data folder all live under it. */
const APP_NAME = 'Wildroom'
const IS_DEV = __STUDIO_DEV__
const DEV_URL = process.env.STUDIO_DEV_URL || 'http://127.0.0.1:5180'
const PREFERRED_PORT = 7777
const SERVER_START_TIMEOUT_MS = 60_000
/** The app's `--background` per theme, so the window never flashes the wrong colour. */
const BACKGROUND = { dark: '#0d0d0f', light: '#e3e3e5' }
const DEFAULT_SIZE = { width: 1440, height: 900 }
const MIN_SIZE = { width: 1100, height: 700 }

let appUrl = '' // e.g. http://127.0.0.1:7777
let mainWindow: BrowserWindow | null = null
let server: StudioServer | null = null
let quitting = false

// Launched from a terminal that went away: never crash on EPIPE when mirroring server output.
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})

// localStorage, window state and the theme live in userData.
// STUDIO_HOME (which the server also honours) moves them, and the logs, under that folder: a scratch install
// then touches nothing of the real library and runs beside the real app (the single-instance lock is per userData).
const studioHome = process.env.STUDIO_HOME ? resolve(process.env.STUDIO_HOME) : undefined
app.setPath('userData', studioHome ? join(studioHome, 'Desktop') : join(app.getPath('appData'), IS_DEV ? `${APP_NAME} Dev` : APP_NAME))
app.setAppLogsPath(studioHome ? join(studioHome, 'Logs') : join(app.getPath('home'), 'Library', 'Logs', APP_NAME))

/**
 * Project bundles macOS asks us to open (double-click in Finder, Open Recent, a drop on the Dock icon). This can
 * happen before the app is ready, so paths wait here until the page asks for them (`takePendingOpens`).
 */
const pendingOpens: string[] = []
let rendererReady = false
app.on('open-file', (event, path) => {
  event.preventDefault()
  deliverOpen(path)
})

function deliverOpen(path: string) {
  const win = mainWindow
  if (win && !win.isDestroyed() && rendererReady) {
    showMainWindow()
    win.webContents.send('studio:open-path', path)
    return
  }
  pendingOpens.push(path)
  if (appUrl && !mainWindow) createWindow()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())
  app.on('window-all-closed', () => {
    // macOS: stay in the Dock (and keep the server and its jobs running) until the user quits.
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (appUrl && !mainWindow) createWindow()
  })
  let gpuAsked = false
  app.on('before-quit', (event) => {
    quitting = true
    if (!server || server.exited) return
    event.preventDefault()
    // A rented GPU bills while on: ask before leaving it running.
    if (!gpuAsked) {
      gpuAsked = true
      void confirmGpuOnQuit().then((proceed) => {
        if (proceed) app.quit()
        else quitting = gpuAsked = false
      })
      return
    }
    // Let the server finish its shutdown (closes the database, releases the library lock) first.
    for (const win of BrowserWindow.getAllWindows()) win.hide()
    void server.stop().finally(() => app.quit())
  })
  void app.whenReady().then(start)
}

/** Quitting with the RunPod GPU on: stop it, leave it (its watchdog stops it ~10 min later) or stay. */
async function confirmGpuOnQuit(): Promise<boolean> {
  let session: { state?: string; gpu?: { name?: string }; costPerHrUsd?: number } | undefined
  try {
    session = (await (await fetch(`${appUrl}/api/gpu/session`, { signal: AbortSignal.timeout(2000) })).json()) as typeof session
  } catch {
    return true
  }
  if (!session?.state || !['creating', 'booting', 'ready', 'stopping'].includes(session.state)) return true
  const price = session.costPerHrUsd ? ` ($${session.costPerHrUsd.toFixed(2)}/h)` : ''
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Stop the GPU and Quit', 'Quit, Leave It On', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: `The RunPod GPU${session.gpu?.name ? ` (${session.gpu.name})` : ''} is still on${price}`,
    detail: 'It bills while on. Left on, it finishes what is rendering and stops by itself about 10 minutes after the app is gone.',
  })
  if (response === 2) return false
  if (response === 0) {
    try {
      await fetch(`${appUrl}/api/gpu/session/stop`, { method: 'POST', headers: { origin: appUrl, 'x-studio': '1' }, signal: AbortSignal.timeout(15_000) })
    } catch {
      // The pod's watchdog still stops it.
    }
  }
  return true
}

async function start() {
  nativeTheme.themeSource = loadTheme()
  installSessionHandlers()
  installIpc()
  Menu.setApplicationMenu(buildMenu())
  if (IS_DEV) {
    appUrl = new URL(DEV_URL).origin
  } else {
    try {
      server = await StudioServer.start()
      appUrl = `http://127.0.0.1:${server.port}`
      server.onUnexpectedExit = onServerCrash
    } catch (err) {
      await showStartupError(err)
      app.exit(1)
      return
    }
  }
  createWindow()
}

// ---------------------------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------------------------

function createWindow(initialPath = '/'): BrowserWindow {
  const state = loadWindowState()
  const win = new BrowserWindow({
    ...state.bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: APP_NAME,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Playback and WebCodecs exports run in the page; keep them at full speed when the window is hidden.
      backgroundThrottling: false,
    },
  })
  mainWindow = win
  if (state.maximized) win.maximize()
  trackWindowState(win)

  win.once('ready-to-show', () => win.show())
  // Never leave the user staring at nothing if the first paint is slow.
  setTimeout(() => {
    if (!quitting && !win.isDestroyed() && !win.isVisible()) win.show()
  }, 5000)
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  const contents = win.webContents
  // A (re)load: the page asks for pending opens again once it is listening.
  contents.on('did-start-loading', () => (rendererReady = false))
  // Links meant for a new window (target=_blank, e.g. "Get key") open in the default browser.
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  // The window only ever shows the app; anything else goes to the browser (http/https/mailto) or nowhere.
  contents.on('will-navigate', (event) => {
    if (isAppUrl(event.url)) return
    event.preventDefault()
    openExternal(event.url)
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.on('dom-ready', () => {
    void contents.insertCSS(TITLE_BAR_CSS)
    setFullScreenClass(win)
  })
  win.on('enter-full-screen', () => setFullScreenClass(win))
  win.on('leave-full-screen', () => setFullScreenClass(win))
  if (IS_DEV) {
    // The dev server may still be starting (or restarting): keep trying.
    contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      // -3 = ERR_ABORTED: superseded by another navigation, not a failure.
      if (isMainFrame && code !== -3) setTimeout(() => !win.isDestroyed() && void win.loadURL(url), 1000)
    })
  }

  void win.loadURL(new URL(initialPath, appUrl).toString())
  return win
}

function showMainWindow() {
  if (!mainWindow) {
    if (appUrl) createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * With `hiddenInset` the page draws under the title bar: each page's top bar becomes the window's drag
 * area and leaves room for the traffic lights (not needed in full screen, where they are hidden).
 * Its controls, and dialogs / menus / popovers (teleported out of #app) that overlap it, stay clickable.
 */
const TITLE_BAR_CSS = `
#app > * > header:first-child { -webkit-app-region: drag; }
html:not(.studio-fullscreen) #app > * > header:first-child { padding-left: 84px; }
#app > * > header:first-child :is(button, a, input, textarea, select, label, [role], [contenteditable], [tabindex]),
:is([data-slot$="-overlay"], [data-slot$="-content"], [role="dialog"], [role="menu"], [role="listbox"]):not(#app *) {
  -webkit-app-region: no-drag;
}
`

function setFullScreenClass(win: BrowserWindow) {
  if (win.isDestroyed()) return
  const js = `document.documentElement.classList.toggle('studio-fullscreen', ${win.isFullScreen()})`
  void win.webContents.executeJavaScript(js).catch(() => {})
}

function isAppUrl(url: string): boolean {
  try {
    return new URL(url).origin === appUrl
  } catch {
    return false
  }
}

function isLoopbackUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    return protocol === 'http:' && (hostname === '127.0.0.1' || hostname === 'localhost')
  } catch {
    return false
  }
}

function openExternal(url: string) {
  try {
    const { protocol } = new URL(url)
    if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') void shell.openExternal(url)
  } catch {
    // not a URL: ignore
  }
}

// ---------------------------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------------------------

type Theme = 'dark' | 'light' | 'system'
const THEMES: readonly Theme[] = ['dark', 'light', 'system']

/**
 * The page owns the setting; the shell remembers the last one it was told so the next launch opens with the right
 * window colour, and follows it with `nativeTheme` so menus, dialogs and `prefers-color-scheme` match.
 */
function themeFile() {
  return join(app.getPath('userData'), 'appearance.json')
}

function loadTheme(): Theme {
  try {
    const { theme } = JSON.parse(readFileSync(themeFile(), 'utf8')) as { theme?: Theme }
    return theme && THEMES.includes(theme) ? theme : 'dark'
  } catch {
    return 'dark'
  }
}

function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light
}

function setTheme(theme: Theme) {
  if (nativeTheme.themeSource === theme) return
  nativeTheme.themeSource = theme
  for (const win of BrowserWindow.getAllWindows()) win.setBackgroundColor(windowBackground())
  try {
    mkdirSync(dirname(themeFile()), { recursive: true })
    writeFileSync(themeFile(), JSON.stringify({ theme }))
  } catch (err) {
    console.error('[desktop] could not save the theme', err)
  }
}

// ---------------------------------------------------------------------------------------------
// Window size / position
// ---------------------------------------------------------------------------------------------

interface WindowState {
  bounds: Partial<Rectangle> & { width: number; height: number }
  maximized: boolean
}

function windowStateFile() {
  return join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState(): WindowState {
  const fallback: WindowState = { bounds: { ...DEFAULT_SIZE }, maximized: false }
  let saved: Partial<Rectangle & { maximized: boolean }> | null
  try {
    saved = JSON.parse(readFileSync(windowStateFile(), 'utf8')) as typeof saved
  } catch {
    return fallback
  }
  if (!saved || typeof saved !== 'object') return fallback
  const { x, y, width, height } = saved
  if (!Number.isFinite(width) || !Number.isFinite(height)) return fallback
  const bounds = { x: Number(x), y: Number(y), width: Number(width), height: Number(height) }
  // Only reuse the position if the window would still be on a connected display (monitors change).
  const display = screen.getAllDisplays().find((d) => overlapArea(d.workArea, bounds) >= 100 * 100)
  const area = (display ?? screen.getPrimaryDisplay()).workArea
  const size = {
    width: Math.round(Math.max(MIN_SIZE.width, Math.min(bounds.width, area.width))),
    height: Math.round(Math.max(MIN_SIZE.height, Math.min(bounds.height, area.height))),
  }
  return {
    bounds: display && Number.isFinite(bounds.x) && Number.isFinite(bounds.y) ? { x: Math.round(bounds.x), y: Math.round(bounds.y), ...size } : size,
    maximized: saved.maximized === true,
  }
}

function overlapArea(a: Rectangle, b: Rectangle): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

function trackWindowState(win: BrowserWindow) {
  let timer: NodeJS.Timeout | undefined
  const save = () => {
    clearTimeout(timer)
    if (win.isDestroyed()) return
    try {
      const file = windowStateFile()
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }))
    } catch (err) {
      console.error('[desktop] could not save the window state', err)
    }
  }
  const saveSoon = () => {
    clearTimeout(timer)
    timer = setTimeout(save, 500)
  }
  win.on('resize', saveSoon)
  win.on('move', saveSoon)
  win.on('maximize', saveSoon)
  win.on('unmaximize', saveSoon)
  win.on('close', save)
}

// ---------------------------------------------------------------------------------------------
// Session: permissions, downloads
// ---------------------------------------------------------------------------------------------

function installSessionHandlers() {
  const ses = session.defaultSession
  // Only the app itself may ask for permissions (clipboard, full screen, …). ComfyUI in its window (the server's local
  // proxy, on its own loopback port) may also copy to the clipboard.
  ses.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(isAppUrl(details.requestingUrl) || (permission === 'clipboard-sanitized-write' && isLoopbackUrl(details.requestingUrl))),
  )
  // `<a download>` exports (.srt, .fcpxml): ask where to save, starting in ~/Downloads.
  ses.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), item.getFilename()) })
  })
}

// ---------------------------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------------------------

function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        // The page opens Settings as a sheet over what is open (an open project stays open).
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendMenuCommand('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Project…', accelerator: 'CmdOrCtrl+N', click: () => sendMenuCommand('new-project') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => sendMenuCommand('open-project') },
        { role: 'recentDocuments', submenu: [{ role: 'clearRecentDocuments' }] },
        { type: 'separator' },
        { label: 'Show Project in Finder', click: () => sendMenuCommand('reveal-project') },
        { label: 'Close Project', accelerator: 'CmdOrCtrl+Shift+W', click: () => sendMenuCommand('close-project') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      // Undo/Redo show ⌘Z / ⇧⌘Z without taking them (registerAccelerator: false): the keys reach the page, where the
      // project's own undo has them (text fields get native undo — see preload.ts). Clicked, the page decides which.
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: () => sendMenuCommand('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', registerAccelerator: false, click: () => sendMenuCommand('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Open Projects Folder', click: () => void openAppFolder('projectsDir') },
        { label: 'Open Cache Folder', click: () => void openAppFolder('cacheDir') },
        ...(IS_DEV ? [] : [{ label: 'Show Server Log', click: () => shell.showItemInFolder(serverLogPath()) }]),
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}

async function openAppFolder(which: 'projectsDir' | 'cacheDir') {
  const health = appUrl ? await getHealth(appUrl) : null
  const path = health?.[which]
  if (path) void shell.openPath(path)
}

type MenuCommand = 'new-project' | 'open-project' | 'close-project' | 'reveal-project' | 'undo' | 'redo' | 'settings'

/** File- and Edit-menu commands are handled by the page (it knows the open project and shows the dialogs). */
function sendMenuCommand(command: MenuCommand) {
  const win = mainWindow
  if (!win || win.isDestroyed()) {
    // Nothing to undo without a window.
    if (appUrl && command !== 'undo' && command !== 'redo') createWindow(command === 'new-project' ? '/?new=1' : command === 'settings' ? '/settings' : '/')
    return
  }
  showMainWindow()
  win.webContents.send('studio:menu', command)
}

// ---------------------------------------------------------------------------------------------
// IPC (preload.ts): native dialogs and Finder integration for project bundles
// ---------------------------------------------------------------------------------------------

function installIpc() {
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) => isAppUrl(event.senderFrame?.url ?? '')
  const showOpen = (event: IpcMainInvokeEvent, options: OpenDialogOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
  }
  ipcMain.handle('studio:choose-project', async (event, opts?: { defaultPath?: string }) => {
    if (!trusted(event)) return null
    const result = await showOpen(event, {
      title: 'Open Project',
      buttonLabel: 'Open',
      defaultPath: typeof opts?.defaultPath === 'string' ? opts.defaultPath : undefined,
      // A bundle is a single "file" once the app's document type is registered, a folder otherwise.
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Wildroom Projects', extensions: ['wildroom'] }],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('studio:choose-folder', async (event, opts?: { title?: string; defaultPath?: string }) => {
    if (!trusted(event)) return null
    const result = await showOpen(event, {
      title: typeof opts?.title === 'string' ? opts.title : 'Choose a Folder',
      buttonLabel: 'Choose',
      defaultPath: typeof opts?.defaultPath === 'string' ? opts.defaultPath : undefined,
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('studio:take-pending-opens', (event) => {
    if (!trusted(event)) return []
    rendererReady = true
    return pendingOpens.splice(0)
  })
  ipcMain.on('studio:add-recent', (event, path: unknown) => {
    if (trusted(event) && typeof path === 'string' && path.endsWith('.wildroom')) app.addRecentDocument(path)
  })
  ipcMain.on('studio:set-theme', (event, theme: unknown) => {
    if (trusted(event) && THEMES.includes(theme as Theme)) setTheme(theme as Theme)
  })
}

// ---------------------------------------------------------------------------------------------
// Local API server (production)
// ---------------------------------------------------------------------------------------------

class ServerStartError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message)
  }
}

class StudioServer {
  exited = false
  onUnexpectedExit?: (code: number, output: string) => void
  private readonly exitPromise: Promise<number>

  private constructor(
    readonly port: number,
    private readonly proc: UtilityProcess,
    private readonly output: OutputTail,
  ) {
    this.exitPromise = new Promise((resolve) => {
      proc.once('exit', (code) => {
        this.exited = true
        output.end()
        if (!quitting) this.onUnexpectedExit?.(code, output.text())
        resolve(code)
      })
    })
  }

  /** Forks the bundled server and resolves once `GET /api/health` answers. */
  static async start(): Promise<StudioServer> {
    const port = await pickPort(PREFERRED_PORT)
    const appPath = app.getAppPath()
    const output = new OutputTail(serverLogPath())
    const proc = utilityProcess.fork(join(appPath, 'server', 'index.mjs'), [], {
      serviceName: `${APP_NAME} Server`,
      stdio: 'pipe',
      execArgv: ['--enable-source-maps'],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        STUDIO_PORT: String(port),
        STUDIO_CLIENT_DIST: join(appPath, 'client'),
        // Settings → Integrations: Claude Desktop starts the MCP bridge with this app's Electron run as Node (the
        // bridge is unpacked from the asar, so any Node can read it).
        STUDIO_MCP_BRIDGE: join(appPath.replace(/\.asar$/, '.asar.unpacked'), 'server', 'studio-mcp.mjs'),
        STUDIO_MCP_NODE: process.execPath,
      },
    })
    proc.stdout?.on('data', (chunk: Buffer) => output.write(chunk, process.stdout))
    proc.stderr?.on('data', (chunk: Buffer) => output.write(chunk, process.stderr))
    // "Move to Trash" of a project: Electron's trashItem (recoverable, Finder's own Trash).
    proc.on('message', (message: { type?: string; id?: string; path?: string } | null) => {
      if (message?.type !== 'trash' || !message.id) return
      const reply = (error?: string) => proc.postMessage({ type: 'trash-result', id: message.id, error })
      if (typeof message.path !== 'string' || !message.path.endsWith('.wildroom')) return reply('Only project folders can be moved to the Trash')
      shell.trashItem(message.path).then(
        () => reply(),
        (err: unknown) => reply(err instanceof Error ? err.message : String(err)),
      )
    })
    const instance = new StudioServer(port, proc, output)
    await instance.waitUntilReady()
    return instance
  }

  private waitUntilReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      let reported: string | undefined
      let settled = false
      const finish = (err?: Error) => {
        if (settled) return
        settled = true
        clearInterval(poll)
        clearTimeout(timeout)
        this.proc.off('message', onMessage)
        if (err) reject(err)
        else resolve()
      }
      const check = async () => {
        if (!settled && (await getHealth(`http://127.0.0.1:${this.port}`))) finish()
      }
      const onMessage = (message: { type?: string; message?: string } | null) => {
        if (message?.type === 'ready') void check()
        else if (message?.type === 'error') reported = message.message
      }
      this.proc.on('message', onMessage)
      void this.exitPromise.then((code) => finish(new ServerStartError(reported ?? `The server exited with code ${code}.`, this.output.text())))
      const poll = setInterval(() => void check(), 250)
      const timeout = setTimeout(() => {
        finish(new ServerStartError(`The server did not answer within ${SERVER_START_TIMEOUT_MS / 1000} s.`, this.output.text()))
        this.proc.kill()
      }, SERVER_START_TIMEOUT_MS)
    })
  }

  /** Asks the server to shut down cleanly; terminates it if it takes too long. */
  async stop(): Promise<void> {
    if (this.exited) return
    const timers = [
      setTimeout(() => this.proc.kill(), 5000), // SIGTERM
      setTimeout(() => {
        if (this.proc.pid) process.kill(this.proc.pid, 'SIGKILL')
      }, 8000),
    ]
    this.proc.postMessage({ type: 'shutdown' })
    await this.exitPromise
    for (const timer of timers) clearTimeout(timer)
  }
}

async function onServerCrash(code: number, output: string) {
  console.error(`[desktop] server exited unexpectedly with code ${code}`)
  const { response } = await dialog.showMessageBox({
    type: 'error',
    message: `The ${APP_NAME} server stopped unexpectedly`,
    detail: `Exit code ${code}.\n\n${lastLines(output, 15)}\n\nLog: ${serverLogPath()}`,
    buttons: ['Relaunch', 'Quit'],
    defaultId: 0,
  })
  if (response === 0) app.relaunch()
  app.exit(response === 0 ? 0 : 1)
}

async function showStartupError(err: unknown) {
  const reason = err instanceof Error ? err.message : String(err)
  const output = err instanceof ServerStartError ? lastLines(err.output, 15) : ''
  console.error(`[desktop] ${APP_NAME} could not start: ${reason}`)
  await dialog.showMessageBox({
    type: 'error',
    message: `${APP_NAME} could not start`,
    detail: [reason, output && `Server output:\n${output}`, `Log: ${serverLogPath()}`].filter(Boolean).join('\n\n'),
    buttons: ['Quit'],
  })
}

/** 7777 like the web version when it is free, otherwise any free port. */
async function pickPort(preferred: number): Promise<number> {
  const tryListen = (port: number) =>
    new Promise<number | null>((resolve) => {
      const probe = createServer()
      probe.once('error', () => resolve(null))
      probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
        const address = probe.address()
        const actual = typeof address === 'object' && address ? address.port : null
        probe.close(() => resolve(actual))
      })
    })
  return (await tryListen(preferred)) ?? (await tryListen(0)) ?? preferred
}

function getHealth(origin: string): Promise<{ ok: boolean; projectsDir?: string; cacheDir?: string } | null> {
  return new Promise((resolve) => {
    const req = request(new URL('/api/health', origin), { timeout: 2000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => {
        try {
          const json = JSON.parse(body) as { ok?: boolean; projectsDir?: string; cacheDir?: string }
          resolve(res.statusCode === 200 && json.ok ? { ok: true, projectsDir: json.projectsDir, cacheDir: json.cacheDir } : null)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    req.end()
  })
}

function serverLogPath() {
  return join(app.getPath('logs'), 'server.log')
}

/** Server stdout/stderr: mirrored to our own stdio and a log file, with the tail kept for error dialogs. */
class OutputTail {
  private tail = ''
  private log: WriteStream | undefined

  constructor(logFile: string) {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      try {
        renameSync(logFile, logFile.replace(/\.log$/, '.previous.log'))
      } catch {
        // first run
      }
      this.log = createWriteStream(logFile)
      this.log.on('error', () => (this.log = undefined))
    } catch {
      this.log = undefined
    }
  }

  write(chunk: Buffer, mirror: NodeJS.WriteStream) {
    mirror.write(chunk)
    this.log?.write(chunk)
    this.tail = (this.tail + chunk.toString('utf8')).slice(-16 * 1024)
  }

  text() {
    return this.tail
  }

  end() {
    this.log?.end()
  }
}

function lastLines(text: string, count: number): string {
  return text.trimEnd().split('\n').slice(-count).join('\n')
}
