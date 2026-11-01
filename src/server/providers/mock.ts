import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { JobError } from '../../shared/types/jobs'
import type { Env } from '../env'
import { escapeFilterValue, fmtNum, isAbortError, runFfmpeg, systemFontPath } from '../services/ffmpeg'
import { jobError, ProviderError, type JobContext, type PollResult, type ProviderAdapter, type ResolvedInput, type SubmitResult } from './types'

/**
 * Demo provider: generates test media locally with ffmpeg (no network, no cost). It behaves like a real async
 * provider — submit() returns a task id, poll() reports progress for ~2–4 s — and keeps task state in
 * `<tmpDir>/mock-tasks/<taskId>.json`, so a fresh adapter (after a server restart) can pick a task up again.
 *
 * mock-video is the A/V sync fixture: the first frame of every second is pure white and, with audio on,
 * a 1 kHz beep lasts exactly that frame.
 */

const ADAPTER_VERSION = '1'
const TASK_TTL_MS = 24 * 60 * 60 * 1000

const FRAME_SIZES: Record<string, [number, number]> = {
  '16:9': [1280, 720],
  '9:16': [720, 1280],
  '1:1': [1024, 1024],
}

interface TaskOutput {
  path: string
  ext: string
  name: string
}

interface MockTask {
  version: 1
  taskId: string
  modelId: string
  params: Record<string, unknown>
  variant: number
  /** Resolved firstFrame image for mock-video. */
  firstFramePath?: string
  /** First reference image for mock-image (drawn behind the prompt, like an edit). */
  referencePath?: string
  outDir: string
  createdAt: number
  /** Simulated provider latency: `done` is never reported before createdAt + simulatedMs. */
  simulatedMs: number
  status: 'running' | 'done' | 'failed' | 'canceled'
  outputs?: TaskOutput[]
  error?: JobError
}

/** Background generations running in this process (by task id), shared by all adapter instances. */
const workers = new Map<string, AbortController>()

