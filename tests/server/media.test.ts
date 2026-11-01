import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { imageSizeFromFile } from 'image-size/fromFile'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { flicksToSeconds, secondsToFlicks } from '../../src/shared/time/flicks'
import type { AssetDTO, AssetVariant } from '../../src/shared/types/assets'
import type { ServerEvent } from '../../src/shared/types/events'
import { createMockAdapter } from '../../src/server/providers/mock'
import { extractFrame, runFfmpeg } from '../../src/server/services/ffmpeg'
import {
  computeWaveformPeaks,
  derivedDir,
  filmstripFrameIndices,
  IngestQueue,
  filmstripLayout,
  INGEST_STEP_VERSIONS,
  proxyFrameRate,
} from '../../src/server/services/ingest'
import { MediaStore } from '../../src/server/services/mediaStore'
import { probeFile } from '../../src/server/services/probe'
import { readJsonFile } from '../../src/server/storage/atomicFile'
import { DerivedCache } from '../../src/server/storage/derivedCache'
import type { ProjectStore } from '../../src/server/storage/projectStore'
import type { AssetRecord } from '../../src/server/storage/records'
import { ProjectRegistry } from '../../src/server/storage/registry'
import { createTestHome, detectFlashes, filePath, measureAvSync, mockJobContext, runMockJob, type TestHome } from './sync-utils'

const FPS = 24
const FRAME = 1 / FPS

let lib: TestHome
let store: MediaStore
const projects = new Map<string, ProjectStore>()
/** A project bundle per test scenario (created on first use). */
function pid(name: string): string {
  let project = projects.get(name)
  if (!project) {
    project = lib.project(name)
    projects.set(name, project)
  }
  return project.id
}
let fixtures: string
/** 3 s, 24 fps, 1280x720 mock clip with flash + beep on every second (kept outside the store). */
let clipPath: string
let clip: AssetDTO

beforeAll(async () => {
  lib = await createTestHome('media')
  store = new MediaStore({ env: lib.env, events: lib.events, registry: lib.registry, cache: lib.cache })
  fixtures = join(lib.dir, 'fixtures')
  await mkdir(fixtures, { recursive: true })
  const adapter = createMockAdapter({ env: lib.env })
  const [output] = await runMockJob(
    adapter,
    mockJobContext(lib.env, 'mock-video', { prompt: 'Sync fixture: a lighthouse at dusk', duration: 3, fps: FPS, aspectRatio: '16:9', audio: true }),
  )
  clipPath = join(fixtures, 'clip.mp4')
  await copyFile(filePath(output!), clipPath)
}, 60_000)

afterAll(async () => {
  await store?.close()
  await lib?.dispose()
})

function variantFile(asset: AssetDTO, variant: AssetVariant): string {
  const path = store.variantPath(store.get(asset.id)!, variant)
  if (!path) throw new Error(`variant ${variant} missing for ${asset.name}`)
  return path
}

