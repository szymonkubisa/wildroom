import { type VoiceTiming, anchorShifts, anchoredClip, voiceTimings } from '@shared/motion/anchors'
import { motionSource } from '@shared/motion/evaluate'
import type { TimelineLayout } from '@shared/timeline'
import { flicksToSeconds } from '@shared/time/flicks'
import type { AssetDTO } from '@shared/types/assets'
import {
  type Clip,
  DIALOGUE_TARGET_LUFS,
  type ProjectDoc,
  activeTake,
  defaultMix,
  defaultVideoProps,
} from '@shared/types/project-doc'
import type { AudioSegment, MotionLayer, Scene, TransitionEnvelope, VideoLayer } from './scene'

type AssetLookup = (id: string) => AssetDTO | undefined

function mediaLayer(
  doc: ProjectDoc,
  clip: Clip,
  start: number,
  end: number,
  z: number,
  lane: number,
  transitions: TransitionEnvelope[],
  getAsset: AssetLookup,
  voices: readonly VoiceTiming[] = [],
): { video?: VideoLayer; audio?: AudioSegment } {
  if (clip.kind === 'gap' || !clip.enabled) return {}
  if (clip.kind === 'title') {
    return {
      video: { clipId: clip.id, kind: 'title', start, end, sourceStart: 0, speed: 1, z, lane, video: clip.video ?? defaultVideoProps(), transitions, title: clip, still: true },
    }
  }
  if (clip.kind === 'generator') {
    return {
      video: { clipId: clip.id, kind: 'generator', start, end, sourceStart: 0, speed: 1, z, lane, video: clip.video ?? defaultVideoProps(), transitions, generator: clip, still: true },
    }
  }
  if (clip.kind === 'motion') {
    // Keys timed to the voice-over land on its words as they're recorded now.
    clip = anchoredClip(clip, anchorShifts(clip, start, voices, doc.settings.fps))
    const { frame, items } = motionSource(clip, doc.canvas)
    const videos: MotionLayer['videos'] = []
    for (const it of items) if (it.kind === 'asset' && it.assetId && getAsset(it.assetId)?.kind === 'video') videos.push({ itemId: it.id, assetId: it.assetId })
    return {
      video: {
        clipId: clip.id,
        kind: 'motion',
        start,
        end,
        sourceStart: (clip.offset ?? 0) / doc.settings.fps,
        speed: 1,
        z,
        lane,
        video: clip.video ?? defaultVideoProps(),
        transitions,
        motion: { clip, frame, items, videos },
        still: videos.length === 0,
      },
    }
  }
  const take = activeTake(clip)
  const sourceStart = flicksToSeconds(take?.sourceIn ?? 0)
  const asset = take?.assetId ? getAsset(take.assetId) : undefined
  const out: { video?: VideoLayer; audio?: AudioSegment } = {}
  if (!take?.assetId || !asset) {
    if (clip.video || !clip.audio) {
      out.video = {
        clipId: clip.id,
        kind: 'pending',
        start,
        end,
        sourceStart,
        speed: clip.speed,
        z,
        lane,
        video: clip.video ?? defaultVideoProps(),
        transitions,
        label: take?.label ?? clip.name,
      }
    }
    return out
  }
  if (clip.video?.enabled !== false && (asset.kind === 'video' || asset.kind === 'image') && clip.video) {
    out.video = {
      clipId: clip.id,
      kind: 'media',
      assetId: asset.id,
      start,
      end,
      sourceStart,
      speed: clip.speed,
      z,
      lane,
      video: clip.video,
      transitions,
      still: asset.kind === 'image',
    }
  }
  if (clip.audio?.enabled && asset.hasAudio && asset.variants.audio) {
    out.audio = {
      clipId: clip.id,
      assetId: asset.id,
      start,
      end,
      sourceStart,
      speed: clip.speed,
      role: clip.audio.role,
      audio: clip.audio,
      transitions,
    }
  }
  return out
}