export function createMockAdapter({ env }: { env: Env }): ProviderAdapter {
  const tasksDir = join(env.tmpDir, 'mock-tasks')
  const taskPath = (taskId: string) => join(tasksDir, `${taskId}.json`)

  async function readTask(taskId: string): Promise<MockTask | undefined> {
    try {
      return JSON.parse(await readFile(taskPath(taskId), 'utf8')) as MockTask
    } catch {
      return undefined
    }
  }

  async function writeTask(task: MockTask): Promise<void> {
    await mkdir(tasksDir, { recursive: true })
    const tmp = `${taskPath(task.taskId)}.tmp-${nanoid(6)}`
    await writeFile(tmp, JSON.stringify(task, null, 2))
    await rename(tmp, taskPath(task.taskId))
  }

  function startWorker(task: MockTask, signal?: AbortSignal) {
    if (workers.has(task.taskId)) return
    const abort = new AbortController()
    const onAbort = () => abort.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    workers.set(task.taskId, abort)
    void (async () => {
      try {
        await mkdir(task.outDir, { recursive: true })
        const outputs = await generate(task, abort.signal)
        const current = await readTask(task.taskId)
        if (!current || current.status === 'canceled') {
          await Promise.all(outputs.map((o) => rm(o.path, { force: true })))
          return
        }
        await writeTask({ ...current, status: 'done', outputs, error: undefined })
      } catch (err) {
        // Interrupted (shutdown/cancel): leave the task 'running' so the next poll resumes it.
        if (isAbortError(err) || abort.signal.aborted) return
        const current = (await readTask(task.taskId)) ?? task
        if (current.status === 'canceled') return
        const message = err instanceof Error ? err.message : String(err)
        await writeTask({ ...current, status: 'failed', error: jobError('provider', `Demo generator failed: ${message}`, { retryable: true }) })
      } finally {
        signal?.removeEventListener('abort', onAbort)
        workers.delete(task.taskId)
      }
    })()
  }

  async function cleanupOldTasks() {
    const names = await readdir(tasksDir).catch(() => [] as string[])
    const cutoff = Date.now() - TASK_TTL_MS
    await Promise.all(
      names.map(async (name) => {
        const path = join(tasksDir, name)
        const info = await stat(path).catch(() => undefined)
        if (info && info.mtimeMs < cutoff) await rm(path, { force: true })
      }),
    )
  }

  return {
    id: 'mock',
    label: 'Demo (local)',
    version: ADAPTER_VERSION,
    credentialFields: [],
    requiredFields: [],
    defaultConcurrency: 2,
    pollIntervalMs: 500,
    billing: 'free',

    async test() {
      return { ok: true, message: 'Demo generator ready — runs locally with ffmpeg, no API key needed' }
    },

    async submit(ctx: JobContext): Promise<SubmitResult> {
      if (!GENERATORS[ctx.model.id]) throw new ProviderError(jobError('invalid_params', `Unknown demo model ${ctx.model.id}`))
      ctx.recordRequest({ model: ctx.model.id, params: ctx.params, variant: ctx.variant })
      const taskId = `mock_${nanoid(12)}`
      const firstFrame = pickInput(ctx.inputs.firstFrame)
      const reference = pickInput(ctx.inputs.referenceImages)
      const task: MockTask = {
        version: 1,
        taskId,
        modelId: ctx.model.id,
        params: ctx.params,
        variant: ctx.variant,
        firstFramePath: firstFrame?.path,
        referencePath: reference?.path,
        outDir: ctx.tmpDir,
        createdAt: Date.now(),
        simulatedMs: 2000 + (hashInt(taskId) % 2000),
        status: 'running',
      }
      await writeTask(task)
      startWorker(task, ctx.signal)
      void cleanupOldTasks()
      return { type: 'async', taskId, meta: { mockTaskId: taskId } }
    },

    async poll(ctx: JobContext): Promise<PollResult> {
      const taskId = ctx.providerTaskId
      if (!taskId) return { type: 'failed', error: jobError('internal', 'Demo task id is missing') }
      const task = await readTask(taskId)
      if (!task) return { type: 'failed', error: jobError('not_found', 'Demo task not found (it may have expired)', { retryable: true }) }
      if (task.status === 'failed' || task.status === 'canceled') {
        return { type: 'failed', error: task.error ?? jobError('canceled', 'Demo task was canceled') }
      }
      // After a restart nothing is generating this task any more (or its outputs vanished): run it again.
      const outputsMissing = task.status === 'done' && !(task.outputs ?? []).every((o) => existsSync(o.path))
      if ((task.status === 'running' || outputsMissing) && !workers.has(taskId)) {
        if (outputsMissing) await writeTask({ ...task, status: 'running', outputs: undefined })
        startWorker({ ...task, status: 'running' }, ctx.signal)
        return { type: 'running', progress: progressOf(task) }
      }
      if (task.status === 'done' && Date.now() - task.createdAt >= task.simulatedMs) {
        return {
          type: 'done',
          outputs: (task.outputs ?? []).map((o) => ({ kind: 'file', path: o.path, ext: o.ext, name: o.name })),
          costUsd: 0,
          response: { taskId, outputs: task.outputs?.length ?? 0 },
        }
      }
      return { type: 'running', progress: progressOf(task) }
    },

    async cancel(ctx: JobContext): Promise<void> {
      const taskId = ctx.providerTaskId
      if (!taskId) return
      workers.get(taskId)?.abort()
      const task = await readTask(taskId)
      if (!task) return
      await writeTask({ ...task, status: 'canceled', error: jobError('canceled', 'Demo task was canceled') })
      await Promise.all((task.outputs ?? []).map((o) => rm(o.path, { force: true })))
    },
  }
}

function progressOf(task: MockTask): number {
  return Math.max(0.01, Math.min(0.95, (Date.now() - task.createdAt) / task.simulatedMs))
}

function pickInput(value: ResolvedInput | ResolvedInput[] | undefined): ResolvedInput | undefined {
  return Array.isArray(value) ? value[0] : value
}

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

type Generator = (task: MockTask, signal: AbortSignal) => Promise<TaskOutput[]>

