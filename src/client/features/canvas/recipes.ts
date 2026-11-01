import { AudioLines, Box, Clapperboard, LayoutGrid, Mountain, Smartphone, Sparkles, UserRound, Video } from '@lucide/vue'
import type { CanvasAssetItem } from '@shared/types/canvas'
import type { GenKind } from '@shared/types/jobs'
import type { Component } from 'vue'
import { toast } from 'vue-sonner'
import { openCoverage } from '@/features/generate/coverageRun'
import { useAssetsStore } from '@/stores/assets'
import { useCanvasStore } from '@/stores/canvas'
import { useGenerateStore } from '@/stores/generate'

/**
 * Starting points — the empty Feed, and Recipes in Create's bar: most fill the Composer — the kind, a prompt with
 * [brackets] to replace, the aspect — and cost nothing until Generate (Auto picks the model); Shots works on a picture
 * there already. Each has a miniature (RecipePreview) that plays on hover.
 */
export interface Recipe {
  id: string
  title: string
  sub: string
  kind: GenKind
  icon: Component
  /** What the catalog groups it under. */
  group: 'Images' | 'Clips' | 'From a picture' | 'Sound'
  prompt?: string
  aspectRatio?: string
  seconds?: number
  /** Does it itself instead of filling the Composer. */
  run?: () => void
}

/** Shots from the image selected on the board (the picker, then one picture per angle beside it). */
function shotsFromSelected() {
  const canvas = useCanvasStore()
  const assets = useAssetsStore()
  const item = canvas.selectedItems.find((i): i is CanvasAssetItem => i.kind === 'asset' && assets.get(i.assetId)?.kind === 'image')
  const asset = item ? assets.get(item.assetId) : undefined
  if (asset?.status === 'ready') return openCoverage(asset, item)
  toast('Pick a picture first', { description: 'Select an image on the board, or hover one in the Feed and click Shots. In Plan, an open shot has “Shots from still”.' })
}

export const RECIPES: Recipe[] = [
  {
    id: 'shots',
    title: 'Shots from one image',
    sub: 'A wide, a close-up, the reverse… of the same moment',
    kind: 'image',
    icon: LayoutGrid,
    group: 'From a picture',
    run: shotsFromSelected,
  },
  {
    id: 'product',
    title: 'Product hero',
    sub: 'Studio shot on a seamless backdrop',
    kind: 'image',
    icon: Box,
    group: 'Images',
    prompt: 'Studio product shot of [your product] on a seamless [colour] backdrop, soft key light from the left, gentle reflection, crisp detail',
  },
  {
    id: 'character',
    title: 'Character sheet',
    sub: 'Front, ¾ and side views to reuse as Cast',
    kind: 'image',
    icon: UserRound,
    group: 'Images',
    prompt: 'Character sheet of [describe the person]: front, three-quarter and side views, full body on plain grey, same outfit in every view, neutral light',
  },
  {
    id: 'place',
    title: 'Location plate',
    sub: 'An empty place to set scenes in',
    kind: 'image',
    icon: Mountain,
    group: 'Images',
    prompt: 'Empty [place] at [time of day], no people, wide establishing view, natural light',
  },
  {
    id: 'establishing',
    title: 'Establishing shot',
    sub: 'A slow cinematic move over a place',
    kind: 'video',
    icon: Clapperboard,
    group: 'Clips',
    prompt: 'Slow aerial push-in over [place] at golden hour, mist in the valleys, cinematic',
    seconds: 5,
  },
  {
    id: 'portrait',
    title: 'Talking portrait',
    sub: 'A close-up that speaks to camera',
    kind: 'video',
    icon: Video,
    group: 'Clips',
    prompt: 'Close-up of [person] speaking to camera, subtle head movement, soft window light, shallow depth of field',
    seconds: 5,
  },
  {
    id: 'vertical',
    title: 'Social vertical',
    sub: '9:16 for Reels and TikTok',
    kind: 'video',
    icon: Smartphone,
    group: 'Clips',
    prompt: 'Handheld vertical shot of [subject], energetic, natural light, quick reveal',
    aspectRatio: '9:16',
    seconds: 5,
  },
  {
    id: 'sting',
    title: 'Logo sting',
    sub: 'A short reveal that ends on the logo',
    kind: 'video',
    icon: Sparkles,
    group: 'Clips',
    prompt: '[Brand name] assembling from glowing particles on black, quick and clean, ends on the logo centred',
    seconds: 4,
  },
  {
    id: 'music',
    title: 'Music bed',
    sub: 'An underscore for the cut',
    kind: 'music',
    icon: AudioLines,
    group: 'Sound',
    prompt: 'Warm cinematic underscore, slow build, piano and strings, [mood]',
  },
]

/** The recipe in the Composer: its kind, prompt and aspect; the model is Auto's (or the one picked) for that kind. */
export function applyRecipe(recipe: Recipe) {
  if (recipe.run) return recipe.run()
  useGenerateStore().open(recipe.kind, {
    params: { prompt: recipe.prompt ?? '', ...(recipe.aspectRatio ? { aspectRatio: recipe.aspectRatio } : {}) },
    ...(recipe.seconds ? { fitSeconds: recipe.seconds } : {}),
  })
}
