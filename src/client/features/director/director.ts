import {
  DIRECTOR_MESSAGES_MAX,
  type DirectorMessage,
  type DirectorTurn,
  type PlanStep,
  type StepProgress,
} from '@shared/director/plan'
import { projectKindOf } from '@shared/projects/meta'
import { hasBrand } from '@shared/types/brand'
import { PLACE_VIEWS, type StoryShot } from '@shared/types/story'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed, markRaw, ref, shallowRef } from 'vue'
import { useBrandSwitch } from '@/features/brand/brandSwitch'
import { type PendingBrief, briefIdea, takeBrief } from '@/features/story/brief'
import { placeViewPhoto } from '@/features/story/references'
import { inFlight, useStory } from '@/features/story/useStory'
import { api, errorMessage } from '@/lib/api'
import { useJobsStore } from '@/stores/jobs'
import { useProjectStore } from '@/stores/project'
import { directorContext } from './context'
import { directorOpen } from './panel'
import { type DirectorTools, createDirectorTools } from './tools'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The Director's chat beside the project (Plan, Create and Edit): the conversation — in the project document, out of
 * the undo history, its last DIRECTOR_MESSAGES_MAX messages — what is being asked, and the plan being run. A plan
 * runs only when approved, step by step through the app's own code (tools.ts), and stops at a step that fails.
 */
