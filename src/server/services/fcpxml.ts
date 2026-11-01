import { pathToFileURL } from 'node:url'
import { layoutTimeline } from '../../shared/timeline'
import { flicksToFrames } from '../../shared/time/flicks'
import { type Clip, type MediaClip, type ProjectDoc, activeTake } from '../../shared/types/project-doc'

/** What the writer needs to know about each asset referenced by the timeline. */
export interface FcpAsset {
  id: string
  name: string
  kind: 'video' | 'image' | 'audio'
  path: string
  durationSeconds?: number
  fps?: number
  width?: number
  height?: number
  hasVideo: boolean
  hasAudio: boolean
  channels?: number
  sampleRate?: number
  /** First video timestamp of the original (proxies/WAVs start at 0, originals may not). */
  timeOffset?: number
}

export interface FcpxmlResult {
  xml: string
  warnings: string[]
}

const CROSS_DISSOLVE_UID = 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265'
const BASIC_TITLE_UID = '.../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti'

function gcd(a: number, b: number): number {
  a = Math.abs(a)
  b = Math.abs(b)
  while (b) [a, b] = [b, a % b]
  return a || 1
}

/** Rational seconds, e.g. 49/24s, 3s. */
export function rational(numerator: number, denominator: number): string {
  if (numerator === 0) return '0s'
  const g = gcd(numerator, denominator)
  const n = numerator / g
  const d = denominator / g
  return d === 1 ? `${n}s` : `${n}/${d}s`
}