describe('video import + ingest', () => {
  it('probes, publishes and produces every variant for a generated clip', async () => {
    const events: ServerEvent[] = []
    const unsubscribe = lib.events.subscribe((e) => events.push(e))
    const imported = await store.importFile(clipPath, {
      name: 'Lighthouse',
      source: 'generation',
      projectId: pid('p1'),
      generationId: 'gen-1',
      generation: {
        generationId: 'gen-1',
        modelId: 'mock-video',
        modelLabel: 'Demo Video',
        provider: 'mock',
        prompt: 'Sync fixture: a lighthouse at dusk',
        params: { duration: 3 },
      },
    })
    // Probe metadata is available immediately, before ingest finishes.
    expect(imported.status).toBe('processing')
    expect(imported.kind).toBe('video')
    expect(Math.abs(flicksToSeconds(imported.durationFlicks!) - 3)).toBeLessThan(FRAME)
    expect(imported.projectIds).toEqual([pid('p1')])
    // The bundle holds the original and the asset record.
    const project = projects.get('p1')!
    expect(store.originalPath(store.get(imported.id)!)).toBe(join(project.root, 'Media', `${store.get(imported.id)!.sha256}.mp4`))
    expect(readJsonFile<AssetRecord>(join(project.root, 'Assets', `${imported.id}.json`))?.value).toMatchObject({
      id: imported.id,
      name: 'Lighthouse',
      kind: 'video',
      generationId: 'gen-1',
    })

    clip = await store.whenReady(imported.id)
    unsubscribe()
    expect(clip.status).toBe('ready')
    expect(clip.error).toBeUndefined()
    expect(clip).toMatchObject({ width: 1280, height: 720, fps: 24, hasVideo: true, hasAudio: true, sampleRate: 48000, channels: 2 })
    expect(clip.videoCodec).toBe('avc')
    expect(clip.audioCodec).toBe('aac')
    expect(clip.mime).toBe('video/mp4')
    expect(clip.durationFlicks).toBe(secondsToFlicks(3))
    expect(clip.timeOffset).toBe(0)
    expect(clip.generation?.prompt).toBe('Sync fixture: a lighthouse at dusk')
    expect(clip.variants).toEqual({ original: true, proxy: true, audio: true, poster: true, filmstrip: true, waveform: true })
    for (const variant of Object.keys(clip.variants) as AssetVariant[]) expect(existsSync(variantFile(clip, variant))).toBe(true)

    // Events: inserted as processing, 'ready' once proxy + wav exist, then again with the later variants.
    const updates = events.flatMap((e) => (e.type === 'asset.upserted' && e.asset.id === clip.id ? [e.asset] : []))
    expect(updates[0]!.status).toBe('processing')
    const firstReady = updates.findIndex((a) => a.status === 'ready')
    expect(firstReady).toBeGreaterThan(0)
    expect(updates[firstReady]!.variants.proxy).toBe(true)
    expect(updates[firstReady]!.variants.audio).toBe(true)
    expect(updates.at(-1)!.variants.filmstrip).toBe(true)

    // Proxy: CFR 24 fps, 720p, no audio, exactly 72 frames.
    const proxy = await probeFile(variantFile(clip, 'proxy'))
    expect(proxy).toMatchObject({ kind: 'video', width: 1280, height: 720, fps: 24, hasAudio: false })
    expect(Math.abs(proxy.durationSeconds! - 3)).toBeLessThan(1e-6)

    // WAV: 48 kHz stereo.
    const wav = await probeFile(variantFile(clip, 'audio'))
    expect(wav).toMatchObject({ kind: 'audio', sampleRate: 48000, channels: 2, audioCodec: 'pcm-s16' })

    // Poster ≤ 640 wide.
    const poster = await imageSizeFromFile(variantFile(clip, 'poster'))
    expect(poster).toMatchObject({ width: 640, height: 360 })

    // Filmstrip: 6 tiles of 128x72 sampled every 0.5 s, one row.
    expect(clip.filmstrip).toEqual({ interval: 0.5, count: 6, tileWidth: 128, tileHeight: 72, columns: 6 })
    const strip = await imageSizeFromFile(variantFile(clip, 'filmstrip'))
    expect(strip).toMatchObject({ width: 6 * 128, height: 72 })

    // Waveform: 100 peaks/s; the beeps (0.5 amplitude) sit at 0, 1 and 2 s, silence in between.
    expect(clip.waveformRate).toBe(100)
    const peaks = new Uint8Array(await readFile(variantFile(clip, 'waveform')))
    expect(peaks.length).toBeGreaterThanOrEqual(300)
    expect(peaks.length).toBeLessThanOrEqual(302)
    for (const at of [0, 100, 200]) expect(peaks[at]).toBeGreaterThan(100)
    for (const at of [50, 150, 250]) expect(peaks[at]).toBeLessThan(3)

    expect(clip.loudness?.integratedLufs).toBeLessThan(-10)
    expect(Number.isFinite(clip.loudness?.truePeakDb)).toBe(true)
  })

  it('keeps flash frames and beeps aligned within one frame (A/V sync fixture)', async () => {
    const report = await measureAvSync(variantFile(clip, 'proxy'), variantFile(clip, 'audio'))
    console.info(
      `[sync] flashes=${report.flashes.map((t) => t.toFixed(4)).join(',')} beeps=${report.beeps
        .map((t) => t.toFixed(5))
        .join(',')} max |A-V| = ${(report.maxAbsOffset * 1000).toFixed(3)} ms`,
    )
    expect(report.flashes).toHaveLength(3)
    report.flashes.forEach((t, i) => expect(Math.abs(t - i)).toBeLessThan(1e-3))
    expect(report.beeps).toHaveLength(3)
    expect(report.maxAbsOffset).toBeLessThanOrEqual(FRAME)

    // The original is in sync too (the fixture itself is correct).
    const original = await measureAvSync(variantFile(clip, 'original'))
    expect(original.maxAbsOffset).toBeLessThanOrEqual(FRAME)
  })

  it('normalises the time origin when audio starts later or earlier than video', async () => {
    const delay = 0.25
    const lateAudio = join(fixtures, 'late-audio.mp4')
    const lateVideo = join(fixtures, 'late-video.mp4')
    // Remux with one stream shifted: an empty edit / offset start in the MP4.
    await runFfmpeg(['-i', clipPath, '-itsoffset', String(delay), '-i', clipPath, '-map', '0:v', '-map', '1:a', '-c', 'copy', lateAudio])
    await runFfmpeg(['-itsoffset', String(delay), '-i', clipPath, '-i', clipPath, '-map', '0:v', '-map', '1:a', '-c', 'copy', lateVideo])

    const [a, v] = await Promise.all([
      store.importFile(lateAudio, { name: 'Late audio', source: 'import', projectId: pid('p-sync') }).then((x) => store.whenReady(x.id)),
      store.importFile(lateVideo, { name: 'Late video', source: 'import', projectId: pid('p-sync') }).then((x) => store.whenReady(x.id)),
    ])
    expect(a.status).toBe('ready')
    expect(v.status).toBe('ready')

    // Audio starts late: the wav is padded, so beeps land `delay` after the flashes.
    expect(a.timeOffset).toBe(0)
    const lateAudioSync = await measureAvSync(variantFile(a, 'proxy'), variantFile(a, 'audio'))
    expect(Math.abs(lateAudioSync.medianOffset - delay)).toBeLessThanOrEqual(FRAME)

    // Video starts late: t=0 is the first video frame, the audio before it is trimmed.
    expect(Math.abs(v.timeOffset! - delay)).toBeLessThan(1e-3)
    const lateVideoSync = await measureAvSync(variantFile(v, 'proxy'), variantFile(v, 'audio'))
    expect(lateVideoSync.flashes[0]).toBeCloseTo(0, 3)
    expect(Math.abs(lateVideoSync.medianOffset + delay)).toBeLessThanOrEqual(FRAME)
  })

  it('extracts the exact frame on screen at a time (original and proxy agree)', async () => {
    const dir = join(fixtures, 'frames')
    await mkdir(dir, { recursive: true })
    const isFlash = async (path: string) => (await detectFlashes(path)).length === 1
    const cases: Array<[number, boolean]> = [
      [24 + 0.5, true], // centre of frame 24 → the flash frame
      [23 + 0.5, false],
      [25 + 0.5, false],
      [48 + 0.99, true], // late in frame 48 is still frame 48
    ]
    for (const [framePos, flash] of cases) {
      for (const source of ['original', 'proxy'] as const) {
        const out = join(dir, `${source}-${framePos}.png`)
        await extractFrame(variantFile(clip, source), framePos / FPS, out)
        expect(await isFlash(out), `${source} @ frame ${framePos}`).toBe(flash)
      }
    }
    const small = join(dir, 'small.jpg')
    await extractFrame(variantFile(clip, 'original'), 1.5, small, { width: 320 })
    expect(await imageSizeFromFile(small)).toMatchObject({ width: 320, height: 180 })
  })
})

