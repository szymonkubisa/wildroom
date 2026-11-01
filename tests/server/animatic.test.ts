import { mkdirSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppDeps, closeDeps, createApp, createDeps } from '../../src/server/app'
import { loadEnv } from '../../src/server/env'
import { ApiError } from '../../src/server/http'
import { MemorySecretStore } from '../../src/server/services/keychain'
import { demoTrim, fitTrimmedLines, type structuredCall, trimDialogue, wordBudget } from '../../src/server/services/director'
import { gpuSessionsTotal, summarizeSpend } from '../../src/server/services/spend'
import { countWords, leadingTags, looksPolish, speakableText, withoutLeadingTags } from '../../src/server/services/speechText'
import { clampRate, listSayVoices, parseSayVoices, pickVoice, sayAvailable, tempVoiceName } from '../../src/server/services/tempVoice'
import { type GenerationRecord, recordToGeneration } from '../../src/server/storage/records'
import type { AssetDTO } from '../../src/shared/types/assets'
import { TEMP_VOICE_KEYWORD, type ProjectDetail, type ProjectSpendDTO } from '../../src/shared/types/api'

describe('spoken text', () => {
  it('drops audio tags and say commands, keeps leading tags apart', () => {
    expect(speakableText('[whispering] Nie teraz. [sighs] Później.')).toBe('Nie teraz. Później.')
    expect(speakableText('[[slnc 900]]Hello  [[rate 50]] there')).toBe('Hello there')
    expect(leadingTags('  [whispering]   [sighs] Go.')).toBe('[whispering] [sighs]')
    expect(leadingTags('No tag [laughs] here')).toBe('')
    expect(withoutLeadingTags('[softly] Go home.')).toBe('Go home.')
    expect(countWords('[shouting] Run, now — run!')).toBe(3)
  })

  it('spots Polish with or without diacritics', () => {
    expect(looksPolish('Cześć, jak się masz?')).toBe(true)
    expect(looksPolish('Nie wiem, czy to dobrze')).toBe(true)
    expect(looksPolish('I know it is fine')).toBe(false)
  })
})

describe('temp voice (macOS say)', () => {
  const SAY_OUTPUT = [
    'Albert              en_US    # Hello! My name is Albert.',
    'Daniel (English (UK)) en_GB    # Hello! My name is Daniel.',
    'Daniel (English (UK)) en_GB    # Hello! My name is Daniel.',
    'Majed               ar_001   # مرحبًا! اسمي ماجد.',
    'Zosia               pl_PL    # Witaj, nazywam się Zosia.',
    '',
  ].join('\n')
  const voices = parseSayVoices(SAY_OUTPUT)

  it('parses `say -v ?` (names with spaces, duplicates dropped)', () => {
    expect(voices).toEqual([
      { name: 'Albert', locale: 'en_US' },
      { name: 'Daniel (English (UK))', locale: 'en_GB' },
      { name: 'Majed', locale: 'ar_001' },
      { name: 'Zosia', locale: 'pl_PL' },
    ])
  })

  it('picks Zosia for Polish, any Polish voice without her, else the system voice', () => {
    expect(pickVoice('Zostań ze mną', voices)).toBe('Zosia')
    expect(pickVoice('Zostań ze mną', [...voices.filter((v) => v.name !== 'Zosia'), { name: 'Ewa', locale: 'pl_PL' }])).toBe('Ewa')
    expect(pickVoice('Zostań ze mną', voices.filter((v) => v.name !== 'Zosia'))).toBeUndefined()
    expect(pickVoice('Stay with me', voices)).toBeUndefined()
  })

  it('validates a requested voice (say silently falls back for unknown names)', () => {
    expect(pickVoice('Hi', voices, 'daniel')).toBe('Daniel (English (UK))')
    expect(pickVoice('Cześć', voices, 'Albert')).toBe('Albert')
    expect(() => pickVoice('Hi', voices, 'Nobody')).toThrow(ApiError)
    expect(pickVoice('Hi', [], 'Nobody')).toBe('Nobody')
  })

  it('clamps the rate, names the asset and knows where say exists', () => {
    expect(clampRate(undefined)).toBeUndefined()
    expect(clampRate('fast')).toBeUndefined()
    expect(clampRate(20)).toBe(90)
    expect(clampRate(212.4)).toBe(212)
    expect(clampRate(900)).toBe(400)
    expect(tempVoiceName('[whispering] Nie wiem, czy to jest dobry pomysł, naprawdę.')).toBe('Temp voice · Nie wiem, czy to jest dobry…')
    expect(tempVoiceName('Go.')).toBe('Temp voice · Go.')
    expect(sayAvailable('linux', () => true)).toBe(false)
    expect(sayAvailable('darwin', () => false)).toBe(false)
  })
})