function frameDuration(fps: number): string {
  const known: [number, string][] = [
    [23.976, '1001/24000s'],
    [29.97, '1001/30000s'],
    [59.94, '1001/60000s'],
  ]
  for (const [rate, fd] of known) if (Math.abs(fps - rate) < 0.01) return fd
  return rational(1, Math.round(fps))
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

function attrs(values: Record<string, string | number | undefined>): string {
  return Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}="${esc(String(v))}"`)
    .join('')
}

function colorComponents(css: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(css.trim())
  if (!m) return '1 1 1 1'
  const n = Number.parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => (c / 255).toFixed(4)).join(' ') + ' 1'
}

interface SpineOut {
  clip: Clip
  offset: number // frames on the timeline (FCP)
  duration: number // frames
  headTrim: number // frames cut from the head for an incoming transition
  transitionAfter?: { offset: number; duration: number }
}

/**
 * FCPXML 1.10 for Final Cut Pro 10.6+. Overlap-mode transitions become FCP transitions that use handles:
 * each side gives up half the transition so the sequence length is identical.
 */
export function writeFcpxml(doc: ProjectDoc, name: string, assets: Map<string, FcpAsset>): FcpxmlResult {
  const warnings = new Set<string>()
  const fps = doc.settings.fps
  const layout = layoutTimeline(doc)
  const t = (frames: number) => rational(Math.round(frames), fps)

  // ---- resources
  const resources: string[] = []
  let nextId = 1
  const rid = () => `r${nextId++}`
  const seqFormat = rid()
  resources.push(`<format${attrs({ id: seqFormat, frameDuration: frameDuration(fps), width: doc.settings.width, height: doc.settings.height })}/>`)
  const assetRef = new Map<string, string>()
  const formatByKey = new Map<string, string>()
  const usedAssets = new Set<string>()
  const collect = (clip: Clip) => {
    if (clip.kind === 'media') {
      const id = activeTake(clip)?.assetId
      if (id) usedAssets.add(id)
    }
  }
  doc.spine.forEach(collect)
  doc.connected.forEach((c) => collect(c.clip))
  for (const id of usedAssets) {
    const a = assets.get(id)
    if (!a) continue
    let format: string | undefined
    if (a.kind === 'video' || a.kind === 'image') {
      const key = a.kind === 'image' ? `img:${a.width}x${a.height}` : `${a.fps}:${a.width}x${a.height}`
      format = formatByKey.get(key)
      if (!format) {
        format = rid()
        formatByKey.set(key, format)
        resources.push(
          `<format${attrs({
            id: format,
            name: a.kind === 'image' ? 'FFVideoFormatRateUndefined' : undefined,
            frameDuration: a.kind === 'video' && a.fps ? frameDuration(a.fps) : undefined,
            width: a.width,
            height: a.height,
          })}/>`,
        )
      }
    }
    const ref = rid()
    assetRef.set(id, ref)
    const offset = a.timeOffset ?? 0
    resources.push(
      `<asset${attrs({
        id: ref,
        name: a.name,
        uid: a.id,
        start: t(Math.round(offset * fps)),
        duration: a.kind === 'image' ? '0s' : t(Math.round((a.durationSeconds ?? 0) * fps)),
        hasVideo: a.hasVideo || a.kind === 'image' ? 1 : undefined,
        format,
        hasAudio: a.hasAudio ? 1 : undefined,
        videoSources: a.hasVideo || a.kind === 'image' ? 1 : undefined,
        audioSources: a.hasAudio ? 1 : undefined,
        audioChannels: a.hasAudio ? (a.channels ?? 2) : undefined,
        audioRate: a.hasAudio ? (a.sampleRate ?? 48000) : undefined,
      })}><media-rep${attrs({ kind: 'original-media', src: pathToFileURL(a.path).href })}/></asset>`,
    )
  }
  let dissolveRef: string | undefined
  let titleRef: string | undefined
  const dissolve = () => {
    if (!dissolveRef) {
      dissolveRef = rid()
      resources.push(`<effect${attrs({ id: dissolveRef, name: 'Cross Dissolve', uid: CROSS_DISSOLVE_UID })}/>`)
    }
    return dissolveRef
  }
  const titleEffect = () => {
    if (!titleRef) {
      titleRef = rid()
      resources.push(`<effect${attrs({ id: titleRef, name: 'Basic Title', uid: BASIC_TITLE_UID })}/>`)
    }
    return titleRef
  }

  // ---- spine geometry in FCP terms
  const spine: SpineOut[] = []
  layout.spine.forEach((s, i) => {
    const inOverlap = s.overlapIn
    const outOverlap = s.overlapOut
    const headTrim = Math.floor(inOverlap / 2)
    const tailTrim = Math.ceil(outOverlap / 2)
    const out: SpineOut = { clip: s.item, offset: s.start + headTrim, duration: s.end - s.start - headTrim - tailTrim, headTrim }
    if (outOverlap > 0) {
      if (s.item.transitionOut?.type !== 'dissolve') warnings.add('Dip transitions are exported as cross dissolves.')
      out.transitionAfter = { offset: s.end - outOverlap, duration: outOverlap }
    }
    spine.push(out)
    if (i === 0 && s.item.transitionIn) warnings.add('Fade-in from black on the first clip is not exported.')
    if (i === layout.spine.length - 1 && s.item.transitionOut) warnings.add('Fade-out to black on the last clip is not exported.')
  })
  const spineEnd = spine.length ? spine.at(-1)!.offset + spine.at(-1)!.duration : 0
  const extent = Math.max(spineEnd, ...layout.connected.map((c) => c.end))
  if (extent > spineEnd) {
    spine.push({ clip: { kind: 'gap', id: 'tail-gap', duration: extent - spineEnd, enabled: true }, offset: spineEnd, duration: extent - spineEnd, headTrim: 0 })
  }

  const parentFor = (frame: number) =>
    spine.find((s) => frame >= s.offset && frame < s.offset + s.duration) ?? spine.at(-1)

  // Start (in-point) of a spine element in its own time, in frames.
  const startOf = (s: SpineOut): number => {
    if (s.clip.kind !== 'media') return 0
    const take = activeTake(s.clip)
    const a = take?.assetId ? assets.get(take.assetId) : undefined
    const offset = Math.round((a?.timeOffset ?? 0) * fps)
    return offset + Math.round(flicksToFrames(take?.sourceIn ?? 0, fps)) + s.headTrim
  }

  let textStyle = 0
  const clipXml = (clip: Clip, offset: number, duration: number, start: number, lane: number | undefined, children: string[] = []): string => {
    const common = { lane, offset: t(offset), name: clip.name ?? undefined, start: t(start), duration: t(duration), enabled: clip.enabled ? undefined : 0 }
    const inner = children.join('')
    if (clip.kind === 'gap') return `<gap${attrs({ ...common, name: 'Gap' })}>${inner}</gap>`
    if (clip.kind === 'generator') {
      warnings.add('Solid colour generators are exported as gaps.')
      return lane === undefined ? `<gap${attrs({ ...common, name: clip.name ?? 'Solid' })}>${inner}</gap>` : ''
    }
    if (clip.kind === 'motion') {
      warnings.add('Motion clips (animated Canvas frames) are exported as gaps: export them as video to keep them.')
      return lane === undefined ? `<gap${attrs({ ...common, name: clip.name ?? 'Motion' })}>${inner}</gap>` : ''
    }
    if (clip.kind === 'title') {
      const id = `ts${++textStyle}`
      const s = clip.style
      const text = clip.subtitle ? `${clip.text}\n${clip.subtitle}` : clip.text
      return (
        `<title${attrs({ ...common, ref: titleEffect(), name: clip.name ?? clip.text.slice(0, 40) })}>` +
        `<text><text-style${attrs({ ref: id })}>${esc(text)}</text-style></text>` +
        `<text-style-def${attrs({ id })}><text-style${attrs({ font: s.fontFamily, fontSize: s.fontSize, fontColor: colorComponents(s.color), bold: s.fontWeight >= 600 ? 1 : undefined, alignment: s.align })}/></text-style-def>` +
        `${inner}</title>`
      )
    }
    return mediaXml(clip, common, inner)
  }

  const mediaXml = (clip: MediaClip, common: Record<string, string | number | undefined>, inner: string): string => {
    const take = activeTake(clip)
    const asset = take?.assetId ? assets.get(take.assetId) : undefined
    const ref = take?.assetId ? assetRef.get(take.assetId) : undefined
    if (!asset || !ref) {
      warnings.add('Clips that are still generating are exported as gaps.')
      return common.lane === undefined ? `<gap${attrs({ ...common, name: 'Pending generation', start: '0s' })}>${inner}</gap>` : ''
    }
    if (clip.speed !== 1) warnings.add('Speed changes are not exported (clips play at 100%).')
    if (clip.video && (clip.video.effects.length || clip.video.transform.scale !== 1 || clip.video.transform.x || clip.video.transform.y || clip.video.transform.rotation)) {
      warnings.add('Transforms and effects are not exported.')
    }
    const adjustments: string[] = []
    if (clip.audio && clip.audio.gainDb !== 0) adjustments.push(`<adjust-volume${attrs({ amount: `${clip.audio.gainDb.toFixed(1)}dB` })}/>`)
    if (clip.audio && (clip.audio.fadeIn || clip.audio.fadeOut)) warnings.add('Audio fades are not exported.')
    common = { ...common, name: common.name ?? asset.name }
    if (asset.kind === 'image') return `<video${attrs({ ...common, ref, start: '0s' })}>${adjustments.join('')}${inner}</video>`
    const audioOn = Boolean(clip.audio?.enabled && asset.hasAudio)
    const videoOn = Boolean(clip.video?.enabled !== false && clip.video && asset.hasVideo)
    return `<asset-clip${attrs({
      ...common,
      ref,
      tcFormat: 'NDF',
      audioRole: audioOn ? clip.audio!.role : undefined,
      srcEnable: asset.hasVideo && asset.hasAudio && audioOn !== videoOn ? (audioOn ? 'audio' : 'video') : undefined,
    })}>${adjustments.join('')}${inner}</asset-clip>`
  }

  // Connected clips and markers become children of the spine element they sit on.
  const children = new Map<SpineOut, string[]>()
  for (const c of layout.connected) {
    const parent = parentFor(c.start)
    if (!parent) continue
    const offsetInParent = startOf(parent) + (c.start - parent.offset)
    const child = c.item.clip
    const start =
      child.kind === 'media'
        ? Math.round(((activeTake(child)?.assetId && assets.get(activeTake(child)!.assetId!)?.timeOffset) || 0) * fps) +
          Math.round(flicksToFrames(activeTake(child)?.sourceIn ?? 0, fps))
        : 0
    const xml = clipXml(child, offsetInParent, c.end - c.start, start, c.lane)
    if (xml) children.set(parent, [...(children.get(parent) ?? []), xml])
  }
  for (const m of layout.markers) {
    const parent = parentFor(m.frame)
    if (!parent) continue
    const at = startOf(parent) + (m.frame - parent.offset)
    const tag = m.kind === 'chapter' ? 'chapter-marker' : 'marker'
    const xml = `<${tag}${attrs({ start: t(at), duration: t(1), value: m.name, completed: m.kind === 'todo' ? (m.done ? 1 : 0) : undefined })}/>`
    children.set(parent, [...(children.get(parent) ?? []), xml])
  }

  const spineXml: string[] = []
  for (const s of spine) {
    spineXml.push(clipXml(s.clip, s.offset, s.duration, startOf(s), undefined, children.get(s)))
    const tr = s.transitionAfter
    if (tr) {
      spineXml.push(`<transition${attrs({ name: 'Cross Dissolve', offset: t(tr.offset), duration: t(tr.duration) })}><filter-video${attrs({ ref: dissolve(), name: 'Cross Dissolve' })}/></transition>`)
    }
  }

  const duration = spine.length ? spine.at(-1)!.offset + spine.at(-1)!.duration : 0
  const warningList = [...warnings]
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    ...(warningList.length ? [`<!-- Wildroom export notes: ${esc(warningList.join(' '))} -->`] : []),
    '<fcpxml version="1.10">',
    `<resources>${resources.join('')}</resources>`,
    `<library><event${attrs({ name: 'Wildroom' })}><project${attrs({ name })}>`,
    `<sequence${attrs({ format: seqFormat, duration: t(duration), tcStart: '0s', tcFormat: 'NDF', audioLayout: 'stereo', audioRate: '48k' })}>`,
    `<spine>${spineXml.join('')}</spine>`,
    '</sequence></project></event></library>',
    '</fcpxml>',
  ].join('\n')
  return { xml, warnings: warningList }
}
