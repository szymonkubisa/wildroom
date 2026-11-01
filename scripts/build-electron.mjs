#!/usr/bin/env node
/**
 * Builds the macOS desktop app.
 *
 *   node scripts/build-electron.mjs           release/mac-arm64/Wildroom.app (+ a .dmg)
 *   node scripts/build-electron.mjs --stage   only prepare dist-electron/app (`pnpm electron:start` runs it)
 *   … --clean                                 reinstall the staged node_modules from scratch
 *
 * dist-electron/app is a self-contained npm project: the server bundled by esbuild, main/preload, the
 * built SPA and a flat node_modules holding only what cannot be bundled (@napi-rs/keyring, @resvg/resvg-js,
 * ffmpeg-static). The native addons are Node-API builds: the same binaries load in Electron and in system Node.
 *
 * Signing: ad-hoc by default (runs on this Mac; elsewhere Gatekeeper asks once, see docs/desktop-app.md).
 * With STUDIO_MAC_IDENTITY="Developer ID Application: Name (TEAMID)" it signs with that certificate and the
 * hardened runtime, and notarizes when APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID are set.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const STAGE = join(ROOT, 'dist-electron', 'app')
const RELEASE = join(ROOT, 'release')
/** Build resources generated for electron-builder (the .icns). */
const RESOURCES = join(ROOT, 'dist-electron', 'build')
export const PRODUCT_NAME = 'Wildroom'
const APP_ID = 'com.szymonkubisa.wildroom'
/** Loaded from node_modules at runtime instead of being bundled: native addons and the ffmpeg binary. */
const EXTERNALS = ['@napi-rs/keyring', '@resvg/resvg-js', 'ffmpeg-static']
const ARCH = process.arch

/** Bundles electron/main.ts and electron/preload.ts (CommonJS). `dev` makes main load the Vite dev server. */
export async function bundleElectron(outdir, { dev }) {
  await esbuild.build({
    entryPoints: { main: join(ROOT, 'electron/main.ts'), preload: join(ROOT, 'electron/preload.ts') },
    outdir,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    define: { __STUDIO_DEV__: String(dev) },
    sourcemap: dev ? 'inline' : false,
    logLevel: 'warning',
  })
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const stageOnly = args.has('--stage')
  // pnpm passes its own npm_* settings to scripts; keep them away from npm / electron-builder.
  for (const key of Object.keys(process.env)) if (/^npm_/i.test(key)) delete process.env[key]

  const rootPkg = readJson(join(ROOT, 'package.json'))
  const electronVersion = readJson(join(ROOT, 'node_modules/electron/package.json')).version

  step('Building the web app (vite build)')
  run(join(ROOT, 'node_modules/.bin/vite'), ['build'], { cwd: ROOT })

  step(`Staging ${relative(ROOT, STAGE)}`)
  const dependencies = Object.fromEntries(EXTERNALS.map((name) => [name, readJson(join(ROOT, 'node_modules', name, 'package.json')).version]))
  const reuseModules = cleanStage(dependencies, args.has('--clean'))
  writeFileSync(
    join(STAGE, 'package.json'),
    `${JSON.stringify(
      {
        name: rootPkg.name,
        productName: PRODUCT_NAME,
        version: rootPkg.version,
        description: rootPkg.description,
        private: true,
        main: 'main.cjs',
        dependencies,
      },
      null,
      2,
    )}\n`,
  )
  await bundleServer()
  await bundleElectron(STAGE, { dev: false })
  cpSync(join(ROOT, 'dist/client'), join(STAGE, 'client'), { recursive: true })

  if (reuseModules) {
    console.log('  node_modules unchanged — reusing (pass --clean to reinstall)')
  } else {
    step(`Installing ${EXTERNALS.join(', ')} (npm)`)
    // Scripts are skipped: ffmpeg comes from the repo.
    run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: STAGE })
  }
  installFfmpeg()

  // Sanity check: the native addons must load in Electron's Node.
  step(`Checking the native addons in Electron ${electronVersion} (${ARCH})`)
  run(electronBinary(), ['-e', "require('@napi-rs/keyring'); require('@resvg/resvg-js')"], {
    cwd: STAGE,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })

  if (stageOnly) {
    console.log(`\nStaged. Run it with: pnpm exec electron ${relative(ROOT, STAGE)}`)
    return
  }

  step('Making the app icon')
  const icon = await makeIcon()

  const identity = process.env.STUDIO_MAC_IDENTITY?.trim() || null
  const notarize = Boolean(identity && process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)
  step(`Packaging with electron-builder (${identity ? `signed: ${identity}${notarize ? ', notarized' : ''}` : 'ad-hoc signed'})`)
  rmSync(RELEASE, { recursive: true, force: true })
  const builder = (await import('electron-builder')).default
  await builder.build({
    // The stage is both the project and the app directory. Using it as projectDir (not the repo) makes
    // electron-builder see an npm project and keeps its native-module rebuild inside the stage.
    projectDir: STAGE,
    targets: builder.Platform.MAC.createTarget(['dir', 'dmg'], builder.Arch[ARCH]),
    publish: 'never',
    config: {
      appId: APP_ID,
      productName: PRODUCT_NAME,
      electronVersion,
      electronDist: join(ROOT, 'node_modules/electron/dist'),
      directories: { output: RELEASE, buildResources: RESOURCES },
      asar: true,
      asarUnpack: ['**/*.node', 'server/studio-mcp.mjs', 'node_modules/ffmpeg-static/**', 'node_modules/@napi-rs/keyring-*/**', 'node_modules/@resvg/resvg-js-*/**'],
      files: [
        '**/*',
      ],
      // Project bundles: "<name>.wildroom" folders that Finder shows as one document (like Final Cut's libraries).
      fileAssociations: [{ ext: 'wildroom', name: 'Wildroom Project', role: 'Editor', isPackage: true, rank: 'Owner' }],
      mac: {
        category: 'public.app-category.video',
        icon,
        darkModeSupport: true,
        // Apple Silicon only runs signed code: unsigned, the bundle's seal is broken and a downloaded copy is
        // "damaged". Ad-hoc ('-') seals it; Gatekeeper then only asks to confirm an unidentified developer.
        identity: identity ?? '-',
        // Needed for notarization; with an ad-hoc signature it would reject Electron's own (Team ID) frameworks.
        hardenedRuntime: Boolean(identity),
        notarize,
        extendInfo: {
          UTExportedTypeDeclarations: [
            {
              UTTypeIdentifier: `${APP_ID}.project`,
              UTTypeDescription: 'Wildroom Project',
              UTTypeConformsTo: ['com.apple.package', 'public.composite-content'],
              UTTypeTagSpecification: { 'public.filename-extension': ['wildroom'] },
            },
          ],
        },
      },
      dmg: { title: '${productName} ${version}', writeUpdateInfo: false },
      publish: null,
    },
  })

  const appPath = join(RELEASE, `mac-${ARCH}`, `${PRODUCT_NAME}.app`)
  const dmg = readdirSync(RELEASE).find((name) => name.endsWith('.dmg'))
  console.log(`\nDone:\n  ${relative(ROOT, appPath)}${dmg ? `\n  ${relative(ROOT, join(RELEASE, dmg))}` : ''}`)
}