describe('trim dialogue', () => {
  const LINES = [
    { speaker: 'Anna', text: "[whispering] I really, honestly don't think we should be going up there tonight, Tomek." },
    { speaker: 'Tomek', text: 'Of course we should, nobody has been up there for years and years.' },
  ]
  const creds = { anthropic: 'test-key' }

  /** A scripted Director: each call returns the next list of lines. */
  function fakeLlm(replies: string[][]) {
    const prompts: string[] = []
    const call = async (_creds: unknown, _system: string, user: string) => {
      prompts.push(user)
      const lines = replies.shift()
      if (!lines) throw new Error('unexpected call')
      return { result: { lines }, via: 'anthropic', model: 'fake-model' }
    }
    return { call: call as unknown as typeof structuredCall, prompts }
  }

  it('returns one line per input line, restoring tags and dropping echoed names', async () => {
    const llm = fakeLlm([['Anna: We shouldn’t go up tonight.', '2. [smug] Nobody goes there anymore.']])
    const res = await trimDialogue({ lines: LINES, maxSeconds: 4, language: 'English' }, creds, false, llm.call)
    expect(res).toEqual({ lines: ['[whispering] We shouldn’t go up tonight.', 'Nobody goes there anymore.'], via: 'anthropic', model: 'fake-model' })
    expect(llm.prompts[0]).toContain(`at most ${wordBudget(4)} spoken words`)
    expect(llm.prompts[0]).toContain('Language: English')
  })

  it('asks again once on a wrong count, then gives up with 502', async () => {
    const retry = fakeLlm([['Just one line.'], ['We shouldn’t.', 'We should.']])
    const ok = await trimDialogue({ lines: LINES, maxSeconds: 3 }, creds, false, retry.call)
    expect(ok.lines).toEqual(['[whispering] We shouldn’t.', 'We should.'])
    expect(retry.prompts[1]).toMatch(/had 1 lines.*exactly 2/s)

    const bad = fakeLlm([['One.'], ['One.', 'Two.', 'Three.']])
    await expect(trimDialogue({ lines: LINES, maxSeconds: 3 }, creds, false, bad.call)).rejects.toMatchObject({ status: 502 })
  })

  it('treats an empty returned line as a wrong answer, and passes empty input lines through', async () => {
    expect(fitTrimmedLines(LINES, ['[whispering]', 'Fine.'])).toBeUndefined()
    const llm = fakeLlm([['Shorter.']])
    const res = await trimDialogue({ lines: [{ speaker: 'A', text: '  ' }, LINES[1]!], maxSeconds: 2 }, creds, false, llm.call)
    expect(res.lines).toEqual(['', 'Shorter.'])
  })

  it('validates input and needs a key unless demo mode is on', async () => {
    await expect(trimDialogue({ lines: [], maxSeconds: 3 }, creds, false)).rejects.toMatchObject({ status: 400 })
    await expect(trimDialogue({ lines: LINES, maxSeconds: 0 }, creds, false)).rejects.toMatchObject({ status: 400 })
    await expect(trimDialogue({ lines: LINES, maxSeconds: 3 }, {}, false)).rejects.toThrow(/Anthropic, OpenRouter or fal\.ai key/)
    const demo = await trimDialogue({ lines: LINES, maxSeconds: 3 }, {}, true)
    expect(demo.via).toBe('demo')
    expect(demo.lines).toHaveLength(2)
    expect(demo.lines[0]!.startsWith('[whispering] ')).toBe(true)
    expect(demo.lines.reduce((n, l) => n + countWords(l), 0)).toBeLessThan(LINES.reduce((n, l) => n + countWords(l.text), 0))
    // Already short enough: unchanged.
    expect(demoTrim([{ speaker: 'A', text: '[softly] Hi.' }], 5)).toEqual(['[softly] Hi.'])
  })
})

