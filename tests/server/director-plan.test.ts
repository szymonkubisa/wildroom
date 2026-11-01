import { mkdirSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppDeps, closeDeps, createApp, createDeps } from '../../src/server/app'
import { loadEnv } from '../../src/server/env'
import { MemorySecretStore } from '../../src/server/services/keychain'
import { type RawPlan, demoPlan, planDirector, planSystem, planUserPrompt, projectSummary, sanitizePlan, type structuredCall } from '../../src/server/services/director'
import type { DirectorContext, DirectorPlanRequest, DirectorPlanResponse } from '../../src/shared/director/plan'

const shot = (id: string, n: string, extra: Partial<DirectorContext['scenes'][number]['shots'][number]> = {}) => ({
  id,
  n,
  what: `Shot ${n} happens.`,
  seconds: 4,
  lines: 0,
  still: 'none' as const,
  take: 'none' as const,
  ...extra,
})

const PROJECT: DirectorContext = {
  name: 'Pierwsza ryba',
  kind: 'film',
  style: '35mm film, soft dawn light',
  script: { length: 120, excerpt: 'EXT. LAKE — DAWN\nKuba casts.', edited: false },
  brandOn: false,
  budgetUsd: 15,
  spentUsd: 2.5,
  models: { image: 'Demo Image', video: 'Demo Video', voice: 'Demo Voice' },
  cast: [
    { id: 'kuba', name: 'Kuba', picture: true, voice: true },
    { id: 'gramp', name: 'Grandpa', picture: false, voice: false },
  ],
  places: [{ id: 'lake', name: 'Lake', picture: true, views: ['main'] }],
  scenes: [
    { id: 'sc1', n: 1, title: 'Misty lake', place: 'Lake', time: 'dawn', shots: [shot('a1', '1.1', { still: 'ready', take: 'draft' }), shot('a2', '1.2', { lines: 2, still: 'redo' })] },
    { id: 'sc2', n: 2, title: 'The bite', shots: [shot('b1', '2.1', { still: 'ready' }), shot('b2', '2.2', { lines: 1 }), shot('b3', '2.3')] },
    { id: 'sc3', n: 3, title: 'Letting go', shots: [] },
  ],
  storyCut: false,
}

const raw = (steps: Partial<RawPlan['steps'][number]>[], reply = 'Plan.'): RawPlan => ({
  reply,
  steps: steps.map((s) => ({
    op: '',
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
    ...s,
  })),
})

const ask = (message: string, project: DirectorContext = PROJECT) => ({ message, project })

describe('the Director’s chat: what it is told', () => {
  it('lists every step the app can run and asks for plans only', () => {
    const system = planSystem()
    for (const op of ['write-script', 'outline', 'scene-shots', 'update-scenes', 'improve-look', 'place-view', 'asset-set', 'edit-scene', 'shot-lengths', 'add-shot', 'stills', 'voices', 'animate', 'music', 'sfx', 'update-timeline', 'create-explainer']) {
      expect(system).toContain(`"${op}"`)
    }
    expect(system).toContain('runs only after the user approves them')
    expect(system).toContain('never that it is done')
  })

  it('sums the project up with ids, statuses and spend', () => {
    const text = projectSummary(PROJECT)
    expect(text).toContain('Project: "Pierwsza ryba" (film)')
    expect(text).toContain('budget $15.00, spent $2.50')
    expect(text).toContain('Kuba [id kuba] (has a picture, has a voice)')
    expect(text).toContain('Grandpa [id gramp] (no picture, no voice)')
    expect(text).toContain('Scene 1 [id sc1] "Misty lake" · Lake · dawn')
    expect(text).toContain('1.2 [id a2] 4 s · still redo · take none · 2 lines')
    expect(text).toContain('Scene 3 [id sc3] "Letting go" · no shots written yet')
    expect(text).toContain('Story cut timeline: not laid out yet.')
  })

  it('passes the last turns and the message', () => {
    const text = planUserPrompt({ ...ask('Make it shorter'), history: [{ role: 'user', text: 'Hi' }, { role: 'director', text: 'Hello.' }] })
    expect(text).toMatch(/User: Hi\nDirector: Hello\./)
    expect(text.endsWith('The user now says: Make it shorter')).toBe(true)
  })
})

