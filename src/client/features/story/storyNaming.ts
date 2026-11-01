import { clipsInAllTimelines } from '@shared/timeline/timelines'
import { flicksToSeconds } from '@shared/time/flicks'
import type { AssetDTO } from '@shared/types/assets'
import { activeTake } from '@shared/types/project-doc'
import { type StoryDoc, type StoryMultishot, type StoryShot, emptyStory } from '@shared/types/story'
import { toRef } from 'vue'
import { api } from '@/lib/api'
import { useAssetsStore } from '@/stores/assets'
import { useJobsStore } from '@/stores/jobs'
import { useProjectStore } from '@/stores/project'
import { takeCuts, validGroups } from './multishot'
import * as planning from './planning'
import { generatedMedia } from './storyMedia'

/**
 * What takes are called: after the shots they show. Reads the jobs, the assets and the story's shots and groups only —
 * the timeline names a split take's pieces with it (nameStoryTakes below) without the rest of the storyboard.
 */

/** Projects whose older takes were renamed after their shots this session (see nameStoryTakes). */
const namedProjects = new Set<string>()

/** A name made from the start of a prompt ("A multi-shot sequence of 3 shots joined by hard…", "… (2)"). */
function promptName(name: string | undefined, prompt: string | undefined): boolean {
  if (!name || !prompt) return false
  const head = name.replace(/\s*\(\d+\)$/, '').replace(/…$/, '').replace(/\s+/g, ' ').trim()
  return head.length >= 12 && prompt.replace(/\s+/g, ' ').trim().startsWith(head)
}

/** A take is called after what its (first) shot shows: "Valentina emerges from the party and discovers Mateo…". */
export function takeName(shots: readonly StoryShot[]): string | undefined {
  return shots[0]?.description?.trim().replace(/\s+/g, ' ') || undefined
}

/** What naming reads: the stores, and the story's shots and groups (see storyCore). */
export interface NamingSource {
  stores: {
    project: ReturnType<typeof useProjectStore>
    assets: ReturnType<typeof useAssetsStore>
    jobs: ReturnType<typeof useJobsStore>
  }
  story: { readonly value: StoryDoc }
  groups: { readonly value: StoryMultishot[] }
  groupShots: (g: StoryMultishot) => StoryShot[]
  outputOf: (generationId?: string) => AssetDTO | undefined
}

export function createNaming(source: NamingSource) {
  const { story, groups, groupShots, outputOf } = source
  const { project, assets, jobs } = source.stores

  /**
   * Takes rendered before the storyboard named its renders are called after their prompt ("A multi-shot sequence of 3
   * shots…"). Their media and the timeline clips cut from them (every timeline) are renamed after the shots they show:
   * a clip of one shot after that shot's description, a longer one after its first shot's. A clip still called after
   * its whole take is renamed too, so pieces split from it name their shots. Names someone typed stay. Once per
   * project and session unless `force`; returns how many names changed.
   */
  async function nameStoryTakes(opts: { force?: boolean } = {}): Promise<number> {
    const id = project.id
    if (!id || (namedProjects.has(id) && !opts.force)) return 0
    namedProjects.add(id)
    const fps = project.doc.settings.fps
    interface Namer {
      whole: string
      prompt?: string
      at: (from: number, to: number) => string
    }
    const namers = new Map<string, Namer>()
    const promptOf = (gid: string, asset: AssetDTO) => {
      const p = jobs.byId[gid]?.params?.prompt ?? asset.generation?.params?.prompt
      return typeof p === 'string' ? p : undefined
    }
    for (const g of groups.value) {
      const shots = groupShots(g)
      const whole = takeName(shots)
      if (!whole) continue
      for (const gid of g.videoGenerationIds) {
        const asset = outputOf(gid)
        if (!asset?.durationFlicks) continue
        const seconds = flicksToSeconds(asset.durationFlicks)
        const { cuts, start } = takeCuts(shots, seconds, g.takes?.[gid])
        const bounds = [start ?? 0, ...cuts, seconds]
        namers.set(asset.id, {
          whole,
          prompt: promptOf(gid, asset),
          // The shots this stretch of the take shows, more than a few frames of each.
          at: (from, to) => {
            const shown = shots.filter((_, i) => Math.min(to, bounds[i + 1]!) - Math.max(from, bounds[i]!) > 0.25)
            return shown.length === 1 ? (takeName(shown) ?? whole) : whole
          },
        })
      }
    }
    for (const shot of story.value.shots) {
      const whole = takeName([shot])
      if (!whole) continue
      for (const gid of shot.videoGenerationIds) {
        const asset = outputOf(gid)
        if (asset) namers.set(asset.id, { whole, prompt: promptOf(gid, asset), at: () => whole })
      }
    }
    let changed = 0
    const before = new Map<string, string>()
    for (const [assetId, namer] of namers) {
      const asset = assets.get(assetId)
      if (!asset || asset.name === namer.whole || !promptName(asset.name, namer.prompt)) continue
      before.set(assetId, asset.name)
      try {
        assets.upsert(await api.assets.update(assetId, { name: namer.whole }))
        changed++
      } catch {
        // Renaming is cosmetic: a failure leaves the old name.
      }
    }
    project.applyFact((d) => {
      for (const clip of clipsInAllTimelines(d)) {
        if (clip.kind !== 'media') continue
        const take = activeTake(clip)
        const namer = take?.assetId ? namers.get(take.assetId) : undefined
        if (!take || !namer) continue
        const old = before.get(take.assetId!) ?? assets.get(take.assetId)?.name
        if (clip.name && clip.name !== old && clip.name !== namer.whole && !promptName(clip.name, namer.prompt)) continue
        const from = flicksToSeconds(take.sourceIn)
        const next = namer.at(from, from + (clip.duration * clip.speed) / fps)
        if (clip.name === next) continue
        clip.name = next
        changed++
      }
    })
    return changed
  }

  return { nameStoryTakes }
}

/**
 * nameStoryTakes for the timeline (Split into shots names a storyboard take's new pieces after their shots): read
 * from the stores as they are, without building the storyboard — its models, settings and the rest.
 */
export function nameStoryTakes(opts: { force?: boolean } = {}): Promise<number> {
  const project = useProjectStore()
  const assets = useAssetsStore()
  const jobs = useJobsStore()
  // Getters, not computeds: read once, for this one naming.
  const story = toRef((): StoryDoc => project.doc.story ?? emptyStory())
  const { outputOf } = generatedMedia(jobs, assets)
  return createNaming({
    stores: { project, assets, jobs },
    story,
    groups: toRef(() => validGroups(story.value)),
    groupShots: (g) => planning.groupShots(story.value, g),
    outputOf,
  }).nameStoryTakes(opts)
}