describe('content-addressed store', () => {
  it('dedupes identical imports: two records, one original per bundle, one set of cache files', async () => {
    const [x, y] = await Promise.all([
      store.importFile(clipPath, { name: 'Copy A', source: 'import', projectId: pid('p-dedupe') }),
      store.importFile(clipPath, { name: 'Copy B', source: 'import', projectId: pid('p-dedupe') }),
    ])
    const [a, b] = await Promise.all([store.whenReady(x.id), store.whenReady(y.id)])
    expect(a.id).not.toBe(b.id)
    expect(a.status).toBe('ready')
    expect(b.status).toBe('ready')
    const rowA = store.get(a.id)!
    const rowB = store.get(b.id)!
    expect(rowA.sha256).toBe(rowB.sha256)
    expect(rowA.sha256).toBe(store.get(clip.id)!.sha256)
    expect(store.originalPath(rowA)).toBe(store.originalPath(rowB))
    const bundle = projects.get('p-dedupe')!.root
    expect(store.originalPath(rowA)).toBe(join(bundle, 'Media', `${rowA.sha256}.mp4`))
    expect(await readdir(join(bundle, 'Media'))).toEqual([`${rowA.sha256}.mp4`])
    // Another project keeps its own copy of the original (bundles are self-contained), sharing the cache.
    expect(store.originalPath(store.get(clip.id)!)).toBe(join(projects.get('p1')!.root, 'Media', `${rowA.sha256}.mp4`))
    expect(existsSync(store.originalPath(store.get(clip.id)!))).toBe(true)

    const cached = (await readdir(derivedDir(lib.env, rowA.sha256!))).sort()
    const v = INGEST_STEP_VERSIONS
    expect(cached).toEqual(
      [
        `audio-v${v.audio}.wav`,
        `filmstrip-v${v.filmstrip}.jpg`,
        `loudness-v${v.loudness}.json`,
        `poster-v${v.poster}.jpg`,
        `proxy-v${v.proxy}.mp4`,
        'state.json',
        `waveform-v${v.waveform}.bin`,
      ].sort(),
    )
    for (const variant of ['proxy', 'audio', 'poster', 'filmstrip', 'waveform'] as const) {
      expect(store.variantPath(rowA, variant)).toBe(store.variantPath(rowB, variant))
    }
    expect(a.filmstrip).toEqual(clip.filmstrip)
    expect(a.loudness).toEqual(clip.loudness)
  })
})