describe('the Director’s plan, made safe to run', () => {
  it('turns the flat steps into typed ones, looking up ids, shot names and scene numbers', () => {
    const { steps } = sanitizePlan(
      raw([
        { op: 'animate', title: 'Drafts', shotIds: ['2.1', 'b2', 'nope'], quality: 'draft' },
        { op: 'stills', title: 'Stills', shotIds: ['shot 2.2', 'b3'] },
        { op: 'edit-scene', targetId: '2', light: 'golden hour sun', time: '' },
        { op: 'voices', shotIds: ['a1', 'a2', 'b2'] },
        { op: 'scene-shots', sceneIds: ['sc3', 'sc9'] },
      ]),
      ask('x'),
    )
    expect(steps.map((s) => s.op)).toEqual(['scene-shots', 'edit-scene', 'stills', 'voices', 'animate'])
    expect(steps[0]).toEqual({ op: 'scene-shots', title: 'Write the shots', sceneIds: ['sc3'] })
    expect(steps[1]).toEqual({ op: 'edit-scene', title: 'Change the scene', sceneId: 'sc2', light: 'golden hour sun' })
    expect(steps[2]).toMatchObject({ op: 'stills', shotIds: ['b2', 'b3'] })
    // Only shots with lines are voiced.
    expect(steps[3]).toMatchObject({ op: 'voices', shotIds: ['a2', 'b2'] })
    expect(steps[4]).toEqual({ op: 'animate', title: 'Drafts', shotIds: ['b1', 'b2'], quality: 'draft' })
  })

  it('drops unknown ops, steps left with nothing to do, and repeats', () => {
    const { steps, reply } = sanitizePlan(
      raw([
        { op: 'delete-everything' },
        { op: 'stills', shotIds: ['zz'] },
        { op: 'improve-look', targetId: 'nobody' },
        { op: 'place-view', targetId: 'lake', view: 'up' },
        { op: 'edit-scene', targetId: 'sc1' },
        { op: 'update-timeline', title: 'A' },
        { op: 'update-timeline', title: 'B' },
      ]),
      ask('x'),
    )
    expect(steps).toEqual([{ op: 'update-timeline', title: 'A' }])
    expect(reply).toBe('Plan.')
  })

  it('fills in what the model left empty and clamps lengths', () => {
    const { steps } = sanitizePlan(
      raw([
        { op: 'write-script' },
        { op: 'music', text: 'warm piano' },
        { op: 'add-shot', targetId: 'sc2', afterShotId: 'a1', text: 'The perch slips back into the water.', seconds: 99 },
        { op: 'shot-lengths', lengths: [{ shotId: '1.1', seconds: 0.2 }, { shotId: 'b1', seconds: 6.04 }] },
        { op: 'improve-look', targetId: 'Grandpa', text: 'older, a cap' },
        { op: 'place-view', targetId: 'Lake', view: 'Reverse' },
      ]),
      ask('A film about a fish'),
    )
    expect(steps[0]).toEqual({ op: 'write-script', title: 'Write the script from your idea', idea: 'A film about a fish' })
    expect(steps.find((s) => s.op === 'shot-lengths')).toMatchObject({ lengths: [{ shotId: 'a1', seconds: 1 }, { shotId: 'b1', seconds: 6 }] })
    // A shot after one that isn't in its scene goes at the end.
    expect(steps.find((s) => s.op === 'add-shot')).toEqual({ op: 'add-shot', title: 'Add a shot', sceneId: 'sc2', action: 'The perch slips back into the water.', seconds: 30 })
    expect(steps.find((s) => s.op === 'improve-look')).toMatchObject({ kind: 'character', id: 'gramp', note: 'older, a cap' })
    expect(steps.find((s) => s.op === 'place-view')).toMatchObject({ placeId: 'lake', view: 'reverse' })
    // The film's length when the model gave none (the shots add up to 20 s).
    expect(steps.find((s) => s.op === 'music')).toMatchObject({ prompt: 'warm piano', seconds: 20 })
  })
})