export const useDirector = defineStore('director', () => {
  const project = useProjectStore()
  const jobs = useJobsStore()
  /** The panel, open or closed in this browser (panel.ts). */
  const open = directorOpen
  const draft = ref('')
  /** Waiting for the Director's answer (or a brief's passes). */
  const sending = ref(false)
  /** Bumped to put the cursor in the message box. */
  const focusNonce = ref(0)
  /** The plan running now (its message), and each step's progress live. */
  const runningId = ref<string>()
  const live = shallowRef<StepProgress[]>([])
  let stopAsked = false
  const spentUsd = ref(0)

  let tools: DirectorTools | undefined
  /** The steps' pricing and running (built once, on first use). */
  const getTools = () => (tools ??= markRaw(createDirectorTools()))

  // Sanitized as the project loads (stores/project.ts): a run cut short by closing the project shows as stopped.
  const messages = computed<DirectorMessage[]>(() => project.doc.director?.messages ?? [])

  /** The conversation written to the document as a fact (no undo step): only into the project it belongs to. */
  function commit(pid: string | undefined, next: DirectorMessage[]) {
    if (!pid || project.id !== pid) return
    const kept = next.slice(-DIRECTOR_MESSAGES_MAX)
    project.applyFact((d) => {
      d.director = { messages: JSON.parse(JSON.stringify(kept)) as DirectorMessage[] }
    })
  }
  function say(pid: string | undefined, m: Omit<DirectorMessage, 'id' | 'at'>): string {
    const id = nanoid(8)
    commit(pid, [...messages.value, { id, at: new Date().toISOString(), ...m }])
    return id
  }
  function patch(pid: string | undefined, id: string, change: (m: DirectorMessage) => DirectorMessage) {
    commit(
      pid,
      messages.value.map((m) => (m.id === id ? change(m) : m)),
    )
  }

  async function refreshSpend() {
    const id = project.id
    if (!id) return
    try {
      const spend = await api.projects.spend(id)
      if (project.id === id) spentUsd.value = spend.totalUsd
    } catch {
      // The last figure stands.
    }
  }
  jobs.onFinished(() => void refreshSpend())

  // ------------------------------------------------------------------------------------------------ the panel

  function show(focus = false) {
    open.value = true
    if (focus) focusNonce.value++
    void refreshSpend()
  }
  function toggle() {
    if (open.value) open.value = false
    else show(true)
  }
  /** "Ask the Director": the panel open with a question in the box (sent when `send`). */
  function ask(text: string, opts: { send?: boolean } = {}) {
    show(true)
    if (opts.send) void send(text)
    else draft.value = text
  }

  // ------------------------------------------------------------------------------------------------ what the Director is told

  /** The project as the Director reads it (context.ts). */
  function context() {
    const s = useStory()
    const st = s.story.value
    const still = (shot: StoryShot) => {
      if (s.preparingOf(shot, 'keyframe') || inFlight(s.jobState(shot.keyframeGenerationId))) return 'coming' as const
      if (s.keyframeOf(shot)) return shot.stillStale ? ('redo' as const) : ('ready' as const)
      return 'none' as const
    }
    const take = (shot: StoryShot) => {
      const group = s.clipGroupOf(shot)
      const ids = group ? group.videoGenerationIds : shot.videoGenerationIds
      if (s.preparingOf(shot, 'take') || ids.some((id) => inFlight(s.jobState(id)))) return 'coming' as const
      const chosen = group ? s.chosenGroupVideo(group) : s.chosenVideoOf(shot)
      if (!chosen) return 'none' as const
      return s.isFinalAsset(chosen) ? ('final' as const) : ('draft' as const)
    }
    return directorContext({
      story: st,
      name: project.name,
      kind: projectKindOf({ doc: project.doc }),
      brandOn: useBrandSwitch().on && hasBrand(project.doc.brand),
      spentUsd: spentUsd.value,
      models: {
        ...(s.modelFor('image') ? { image: s.modelFor('image')!.label } : {}),
        ...(s.modelFor('video') ? { video: s.modelFor('video')!.label } : {}),
        ...(s.finalModel() ? { finalVideo: s.finalModel()!.label } : {}),
        ...(s.modelFor('speech') ? { voice: s.modelFor('speech')!.label } : {}),
      },
      shotName: s.shotName,
      still,
      take,
      placeViews: (id) => {
        const place = st.places?.find((p) => p.id === id)
        return place ? PLACE_VIEWS.filter((v) => placeViewPhoto(place, v)) : []
      },
      storyCut: Boolean(st.cutTimelineId && project.doc.timelines?.some((t) => t.id === st.cutTimelineId)),
    })
  }

  /** The last turns, with what became of each plan, for the Director to follow the conversation. */
  function history(): DirectorTurn[] {
    return messages.value
      .filter((m) => m.tone !== 'error')
      .slice(-12)
      .map((m) => {
        const plan = m.plan ? ` [plan: ${m.plan.steps.map((x) => x.title).join('; ')} — ${m.plan.state === 'ready' ? 'not approved yet' : m.plan.state}]` : ''
        return { role: m.role, text: `${m.text}${plan}`.slice(0, 2000) }
      })
  }

  // ------------------------------------------------------------------------------------------------ asking

  async function send(text = draft.value) {
    const message = text.trim()
    const pid = project.id
    if (!message || sending.value || !pid) return
    const turns = history()
    say(pid, { role: 'user', text: message })
    draft.value = ''
    sending.value = true
    try {
      await refreshSpend()
      const res = await api.director.plan({ message: message.slice(0, 4000), history: turns, project: context() })
      say(pid, { role: 'director', text: res.reply, ...(res.steps.length ? { plan: { steps: res.steps, state: 'ready' } } : {}) })
    } catch (err) {
      const text = errorMessage(err)
      // No key that can run the Director: the way to add one, under the message.
      say(pid, { role: 'director', text, tone: 'error', ...(/Settings → Providers/.test(text) ? { action: 'providers' as const } : {}) })
    } finally {
      sending.value = false
    }
  }

  // ------------------------------------------------------------------------------------------------ plans

  /** Runs an approved plan's steps in order; stops at one that fails, or when Stop is pressed. */
  async function approve(id: string) {
    const msg = messages.value.find((m) => m.id === id)
    const pid = project.id
    if (!msg?.plan || msg.plan.state !== 'ready' || runningId.value || !pid) return
    const t = getTools()
    await refreshSpend()
    const quote = t.quote(msg.plan.steps, spentUsd.value)
    // The card said the Story cut would be replaced: approving agreed to it (asked again only if edited since).
    const replaceCut = t.storyCutEdited()
    const steps = msg.plan.steps
    const progress: StepProgress[] = steps.map(() => ({ state: 'waiting' }))
    const set = (i: number, p: StepProgress) => {
      progress[i] = p
      live.value = [...progress]
    }
    runningId.value = id
    stopAsked = false
    live.value = [...progress]
    patch(pid, id, (m) => ({ ...m, plan: { ...m.plan!, state: 'running', progress: [...progress], ...(quote.usd != null ? { approvedUsd: quote.usd } : {}) } }))
    let state: 'done' | 'stopped' = 'done'
    try {
      for (const [i, step] of steps.entries()) {
        if (project.id !== pid) return
        if (stopAsked) {
          state = 'stopped'
          break
        }
        set(i, { state: 'running' })
        const result = await t.runStep(step, quote.steps[i], {
          progress: (p) => set(i, { state: 'running', ...(progress[i]?.note ? { note: progress[i]!.note } : {}), ...p }),
          stopped: () => stopAsked,
          replaceCut,
        })
        set(i, result)
        if (project.id !== pid) return
        patch(pid, id, (m) => ({ ...m, plan: { ...m.plan!, progress: [...progress] } }))
        if (result.state === 'failed' || result.state === 'stopped') {
          state = 'stopped'
          break
        }
      }
      patch(pid, id, (m) => ({ ...m, plan: { ...m.plan!, state, progress: [...progress] } }))
    } finally {
      if (runningId.value === id) runningId.value = undefined
      live.value = []
      void refreshSpend()
    }
  }

  /** Stop: the running step finishes waiting, the rest don't run (renders already started go on in Activity). */
  function stop() {
    if (runningId.value) stopAsked = true
  }

  function decline(id: string) {
    patch(project.id, id, (m) => (m.plan && m.plan.state === 'ready' ? { ...m, plan: { ...m.plan, state: 'declined' } } : m))
  }

  /** "Change something": the cursor in the box, to say what. */
  function change() {
    show(true)
  }

  /** Progress of a plan's steps: live while it runs, else as saved. */
  const progressOf = (m: DirectorMessage) => (m.id === runningId.value && live.value.length ? live.value : m.plan?.progress)

  function clear() {
    if (runningId.value || sending.value) return
    project.applyFact((d) => {
      delete d.director
    })
  }

  // ------------------------------------------------------------------------------------------------ a brief from Home

  /**
   * A brief from Home ("What are we making?") for the project just made: the panel opens with it as the first message,
   * the Director writes the script, the scenes and their shots (its text passes — nothing is generated), then proposes
   * the stills, voices and draft takes as a plan with their cost, for the user to approve. Runs once (takeBrief).
   */
  async function takeHomeBrief() {
    const brief = takeBrief(project.id)
    if (brief) await runBrief(brief)
  }

  async function runBrief(b: PendingBrief) {
    const pid = b.projectId
    const s = useStory()
    open.value = true
    s.update('Brief', (st) => (st.script = b.text))
    say(pid, { role: 'user', text: b.text })
    sending.value = true
    const gone = () => project.id !== pid
    try {
      const status = await api.director.status().catch(() => ({ via: 'none' as const, reason: undefined }))
      if (gone()) return
      if (status.via === 'none') {
        say(pid, {
          role: 'director',
          text: `Your brief is in Plan › Script. ${status.reason ?? 'I need an Anthropic, OpenRouter or fal.ai key to write the script, scenes and shots from it.'}`,
          tone: 'note',
          action: 'providers',
        })
        return
      }
      if (status.via === 'demo') {
        say(pid, {
          role: 'director',
          text: 'Demo mode: no AI runs the Director, so the script, scenes and shots are placeholders made by simple rules. Add a Director key (Settings › Providers) for real ones.',
          tone: 'note',
        })
      }
      say(pid, { role: 'director', text: 'Writing a short script from your brief — it shows up in Plan › Script.', tone: 'note' })
      let title = ''
      try {
        const res = await s.writeScript(briefIdea(b))
        title = res.title && res.title !== 'Untitled' ? res.title : ''
      } catch (err) {
        if (!gone()) say(pid, { role: 'director', text: `The script couldn’t be written: ${errorMessage(err)}. Your brief is in Plan › Script — try Write script from idea there, or ask me again.`, tone: 'error' })
        return
      }
      if (gone()) return
      say(pid, { role: 'director', text: `Script written${title ? `: “${title}”` : ''}. Reading it into cast, places and scenes…`, tone: 'note' })
      try {
        await s.outlineStory()
      } catch (err) {
        if (!gone()) say(pid, { role: 'director', text: `The scenes couldn’t be made: ${errorMessage(err)}. The script is in Plan › Script — try Create scenes there.`, tone: 'error' })
        return
      }
      if (gone()) return
      const st = s.story.value
      const scenes = st.scenes ?? []
      say(pid, {
        role: 'director',
        text: `${plural(scenes.length, 'scene')}, ${plural(st.characters.length, 'character')}, ${plural(st.places?.length ?? 0, 'place')}. Writing the shots of every scene…`,
        tone: 'note',
      })
      const results = await Promise.allSettled(scenes.map((x) => s.writeShotsForScene(x.id)))
      if (gone()) return
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (failed.length === results.length) {
        say(pid, { role: 'director', text: `The shots couldn’t be written: ${errorMessage(failed[0]?.reason)}. Try Write shots in Plan › Shots.`, tone: 'error' })
        return
      }
      const plan = briefPlan()
      const shots = s.story.value.shots
      const seconds = Math.round(shots.reduce((n, x) => n + x.duration, 0))
      const unpictured = [...s.story.value.characters.filter((c) => !c.refAssetId), ...(s.story.value.places ?? []).filter((p) => !p.refAssetIds?.length)].length
      say(pid, {
        role: 'director',
        text: [
          `Here is the plan: ${plural(scenes.length, 'scene')}, ${plural(shots.length, 'shot')}, about ${seconds} s.`,
          failed.length ? `${plural(failed.length, 'scene')} couldn’t be written — Write shots in Plan › Shots.` : '',
          'Nothing is generated until you approve it, and you can change any scene or shot first.',
          unpictured ? 'Cast & Places have no pictures yet, so the stills will invent faces and places — give them pictures there first if they should match from shot to shot.' : '',
        ]
          .filter(Boolean)
          .join(' '),
        ...(plan.length ? { plan: { steps: plan, state: 'ready' as const } } : {}),
      })
    } finally {
      sending.value = false
    }
  }

  /** The brief's plan: stills, the lines ElevenLabs records, and a draft take of every shot. */
  function briefPlan(): PlanStep[] {
    const s = useStory()
    const t = getTools()
    const shots = s.story.value.shots
    if (!shots.length) return []
    const ids = shots.map((x) => x.id)
    const lines = shots.filter((x) => x.dialogue.some((l) => l.text.trim()))
    const steps: PlanStep[] = [
      { op: 'stills', title: `Stills · ${plural(shots.length, 'shot')}`, shotIds: ids },
      ...(lines.length ? [{ op: 'voices' as const, title: `Voices · ${plural(lines.reduce((n, x) => n + x.dialogue.filter((l) => l.text.trim()).length, 0), 'line')}`, shotIds: lines.map((x) => x.id) }] : []),
      { op: 'animate', title: `Draft takes · ${plural(shots.length, 'shot')}`, shotIds: ids, quality: 'draft' },
    ]
    // Lines the video model speaks itself need no ElevenLabs step.
    return steps.filter((x) => x.op !== 'voices' || !t.quoteStep(x).nothing)
  }

  return {
    open,
    draft,
    sending,
    focusNonce,
    runningId,
    messages,
    spentUsd,
    tools: getTools,
    show,
    toggle,
    ask,
    send,
    approve,
    stop,
    decline,
    change,
    progressOf,
    clear,
    refreshSpend,
    takeHomeBrief,
  }
})