const baseRole = (role: string) => role.split('.')[0] ?? role

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const r of sorted) {
    const last = out.at(-1)
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

/** Dialogue loudness normalisation and music ducking — computed once, so playback and export match. */
function applyMix(doc: ProjectDoc, audio: AudioSegment[], getAsset: AssetLookup) {
  const mix = doc.mix ?? defaultMix()
  if (mix.normalizeDialogue) {
    for (const seg of audio) {
      if (baseRole(seg.role) !== 'dialogue') continue
      const lufs = getAsset(seg.assetId)?.loudness?.integratedLufs
      if (lufs !== undefined && Number.isFinite(lufs) && lufs > -70) {
        seg.normGainDb = Math.max(-12, Math.min(12, DIALOGUE_TARGET_LUFS - lufs))
      }
    }
  }
  if (mix.ducking.enabled) {
    const ranges = mergeRanges(
      audio.filter((s) => s.audio.enabled && baseRole(s.role) === 'dialogue').map((s) => [s.start, s.end] as [number, number]),
    )
    if (ranges.length) {
      const ramp = Math.max(1, Math.round(mix.ducking.fadeSeconds * doc.settings.fps))
      for (const seg of audio) {
        if (baseRole(seg.role) === 'music') seg.duck = { ranges, amountDb: mix.ducking.amountDb, ramp }
      }
    }
  }
}

/** Resolves the laid-out timeline into what the player/exporter draw and mix. */
export function buildScene(doc: ProjectDoc, layout: TimelineLayout, getAsset: AssetLookup): Scene {
  const video: VideoLayer[] = []
  const audio: AudioSegment[] = []
  const edit = new Set<number>([0])
  const voices = voiceTimings(layout, (id) => getAsset(id)?.alignment?.words)
  const last = layout.spine.length - 1

  layout.spine.forEach((si, i) => {
    const item = si.item
    const transitions: TransitionEnvelope[] = []
    const prev = layout.spine[i - 1]
    if (prev?.item.transitionOut && si.overlapIn > 0) {
      transitions.push({ type: prev.item.transitionOut.type, start: si.start, end: si.start + si.overlapIn, side: 'in', solo: false })
    }
    if (item.transitionOut) {
      if (i < last && si.overlapOut > 0) {
        transitions.push({ type: item.transitionOut.type, start: si.end - si.overlapOut, end: si.end, side: 'out', solo: false })
      } else if (i === last) {
        const d = Math.min(item.transitionOut.duration, si.end - si.start)
        transitions.push({ type: item.transitionOut.type, start: si.end - d, end: si.end, side: 'out', solo: true })
      }
    }
    if (i === 0 && item.transitionIn) {
      const d = Math.min(item.transitionIn.duration, si.end - si.start)
      transitions.push({ type: item.transitionIn.type, start: si.start, end: si.start + d, side: 'in', solo: true })
    }
    const res = mediaLayer(doc, item, si.start, si.end, i * 0.001, 0, transitions, getAsset, voices)
    if (res.video) video.push(res.video)
    if (res.audio) audio.push(res.audio)
    edit.add(si.start)
    edit.add(si.end)
  })

  layout.connected.forEach((ci, i) => {
    if (ci.hanging) return
    const z = ci.lane > 0 ? ci.lane + i * 1e-6 : ci.lane - 1 + i * 1e-6
    const res = mediaLayer(doc, ci.item.clip, ci.start, ci.end, z, ci.lane, [], getAsset, voices)
    if (res.video) video.push(res.video)
    if (res.audio) audio.push(res.audio)
    edit.add(ci.start)
    edit.add(ci.end)
  })

  applyMix(doc, audio, getAsset)
  video.sort((a, b) => a.z - b.z)
  const duration = Math.max(0, ...layout.spine.map((s) => s.end), ...layout.connected.filter((c) => !c.hanging).map((c) => c.end))
  return {
    fps: doc.settings.fps,
    width: doc.settings.width,
    height: doc.settings.height,
    duration,
    video,
    audio,
    editPoints: [...edit].sort((a, b) => a - b),
  }
}