const GENERATORS: Record<string, Generator> = {
  'mock-video': generateVideo,
  'mock-image': generateImage,
  'mock-speech': generateSpeech,
  'mock-music': generateMusic,
  'mock-sfx': generateSfx,
}

function generate(task: MockTask, signal: AbortSignal): Promise<TaskOutput[]> {
  const generator = GENERATORS[task.modelId]
  if (!generator) throw new Error(`Unknown demo model ${task.modelId}`)
  return generator(task, signal)
}

function hashInt(text: string): number {
  return createHash('sha256').update(text).digest().readUInt32BE(0)
}

function excerpt(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`
}

const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v : fallback)
const num = (v: unknown, fallback: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Unique output base name so re-runs and variants never collide inside the job's tmp dir. */
const outputBase = (task: MockTask) => `${task.modelId}-${task.variant}-${nanoid(6)}`

/** Runs ffmpeg into a temp file inside outDir (cwd, so drawtext text files need no path escaping), then renames. */
async function render(task: MockTask, fileName: string, args: (out: string) => string[], signal: AbortSignal): Promise<string> {
  const finalPath = join(task.outDir, fileName)
  const dot = fileName.lastIndexOf('.')
  const tmpName = `${fileName.slice(0, dot)}.partial${fileName.slice(dot)}`
  try {
    await runFfmpeg(args(tmpName), { signal, cwd: task.outDir })
    await rename(join(task.outDir, tmpName), finalPath)
  } finally {
    await rm(join(task.outDir, tmpName), { force: true })
  }
  return finalPath
}

function hslHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `${f(0)}${f(8)}${f(4)}`
}

/** Average colour of an image as RRGGBB (ffmpeg area-downscale to 1×1), or undefined if it can't be decoded. */
async function averageColor(imagePath: string, workDir: string, signal: AbortSignal): Promise<string | undefined> {
  const out = join(workDir, `avg-${nanoid(6)}.rgb`)
  try {
    await runFfmpeg(['-i', imagePath, '-vf', 'scale=1:1:flags=area,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', out], { signal })
    const rgb = await readFile(out)
    if (rgb.length < 3) return undefined
    return [rgb[0]!, rgb[1]!, rgb[2]!].map((c) => c.toString(16).padStart(2, '0')).join('')
  } catch (err) {
    if (isAbortError(err)) throw err
    return undefined
  } finally {
    await rm(out, { force: true })
  }
}

async function generateVideo(task: MockTask, signal: AbortSignal): Promise<TaskOutput[]> {
  const p = task.params
  const prompt = str(p.prompt, 'Demo video')
  const duration = num(p.duration, 5)
  const fps = Math.round(num(p.fps, 24))
  const [w, h] = FRAME_SIZES[str(p.aspectRatio, '16:9')] ?? FRAME_SIZES['16:9']!
  const withAudio = p.audio !== false
  const base = outputBase(task)
  const font = systemFontPath()

  const chain = [`testsrc2=size=${w}x${h}:rate=${fps}:duration=${fmtNum(duration)}`]
  // Takes are told apart by hue.
  const hue = (task.variant * 67) % 360
  if (hue) chain.push(`hue=h=${hue}`)
  const tint = task.firstFramePath ? await averageColor(task.firstFramePath, task.outDir, signal) : undefined
  if (tint) chain.push(`drawbox=x=0:y=0:w=iw:h=ih:color=0x${tint}@0.45:t=fill`)
  if (font) {
    const small = Math.min(w, h)
    const promptSize = Math.round(small * 0.045)
    const promptFile = `${base}.prompt.txt`
    await writeFile(join(task.outDir, promptFile), wrapText(excerpt(prompt, 60), charsPerLine(w, promptSize), 3))
    const f = escapeFilterValue(font)
    const text = `fontfile=${f}:fontcolor=white:bordercolor=black:x=(w-tw)/2`
    chain.push(`drawtext=${text}:text=%{frame_num}:fontsize=${Math.round(small * 0.3)}:borderw=8:y=(h-th)/2-${Math.round(h * 0.06)}`)
    chain.push(`drawtext=${text}:timecode='00\\:00\\:00\\:00':rate=${fps}:fontsize=${Math.round(small * 0.07)}:borderw=3:y=${Math.round(h * 0.68)}`)
    chain.push(
      `drawtext=${text}:textfile=${promptFile}:expansion=none:fontsize=${promptSize}:line_spacing=${Math.round(promptSize * 0.3)}:borderw=2:y=${Math.round(h * 0.8)}`,
    )
  }
  // Sync marker: the first frame of every second is pure white (drawn last so it covers the text).
  chain.push(`drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(mod(n,${fps}),0)'`, 'format=yuv420p')

  let graph = `${chain.join(',')}[v]`
  if (withAudio) {
    // Sample-exact beep: 1 kHz, exactly one frame (1/fps s) long, starting on every whole second.
    const beep = `0.5*sin(2*PI*1000*t)*lt(mod(t,1),1/${fps})`
    graph += `;aevalsrc=exprs='${beep}|${beep}':s=48000:d=${fmtNum(duration)}[a]`
  }
  const path = await render(
    task,
    `${base}.mp4`,
    (out) => [
      '-filter_complex',
      graph,
      '-map',
      '[v]',
      ...(withAudio ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'] : []),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-g',
      String(fps),
      '-movflags',
      '+faststart',
      '-t',
      fmtNum(duration),
      out,
    ],
    signal,
  )
  await rm(join(task.outDir, `${base}.prompt.txt`), { force: true })
  return [{ path, ext: 'mp4', name: `Demo video — ${excerpt(prompt, 40)}` }]
}

/** Rough characters per line for a proportional font filling 85 % of the frame width. */
function charsPerLine(frameWidth: number, fontSize: number): number {
  return Math.max(8, Math.floor((frameWidth * 0.85) / (fontSize * 0.55)))
}

/** Greedy word wrap for drawtext (which doesn't wrap by itself). */
function wrapText(text: string, width: number, maxLines: number): string {
  const lines: string[] = []
  let line = ''
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    const candidate = line ? `${line} ${word}` : word
    if (candidate.length <= width) {
      line = candidate
      continue
    }
    if (line) lines.push(line)
    line = word.length > width ? `${word.slice(0, width - 1)}…` : word
  }
  if (line) lines.push(line)
  if (lines.length <= maxLines) return lines.join('\n')
  const kept = lines.slice(0, maxLines)
  kept[maxLines - 1] = `${kept[maxLines - 1]!.slice(0, width - 1)}…`
  return kept.join('\n')
}

