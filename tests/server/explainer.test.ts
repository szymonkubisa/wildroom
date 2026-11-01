import { mkdirSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppDeps, closeDeps, createApp, createDeps } from '../../src/server/app'
import { loadEnv } from '../../src/server/env'
import { type RawPlan, demoPlan, sanitizePlan, type structuredCall } from '../../src/server/services/director'
import { demoExplainer, explainerSystem, explainerUserPrompt, planExplainer } from '../../src/server/services/explainer'
import { MemorySecretStore } from '../../src/server/services/keychain'
import type { DirectorContext } from '../../src/shared/director/plan'
import type { ExplainerResponse, RawExplainer } from '../../src/shared/motion/explainer'

const PROJECT: DirectorContext = {
  name: 'Solar',
  script: { length: 0, excerpt: '', edited: false },
  brandOn: false,
  models: {},
  cast: [],
  places: [],
  scenes: [],
  storyCut: false,
}

const step = (o: Partial<RawPlan['steps'][number]>): RawPlan['steps'][number] => ({
  op: 'create-explainer',
  title: '',
  sceneIds: [],
  shotIds: [],
  targetId: '',
  afterShotId: '',
  look: '',
  text: '',
  view: '',
  quality: '',
  again: false,
  light: '',
  time: '',
  shotType: '',
  seconds: 0,
  lengths: [],
  ...o,
})

const written: RawExplainer = {
  title: 'Solar in a minute',
  style: 'flat illustration',
  scenes: [
    {
      title: 'Light in',
      voiceover: 'Sunlight lands on the panel.',
      zoom: true,
      layout: 'column',
      elements: [
        { kind: 'title', text: 'Light in', prompt: '', shape: '', cue: '', animation: 'slide-up-in', key: '' },
        { kind: 'image', text: '', prompt: 'a solar panel in sunlight', shape: '', cue: 'panel', animation: 'pop', key: '' },
      ],
    },
  ],
}

describe('create-explainer in the Director’s plan', () => {
  it('takes the topic from the step’s text (else the message) and clamps the length', () => {
    const { steps } = sanitizePlan({ reply: 'Ok.', steps: [step({ text: 'How solar panels work', seconds: 999 })] }, { message: 'Explain solar', project: PROJECT })
    expect(steps).toEqual([{ op: 'create-explainer', title: 'Make the explainer', topic: 'How solar panels work', seconds: 600 }])
    const styled = sanitizePlan({ reply: 'Ok.', steps: [step({ text: 'Solar', seconds: 40, look: 'dark-editorial' }), step({ text: 'Solar', seconds: 40, look: 'neon' })] }, { message: 'x', project: PROJECT })
    expect(styled.steps.map((s) => (s.op === 'create-explainer' ? s.style : 'x'))).toEqual(['dark-editorial', undefined])
    const second = sanitizePlan({ reply: 'Ok.', steps: [step({ seconds: 0 })] }, { message: 'Explain solar', project: PROJECT })
    expect(second.steps).toEqual([{ op: 'create-explainer', title: 'Make the explainer', topic: 'Explain solar', seconds: 45 }])
  })

  it('demo rules plan an explainer when asked for one', () => {
    const raw = demoPlan({ message: 'Make a 30 seconds explainer about solar panels', project: PROJECT })
    const { steps } = sanitizePlan(raw, { message: 'x', project: PROJECT })
    expect(steps).toEqual([{ op: 'create-explainer', title: 'Make the explainer', topic: 'Make a 30 seconds explainer about solar panels', seconds: 30 }])
  })
})

