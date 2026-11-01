import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { totalmem } from 'node:os'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { FalAspect } from '../../shared/models/catalog/fal'
import {
  ASPECT_RATIOS,
  FLUX_ASPECT_RATIOS,
  type FluxMode,
  type FluxResolution,
  type LtxAspect,
  type LtxQuality,
  fluxSize,
  ltxFrames,
  ltxSize,
} from '../../shared/models/catalog/local'
import type { ProviderTestResult } from '../../shared/types/api'
import type { Env } from '../env'
import { type JobContext, type PollResult, type ProviderAdapter, ProviderError, type ResolvedInput, jobError } from './types'

/** The models this adapter runs (src/shared/models/catalog/local.ts). */
const FLUX_MODEL_ID = 'local-flux-2'
const LTX_MODEL_ID = 'local-ltx-2.5'

/** Where scripts/install-local-ltx.sh puts the MLX runtime and the 4-bit LTX-2.5 pack, inside env.modelsDir. */
export const LTX_RUNTIME = 'ltx-2-mlx'
export const LTX_PACK = 'ltx-2.5-mlx-q4'
/** Files the distilled pipeline needs; hf downloads into a hidden cache and moves each file here once complete. */
const PACK_FILES = ['transformer-distilled.safetensors', 'text_encoder.safetensors', 'connector.safetensors', 'embedded_config.json']
/** Quality mode (`--two-stage`) adds the dev transformer; scripts/install-local-ltx.sh --quality fetches it. */
export const DEV_TRANSFORMER = 'transformer-dev.safetensors'

/** Below this much unified memory the transformer is streamed from disk (--low-ram): ~5% slower, ~75% less peak memory. */
const LOW_RAM_BELOW = 40 * 2 ** 30
/** Full HD on a 16 GB Mac is an overnight job; past this a render is assumed stuck and stopped. */
const MAX_RUN_MS = 12 * 3600_000

export interface LtxInstall {
  bin: string
  pack: string
  installed: boolean
  /** The dev transformer is there, so Quality mode can run. */
  quality: boolean
  detail: string
}

export function ltxInstall(env: Pick<Env, 'modelsDir'>): LtxInstall {
  const bin = join(env.modelsDir, LTX_RUNTIME, '.venv', 'bin', 'ltx-2-mlx')
  const pack = join(env.modelsDir, LTX_PACK)
  const quality = existsSync(join(pack, DEV_TRANSFORMER))
  if (!existsSync(bin)) return { bin, pack, installed: false, quality, detail: 'Runtime not installed — run scripts/install-local-ltx.sh' }
  const missing = PACK_FILES.filter((f) => !existsSync(join(pack, f)))
  if (missing.length)
    return { bin, pack, installed: false, quality, detail: `Model weights incomplete (missing ${missing.join(', ')}) — run scripts/install-local-ltx.sh` }
  const files = quality ? [...PACK_FILES, DEV_TRANSFORMER] : PACK_FILES
  const gb = files.reduce((sum, f) => sum + statSync(join(pack, f)).size, 0) / 1e9
  const modes = quality ? 'Fast + Quality modes' : 'Fast mode (for Quality run pnpm models:ltx-quality)'
  return { bin, pack, installed: true, quality, detail: `LTX-2.5 4-bit ready — ${modes} (${gb.toFixed(0)} GB in ${pack})` }
}

/** Where scripts/install-local-flux2.sh puts mflux and the pre-quantized FLUX.2 [klein] packs, inside env.modelsDir. */
export const FLUX_RUNTIME = 'mflux'
export const FLUX_PACKS: Record<FluxMode, { dir: string; base: string; label: string }> = {
  fast: { dir: 'flux2-klein-4b-mflux-q4', base: 'flux2-klein-4b', label: 'Fast' },
  quality: { dir: 'flux2-klein-4b-mflux-q8', base: 'flux2-klein-4b', label: 'Quality' },
  max: { dir: 'flux2-klein-9b-mflux-q4', base: 'flux2-klein-9b', label: 'Max' },
}
const FLUX_MODES = Object.keys(FLUX_PACKS) as FluxMode[]