describe('audio and image imports', () => {
  it('audio-only: wav + waveform + loudness, no picture variants', async () => {
    const adapter = createMockAdapter({ env: lib.env })
    const [music] = await runMockJob(adapter, mockJobContext(lib.env, 'mock-music', { prompt: 'Warm pad', durationSeconds: 5 }))
    const imported = await store.importFile(filePath(music!), { name: music!.name!, source: 'generation', projectId: pid('p-audio'), move: true })
    expect(existsSync(filePath(music!))).toBe(false) // moved into the store
    const asset = await store.whenReady(imported.id)
    expect(asset).toMatchObject({ kind: 'audio', status: 'ready', hasVideo: false, hasAudio: true, sampleRate: 48000, channels: 2 })
    expect(asset.variants).toEqual({ original: true, audio: true, waveform: true })
    expect(Math.abs(flicksToSeconds(asset.durationFlicks!) - 5)).toBeLessThan(0.01)
    expect(asset.timeOffset).toBe(0)
    const peaks = await readFile(variantFile(asset, 'waveform'))
    expect(Math.abs(peaks.length - 500)).toBeLessThanOrEqual(1)
    expect(Math.max(...peaks)).toBeGreaterThan(50)
    expect(asset.loudness?.integratedLufs).toBeLessThan(0)

    // An MP3 (encoder delay behind a LAME header) keeps the same duration through ingest.
    const mp3 = join(fixtures, 'music.mp3')
    await runFfmpeg(['-i', variantFile(asset, 'original'), '-c:a', 'libmp3lame', '-b:a', '192k', mp3])
    const fromMp3 = await store.whenReady((await store.importFile(mp3, { name: 'MP3', source: 'import', projectId: pid('p-audio') })).id)
    expect(fromMp3).toMatchObject({ kind: 'audio', status: 'ready', mime: 'audio/mpeg' })
    expect(fromMp3.variants).toEqual({ original: true, audio: true, waveform: true })
    const wav = await probeFile(variantFile(fromMp3, 'audio'))
    expect(Math.abs(wav.durationSeconds! - flicksToSeconds(fromMp3.durationFlicks!))).toBeLessThan(0.05)
  })

  it('image: a 640-wide poster and a display copy that keeps alpha', async () => {
    const adapter = createMockAdapter({ env: lib.env })
    const [image] = await runMockJob(adapter, mockJobContext(lib.env, 'mock-image', { prompt: 'A red fox in snow', aspectRatio: '16:9' }))
    const asset = await store.whenReady(
      (await store.importFile(filePath(image!), { name: image!.name!, source: 'generation', projectId: pid('p-img') })).id,
    )
    expect(asset).toMatchObject({ kind: 'image', status: 'ready', mime: 'image/png', width: 1280, height: 720, hasVideo: false, hasAudio: false })
    expect(asset.durationFlicks).toBeUndefined()
    expect(asset.variants).toEqual({ original: true, poster: true, display: true })
    expect(await imageSizeFromFile(variantFile(asset, 'poster'))).toMatchObject({ width: 640, height: 360 })
    // Under the 2048 px cap: the display copy keeps the original size.
    expect(await imageSizeFromFile(variantFile(asset, 'display'))).toMatchObject({ width: 1280, height: 720, type: 'webp' })
    expect(store.variantPath(store.get(asset.id)!, 'proxy')).toBeUndefined()
  })

  it('svg: imports a transparent PNG rendering and keeps the original SVG beside it', async () => {
    const svgPath = join(fixtures, 'logo.svg')
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><circle cx="50" cy="50" r="40" fill="#e33"/></svg>'
    await writeFile(svgPath, svg)
    const asset = await store.whenReady((await store.importFile(svgPath, { name: 'Logo', source: 'generation', projectId: pid('p-svg') })).id)
    expect(asset).toMatchObject({ kind: 'image', status: 'ready', mime: 'image/png', width: 2048, height: 1024, vector: true })
    expect(asset.variants).toEqual({ original: true, poster: true, display: true })
    const row = store.get(asset.id)!
    expect(store.originalPath(row)).toMatch(/\.png$/)
    expect(await readFile(store.vectorPath(row)!, 'utf8')).toBe(svg)
    expect(existsSync(svgPath)).toBe(true) // copied, not moved

    // Adding it to another project copies the SVG into that bundle too.
    const copy = store.get((await store.linkToProject(asset.id, pid('p-svg-2'))).id)!
    expect(store.vectorPath(copy)!.startsWith(projects.get('p-svg-2')!.root)).toBe(true)
    expect(await readFile(store.vectorPath(copy)!, 'utf8')).toBe(svg)
  })

  it('rejects unsupported files with a clear error', async () => {
    const junk = join(fixtures, 'notes.txt')
    await writeFile(junk, 'definitely not media')
    await expect(store.importFile(junk, { name: 'Notes', source: 'import', projectId: pid('p-x') })).rejects.toThrow(/Unsupported/)
  })
})