describe('the Director’s demo rules', () => {
  const plan = (message: string, project?: DirectorContext) => sanitizePlan(demoPlan(ask(message, project)), ask(message, project))

  it('outlines an idea when there are no scenes yet, and says it is a placeholder', () => {
    const empty = { ...PROJECT, script: { length: 0, excerpt: '', edited: false }, scenes: [], cast: [], places: [] }
    const p = plan('A 45-second film: Kuba catches his first fish', empty)
    expect(p.steps.map((s) => s.op)).toEqual(['write-script', 'outline'])
    expect(p.steps[0]).toMatchObject({ idea: 'A 45-second film: Kuba catches his first fish' })
    expect(p.reply).toMatch(/^Demo rules \(no AI\).*placeholder/)
  })

  it('moves a scene to golden hour and redraws only its stills', () => {
    const p = plan('Make scene 2 golden hour')
    expect(p.steps).toEqual([
      expect.objectContaining({ op: 'edit-scene', sceneId: 'sc2', time: 'golden hour' }),
      expect.objectContaining({ op: 'stills', shotIds: ['b1'], again: true }),
    ])
  })

  it('adds a shot, retimes the film, writes music', () => {
    expect(plan('Add a shot of the fish').steps).toEqual([expect.objectContaining({ op: 'add-shot', sceneId: 'sc3', action: 'A close shot of the fish.', seconds: 3 })])
    expect(plan('Add a shot of the bread cooling to scene 2').steps).toEqual([expect.objectContaining({ op: 'add-shot', sceneId: 'sc2', action: 'A close shot of the bread cooling.' })])
    const shorter = plan('Make it 10 seconds').steps[0]!
    expect(shorter.op).toBe('shot-lengths')
    if (shorter.op === 'shot-lengths') expect(shorter.lengths.reduce((n, l) => n + l.seconds, 0)).toBe(10)
    expect(plan('Write music for it').steps).toEqual([expect.objectContaining({ op: 'music', seconds: 20, prompt: 'A score for the film. 35mm film, soft dawn light' })])
  })

  it('animating plans the missing stills first', () => {
    const p = plan('Animate scene 2')
    expect(p.steps.map((s) => s.op)).toEqual(['stills', 'animate'])
    expect(p.steps[0]).toMatchObject({ shotIds: ['b2', 'b3'] })
    expect(p.steps[1]).toMatchObject({ shotIds: ['b1', 'b2', 'b3'], quality: 'draft' })
  })

  it('says what it can’t do instead of pretending', () => {
    const p = plan('Translate the film into French')
    expect(p.steps).toEqual([])
    expect(p.reply).toMatch(/Demo rules \(no AI\) understand only a few requests/)
  })
})

describe('planDirector: the model, demo rules, or an error', () => {
  it('asks the model with the system prompt and the project, then sanitizes its plan', async () => {
    const calls: { system: string; user: string }[] = []
    const call = (async (_creds: unknown, system: string, user: string) => {
      calls.push({ system, user })
      return { result: raw([{ op: 'stills', title: 'Stills for 2.2', shotIds: ['b2'] }], 'I’ll draw it.'), via: 'openrouter', model: 'anthropic/claude-opus-5.5' }
    }) as unknown as typeof structuredCall
    const res = await planDirector(ask('Draw 2.2'), { openrouter: 'k' }, false, call)
    expect(res).toEqual({ reply: 'I’ll draw it.', steps: [{ op: 'stills', title: 'Stills for 2.2', shotIds: ['b2'] }], via: 'openrouter', model: 'anthropic/claude-opus-5.5' })
    expect(calls[0]!.system).toBe(planSystem())
    expect(calls[0]!.user).toContain('The user now says: Draw 2.2')
  })

  it('runs the demo rules without a key, and refuses when demo mode is off', async () => {
    expect((await planDirector(ask('Write music for it'), {}, true)).via).toBe('demo')
    await expect(planDirector(ask('Write music for it'), {}, false)).rejects.toThrow(/Anthropic, OpenRouter or fal\.ai key/)
  })
})

describe('POST /api/director/plan', () => {
  const HOST = '127.0.0.1:5180'
  let root: string
  let deps: AppDeps
  let app: ReturnType<typeof createApp>
  const post = (body: unknown) =>
    app.request(`http://${HOST}/api/director/plan`, {
      method: 'POST',
      headers: { host: HOST, origin: `http://${HOST}`, 'x-studio': '1', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  beforeAll(async () => {
    mkdirSync('tests/.tmp', { recursive: true })
    root = resolve(await mkdtemp(join('tests/.tmp', 'director-plan-')))
    deps = createDeps(loadEnv({ home: join(root, 'home'), port: 7778 }), { secrets: new MemorySecretStore() })
    app = createApp(deps)
  })
  afterAll(async () => {
    await closeDeps(deps)
    rmSync(root, { recursive: true, force: true })
  })

  it('answers with a plan (demo rules: no key in the test keychain)', async () => {
    const res = await post({ message: 'Make scene 2 golden hour', history: [], project: PROJECT } satisfies DirectorPlanRequest)
    expect(res.status).toBe(200)
    const body = (await res.json()) as DirectorPlanResponse
    expect(body.via).toBe('demo')
    expect(body.steps.map((s) => s.op)).toEqual(['edit-scene', 'stills'])
  })

  it('refuses a request that isn’t one', async () => {
    expect((await post({ message: '   ', project: PROJECT })).status).toBe(400)
    expect((await post({ message: 'Hi' })).status).toBe(400)
    const res = await post({ message: 'Hi', project: { ...PROJECT, scenes: [{ id: 'x', n: 0, title: 't', shots: [] }] } })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/^project\.scenes\.0\.n:/)
  })
})
