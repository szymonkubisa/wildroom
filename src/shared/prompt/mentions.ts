/**
 * @mentions in a generation prompt: "@Kuba fishing on @Jetty". The story's characters and places can be named with an
 * @ and their handle; the Composer shows each as a chip, and before the prompt is sent each one becomes what the
 * model understands — its picture in the model's reference slot and the model's own name for it ("Image 1",
 * "@element_1", the name for Veo's ingredients), or, where it can't take a picture, the name and look in words.
 * Pure: the story, the model and what is ready come in as arguments.
 */
import { KLING_FAL_ELEMENT_VIEWS } from '../models/catalog/fal'
import type { ModelSpec, ParamValues } from '../models/types'
import { workflowFor } from '../models/workflow'
import { castToken, isUnseen, lookOf, subjectsPreamble, titleCase } from '../story/cast'
import { type KeyframeRef, withLegend } from '../story/legend'
import type { StoryCharacter, StoryPlace } from '../types/story'

export type MentionKind = 'character' | 'place'

/** A character or place the prompt can @-mention. */
export interface Mentionable {
  kind: MentionKind
  id: string
  name: string
  /** What is typed after the @: the name in word case without spaces ("PANI EWA" → "PaniEwa"). */
  handle: string
  /** Its pictures that are ready, the front (or main) view first. */
  views: string[]
  /** A character synced to Kling's element library (Kling's own API takes it as an element). */
  klingElementId?: string
}

/** "PANI EWA" → "Pani Ewa", "jean-luc" → "Jean-Luc"; a name already in mixed case stays as written. */
export function displayName(name: string): string {
  const n = name.trim()
  if (n !== n.toUpperCase() && n !== n.toLowerCase()) return n
  return n.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase())
}

/** The handle typed after the @ for a name. */
export const mentionHandle = (name: string) => displayName(name).replace(/\s+/g, '')

/** The story's characters and places as things to mention, with their ready pictures (`ready` says which are). */
export function mentionables(
  story: { characters: readonly StoryCharacter[]; places?: readonly StoryPlace[] },
  ready: (assetId: string) => boolean,
): Mentionable[] {
  const usable = (ids: (string | undefined)[]) => [...new Set(ids.filter((id): id is string => Boolean(id) && ready(id!)))]
  return [
    ...story.characters.map((c) => ({
      kind: 'character' as const,
      id: c.id,
      name: displayName(c.name),
      handle: mentionHandle(c.name),
      views: usable([c.refAssetId, ...(c.refAssetIds ?? [])]),
      ...(c.kling?.elementId ? { klingElementId: c.kling.elementId } : {}),
    })),
    ...(story.places ?? []).map((p) => ({ kind: 'place' as const, id: p.id, name: displayName(p.name), handle: mentionHandle(p.name), views: usable(p.refAssetIds ?? []) })),
  ].filter((m) => m.handle)
}

// ------------------------------------------------------------------------------------ typing