describe('robustness', () => {
  it('settles an ingest whose failure cannot even be recorded (a read-only cache), and says so', async () => {
    const broken = join(fixtures, 'not-media.mp4')
    await writeFile(broken, 'not a video')
    const cache = {
      state: () => undefined,
      setState: () => {
        throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' })
      },
    } as unknown as DerivedCache
    const settled: string[] = []
    const queue = new IngestQueue({ env: lib.env, cache, onChange: () => {}, onSettled: (sha) => settled.push(sha) })
    const sha = 'f'.repeat(64)
    // Before: the rejection escaped the queue (unhandled — fatal for the server process).
    await queue.ensure(sha, () => broken)
    expect(settled).toEqual([sha])
    expect(queue.pendingShas().size).toBe(0)
    await queue.close()
  })

  it('resumes an interrupted ingest on the next start and regenerates missing cache files', async () => {
    const source = join(fixtures, 'resume.mp4')
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source])
    // Each "run" of the server: its own registry, cache index and media store over the same folders.
    const boot = () => {
      const registry = new ProjectRegistry({ env: lib.env, appState: lib.appState, events: lib.events })
      const media = new MediaStore({ env: lib.env, events: lib.events, registry, cache: new DerivedCache(lib.env) })
      return { registry, media }
    }
    const run1 = boot()
    const bundle = run1.registry.create({ name: 'Resume' })
    const imported = await run1.media.importFile(source, { name: 'Interrupted', source: 'import', projectId: bundle.id })
    await run1.media.close() // server stops mid-ingest: ffmpeg is killed, the state stays 'processing'
    expect(run1.media.get(imported.id)!.status).toBe('processing')
    run1.registry.closeAll()

    const run2 = boot()
    run2.registry.open(bundle.root)
    const second = run2.media
    try {
      const ready = await second.whenReady(imported.id)
      expect(ready.status).toBe('ready')
      expect(ready.variants).toEqual({ original: true, proxy: true, poster: true, filmstrip: true })
      const row = second.get(imported.id)!
      expect((await readdir(derivedDir(lib.env, row.sha256!))).filter((n) => n.includes('.tmp-'))).toEqual([])

      // A cached file disappears (cache cleared / step version bumped): serving it schedules a re-ingest.
      const proxy = second.variantPath(row, 'proxy')!
      await rm(proxy)
      expect(second.variantPath(row, 'proxy')).toBeUndefined()
      expect(second.get(row.id)!.status).toBe('processing')
      expect((await second.whenReady(row.id)).status).toBe('ready')
      expect(existsSync(proxy)).toBe(true)
    } finally {
      await second.close()
      run2.registry.closeAll()
    }

    // Stopped after 'ready' but before the later steps: the next start finishes them.
    const sha = readJsonFile<AssetRecord>(join(bundle.root, 'Assets', `${imported.id}.json`))!.value.sha256
    new DerivedCache(lib.env).setState(sha!, { variants: { original: true, proxy: true, poster: true }, filmstrip: undefined, pending: true })
    const run3 = boot()
    run3.registry.open(bundle.root)
    const third = run3.media
    try {
      const finished = await third.whenReady(imported.id)
      expect(finished.variants.filmstrip).toBe(true)
      expect(finished.filmstrip?.count).toBe(8)
      expect(third.get(imported.id)!.meta).toEqual({})
      expect(lib.cache.state(sha!)).toBeDefined()
    } finally {
      await third.close()
      run3.registry.closeAll()
    }
  })

  it('handles rotation metadata, anamorphic pixels, silent and tiny clips', async () => {
    const rotated = join(fixtures, 'rotated.mp4')
    const anamorphic = join(fixtures, 'anamorphic.mp4')
    const tiny = join(fixtures, 'tiny.mp4')
    await runFfmpeg(['-i', clipPath, '-c', 'copy', '-metadata:s:v:0', 'rotate=90', rotated])
    const x264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=25:duration=2', '-vf', 'setsar=32/27', ...x264, anamorphic])
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24', '-frames:v', '2', ...x264, tiny])
    const [r, a, t] = await Promise.all(
      [rotated, anamorphic, tiny].map(async (path) =>
        store.whenReady((await store.importFile(path, { name: path, source: 'import', projectId: pid('p-edge') })).id),
      ),
    )

    // Display orientation everywhere: 90° CCW display matrix = 270° clockwise.
    expect(r).toMatchObject({ status: 'ready', width: 720, height: 1280, rotation: 270 })
    expect(await probeFile(variantFile(r!, 'proxy'))).toMatchObject({ width: 404, height: 720, rotation: 0 })
    expect(await imageSizeFromFile(variantFile(r!, 'poster'))).toMatchObject({ width: 640, height: 1136 })
    expect((await measureAvSync(variantFile(r!, 'proxy'), variantFile(r!, 'audio'))).maxAbsOffset).toBeLessThanOrEqual(FRAME)

    // 640x480 with 32:27 pixels displays as 759x480; the proxy has square pixels.
    expect(a).toMatchObject({ status: 'ready', width: 759, height: 480, hasAudio: false })
    expect(a!.variants).toEqual({ original: true, proxy: true, poster: true, filmstrip: true })
    expect(await probeFile(variantFile(a!, 'proxy'))).toMatchObject({ width: 758, height: 480 })

    // Two frames: never more filmstrip tiles than frames.
    expect(t).toMatchObject({ status: 'ready' })
    expect(t!.filmstrip).toMatchObject({ count: 2, columns: 2 })
  })

  it('applies EXIF orientation to stills and reads HEIC', async () => {
    const plain = join(fixtures, 'plain.jpg')
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=1', '-frames:v', '1', plain])
    const rotatedJpeg = join(fixtures, 'exif6.jpg')
    await writeFile(rotatedJpeg, withExifOrientation(await readFile(plain), 6))
    const jpeg = await store.whenReady((await store.importFile(rotatedJpeg, { name: 'Portrait', source: 'import', projectId: pid('p-img') })).id)
    expect(jpeg).toMatchObject({ status: 'ready', kind: 'image', mime: 'image/jpeg', width: 360, height: 640, rotation: 90 })
    expect(await imageSizeFromFile(variantFile(jpeg, 'poster'))).toMatchObject({ width: 360, height: 640 })

    if (process.platform !== 'darwin') return // HEIC fixtures are made (and decoded) with macOS sips
    const heic = join(fixtures, 'still.heic')
    execFileSync('sips', ['-s', 'format', 'heic', plain, '--out', heic], { stdio: 'ignore' })
    const still = await store.whenReady((await store.importFile(heic, { name: 'HEIC', source: 'import', projectId: pid('p-img') })).id)
    expect(still).toMatchObject({ status: 'ready', mime: 'image/heic', width: 640, height: 360 })
    expect(await imageSizeFromFile(variantFile(still, 'poster'))).toMatchObject({ width: 640, height: 360 })
  })
})