export interface FluxInstall {
  bin: string
  /** Multi-reference editing has its own entry point. */
  editBin: string
  /** Pack folder per downloaded mode (the installer marks a finished download with `.complete`). */
  packs: Partial<Record<FluxMode, string>>
  installed: boolean
  detail: string
}

export function fluxInstall(env: Pick<Env, 'modelsDir'>): FluxInstall {
  const venv = join(env.modelsDir, FLUX_RUNTIME, '.venv', 'bin')
  const bin = join(venv, 'mflux-generate-flux2')
  const editBin = join(venv, 'mflux-generate-flux2-edit')
  const packs: FluxInstall['packs'] = {}
  for (const mode of FLUX_MODES) {
    const dir = join(env.modelsDir, FLUX_PACKS[mode].dir)
    if (existsSync(join(dir, '.complete'))) packs[mode] = dir
  }
  const base = { bin, editBin, packs }
  if (!existsSync(bin)) return { ...base, installed: false, detail: 'FLUX.2 [klein] is not installed — run pnpm models:flux2' }
  const ready = FLUX_MODES.filter((m) => packs[m])
  if (!ready.length) return { ...base, installed: false, detail: 'FLUX.2 [klein] weights are not downloaded — run pnpm models:flux2' }
  const more = packs.max ? '' : ' (for Max run pnpm models:flux2-max)'
  return { ...base, installed: true, detail: `FLUX.2 [klein] ready — ${ready.map((m) => FLUX_PACKS[m].label).join(' + ')} modes${more}` }
}

/**
 * Turns mflux's stderr into 0–1 progress. Loading the weights and encoding the prompt print nothing, then a tqdm
 * bar counts the 4 denoising steps (`2/4 [00:26<00:26, 13.10s/it]`), then the decode is silent until
 * `Image saved successfully at: <path>`.
 */
export class FluxProgress {
  progress = 0.02
  phase = 'Loading'
  /** The path mflux actually wrote: it never overwrites, so a taken name becomes name_1.png. */
  savedPath?: string
  private pending = ''

  feed(chunk: string) {
    const lines = (this.pending + chunk).split(/[\r\n]+/)
    this.pending = lines.pop() ?? ''
    for (const line of lines) this.line(line.trim())
  }

  private bump(value: number) {
    this.progress = Math.max(this.progress, Math.min(0.99, value))
  }

  private line(line: string) {
    if (!line) return
    const saved = /Image saved successfully at:\s*(.+)$/.exec(line)
    if (saved) {
      this.savedPath = saved[1]!.trim()
      this.bump(0.99)
      return
    }
    const bar = /(\d+)\/(\d+) \[/.exec(line)
    if (!bar) return
    const step = Number(bar[1])
    const total = Number(bar[2]) || 1
    this.phase = step >= total ? 'Decoding' : 'Rendering'
    this.bump(step >= total ? 0.9 : 0.25 + 0.6 * (step / total))
  }
}

/**
 * The mflux command line for a job: text-to-image, or the edit entry point when there are reference images (Auto
 * aspect then follows the first one). Text goes in `--flag=value` form so a prompt starting with "-" stays a value.
 *
 * The decode is untiled unless `tiled`: FLUX.2's VAE normalises each tile on its own, so a tiled decode shifts the
 * colours tile by tile (measured: a visibly warmer image, PSNR 24 dB against the untiled one). Untiled peaks at
 * ~10 GB for 1MP and ~20 GB for 2MP — on a 16 GB M4 macOS absorbs that with memory compression (2MP took the same
 * 108 s); a tiled decode (~6 GB) is the fallback when a render runs out of memory.
 */
export function fluxArgs(
  params: JobContext['params'],
  inputs: JobContext['inputs'],
  opts: { pack: string; base: string; output: string; lowRam: boolean; tiled?: boolean },
): { edit: boolean; argv: string[] } {
  const refInput = inputs.referenceImages
  const refs = Array.isArray(refInput) ? refInput : refInput ? [refInput] : []
  const first = refs[0]
  const named = FLUX_ASPECT_RATIOS[params.aspectRatio as FalAspect]
  const aspect = named ?? (first?.width && first.height ? first.width / first.height : 16 / 9)
  const { width, height } = fluxSize(aspect, (params.resolution as FluxResolution) ?? '1MP')
  const argv = ['--model', opts.pack, '--base-model', opts.base, `--prompt=${String(params.prompt ?? '')}`, '--steps', '4']
  argv.push('--width', String(width), '--height', String(height), `--output=${opts.output}`)
  if (refs.length) argv.push('--image-paths', ...refs.map((r) => r.path))
  if (typeof params.seed === 'number') argv.push('--seed', String(params.seed))
  if (opts.lowRam) argv.push('--low-ram')
  if (opts.tiled) argv.push('--vae-tiling')
  return { edit: refs.length > 0, argv }
}

/**
 * Turns the CLI's stderr into 0–1 progress. The distilled pipeline prints `[phase] ...` markers around its
 * silent stages and tqdm bars for its two denoising passes (8 half-res + 3 full-res steps). Weights follow a
 * measured M4 16 GB run: ~16% prompt encoding, ~38% per pass, ~5% decode.
 */
export class LtxProgress {
  progress = 0
  phase = 'Starting'
  private pass = -1
  private lastStep = Infinity
  private lastDesc = ''
  /** Pipe chunks split lines anywhere; a bar fragment would look like a new pass, so wait for its \r or \n. */
  private pending = ''

