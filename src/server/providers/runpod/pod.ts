import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import type { CreatePodBody } from './api'

/**
 * What runs on a pod: the official ComfyUI image. Its CUDA 12.8 build runs every supported GPU (PyTorch cu128
 * includes Blackwell) and fits far more hosts than the CUDA 13 build: RunPod has fewer machines on CUDA 13 drivers.
 * The volume's venv is named after the image's CUDA line, so changing it later means preparing the volume again.
 */
export const COMFY_IMAGE = 'runpod/comfyui:1.4.0-comfyuiv0.35.0-cuda12.8'
export const MIN_CUDA = '12.8'
export const COMFY_PORT = 8188
/** Version of scripts/runpod/setup-volume.sh (its SETUP_VERSION): a volume prepared by an older one is set up again. */
export const SETUP_VERSION = 3
/** Every pod the app makes is named `wildroom-<kind>-<install>-<time>`, so it can find (and clean up) its own. */
export const POD_PREFIX = 'wildroom-'
const WORKSPACE = '/workspace'

export type PodKind = 'render' | 'setup'

export const podUrl = (podId: string) => `https://${podId}-${COMFY_PORT}.proxy.runpod.net`

/** Short, name-safe id of this installation. */
export const installTag = (machineId: string) => machineId.replace(/[^a-z0-9]/gi, '').slice(-10).toLowerCase() || 'local'

export const podName = (kind: PodKind, install: string) => `${POD_PREFIX}${kind}-${install}-${Date.now().toString(36)}`

export function isOwnPod(name: string, install: string): { kind: PodKind } | undefined {
  const m = /^wildroom-(render|setup)-([a-z0-9]+)-/.exec(name)
  return m && m[2] === install ? { kind: m[1] as PodKind } : undefined
}

/**
 * The volume's start hook does the rest (token gate, watchdog); an unprepared volume never exposes ComfyUI. The model
 * preload (sent with the pod) runs beside it while ComfyUI boots.
 */
const RENDER_ENTRY = [
  `if [ -f ${WORKSPACE}/bootstrap/on_start.sh ]; then`,
  `if [ -n "\${WILDROOM_PRELOAD_SH:-}" ]; then (setsid bash -c "$WILDROOM_PRELOAD_SH" >/dev/null 2>&1 </dev/null &); fi;`,
  `exec bash ${WORKSPACE}/bootstrap/on_start.sh; fi;`,
  `echo "[wildroom] this volume is not prepared: run Prepare volume in the app";`,
  'exec sleep infinity',
].join(' ')

export function renderPodBody(opts: {
  install: string
  gpuId: string
  volumeId: string
  dataCenter: string
  token: string
  watchdogMinutes: number
  maxHours: number
  /** Model files (under the volume's models folder) to read ahead while the pod boots. */
  preload?: string[]
}): CreatePodBody {
  return {
    name: podName('render', opts.install),
    image: COMFY_IMAGE,
    gpu: { id: opts.gpuId, count: 1, minCudaVersion: MIN_CUDA },
    cloud: 'SECURE',
    dataCenterIds: [opts.dataCenter],
    mounts: { network: [{ volumeId: opts.volumeId, path: WORKSPACE }] },
    disk: 30,
    ports: [`${COMFY_PORT}/http`],
    env: {
      COMFY_AUTH_TOKEN: opts.token,
      WILDROOM_WATCHDOG_MIN: String(opts.watchdogMinutes),
      WILDROOM_MAX_HOURS: String(opts.maxHours),
      ...(opts.preload?.length ? { WILDROOM_PRELOAD: opts.preload.join(' '), WILDROOM_PRELOAD_SH: podScript('preload.sh') } : {}),
    },
    entrypoint: ['bash', '-c'],
    cmd: [RENDER_ENTRY],
  }
}

/** Unpacks the setup scripts (sent in an env var: nothing has to be hosted anywhere) and runs the setup. */
const SETUP_ENTRY = [
  'set -e',
  `mkdir -p ${WORKSPACE}/bootstrap/src`,
  `python3 -c 'import os, json, gzip, base64; files = json.loads(gzip.decompress(base64.b64decode(os.environ["WILDROOM_BUNDLE"]))); [open("${WORKSPACE}/bootstrap/src/" + name, "w").write(text) for name, text in files.items()]'`,
  `exec bash ${WORKSPACE}/bootstrap/src/setup-volume.sh`,
].join('; ')

/** The setup only installs and downloads: a CPU pod does it (cheaper, more often free); a GPU is the fallback. */
export type SetupMachine = { gpuId: string } | { cpuId: string; vcpuCount: number }

export function setupPodBody(opts: { install: string; machine: SetupMachine; volumeId: string; dataCenter: string; hfToken: string; bundle: string }): CreatePodBody {
  const m = opts.machine
  return {
    name: podName('setup', opts.install),
    image: COMFY_IMAGE,
    ...('gpuId' in m ? { gpu: { id: m.gpuId, count: 1, minCudaVersion: MIN_CUDA } } : { cpu: { id: m.cpuId, vcpuCount: m.vcpuCount } }),
    cloud: 'SECURE',
    dataCenterIds: [opts.dataCenter],
    mounts: { network: [{ volumeId: opts.volumeId, path: WORKSPACE }] },
    disk: 30,
    // Serves only bootstrap/progress/status.txt (progress lines) while the setup runs.
    ports: [`${COMFY_PORT}/http`],
    env: { WILDROOM_BUNDLE: opts.bundle, HF_TOKEN: opts.hfToken, WILDROOM_SELF_TERMINATE: '1' },
    entrypoint: ['bash', '-c'],
    cmd: [SETUP_ENTRY],
  }
}

// ---------------------------------------------------------------- the scripts shipped to pods

export const POD_FILES = ['setup-volume.sh', 'on_start.sh', 'watchdog.sh', 'Caddyfile'] as const

/** Where scripts/runpod lives: next to the bundled server in the app, in the repo during development. */
export function podAssetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.STUDIO_POD_ASSETS_DIR,
    join(here, 'runpod'), // packaged: server/index.mjs + server/runpod/
    resolve(here, '../../../../scripts/runpod'), // dev: src/server/providers/runpod/
    resolve(process.cwd(), 'scripts/runpod'),
  ].filter((p): p is string => Boolean(p))
  const found = candidates.find((dir) => existsSync(join(dir, 'setup-volume.sh')))
  if (!found) throw new Error('The RunPod setup scripts are missing from this build')
  return found
}

/** A script sent with every render pod (not stored on the volume). */
export function podScript(name: 'preload.sh', dir = podAssetsDir()): string {
  return readFileSync(join(dir, name), 'utf8')
}

/** The pod scripts as one env-var-sized blob: base64(gzip(JSON {file: text})). */
export function podBundle(dir = podAssetsDir()): string {
  const files: Record<string, string> = {}
  for (const name of POD_FILES) files[name] = readFileSync(join(dir, name), 'utf8')
  return gzipSync(Buffer.from(JSON.stringify(files))).toString('base64')
}