/** Inserts a minimal EXIF APP1 segment carrying only the Orientation tag right after the JPEG SOI marker. */
function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0])
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const length = Buffer.alloc(2)
  length.writeUInt16BE(payload.length + 2)
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), length, payload, jpeg.subarray(2)])
}

describe('project membership and library queries', () => {
  it('removing soft-deletes; linking restores, or copies the asset into another project', async () => {
    const asset = await store.importFile(clipPath, { name: 'Shared shot', source: 'import', projectId: pid('p-a') })
    await store.whenReady(asset.id)
    const copy = await store.linkToProject(asset.id, pid('p-b'))
    expect(copy.id).not.toBe(asset.id)
    expect(copy.projectIds).toEqual([pid('p-b')])
    expect(copy.name).toBe('Shared shot')
    const copyRow = store.get(copy.id)!
    expect(copyRow.sha256).toBe(store.get(asset.id)!.sha256)
    expect(store.originalPath(copyRow).startsWith(projects.get('p-b')!.root)).toBe(true)
    expect(existsSync(store.originalPath(copyRow))).toBe(true)

    const events: ServerEvent[] = []
    const unsubscribe = lib.events.subscribe((e) => events.push(e))
    store.removeFromProject(asset.id, pid('p-a'))
    const row = store.get(asset.id)!
    expect(row.deletedAt).not.toBeNull()
    expect(store.list(pid('p-a')).map((a) => a.id)).not.toContain(asset.id)
    expect(store.list(pid('p-b')).map((a) => a.id)).toContain(copy.id)
    expect(existsSync(store.originalPath(row))).toBe(true) // files are never deleted here
    unsubscribe()
    expect(events.filter((e) => e.type === 'asset.removed').length).toBe(1)

    // Linking again restores it.
    await store.linkToProject(asset.id, pid('p-a'))
    expect(store.get(asset.id)!.deletedAt).toBeNull()
    expect(store.list(pid('p-a')).map((a) => a.id)).toEqual([asset.id])
  })

  it('lists newest first, filters by kind and searches names and prompts', async () => {
    const one = await store.importFile(clipPath, {
      name: 'Harbour wide',
      source: 'generation',
      projectId: pid('p-list'),
      generation: { generationId: 'g', modelId: 'mock-video', modelLabel: 'Demo', provider: 'mock', prompt: 'Foggy 100% harbour', params: {} },
    })
    const two = await store.importFile(variantFile(clip, 'poster'), { name: 'Poster still', source: 'derived', projectId: pid('p-list'), parentIds: [clip.id] })
    await Promise.all([store.whenReady(one.id), store.whenReady(two.id)])

    expect(store.list(pid('p-list')).map((a) => a.id)).toEqual([two.id, one.id])
    expect(store.list(pid('p-list'), { kind: 'image' }).map((a) => a.id)).toEqual([two.id])
    expect(store.list(pid('p-list'), { search: 'harbour' }).map((a) => a.id)).toEqual([one.id])
    expect(store.list(pid('p-list'), { search: 'foggy' }).map((a) => a.id)).toEqual([one.id]) // prompt only
    expect(store.list(pid('p-list'), { search: '100%' }).map((a) => a.id)).toEqual([one.id]) // literal substring match
    expect(store.list(pid('p-list'), { search: '1%0' })).toEqual([])
    expect(store.getDTO(two.id)!.parentIds).toEqual([clip.id])

    const updated = store.update(one.id, { name: 'Harbour (fav)', rating: 1, keywords: ['sea', ' sea ', 'fog'], role: 'video' })
    expect(updated).toMatchObject({ name: 'Harbour (fav)', rating: 1, keywords: ['sea', 'fog'], role: 'video' })
    const withMeta = store.setMeta(one.id, { alignment: [1, 2, 3] })
    expect(withMeta.generation?.prompt).toBe('Foggy 100% harbour')
    expect(store.get(one.id)!.meta).toMatchObject({ alignment: [1, 2, 3] })
    // Changes land in the bundle's record file.
    projects.get('p-list')!.flushSync()
    expect(readJsonFile<AssetRecord>(join(projects.get('p-list')!.root, 'Assets', `${one.id}.json`))?.value).toMatchObject({
      name: 'Harbour (fav)',
      rating: 1,
      keywords: ['sea', 'fog'],
      meta: { alignment: [1, 2, 3] },
    })
  })
})