describe('planExplainer', () => {
  it('asks the text model with the explainer prompt and validates what it writes', async () => {
    const calls: { system: string; user: string }[] = []
    const call = (async (_creds: unknown, system: string, user: string) => {
      calls.push({ system, user })
      return { result: written, via: 'openrouter', model: 'test-model' }
    }) as unknown as typeof structuredCall
    const res = await planExplainer({ topic: 'How solar works', seconds: 30, brand: { colors: ['#ffaa00'] } }, { openrouter: 'k' }, false, call)
    expect(res.via).toBe('openrouter')
    expect(res.explainer.scenes[0]!.elements.map((e) => e.kind)).toEqual(['title', 'image'])
    expect(calls[0]!.system).toBe(explainerSystem())
    expect(calls[0]!.user).toBe(explainerUserPrompt({ topic: 'How solar works', seconds: 30, brand: { colors: ['#ffaa00'] } }))
    expect(calls[0]!.user).toMatch(/about 4 scenes[\s\S]*#ffaa00/)
  })

  it('fails clearly without a topic, without a key, or with nothing usable', async () => {
    await expect(planExplainer({ topic: '  ', seconds: 30 }, {}, true)).rejects.toThrow(/what the explainer is about/)
    await expect(planExplainer({ topic: 'Solar', seconds: 30 }, {}, false)).rejects.toThrow(/Anthropic, OpenRouter or fal\.ai key/)
    const empty = (async () => ({ result: { title: '', style: '', scenes: [] }, via: 'fal', model: 'm' })) as unknown as typeof structuredCall
    await expect(planExplainer({ topic: 'Solar', seconds: 30 }, { fal: 'k' }, false, empty)).rejects.toThrow(/no usable scenes/)
  })

  it('demo rules: a scene per sentence, in each layout in turn, moves left to the style', async () => {
    const raw = demoExplainer({ topic: 'Sunlight hits the panel on your roof. The inverter turns it into power for the house. Hi.', seconds: 60 })
    expect(raw.scenes).toHaveLength(2)
    const topic = 'Sunlight hits the panel on your roof. The inverter turns 230 volts into power. Three parts make a loop here. Two choices sit side by side now.'
    const res = await planExplainer({ topic, seconds: 60, style: 'mono-3d' }, {}, true)
    expect(res.via).toBe('demo')
    expect(res.explainer.scenes.map((s) => s.layout)).toEqual(['center', 'column', 'diagram', 'cards'])
    expect(res.explainer.scenes[1]!.elements.map((e) => [e.kind, e.animation])).toEqual([
      ['title', 'auto'],
      ['shape', 'auto'],
      ['number', 'auto'],
      ['image', 'auto'],
    ])
    expect(res.explainer.scenes[1]!.elements[2]!.text).toBe('230')
    expect(res.explainer.scenes[0]!.elements[3]!.key).toBe('hero')
  })

  it('tells the text model about the look and the layouts', () => {
    expect(explainerSystem()).toMatch(/"diagram"[\s\S]*"key"/)
    expect(explainerUserPrompt({ topic: 'x', seconds: 30, style: 'minimal-duotone' })).toMatch(/Minimal duotone reel/)
  })
})

describe('POST /api/director/explainer', () => {
  const HOST = '127.0.0.1:5180'
  let root: string
  let deps: AppDeps
  let app: ReturnType<typeof createApp>
  const post = (body: unknown) =>
    app.request(`http://${HOST}/api/director/explainer`, {
      method: 'POST',
      headers: { host: HOST, origin: `http://${HOST}`, 'x-studio': '1', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  beforeAll(async () => {
    mkdirSync('tests/.tmp', { recursive: true })
    root = resolve(await mkdtemp(join('tests/.tmp', 'explainer-')))
    deps = createDeps(loadEnv({ home: join(root, 'home'), port: 7779 }), { secrets: new MemorySecretStore() })
    app = createApp(deps)
  })
  afterAll(async () => {
    await closeDeps(deps)
    rmSync(root, { recursive: true, force: true })
  })

  it('writes the scenes (demo rules: no key in the test keychain)', async () => {
    const res = await post({ topic: 'Wind turns the blades. The generator makes electricity.', seconds: 20 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as ExplainerResponse
    expect(body.via).toBe('demo')
    expect(body.explainer.scenes).toHaveLength(2)
  })

  it('refuses an empty topic', async () => {
    expect((await post({ topic: '', seconds: 20 })).status).toBe(400)
  })
})
