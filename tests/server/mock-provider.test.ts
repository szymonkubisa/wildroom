import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMockAdapter } from '../../src/server/providers/mock'
import type { ProviderAdapter } from '../../src/server/providers/types'
import { runFfmpeg } from '../../src/server/services/ffmpeg'
import { probeFile } from '../../src/server/services/probe'
import { createTestHome, filePath, measureAvSync, mockJobContext, pollUntilDone, runMockJob, type TestHome } from './sync-utils'

let lib: TestHome
let adapter: ProviderAdapter

beforeAll(async () => {
  lib = await createTestHome('mock')
  adapter = createMockAdapter({ env: lib.env })
})

afterAll(async () => {
  await lib?.dispose()
})

describe('mock provider', () => {
  it('describes itself and always passes the credentials test', async () => {
    expect(adapter).toMatchObject({ id: 'mock', credentialFields: [], requiredFields: [] })
    expect(await adapter.test({})).toMatchObject({ ok: true })
  })

  it('runs asynchronously with growing progress, then returns a named file', async () => {
    const ctx = mockJobContext(lib.env, 'mock-video', { prompt: 'A paper boat drifting down a rain gutter', duration: 3, fps: 25, aspectRatio: '9:16', audio: true })
    const submitted = await adapter.submit(ctx)
    expect(submitted.type).toBe('async')
    if (submitted.type !== 'async') return
    ctx.providerTaskId = submitted.taskId

    const first = await adapter.poll!(ctx)
    expect(first.type).toBe('running')
    await new Promise((r) => setTimeout(r, 700))
    const second = await adapter.poll!(ctx)
    expect(second.type).toBe('running') // never done before ~2 s
    if (first.type === 'running' && second.type === 'running') expect(second.progress!).toBeGreaterThan(first.progress!)

    const started = Date.now()
    const [output] = await pollUntilDone(adapter, ctx)
    expect(Date.now() - started).toBeLessThan(4500)
    expect(output).toMatchObject({ kind: 'file', ext: 'mp4', name: 'Demo video — A paper boat drifting down a rain gutter' })
    expect(filePath(output!).startsWith(ctx.tmpDir)).toBe(true)

    const probe = await probeFile(filePath(output!))
    expect(probe).toMatchObject({ kind: 'video', width: 720, height: 1280, fps: 25, hasAudio: true, sampleRate: 48000, channels: 2 })
    expect(probe.durationSeconds).toBeCloseTo(3, 3)

    // The sync pattern: a flash on frames 0, 25, 50 and a one-frame beep at 0, 1, 2 s.
    const sync = await measureAvSync(filePath(output!))
    expect(sync.flashes.map((t) => Math.round(t * 1000) / 1000)).toEqual([0, 1, 2])
    expect(sync.beeps).toHaveLength(3)
    expect(sync.maxAbsOffset).toBeLessThanOrEqual(1 / 25)
  })

  it('generates images, speech, music and sfx with the requested shapes', async () => {
    const jobs = await Promise.all([
      runMockJob(adapter, mockJobContext(lib.env, 'mock-image', { prompt: 'Square card', aspectRatio: '1:1' })),
      runMockJob(adapter, mockJobContext(lib.env, 'mock-speech', { text: 'Forty-five characters of dialogue, give or take.' })),
      runMockJob(adapter, mockJobContext(lib.env, 'mock-music', { prompt: 'Calm pad', durationSeconds: 6 })),
      runMockJob(adapter, mockJobContext(lib.env, 'mock-sfx', { prompt: 'Door slam', durationSeconds: 1.5 })),
    ])
    const [image, speech, music, sfx] = jobs.map((outputs) => outputs[0]!)

    expect(image).toMatchObject({ ext: 'png', name: 'Demo image — Square card' })
    expect(await probeFile(filePath(image!))).toMatchObject({ kind: 'image', width: 1024, height: 1024 })

    const text = 'Forty-five characters of dialogue, give or take.'
    expect(speech).toMatchObject({ ext: 'wav', name: `Demo voice — ${text.slice(0, 39)}…` })
    const speechProbe = await probeFile(filePath(speech!))
    expect(speechProbe).toMatchObject({ kind: 'audio', sampleRate: 48000, channels: 2 })
    expect(speechProbe.durationSeconds).toBeCloseTo(text.length / 15, 2)

    for (const [output, seconds, name] of [
      [music, 6, 'Demo music — Calm pad'],
      [sfx, 1.5, 'Demo SFX — Door slam'],
    ] as const) {
      expect(output).toMatchObject({ ext: 'wav', name })
      const probe = await probeFile(filePath(output!))
      expect(probe).toMatchObject({ kind: 'audio', sampleRate: 48000, channels: 2, audioCodec: 'pcm-s16' })
      expect(probe.durationSeconds).toBeCloseTo(seconds, 2)
    }
  })

  it('makes takes distinguishable per variant and tints with a start frame', async () => {
    const red = join(lib.env.tmpDir, 'red.png')
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', red])
    const params = { prompt: 'Same prompt', duration: 3, fps: 24, audio: false }
    const tintedCtx = mockJobContext(lib.env, 'mock-video', params, 0)
    tintedCtx.inputs.firstFrame = { assetId: 'img-red', kind: 'image', path: red, mime: 'image/png', width: 64, height: 64 }
    const [a, b, tinted] = await Promise.all([
      runMockJob(adapter, mockJobContext(lib.env, 'mock-video', params, 0)),
      runMockJob(adapter, mockJobContext(lib.env, 'mock-video', params, 1)),
      runMockJob(adapter, tintedCtx),
    ])
    /** Mean Y/U/V of a non-flash frame. */
    const planeMeans = async (path: string) => {
      const { stderr } = await runFfmpeg(['-ss', '0.5', '-i', path, '-vf', 'showinfo', '-frames:v', '1', '-f', 'null', '-'])
      return /mean:\[(\d+) (\d+) (\d+)\]/.exec(stderr)!.slice(1).map(Number)
    }
    const [takeA, takeB, redTinted] = await Promise.all([a, b, tinted].map((o) => planeMeans(filePath(o[0]!))))
    expect(takeB).not.toEqual(takeA)
    expect(redTinted![2]!).toBeGreaterThan(takeA![2]! + 10) // Cr rises under a red tint
    expect((await probeFile(filePath(a[0]!))).hasAudio).toBe(false)
  })

  it('survives a restart: a fresh adapter instance resumes the task from disk', async () => {
    const controller = new AbortController()
    const ctx = { ...mockJobContext(lib.env, 'mock-sfx', { prompt: 'Thunder', durationSeconds: 2 }), signal: controller.signal }
    const submitted = await adapter.submit(ctx)
    if (submitted.type !== 'async') throw new Error('expected an async task')
    // The "old server" dies: its in-flight ffmpeg work is killed before it could finish.
    controller.abort()
    await new Promise((r) => setTimeout(r, 100))
    const taskFile = join(lib.env.tmpDir, 'mock-tasks', `${submitted.taskId}.json`)
    expect(JSON.parse(await readFile(taskFile, 'utf8'))).toMatchObject({ status: 'running' })

    const restarted = createMockAdapter({ env: lib.env })
    const resumed = { ...ctx, signal: new AbortController().signal, providerTaskId: submitted.taskId }
    const [output] = await pollUntilDone(restarted, resumed)
    expect(output).toMatchObject({ kind: 'file', ext: 'wav', name: 'Demo SFX — Thunder' })
    expect((await probeFile(filePath(output!))).durationSeconds).toBeCloseTo(2, 2)
    // Polling again from yet another instance still reports the finished result.
    expect((await createMockAdapter({ env: lib.env }).poll!(resumed)).type).toBe('done')
  })

  it('cancel stops the task and poll reports it', async () => {
    const ctx = mockJobContext(lib.env, 'mock-music', { prompt: 'Long pad', durationSeconds: 30 })
    const submitted = await adapter.submit(ctx)
    if (submitted.type !== 'async') throw new Error('expected an async task')
    ctx.providerTaskId = submitted.taskId
    await adapter.cancel!(ctx)
    const result = await adapter.poll!(ctx)
    expect(result).toMatchObject({ type: 'failed', error: { code: 'canceled' } })
    await new Promise((r) => setTimeout(r, 200))
    expect((await readdir(ctx.tmpDir).catch(() => [])).filter((n) => n.endsWith('.wav'))).toEqual([])
  })

  it('reports unknown tasks as failed instead of hanging', async () => {
    const ctx = { ...mockJobContext(lib.env, 'mock-image', { prompt: 'x' }), providerTaskId: 'mock_does_not_exist' }
    expect(await adapter.poll!(ctx)).toMatchObject({ type: 'failed', error: { code: 'not_found' } })
  })
})