describe('ingest helpers', () => {
  it('filmstrip layout follows the tile rules', () => {
    expect(filmstripLayout(3, 1280, 720)).toEqual({ interval: 0.5, count: 6, tileWidth: 128, tileHeight: 72, columns: 6 })
    expect(filmstripLayout(1, 720, 1280)).toMatchObject({ count: 4, interval: 0.25, tileWidth: 40, columns: 4 })
    expect(filmstripLayout(600, 1920, 1080)).toMatchObject({ count: 120, interval: 5, columns: 12 })
    expect(filmstripLayout(0.1, 1280, 720, 3)).toMatchObject({ count: 3 }) // never more tiles than frames
    const info = filmstripLayout(3, 1280, 720)
    expect(filmstripFrameIndices(info, 24, 72)).toEqual([6, 18, 30, 42, 54, 66])
  })

  it('proxy frame rate keeps NTSC rates exact', () => {
    expect(proxyFrameRate(29.97)).toMatchObject({ arg: '30000/1001' })
    expect(proxyFrameRate(23.976)).toMatchObject({ arg: '24000/1001' })
    expect(proxyFrameRate(25)).toEqual({ value: 25, arg: '25' })
    expect(proxyFrameRate(12.3456)).toEqual({ value: 12.346, arg: '12.346' })
    expect(proxyFrameRate(undefined).value).toBe(30)
  })

  it('waveform peaks: mono mix, max |sample| per bucket, 0..255', async () => {
    const wav = join(fixtures, 'square.wav')
    // 0.5 s full-scale left channel, silent right → mono mix peaks at ~50 %; then 0.5 s silence.
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      "aevalsrc=exprs='if(lt(t,0.5),0.999,0)|0':s=48000:d=1",
      '-c:a',
      'pcm_s16le',
      wav,
    ])
    const peaks = await computeWaveformPeaks(wav, 100)
    expect(peaks.length).toBe(100)
    expect(peaks[10]).toBe(127)
    expect(peaks[49]).toBe(127)
    expect(peaks[50]).toBe(0)
    expect(peaks[99]).toBe(0)
  })
})