  /** `split` is where stage 1 ends: Quality mode's 120 guided forwards dwarf the 3-step refine. */
  constructor(private readonly split = 0.55) {}

  feed(chunk: string) {
    const lines = (this.pending + chunk).split(/[\r\n]+/)
    this.pending = lines.pop() ?? ''
    for (const line of lines) this.line(line.trim())
  }

  private bump(value: number) {
    this.progress = Math.max(this.progress, Math.min(0.99, value))
  }

  private line(line: string) {
    if (!line) return
    const marker = /^\[([^\]]+)\]\s*(\.\.\.|done)/.exec(line)
    if (marker) {
      const label = marker[1]!
      const done = marker[2] === 'done'
      if (/text encoder/i.test(label)) this.bump(done ? 0.08 : 0.01)
      else if (/encoding prompt/i.test(label)) this.bump(done ? 0.14 : 0.09)
      else if (/loading transformer/i.test(label)) this.bump(done ? 0.2 : 0.15)
      else if (/decoders/i.test(label)) this.bump(0.9)
      else if (/decoding/i.test(label)) this.bump(done ? 0.97 : 0.91)
      if (!done) this.phase = label
      return
    }
    const bar = /^([^:|]*?):?\s*\d+%\|.*?\|\s*(\d+)\/(\d+)/.exec(line)
    if (!bar) return
    const desc = bar[1]!.trim()
    const step = Number(bar[2])
    const total = Number(bar[3]) || 1
    if (desc !== this.lastDesc || step < this.lastStep) this.pass++
    this.lastDesc = desc
    this.lastStep = step
    const [from, to] = this.pass <= 0 ? [0.2, this.split] : [this.split, 0.9]
    this.phase = this.pass <= 0 ? 'Rendering' : 'Refining'
    this.bump(from + (to - from) * (step / total))
  }
}

interface Progress {
  progress: number
  feed(chunk: string): void
  /** Set when the CLI reports where it saved the file (mflux may pick another name than requested). */
  savedPath?: string
}

interface Task {
  child: ChildProcess
  bin: string
  argv: string[]
  cwd: string
  /** Model name for messages ("LTX-2.5", "FLUX.2 [klein]"). */
  label: string
  /** What to try when it runs out of memory. */
  oomHint: string
  /** A lighter command line to rerun once if this one runs out of memory. */
  oomFallback?: string[]
  /** Runs started for this job; GPU watchdog kills are retried. */
  attempts: number
  startedAt: number
  output: string
  ext: 'mp4' | 'png'
  makeProgress: () => Progress
  progress: Progress
  log: string[]
  exit?: { code: number | null; signal: NodeJS.Signals | null }
}

type TaskSpec = Omit<Task, 'child' | 'exit' | 'log' | 'progress'>

/**
 * macOS kills a Metal command buffer that runs too long. It is transient: it happens when the GPU queue is contended
 * (Spotlight indexing, another heavy app), and the same render usually goes through on the next try.
 */