async function generateImage(task: MockTask, signal: AbortSignal): Promise<TaskOutput[]> {
  const prompt = str(task.params.prompt, 'Demo image')
  const [w, h] = FRAME_SIZES[str(task.params.aspectRatio, '16:9')] ?? FRAME_SIZES['16:9']!
  const color = hslHex((hashInt(prompt) + task.variant * 47) % 360, 0.55, 0.42)
  const base = outputBase(task)
  const font = systemFontPath()
  // With a reference image the demo "edit" keeps the picture and writes the instruction over its lower part.
  const ref = task.referencePath
  const chain = ref ? [`[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`] : [`color=c=0x${color}:s=${w}x${h}:d=1`]
  if (font) {
    const fontSize = Math.round(Math.min(w, h) * (ref ? 0.035 : 0.06))
    const promptFile = `${base}.prompt.txt`
    await writeFile(join(task.outDir, promptFile), wrapText(prompt, charsPerLine(w, fontSize), ref ? 3 : 8))
    const y = ref ? 'h-th-h*0.06' : '(h-th)/2'
    chain.push(
      `drawtext=fontfile=${escapeFilterValue(font)}:textfile=${promptFile}:expansion=none:fontsize=${fontSize}:fontcolor=white:borderw=2:bordercolor=black@0.5:line_spacing=${Math.round(fontSize * 0.35)}:x=(w-tw)/2:y=${y}${ref ? `:box=1:boxcolor=0x${color}@0.6:boxborderw=${Math.round(fontSize * 0.4)}` : ''}`,
    )
  }
  const inputs = ref ? ['-i', ref] : []
  const path = await render(task, `${base}.png`, (out) => [...inputs, '-filter_complex', `${chain.join(',')}[v]`, '-map', '[v]', '-frames:v', '1', '-update', '1', out], signal)
  await rm(join(task.outDir, `${base}.prompt.txt`), { force: true })
  return [{ path, ext: 'png', name: `Demo image — ${excerpt(prompt, 40)}` }]
}