describe('project spend', () => {
  const row = (provider: string, modelId: string, status: string, costUsd: number | null, createdAt = '2026-10-01T10:00:00.000Z') => ({
    provider,
    modelId,
    status,
    costUsd,
    createdAt,
  })

  it('sums succeeded jobs and failed ones that report a charge', () => {
    const spend = summarizeSpend([
      row('fal', 'veo-3.1', 'succeeded', 1.2, '2026-10-02T10:00:00.000Z'),
      row('fal', 'veo-3.1', 'succeeded', 0.8),
      row('kling', 'kling-3.0', 'failed', 0.35),
      row('kling', 'kling-3.0', 'failed', null),
      row('local', 'ltx-local', 'succeeded', null, '2026-09-30T08:00:00.000Z'),
      row('runpod', 'ltx-runpod', 'succeeded', 0.0123),
      row('elevenlabs', 'tts', 'queued', null),
      row('elevenlabs', 'tts', 'canceled', null),
    ])
    expect(spend).toEqual({
      totalUsd: 2.3623,
      byProvider: { fal: 2, kling: 0.35, local: 0, runpod: 0.0123 },
      byModel: {
        'veo-3.1': { usd: 2, count: 2 },
        'kling-3.0': { usd: 0.35, count: 1 },
        'ltx-local': { usd: 0, count: 1 },
        'ltx-runpod': { usd: 0.0123, count: 1 },
      },
      count: 5,
      since: '2026-09-30T08:00:00.000Z',
    })
    expect(summarizeSpend([])).toEqual({ totalUsd: 0, byProvider: {}, byModel: {}, count: 0 })
  })

  it('adds up RunPod sessions (machine-wide) only when there are any', () => {
    expect(gpuSessionsTotal([])).toBeUndefined()
    expect(gpuSessionsTotal([{ costUsd: 0.5 }, { costUsd: 0.254 }])).toBe(0.75)
    expect(gpuSessionsTotal([{ costUsd: 0.5 }], 0.3)).toBe(0.8)
  })
})

// ------------------------------------------------------------------------------------------------ routes

const ORIGIN = 'http://127.0.0.1:5180'
const HOST = '127.0.0.1:5180'