const WATCHDOG = /kIOGPUCommandBuffer|GPU Timeout|Impacting ?Interactivity|MTLCommandBufferError/i
const MAX_ATTEMPTS = 3

/** Last lines of the CLI's output, for error messages. */
function tail(log: string[], lines = 6): string {
  return log.join('').split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).slice(-lines).join('\n')
}

/** macOS kills a process that exhausts memory with SIGKILL; MLX may also fail an allocation first. */
function outOfMemory(task: Task): boolean {
  return task.exit?.signal === 'SIGKILL' || /out of memory|insufficient memory|metal.*(alloc|memory)|Killed/i.test(tail(task.log, 40))
}

function failure(task: Task): PollResult {
  const text = tail(task.log, 40)
  if (WATCHDOG.test(text))
    return {
      type: 'failed',
      error: jobError(
        'gpu_timeout',
        `macOS stopped the render's GPU work ${task.attempts} times (GPU watchdog). This happens while the Mac is busy — Spotlight indexing, heavy apps. Try again later, or at a lower quality.`,
        { retryable: true },
      ),
    }
  if (outOfMemory(task))
    return {
      type: 'failed',
      error: jobError('out_of_memory', `${task.label} ran out of memory on this Mac. ${task.oomHint}`, { retryable: true }),
    }
  const detail = tail(task.log) || `exit code ${task.exit?.code ?? '?'}${task.exit?.signal ? ` (${task.exit.signal})` : ''}`
  return { type: 'failed', error: jobError('provider', `${task.label} failed: ${detail}`, { retryable: true }) }
}

function frameArg(input: ResolvedInput | ResolvedInput[] | undefined): ResolvedInput | undefined {
  return Array.isArray(input) ? input[0] : input
}

/**
 * The `ltx-2-mlx generate` command line for a job. Text goes in `--flag=value` form: argparse would read a prompt
 * that starts with "-" as another option.
 */
export function ltxArgs(
  params: JobContext['params'],
  inputs: JobContext['inputs'],
  opts: { pack: string; output: string; lowRam: boolean },
): string[] {
  const fps = Number(params.fps ?? 24)
  const frames = ltxFrames(Number(params.duration ?? 4), fps)
  const first = frameArg(inputs.firstFrame)
  const last = frameArg(inputs.lastFrame)
  const framed = first ?? last
  const aspect = framed?.width && framed.height ? framed.width / framed.height : ASPECT_RATIOS[(params.aspectRatio as LtxAspect) ?? '16:9']
  const { width, height } = ltxSize(aspect, (params.quality as LtxQuality) ?? 'standard')
  const quality = params.mode === 'quality'
  const out = ['generate', quality ? '--two-stage' : '--distilled', '--model', opts.pack, `--prompt=${String(params.prompt ?? '')}`]
  out.push('-W', String(width), '-H', String(height), '-f', String(frames), '--frame-rate', String(fps), '-o', opts.output)
  // PATH FRAME_IDX STRENGTH: frame 0 replaces the first latent, any other index guides towards that image.
  if (first) out.push('--image', first.path, '0', '1.0')
  if (last) out.push('--image', last.path, String(frames - 1), '1.0')
  if (typeof params.seed === 'number') out.push('--seed', String(params.seed))
  // Only the guided (Quality) pipeline has CFG; the distilled one rejects a negative prompt.
  const negative = typeof params.negativePrompt === 'string' ? params.negativePrompt.trim() : ''
  if (quality && negative) out.push(`--negative-prompt=${negative}`)
  if (params.audio === false) out.push('--no-audio')
  if (opts.lowRam) out.push('--low-ram')
  return out
}

/** Every render this server started, across adapters: they are its children, killed with it (10+ GB each). */
const renders = new Set<ChildProcess>()
process.once('exit', () => killAllRenders())

/**
 * Kills every local render now. Shutdown calls it first: the desktop app SIGKILLs a server that takes more than 8 s to
 * quit, and a SIGKILLed process never sees 'exit' — its renders would run on, orphaned, holding 10+ GB each.
 */
export function killAllRenders() {
  for (const child of renders) child.kill('SIGKILL')
}