async function bundleServer() {
  await esbuild.build({
    entryPoints: [join(ROOT, 'src/server/index.ts')],
    outfile: join(STAGE, 'server/index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: EXTERNALS,
    // CommonJS dependencies bundled into an ES module still call require() (Node built-ins).
    banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
    sourcemap: 'linked',
    sourcesContent: false,
    logLevel: 'warning',
  })
  // Scripts the server ships to RunPod pods (read at runtime, see src/server/providers/runpod/pod.ts).
  cpSync(join(ROOT, 'scripts/runpod'), join(STAGE, 'server/runpod'), { recursive: true })
  // The MCP stdio bridge Claude Desktop starts (Settings → Integrations), and the docs the MCP tools hand to Claude.
  copyFileSync(join(ROOT, 'scripts/studio-mcp.mjs'), join(STAGE, 'server/studio-mcp.mjs'))
  mkdirSync(join(STAGE, 'server/docs'), { recursive: true })
  for (const doc of ['motion-import.md', 'mcp.md']) copyFileSync(join(ROOT, 'docs', doc), join(STAGE, 'server/docs', doc))
}

/** electron/icon.svg → dist-electron/build/icon.icns (every size macOS asks for, drawn by resvg). */
async function makeIcon() {
  const { Resvg } = await import('@resvg/resvg-js')
  const svg = readFileSync(join(ROOT, 'electron/icon.svg'), 'utf8')
  const iconset = join(RESOURCES, 'icon.iconset')
  rmSync(iconset, { recursive: true, force: true })
  mkdirSync(iconset, { recursive: true })
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const png = new Resvg(svg, { fitTo: { mode: 'width', value: size * scale } }).render().asPng()
      writeFileSync(join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`), png)
    }
  }
  const icns = join(RESOURCES, 'icon.icns')
  run('iconutil', ['-c', 'icns', '-o', icns, iconset])
  return icns
}

/** Empties the stage, keeping node_modules when the external dependencies did not change. */
function cleanStage(dependencies, clean) {
  const pkgFile = join(STAGE, 'package.json')
  const previous = existsSync(pkgFile) ? readJson(pkgFile).dependencies : undefined
  const reuse = !clean && existsSync(join(STAGE, 'node_modules')) && JSON.stringify(previous) === JSON.stringify(dependencies)
  const keep = reuse ? new Set(['node_modules', 'package-lock.json']) : new Set()
  if (existsSync(STAGE)) {
    for (const entry of readdirSync(STAGE)) if (!keep.has(entry)) rmSync(join(STAGE, entry), { recursive: true, force: true })
  }
  mkdirSync(STAGE, { recursive: true })
  return reuse
}

/** ffmpeg-static downloads its binary in an install script: reuse the one the repo already has. */
function installFfmpeg() {
  const target = join(STAGE, 'node_modules/ffmpeg-static')
  if (existsSync(join(target, 'ffmpeg'))) return
  const source = join(ROOT, 'node_modules/ffmpeg-static')
  if (existsSync(join(source, 'ffmpeg'))) {
    for (const file of ['ffmpeg', 'ffmpeg.LICENSE', 'ffmpeg.README']) {
      if (existsSync(join(source, file))) copyFileSync(join(source, file), join(target, file))
    }
    chmodSync(join(target, 'ffmpeg'), 0o755)
  } else {
    run(process.execPath, ['install.js'], { cwd: target })
  }
}

function electronBinary() {
  const pathFile = join(ROOT, 'node_modules/electron/path.txt')
  if (!existsSync(pathFile)) run(process.execPath, [join(ROOT, 'node_modules/electron/install.js')])
  return join(ROOT, 'node_modules/electron/dist', readFileSync(pathFile, 'utf8').trim())
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts })
}

function step(message) {
  console.log(`\n▸ ${message}`)
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\n✖ ${err instanceof Error ? (err.stack ?? err.message) : err}`)
    process.exit(1)
  })
}