describe('routes', () => {
  let root: string
  let deps: AppDeps
  let app: ReturnType<typeof createApp>
  let project: ProjectDetail

  const req = (method: string, path: string, body?: unknown) =>
    app.request(`http://${HOST}${path}`, {
      method,
      headers: { host: HOST, ...(method !== 'GET' ? { origin: ORIGIN, 'x-studio': '1' } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  beforeAll(async () => {
    mkdirSync('tests/.tmp', { recursive: true })
    root = resolve(await mkdtemp(join('tests/.tmp', 'animatic-')))
    deps = createDeps(loadEnv({ home: join(root, 'home'), port: 7778 }), { secrets: new MemorySecretStore() })
    app = createApp(deps)
    project = (await (await req('POST', '/api/projects', { name: 'Animatic' })).json()) as ProjectDetail
  })

  afterAll(async () => {
    await closeDeps(deps)
    rmSync(root, { recursive: true, force: true })
  })

  it('sums the generation records of a project', async () => {
    const store = deps.registry.mounted(project.id)!
    const base: GenerationRecord = {
      id: 'g1',
      modelId: 'mock-video',
      provider: 'mock',
      kind: 'video',
      status: 'succeeded',
      progress: 1,
      label: 'x',
      params: {},
      providerTaskId: null,
      providerMeta: {},
      requestJson: null,
      responseJson: null,
      adapterVersion: null,
      error: null,
      costEstimateUsd: null,
      costUsd: 0.25,
      outputAssetIds: [],
      variant: 0,
      batchId: null,
      queueOrder: null,
      attempts: 1,
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:00:00.000Z',
      startedAt: null,
      finishedAt: null,
    }
    store.putGeneration(recordToGeneration(base, project.id), 'memory')
    store.putGeneration(recordToGeneration({ ...base, id: 'g2', status: 'failed', costUsd: 0.1 }, project.id), 'memory')
    store.putGeneration(recordToGeneration({ ...base, id: 'g3', status: 'failed', costUsd: null }, project.id), 'memory')
    const res = await req('GET', `/api/projects/${project.id}/spend`)
    expect(res.status).toBe(200)
    const spend = (await res.json()) as ProjectSpendDTO
    expect(spend).toMatchObject({ totalUsd: 0.35, byProvider: { mock: 0.35 }, byModel: { 'mock-video': { usd: 0.35, count: 2 } }, count: 2 })
    // RunPod was never used in this test home.
    expect(spend.gpuSessionsUsd).toBeUndefined()
  })

  it('trim-dialogue needs lines, and a key outside demo mode', async () => {
    expect((await req('POST', '/api/director/trim-dialogue', { lines: [], maxSeconds: 3 })).status).toBe(400)
    const body = { lines: [{ speaker: 'A', text: '[softly] Hello there, my old and very dear friend' }], maxSeconds: 1 }
    deps.settings.update({ demoMode: true })
    const demo = await req('POST', '/api/director/trim-dialogue', body)
    expect(demo.status).toBe(200)
    expect(await demo.json()).toEqual({ lines: ['[softly] Hello there…'], via: 'demo', model: 'local rules' })
    deps.settings.update({ demoMode: false })
    expect((await req('POST', '/api/director/trim-dialogue', body)).status).toBe(400)
  })

  it('temp-voice rejects empty text', async () => {
    const res = await req('POST', `/api/projects/${project.id}/temp-voice`, { text: '  [whispering]  ' })
    expect(res.status).toBe(400)
  })

  it.skipIf(!sayAvailable())('speaks a Polish line into a tagged audio asset', async () => {
    const res = await req('POST', `/api/projects/${project.id}/temp-voice`, { text: '[whispering] Cześć, to tylko test.' })
    expect(res.status).toBe(201)
    const asset = (await res.json()) as AssetDTO
    expect(asset).toMatchObject({ kind: 'audio', source: 'derived', role: 'dialogue', keywords: [TEMP_VOICE_KEYWORD] })
    expect(asset.name).toBe('Temp voice · Cześć, to tylko test.')
    const ready = await deps.media.whenReady(asset.id)
    expect(ready.durationFlicks).toBeGreaterThan(0)
    const meta = deps.media.get(asset.id)!.meta
    expect(meta).toMatchObject({ tempVoice: true, text: 'Cześć, to tylko test.' })
    const polish = (await listSayVoices()).some((v) => v.locale.startsWith('pl'))
    if (polish) expect(String(meta.voice)).not.toBe('system default')
    // An unknown voice is refused instead of silently using the default.
    expect((await req('POST', `/api/projects/${project.id}/temp-voice`, { text: 'Hi', voice: 'No Such Voice' })).status).toBe(400)
  })
})
