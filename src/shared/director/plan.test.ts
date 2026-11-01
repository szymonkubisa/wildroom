import { describe, expect, it } from 'vitest'
import { DIRECTOR_MESSAGES_MAX, directorPlanRequestSchema, sanitizeDirector } from './plan'

const msg = (i: number, extra: Record<string, unknown> = {}) => ({ id: `m${i}`, role: i % 2 ? 'director' : 'user', text: `Message ${i}`, at: '2026-10-18T00:00:00.000Z', ...extra })

describe('the Director’s conversation as loaded', () => {
  it('keeps the last messages only, and nothing when there is nothing', () => {
    const many = { messages: Array.from({ length: DIRECTOR_MESSAGES_MAX + 7 }, (_, i) => msg(i)) }
    const out = sanitizeDirector(many)!
    expect(out.messages).toHaveLength(DIRECTOR_MESSAGES_MAX)
    expect(out.messages[0]!.id).toBe('m7')
    expect(sanitizeDirector(undefined)).toBeUndefined()
    expect(sanitizeDirector({ messages: [] })).toBeUndefined()
    expect(sanitizeDirector({ messages: 'nope' })).toBeUndefined()
  })

  it('drops what isn’t a message, and plans with a step this build can’t run', () => {
    const out = sanitizeDirector({
      messages: [
        msg(0),
        { id: 'x', role: 'robot', text: 'hi' },
        { id: 7, role: 'user', text: 'hi' },
        msg(1, { plan: { steps: [{ op: 'launch-rocket', title: 'Go' }], state: 'ready' } }),
        msg(3, { plan: { steps: [{ op: 'update-timeline', title: 'Lay it out' }], state: 'ready' }, tone: 'shout', action: 'providers' }),
      ],
    })!
    expect(out.messages.map((m) => m.id)).toEqual(['m0', 'm1', 'm3'])
    expect(out.messages[1]!.plan).toBeUndefined()
    expect(out.messages[2]).toMatchObject({ plan: { steps: [{ op: 'update-timeline', title: 'Lay it out' }], state: 'ready' }, action: 'providers' })
    expect(out.messages[2]!.tone).toBeUndefined()
  })

  it('a run cut short by closing the project shows as stopped, its running step too', () => {
    const out = sanitizeDirector({
      messages: [
        msg(1, {
          plan: {
            steps: [
              { op: 'stills', title: 'Stills', shotIds: ['a'] },
              { op: 'animate', title: 'Takes', shotIds: ['a'], quality: 'draft' },
            ],
            state: 'running',
            approvedUsd: 0.4,
            progress: [
              { state: 'running', note: '2 of 4 stills', done: 2, total: 4, show: { sceneId: 's1', workspace: 'nowhere' } },
              { state: 'waiting' },
            ],
          },
        }),
      ],
    })!
    const plan = out.messages[0]!.plan!
    expect(plan.state).toBe('stopped')
    expect(plan.approvedUsd).toBe(0.4)
    expect(plan.progress![0]).toEqual({ state: 'stopped', note: 'Stopped when the project closed — renders it started went on in Activity', done: 2, total: 4, show: { sceneId: 's1' } })
    expect(plan.progress![1]).toEqual({ state: 'waiting' })
  })
})

describe('a request to the Director', () => {
  const project = {
    script: { length: 0, excerpt: '', edited: false },
    brandOn: false,
    models: {},
    cast: [],
    places: [],
    scenes: [],
    storyCut: false,
  }

  it('needs a message and a project; history defaults to none', () => {
    const ok = directorPlanRequestSchema.safeParse({ message: ' Hi ', project })
    expect(ok.success && ok.data).toMatchObject({ message: 'Hi', history: [] })
    expect(directorPlanRequestSchema.safeParse({ message: '  ', project }).success).toBe(false)
    expect(directorPlanRequestSchema.safeParse({ message: 'Hi' }).success).toBe(false)
    expect(directorPlanRequestSchema.safeParse({ message: 'x'.repeat(4001), project }).success).toBe(false)
  })
})