/** The @word being typed at `caret`: where its @ is and what follows it (possibly nothing yet). */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | undefined {
  const m = /(?:^|[\s(“"‘'[])@([\p{L}\p{N}_’'-]*)$/u.exec(text.slice(0, caret))
  if (!m) return undefined
  return { start: caret - m[1]!.length - 1, query: m[1]! }
}

/** Replaces the @word being typed at `caret` with `@handle ` (or removes it when `handle` is empty). */
export function completeMention(text: string, caret: number, handle: string): { text: string; caret: number } {
  const q = mentionQuery(text, caret)
  if (!q) return { text, caret }
  const insert = handle ? `@${handle} ` : ''
  const after = text.slice(caret).replace(handle ? /^\s+/ : /^$/, '')
  return { text: text.slice(0, q.start) + insert + after, caret: q.start + insert.length }
}

/** Those of `query` first that start with it, then those that contain it; all of them for an empty query. */
export function matchMentions<T extends { name: string; handle: string }>(items: readonly T[], query: string): T[] {
  const q = query.toLowerCase()
  if (!q) return [...items]
  const starts = items.filter((m) => m.handle.toLowerCase().startsWith(q) || m.name.toLowerCase().startsWith(q))
  const contains = items.filter((m) => !starts.includes(m) && (m.handle.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)))
  return [...starts, ...contains]
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const handleRe = (handle: string, flags = 'giu') => new RegExp(`@${escapeRe(handle)}(?![\\p{L}\\p{N}_])`, flags)

/** The characters and places the text @-mentions, in the order they first appear. */
export function mentionsIn<T extends { handle: string }>(text: string, items: readonly T[]): T[] {
  return items
    .map((m) => ({ m, at: text.search(handleRe(m.handle, 'iu')) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.m)
}

/** The text with every @mention of `item` written as its plain name (the chip's ×). */
export function unmention(text: string, item: Pick<Mentionable, 'handle' | 'name'>): string {
  return text.replace(handleRe(item.handle), item.name)
}

// ------------------------------------------------------------------------------------ compiling

/** How a mention went to the model. */
export interface MentionNote {
  id: string
  kind: MentionKind
  /** 'picture': in the reference slot; 'element': a Kling element; 'words': named (and described) in the prompt only. */
  as: 'picture' | 'element' | 'words'
  /** What the prompt calls it now. */
  token: string
}

export interface CompiledMentions {
  prompt: string
  /** Values to lay over the form's: the reference slot, Kling elements, the place as the background. */
  params: ParamValues
  notes: MentionNote[]
}

export interface MentionInput {
  model: ModelSpec
  /** The form's values: what is attached already (a start frame, references) decides what still fits. */
  values: ParamValues
  /** The prompt as typed, with its @mentions. */
  prompt: string
  mentioned: readonly Mentionable[]
  characters: readonly StoryCharacter[]
  places?: readonly StoryPlace[]
  /** How the legend names a picture that was attached by hand ("the picture “Dock at dawn”"). */
  labelOf?: (assetId: string) => string
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && Boolean(x)) : [])
const hasAsset = (v: unknown) => (typeof v === 'string' ? Boolean(v) : asList(v).length > 0)
const sentence = (s: string) => s.trim().replace(/[.;,\s]+$/, '')

/**
 * The prompt and inputs for `model` with its @mentions resolved. A video model gets the cast its workflow takes —
 * reference images named by its token (Image 1, the name for Veo, character1), Kling elements (synced characters on
 * Kling's own API; characters with a front and another angle on fal), the place's photo as LTX's background — within
 * what fits beside a start frame. An image model gets the pictures as references with a legend saying which is which.
 * Whatever doesn't fit (or has no picture) is named in words, its look after the prompt.
 */
export function compileMentions(input: MentionInput): CompiledMentions {
  const { model, values } = input
  let prompt = input.prompt
  const notes: MentionNote[] = []
  const params: ParamValues = {}
  const characters = input.mentioned.filter((m) => m.kind === 'character')
  const places = input.mentioned.filter((m) => m.kind === 'place')
  if (!input.mentioned.length) return { prompt, params, notes }

  const character = (id: string) => input.characters.find((c) => c.id === id)
  const picture = (m: Mentionable, token: string) => notes.push({ id: m.id, kind: m.kind, as: 'picture', token })
  const element = (m: Mentionable, token: string) => notes.push({ id: m.id, kind: m.kind, as: 'element', token })
  const subjects = new Map<string, string>()

  if (model.kind === 'video') {
    const workflow = workflowFor(model)
    const cast = workflow.cast
    const withFrame = hasAsset(values.firstFrame) || hasAsset(values.continueFrom)
    const room = cast ? (withFrame ? cast.maxWithKeyframe : cast.max) : 0
    if (cast?.param === 'elements') {
      // Kling's own API: only characters synced to its element library, as many as it takes beside a start frame.
      const ids = asList(values.elements)
      for (const m of characters) {
        const c = character(m.id)
        if (!m.klingElementId || !c || isUnseen(c) || ids.length >= room || ids.includes(m.klingElementId)) continue
        ids.push(m.klingElementId)
        element(m, castToken(workflow, ids.length, c))
      }
      if (ids.length) params.elements = ids
    } else if (cast?.param === 'elementImages') {
      // Kling elements on fal: each character as a front view plus its other angles (2–4 views).
      const images = asList(values.elementImages)
      const counts = Array.isArray(values.elementCounts) ? [...(values.elementCounts as number[])] : []
      const maxImages = model.params.find((p) => p.key === 'elementImages')?.ui.maxItems ?? Infinity
      const minViews = cast.needsAngles ? 2 : 1
      for (const m of characters) {
        const c = character(m.id)
        const views = m.views.slice(0, KLING_FAL_ELEMENT_VIEWS.max)
        if (!c || isUnseen(c) || views.length < minViews || counts.length >= room || images.length + views.length > maxImages) continue
        images.push(...views)
        counts.push(views.length)
        element(m, castToken(workflow, counts.length, c))
      }
      if (counts.length) Object.assign(params, { elementImages: images, elementCounts: counts })
    } else if (cast?.param === 'referenceImages') {
      const slot = model.params.find((p) => p.key === 'referenceImages')
      const refs = asList(values.referenceImages)
      const max = Math.min(room, slot?.ui.maxItems ?? room)
      for (const m of characters) {
        const c = character(m.id)
        const front = m.views[0]
        if (!c || isUnseen(c) || !front || refs.length >= max || refs.includes(front)) continue
        refs.push(front)
        const token = castToken(workflow, refs.length, c)
        subjects.set(c.id, token)
        picture(m, token)
      }
      if (subjects.size) params.referenceImages = refs
      // The place as the scene behind them, numbered after the cast: LTX's background, or one more reference (Seedance).
      const p = places[0]
      if (p && workflow.scene?.param === 'referenceBackground' && !withFrame && p.views[0] && !hasAsset(values.referenceBackground)) {
        params.referenceBackground = p.views[0]
        picture(p, castToken(workflow, refs.length + 1))
      } else if (p && workflow.scene?.param === 'referenceImages' && !withFrame && p.views[0] && refs.length < max && !refs.includes(p.views[0])) {
        refs.push(p.views[0])
        params.referenceImages = refs
        picture(p, (workflow.scene.token ?? '@Image{n}').replace('{n}', String(refs.length)))
      }
    }
    // Kling O3's reference slot beside its elements: the place's photo, named @Image1….
    if (workflow.scene?.param === 'referenceImages' && !withFrame && cast?.param !== 'referenceImages') {
      const slot = model.params.find((p) => p.key === 'referenceImages')
      const refs = asList(values.referenceImages)
      const p = places[0]
      if (p?.views[0] && slot && refs.length < (slot.ui.maxItems ?? 0) - (params.elementCounts as number[] | undefined ?? []).length) {
        refs.push(p.views[0])
        params.referenceImages = refs
        picture(p, (workflow.scene.token ?? '@Image{n}').replace('{n}', String(refs.length)))
      }
    }
    // Numbered pictures get a line each on who they are (as the storyboard writes LTX prompts).
    if (subjects.size && (workflow.dialect === 'ltx' || workflow.dialect === 'generic')) {
      const intro = subjectsPreamble(input.characters, subjects)
      if (intro) prompt = `${sentence(intro)}. ${prompt}`
    }
  } else if (model.kind === 'image') {
    const slot = model.params.find((p) => p.ui.control === 'images' && !p.ui.source)
    if (slot) {
      const attached = asList(values[slot.key])
      const refs: KeyframeRef[] = attached.map((id) => ({ id, kind: 'frame', label: input.labelOf?.(id) ?? 'an attached picture' }))
      const max = slot.ui.maxItems ?? 4
      for (const m of [...characters, ...places]) {
        const front = m.views[0]
        if (!front || refs.length >= max || refs.some((r) => r.id === front)) continue
        refs.push({ id: front, kind: m.kind, label: m.kind === 'place' ? `the location “${m.name}”` : m.name, ...(m.kind === 'character' ? { characterId: m.id } : {}) })
        picture(m, m.name)
      }
      if (refs.length > attached.length) {
        params[slot.key] = refs.map((r) => r.id)
        // The looks of those without a picture, then the legend of the pictures (as the storyboard's stills end).
        return { prompt: withLegend(describeTheRest(written(prompt, input.mentioned, notes), input, notes), refs), params, notes }
      }
    }
  }

  return { prompt: describeTheRest(written(prompt, input.mentioned, notes), input, notes), params, notes }
}

/** The prompt with each @mention written as the model knows it: its token, or its name. */
function written(prompt: string, mentioned: readonly Mentionable[], notes: MentionNote[]): string {
  let out = prompt
  for (const m of mentioned) {
    const note = notes.find((n) => n.id === m.id)
    out = out.replace(handleRe(m.handle), note?.token ?? m.name)
  }
  return out
}

/** Those named in words only: their looks after the prompt, so the name means someone. */
function describeTheRest(prompt: string, input: MentionInput, notes: MentionNote[]): string {
  const looks: string[] = []
  for (const m of input.mentioned) {
    if (notes.some((n) => n.id === m.id)) continue
    notes.push({ id: m.id, kind: m.kind, as: 'words', token: m.name })
    if (m.kind === 'character') {
      const c = input.characters.find((x) => x.id === m.id)
      const look = c && !isUnseen(c) ? lookOf(c, true) : ''
      // lookOf starts with the name as the storyboard writes it ("Dziadek henryk: …"): here, as the prompt names them.
      const named = c && look.startsWith(`${titleCase(c.name)}: `) ? `${m.name}: ${look.slice(titleCase(c.name).length + 2)}` : look
      if (named) looks.push(sentence(named))
    } else {
      const p = input.places?.find((x) => x.id === m.id)
      const first = p?.description.split(/[.;]/)[0]?.trim()
      if (first) looks.push(first.toLowerCase().startsWith(m.name.toLowerCase()) ? sentence(first) : `${m.name}: ${sentence(first)}`)
    }
  }
  return looks.length ? `${sentence(prompt)}. ${looks.join('. ')}.` : prompt
}
