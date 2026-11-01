import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Runtime configuration.
 *
 * Projects are self-contained bundles (`<name>.wildroom` folders) that can live anywhere; `projectsDir` is only
 * where new ones go by default. Everything machine-local lives outside the bundles: app state (settings, recent
 * projects, the instance lock), regenerable caches (proxies, posters, waveforms…), scratch files and model weights.
 *
 * STUDIO_HOME puts all of it under one folder (tests use a temp dir): `<home>/{AppData,Cache,Projects}`.
 * STUDIO_PROJECTS_DIR, STUDIO_CACHE_DIR and STUDIO_MODELS_DIR override single locations.
 */
export interface Env {
  host: string
  port: number
  isProd: boolean
  /** app.json (settings, recents), machine.json, the instance lock, project backups. */
  appDataDir: string
  /** Root of everything regenerable. */
  cacheDir: string
  /** Derived media keyed by content hash: `<derivedDir>/<sha[0:2]>/<sha256>/<step>-v<N>.<ext>`. */
  derivedDir: string
  /** Scratch files (uploads, job outputs, exports in progress). */
  tmpDir: string
  /** Default location of new project bundles (Settings can change it; see AppState). */
  projectsDir: string
  /** Local model runtimes and weights (e.g. LTX-2.5 for MLX), installed by scripts/install-local-ltx.sh. */
  modelsDir: string
  clientDist: string
  /** Browser origins allowed to call the API (dev server + the server itself). */
  allowedOrigins: string[]
  allowedHosts: string[]
}

export const APP_DIR_NAME = 'Wildroom'

export function loadEnv(overrides: { home?: string; port?: number } = {}): Env {
  const host = '127.0.0.1'
  const port = overrides.port ?? Number(process.env.STUDIO_PORT ?? 7777)
  // The dev web server (vite) in front of it: 5180, or a sandbox's STUDIO_WEB_PORT.
  const webPort = Number(process.env.STUDIO_WEB_PORT ?? 5180)
  const homeOverride = overrides.home ?? process.env.STUDIO_HOME
  const home = homeOverride ? resolve(homeOverride) : undefined
  const fromEnv = (name: string) => (process.env[name] ? resolve(process.env[name]!) : undefined)

  const appDataDir = home ? join(home, 'AppData') : join(homedir(), 'Library', 'Application Support', APP_DIR_NAME)
  const cacheDir = fromEnv('STUDIO_CACHE_DIR') ?? (home ? join(home, 'Cache') : join(homedir(), 'Library', 'Caches', APP_DIR_NAME))
  const env: Env = {
    host,
    port,
    isProd: process.env.NODE_ENV === 'production',
    appDataDir,
    cacheDir,
    derivedDir: join(cacheDir, 'Derived'),
    tmpDir: join(cacheDir, 'Tmp'),
    projectsDir: fromEnv('STUDIO_PROJECTS_DIR') ?? (home ? join(home, 'Projects') : join(homedir(), 'Movies', APP_DIR_NAME)),
    modelsDir: fromEnv('STUDIO_MODELS_DIR') ?? join(appDataDir, 'Models'),
    // The desktop app ships the built SPA inside its bundle and points here via STUDIO_CLIENT_DIST.
    clientDist: resolve(process.env.STUDIO_CLIENT_DIST || 'dist/client'),
    allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`],
    allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`, `127.0.0.1:${webPort}`, `localhost:${webPort}`],
  }
  for (const dir of [env.appDataDir, env.cacheDir, env.derivedDir, env.tmpDir]) {
    mkdirSync(dir, { recursive: true })
  }
  return env
}