const WAV_ARGS = ['-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2']

async function renderAudio(task: MockTask, graph: string, signal: AbortSignal): Promise<string> {
  return render(task, `${outputBase(task)}.wav`, (out) => ['-filter_complex', `${graph}[a]`, '-map', '[a]', ...WAV_ARGS, out], signal)
}

async function generateSpeech(task: MockTask, signal: AbortSignal): Promise<TaskOutput[]> {
  const text = str(task.params.text, str(task.params.prompt, 'Hello'))
  const duration = Math.max(1, Math.round((text.trim().length / 15) * 100) / 100)
  const freq = 220 + ((hashInt(text) + task.variant * 37) % 221)
  const d = fmtNum(duration)
  // Soft tone with a syllable-like wobble, 80 ms attack and 250 ms release.
  const voice = `0.3*sin(2*PI*${freq}*t)*(0.55+0.45*sin(2*PI*3.3*t))*min(1,t/0.08)*min(1,(${d}-t)/0.25)`
  const path = await renderAudio(task, `aevalsrc=exprs='${voice}|${voice}':s=48000:d=${d}`, signal)
  return [{ path, ext: 'wav', name: `Demo voice — ${excerpt(text, 40)}` }]
}

async function generateMusic(task: MockTask, signal: AbortSignal): Promise<TaskOutput[]> {
  const prompt = str(task.params.prompt, 'Demo music')
  const duration = num(task.params.durationSeconds, 20)
  const roots = [220, 246.94, 261.63, 293.66, 329.63, 349.23, 392]
  const seed = hashInt(prompt) + task.variant * 3
  const root = roots[seed % roots.length]!
  const third = root * 2 ** ((seed & 8 ? 3 : 4) / 12) // minor or major
  const fifth = root * 2 ** (7 / 12)
  const pad = (detune: number) =>
    `0.16*(sin(2*PI*${fmtNum(root * detune, 3)}*t)+sin(2*PI*${fmtNum(third * detune, 3)}*t)+sin(2*PI*${fmtNum(fifth * detune, 3)}*t))*(0.85+0.15*sin(2*PI*0.25*t))`
  const fadeIn = Math.min(2, duration / 4)
  const fadeOut = Math.min(3, duration / 3)
  const graph = [
    `aevalsrc=exprs='${pad(1)}|${pad(1.003)}':s=48000:d=${fmtNum(duration)}`,
    `afade=t=in:st=0:d=${fmtNum(fadeIn)}`,
    `afade=t=out:st=${fmtNum(duration - fadeOut)}:d=${fmtNum(fadeOut)}`,
  ].join(',')
  const path = await renderAudio(task, graph, signal)
  return [{ path, ext: 'wav', name: `Demo music — ${excerpt(prompt, 40)}` }]
}

async function generateSfx(task: MockTask, signal: AbortSignal): Promise<TaskOutput[]> {
  const prompt = str(task.params.prompt, 'Demo SFX')
  const duration = num(task.params.durationSeconds, 3)
  const seed = hashInt(prompt) + task.variant * 101
  const center = 400 + (seed % 3600)
  const d = fmtNum(duration)
  // 5 ms attack, exponential decay to about -50 dB at the end.
  const env = `min(1,t/0.005)*exp(-6*t/${d})`
  const graph = [
    `anoisesrc=color=white:amplitude=0.9:sample_rate=48000:duration=${d}:seed=${seed % 100000}`,
    `bandpass=f=${center}:width_type=q:width=1.2`,
    `aeval=exprs='val(0)*${env}|val(0)*${env}':c=stereo`,
  ].join(',')
  const path = await renderAudio(task, graph, signal)
  return [{ path, ext: 'wav', name: `Demo SFX — ${excerpt(prompt, 40)}` }]
}
