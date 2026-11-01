import { fitParams } from '@shared/models/fit'
import { getModel } from '@shared/models/registry'
import type { ModelSpec } from '@shared/models/types'
import type { StoryCharacter, StoryDoc, StoryPlace } from '@shared/types/story'
import { computed, watch } from 'vue'
import { titleCase } from './cast'
import { type DesignKind, angleOf, designPrompt } from './design'
import type { StoryCore } from './storyCore'
import { isDead } from './storyMedia'
import type { Planned } from './storyRunner'

// ---- the look designer
const designSubject = (s: StoryDoc, kind: DesignKind, id: string) => (kind === 'character' ? s.characters.find((x) => x.id === id) : s.places?.find((x) => x.id === id))

const takesReferences = (model: ModelSpec) => model.params.some((p) => p.key === 'referenceImages')
/** The hero's front view, the place's main view. */
const mainOf = (kind: DesignKind, x: StoryCharacter | StoryPlace) => (kind === 'character' ? (x as StoryCharacter).refAssetId : x.refAssetIds?.[0])

export function createDesign(core: StoryCore) {
  const { story, aspect, update, fact, usable, modelFor, outputOf, jobState, cancelIfRendering } = core
  const { assets } = core.stores

  /** The look designer's image model: its own choice (StoryDoc.designModelId) when that can render now, else the stills'. */
  function designModel(): ModelSpec | undefined {
    const chosen = story.value.designModelId ? getModel(story.value.designModelId) : undefined
    return chosen?.kind === 'image' && usable(chosen) ? chosen : modelFor('image')
  }
  const setDesignModel = (id: string) => update('Look model', (s) => (s.designModelId = id))

  /**
   * One picture in the look designer with its image model (designModel): a candidate for the hero's or the place's
   * main picture, or (`angle`) another view of `from` — the picked candidate — sent along as the reference. `auto`: a
   * quick look, which becomes the main picture by itself once drawn (see the watch below).
   */
  function planDesign(kind: DesignKind, id: string, opts: { angle?: string; from?: string; view?: string; auto?: boolean } = {}): Planned | string {
    const model = designModel()
    if (!model) return 'No image model available'
    const subject = designSubject(story.value, kind, id)
    if (!subject) return 'It was deleted'
    if (!subject.description.trim()) return `Describe ${titleCase(subject.name)}’s look first (or let AI write it)`
    const angle = angleOf(kind, opts.angle)
    if (opts.angle) {
      if (!takesReferences(model)) return `${model.label} doesn't take reference images — pick an image model that does (e.g. FLUX.2 klein or Nano Banana)`
      if (!opts.from || assets.get(opts.from)?.status !== 'ready') return 'Pick the main picture first'
    }
    const prompt = designPrompt(
      kind,
      {
        name: titleCase(subject.name),
        description: subject.description,
        light: kind === 'place' ? (subject as { light?: string }).light : undefined,
        pictureNotes: subject.pictureNotes,
      },
      story.value.style,
      angle,
      opts.view,
    )
    const params = fitParams(model, {
      prompt,
      ...(angle ? { referenceImages: [opts.from] } : {}),
      aspectRatio: kind === 'character' ? '3:4' : aspect.value,
    })
    const name = titleCase(subject.name)
    return {
      model,
      params,
      label: `${angle ? angle.label : kind === 'character' ? 'Look' : 'Place'} · ${name}`,
      name: `${name} — ${angle ? angle.label.toLowerCase() : kind === 'character' ? 'look' : 'main view'}`,
      apply: (gid) =>
        update(angle ? 'Design angle' : 'Design look', (s) => {
          const x = designSubject(s, kind, id)
          if (x) x.designTakes = [...(x.designTakes ?? []), { generationId: gid, ...(angle ? { angle: angle.id } : {}), ...(opts.auto && !angle ? { auto: true } : {}) }]
        }),
    }
  }

  // ---- quick looks: a main picture for each hero and place without one, no designer
  /** A quick look of it is still being drawn. */
  const quickLooking = (kind: DesignKind, id: string) => Boolean(designSubject(story.value, kind, id)?.designTakes?.some((t) => t.auto))
  /** A quick look for each of these without a main picture (and none on its way); all of both kinds by default. */
  function planQuickLooks(kinds: DesignKind[] = ['character', 'place']): (Planned | string)[] {
    const subjects = [
      ...(kinds.includes('character') ? story.value.characters.map((x) => ['character', x] as const) : []),
      ...(kinds.includes('place') ? (story.value.places ?? []).map((x) => ['place', x] as const) : []),
    ]
    return subjects.filter(([kind, x]) => !mainOf(kind, x) && !quickLooking(kind, x.id)).map(([kind, x]) => planDesign(kind, x.id, { auto: true }))
  }
  /** Quick looks drawn or failed: the drawn one becomes the main picture when there is still none. */
  const quickDone = computed(() => {
    const done: { kind: DesignKind; id: string; generationId: string; assetId?: string }[] = []
    const scan = (kind: DesignKind, list: (StoryCharacter | StoryPlace)[] = []) => {
      for (const x of list) {
        for (const t of x.designTakes ?? []) {
          if (!t.auto) continue
          const out = outputOf(t.generationId)
          if (out && assets.get(out.id)?.status === 'ready') done.push({ kind, id: x.id, generationId: t.generationId, assetId: out.id })
          else if (isDead(jobState(t.generationId))) done.push({ kind, id: x.id, generationId: t.generationId })
        }
      }
    }
    scan('character', story.value.characters)
    scan('place', story.value.places)
    return done
  })
  watch(quickDone, (done) => {
    if (!done.length) return
    // The flag goes first and isn't an undo step: undoing the pick then can't bring it back to pick again.
    fact((s) => {
      for (const d of done) {
        const take = designSubject(s, d.kind, d.id)?.designTakes?.find((t) => t.generationId === d.generationId)
        if (take) delete take.auto
      }
    })
    for (const d of done) {
      const x = designSubject(story.value, d.kind, d.id)
      if (d.assetId && x && !mainOf(d.kind, x)) approveDesign(d.kind, d.id, d.assetId, [])
    }
  })

  /**
   * Approves the designer's picks: the main picture becomes the hero's front view (the place's main view) and the
   * chosen angles its other views — for a place each with a note of what it shows. Undoable.
   */
  function approveDesign(kind: DesignKind, id: string, main: string, angles: { assetId: string; angle?: string }[]) {
    // A new look: the LTX video reference was redrawn from the old pictures, and LTX takes it over the front view —
    // the clips kept the old look. It goes (and one still being drawn from them is canceled): made again from the new.
    const hero = kind === 'character' ? story.value.characters.find((c) => c.id === id) : undefined
    const newLook = Boolean(hero && hero.refAssetId !== main)
    if (newLook) cancelIfRendering(hero!.videoRefGenerationId, 'the video reference')
    update(kind === 'character' ? 'Approve character look' : 'Approve place look', (s) => {
      const x = designSubject(s, kind, id)
      if (!x) return
      const views = angles.map((a) => a.assetId).filter((a) => a !== main)
      if (kind === 'character') {
        const c = x as StoryCharacter
        c.refAssetId = main
        c.refAssetIds = views.slice(0, 3)
        if (newLook) {
          c.videoRefAssetId = undefined
          c.videoRefGenerationId = undefined
        }
        return
      }
      const p = x as StoryPlace
      // The main view, the three other directions and a detail.
      p.refAssetIds = [main, ...views].slice(0, 5)
      const notes: Record<string, string> = {}
      for (const assetId of p.refAssetIds) {
        const angle = angleOf('place', angles.find((a) => a.assetId === assetId)?.angle)
        const note = p.refNotes?.[assetId] ?? angle?.note
        if (note) notes[assetId] = note
      }
      p.refNotes = notes
    })
  }

  return { designModel, setDesignModel, planDesign, approveDesign, quickLooking, planQuickLooks }
}