export function createLocalAdapter(deps: { env: Pick<Env, 'modelsDir'> }): ProviderAdapter {
  const tasks = new Map<string, Task>()

  /** Starts (or restarts) the CLI for a task and wires its output into the task's log and progress. */
  function run(task: TaskSpec): Task {
    const child = spawn(task.bin, task.argv, {
      cwd: task.cwd,
      // Weights are local; never reach Hugging Face during a render.
      env: { ...process.env, PYTHONUNBUFFERED: '1', HF_HUB_OFFLINE: '1', TQDM_MININTERVAL: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    renders.add(child)
    child.once('exit', () => renders.delete(child))
    // Keep the Mac awake (the display may still sleep) until this render exits, so overnight queues finish.
    if (process.platform === 'darwin' && child.pid)
      spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(child.pid)], { stdio: 'ignore' }).on('error', () => {})
    const started: Task = { ...task, child, progress: task.makeProgress(), log: [] }
    const onData = (data: Buffer) => {
      const text = data.toString('utf8')
      started.progress.feed(text)
      started.log.push(text)
      if (started.log.length > 400) started.log.splice(0, started.log.length - 200)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (err) => {
      started.log.push(`\n${err.message}\n`)
      started.exit ??= { code: -1, signal: null }
    })
    child.on('exit', (code, signal) => (started.exit = { code, signal }))
    return started
  }

  /** Each model is installed on its own; the provider counts as set up once any of them can run. */
  function installs() {
    const flux = fluxInstall(deps.env)
    const ltx = ltxInstall(deps.env)
    return {
      configured: flux.installed || ltx.installed,
      detail: `${flux.detail}\n${ltx.detail}`,
      models: {
        [FLUX_MODEL_ID]: { ready: flux.installed, detail: flux.detail },
        [LTX_MODEL_ID]: { ready: ltx.installed, detail: ltx.detail },
      },
    }
  }

  function status(): ProviderTestResult {
    const s = installs()
    return { ok: s.configured, message: s.detail }
  }

  function submitFlux(ctx: JobContext): string {
    const install = fluxInstall(deps.env)
    if (!install.installed) throw new ProviderError(jobError('not_installed', install.detail))
    const mode = (ctx.params.mode as FluxMode) ?? 'fast'
    const pack = install.packs[mode]
    if (!pack)
      throw new ProviderError(
        jobError(
          'not_installed',
          mode === 'max'
            ? 'Max mode needs FLUX.2 [klein] 9B (~9.5 GB, non-commercial licence): run pnpm models:flux2-max, or use Fast or Quality.'
            : `${FLUX_PACKS[mode].label} mode isn't downloaded yet: run pnpm models:flux2.`,
        ),
      )
    const output = join(ctx.tmpDir, `flux2-${ctx.generationId}.png`)
    const opts = { pack, base: FLUX_PACKS[mode].base, output, lowRam: totalmem() < LOW_RAM_BELOW }
    const { edit, argv } = fluxArgs(ctx.params, ctx.inputs, opts)
    ctx.recordRequest({ command: edit ? 'mflux-generate-flux2-edit' : 'mflux-generate-flux2', args: argv })
    const taskId = nanoid(10)
    tasks.set(
      taskId,
      run({
        bin: edit ? install.editBin : install.bin,
        argv,
        cwd: ctx.tmpDir,
        label: 'FLUX.2 [klein]',
        oomHint: 'Try 1MP, fewer reference images, or close other apps.',
        // A tiled decode needs ~6 GB instead of ~20 GB at 2MP, at the cost of slight colour shifts between tiles.
        oomFallback: fluxArgs(ctx.params, ctx.inputs, { ...opts, tiled: true }).argv,
        attempts: 1,
        startedAt: Date.now(),
        output,
        ext: 'png',
        makeProgress: () => new FluxProgress(),
      }),
    )
    return taskId
  }

  function submitLtx(ctx: JobContext): string {
    const install = ltxInstall(deps.env)
    if (!install.installed) throw new ProviderError(jobError('not_installed', install.detail))
    const quality = ctx.params.mode === 'quality'
    if (quality && !install.quality)
      throw new ProviderError(jobError('not_installed', 'Quality mode needs the full LTX-2.5 model (~20 GB): run pnpm models:ltx-quality, or use Fast mode.'))
    const output = join(ctx.tmpDir, `ltx-${ctx.generationId}.mp4`)
    const argv = ltxArgs(ctx.params, ctx.inputs, { pack: install.pack, output, lowRam: totalmem() < LOW_RAM_BELOW })
    ctx.recordRequest({ command: 'ltx-2-mlx', args: argv })
    const taskId = nanoid(10)
    const split = quality ? 0.85 : 0.55
    tasks.set(
      taskId,
      run({
        bin: install.bin,
        argv,
        cwd: ctx.tmpDir,
        label: 'LTX-2.5',
        oomHint: 'Try Draft quality, a shorter duration, audio off, or close other apps.',
        attempts: 1,
        startedAt: Date.now(),
        output,
        ext: 'mp4',
        makeProgress: () => new LtxProgress(split),
      }),
    )
    return taskId
  }

  return {
    id: 'local',
    label: 'This Mac',
    version: 'ltx-2-mlx@0.15.12, mflux@0.21.0',
    credentialFields: [],
    requiredFields: [],
    // One render at a time: each one needs most of the unified memory.
    defaultConcurrency: 1,
    pollIntervalMs: 1500,
    // A little past our own limit, so poll() stops the process itself instead of leaving it running.
    maxRunMs: MAX_RUN_MS + 10 * 60_000,
    billing: 'free',
    status: () => {
      const { configured, detail, models } = installs()
      return { configured, detail, models }
    },
    async test() {
      return status()
    },
    async submit(ctx) {
      const taskId = ctx.model.id === FLUX_MODEL_ID ? submitFlux(ctx) : submitLtx(ctx)
      return { type: 'async', taskId }
    },
    async poll(ctx) {
      const task = ctx.providerTaskId ? tasks.get(ctx.providerTaskId) : undefined
      if (!task)
        return {
          type: 'failed',
          error: jobError('interrupted', `The app restarted while ${ctx.model.label} was rendering. Retry to render it again.`, { retryable: true }),
        }
      if (!task.exit && Date.now() - task.startedAt > MAX_RUN_MS) {
        task.child.kill('SIGKILL')
        tasks.delete(ctx.providerTaskId!)
        return { type: 'failed', error: jobError('timeout', `${task.label} did not finish within 12 hours and was stopped.`, { retryable: true }) }
      }
      if (!task.exit) return { type: 'running', progress: task.progress.progress }
      if (task.exit.code !== 0 && task.attempts < MAX_ATTEMPTS) {
        const { child: _child, exit: _exit, log: _log, progress: _progress, ...spec } = task
        if (WATCHDOG.test(tail(task.log, 40))) {
          console.warn(`[local] ${task.label} hit the GPU watchdog; retrying (attempt ${task.attempts + 1} of ${MAX_ATTEMPTS})`)
          tasks.set(ctx.providerTaskId!, run({ ...spec, attempts: task.attempts + 1 }))
          return { type: 'running', progress: task.progress.progress }
        }
        if (task.oomFallback && outOfMemory(task)) {
          console.warn(`[local] ${task.label} ran out of memory; retrying with a lighter setup`)
          tasks.set(ctx.providerTaskId!, run({ ...spec, argv: task.oomFallback, oomFallback: undefined, attempts: task.attempts + 1 }))
          return { type: 'running', progress: task.progress.progress }
        }
      }
      tasks.delete(ctx.providerTaskId!)
      // mflux logs a failed save instead of exiting non-zero, so the file itself is the proof.
      const path = task.progress.savedPath && existsSync(task.progress.savedPath) ? task.progress.savedPath : task.output
      if (task.exit.code !== 0 || !existsSync(path)) return failure(task)
      return { type: 'done', outputs: [{ kind: 'file', path, ext: task.ext }], costUsd: 0 }
    },
    async cancel(ctx) {
      const task = ctx.providerTaskId ? tasks.get(ctx.providerTaskId) : undefined
      if (!task || task.exit) return
      task.child.kill('SIGTERM')
      setTimeout(() => task.exit || task.child.kill('SIGKILL'), 5000).unref()
      tasks.delete(ctx.providerTaskId!)
    },
  }
}
