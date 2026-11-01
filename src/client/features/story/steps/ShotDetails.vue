<script setup lang="ts">
import { ArrowDown, ArrowRightToLine, ArrowUp, CornerDownRight, Hourglass, Link2, MoreHorizontal, Trash2, Unlink, X } from '@lucide/vue'
import { moveShot } from '@shared/story/structure'
import type { StoryShot } from '@shared/types/story'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { continuesBlocker } from '../sceneRun'
import { inFlight, useStory } from '../useStory'
import ShotDialogue from './ShotDialogue.vue'
import ShotFields from './ShotFields.vue'
import ShotMedia from './ShotMedia.vue'
import ShotPrompts from './ShotPrompts.vue'

/**
 * A shot opened under its row: its fields and lines on the left; its still, takes and two prompts on the right; the
 * shot's own actions (move, join, continue, delete) in its ⋯ menu.
 */
const props = defineProps<{ shot: StoryShot; index: number; total: number; label: string }>()
const s = useStory()

const group = computed(() => s.groupOf(props.shot))
/** Why the shot can't continue the previous one (StoryShot.continues), or nothing. */
const continuesProblem = computed(() => continuesBlocker(s.story.value, props.shot))
const waitingFor = computed(() => s.waitingFor(props.shot))
const takeWaiting = computed(() => s.preparingOf(props.shot, 'take'))
const hasPreviousEnd = computed(() => Boolean(s.previousEnd(props.shot)))
const keyState = computed(() => s.jobState(props.shot.keyframeGenerationId))
const hasKeyframe = computed(() => Boolean(s.keyframeOf(props.shot) || props.shot.keyframeGenerationId))
const preview = ref<{ url: string; video: boolean }>()

function edit(label: string, mutate: (shot: StoryShot) => void) {
  s.updateShot(props.shot.id, label, mutate)
}
function toggleContinues() {
  edit(props.shot.continues ? 'Cut from previous shot' : 'Continue previous shot', (x) => {
    if (x.continues) delete x.continues
    else x.continues = true
  })
}

/** A shot moves past its neighbour, or at the edge of its scene into the scene next to it (empty ones too). */
function canMove(delta: -1 | 1) {
  const at = props.index + delta
  if (at >= 0 && at < props.total) return true
  const scenes = s.story.value.scenes ?? []
  const k = scenes.findIndex((x) => x.id === props.shot.sceneId)
  return k >= 0 && Boolean(scenes[k + delta])
}
/**
 * A multi-shot group needs its shots in a row, in order: an edit that breaks that would silently drop the group and
 * its takes, so the group has to be broken up first.
 */
const GROUP_FIRST = 'is part of a multi-shot — break it up first (⋯ → Break up multi-shot)'
function move(delta: -1 | 1) {
  if (group.value) return void toast.warning(`This shot ${GROUP_FIRST}`)
  // Hops over a whole multi-shot rather than landing inside it; at a scene's edge it moves into the next scene.
  s.update('Reorder shots', (story) => moveShot(story, props.shot.id, delta))
}
function remove() {
  if (group.value) return void toast.warning(`This shot ${GROUP_FIRST}`)
  s.cancelShotRenders(props.shot)
  s.update('Delete shot', (story) => (story.shots = story.shots.filter((x) => x.id !== props.shot.id)))
}
</script>

<template>
  <!-- A container: side by side when the board is wide, one column when it is narrow (the Scene panel open). -->
  <div class="@container grid gap-3 rounded-b-2xl border-t bg-card p-3.5 ring-1 ring-border" :data-shot-details="shot.id">
    <div class="flex flex-wrap items-center gap-2">
      <span
        v-if="shot.continues && !continuesProblem"
        class="flex shrink-0 items-center gap-1 rounded-md bg-brand/10 px-1.5 py-0.5 text-[11px] text-brand"
        title="No cut: the take starts where the previous shot’s take ends"
        data-continues=""
      >
        <CornerDownRight class="size-3" /> continues the shot before
      </span>
      <span v-if="waitingFor" class="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground" data-waiting=""><Hourglass class="size-3" /> waiting for {{ waitingFor }}</span>
      <span v-else-if="takeWaiting" class="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground" data-waiting=""><Hourglass class="size-3" /> take waits for {{ takeWaiting }}</span>
      <div class="flex-1" />
      <DropdownMenu>
        <DropdownMenuTrigger as-child><Button variant="ghost" size="icon-sm" :aria-label="`More for shot ${label}`"><MoreHorizontal /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem :disabled="!canMove(-1)" @select="move(-1)"><ArrowUp /> Move up</DropdownMenuItem>
          <DropdownMenuItem :disabled="!canMove(1)" @select="move(1)"><ArrowDown /> Move down</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem :disabled="!s.canJoin(shot)" @select="s.joinWithNext(shot)"><Link2 /> Join next shot into multi-shot</DropdownMenuItem>
          <DropdownMenuItem v-if="group" @select="s.breakUp(group)"><Unlink /> Break up multi-shot</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            :disabled="Boolean(continuesProblem) && !shot.continues"
            :title="continuesProblem ?? 'No cut: the take starts where the previous shot’s take ends, and waits for it'"
            @select="toggleContinues"
          >
            <CornerDownRight /> {{ shot.continues ? 'Cut from the previous shot' : 'Continues the previous shot (no cut)' }}
          </DropdownMenuItem>
          <DropdownMenuItem :disabled="!hasPreviousEnd || inFlight(keyState)" @select="s.keyframeFromPrevious(shot)"><ArrowRightToLine /> Still from previous shot’s end</DropdownMenuItem>
          <DropdownMenuItem :disabled="!hasKeyframe" @select="s.removeKeyframe(shot)"><X /> Remove still</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" @select="remove"><Trash2 /> Delete shot</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <div class="grid grid-cols-[minmax(0,1fr)] gap-4 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div class="grid content-start gap-4">
        <ShotFields :shot="shot" />
        <ShotDialogue :shot="shot" />
      </div>
      <div class="grid content-start gap-4">
        <ShotMedia :shot="shot" @preview="(url, video) => (preview = { url, video })" />
        <ShotPrompts :shot="shot" />
      </div>
    </div>
    <p class="text-[11px] text-muted-foreground">
      The Director wrote both prompts from the scene. Change them freely: the cast’s and the place’s pictures go along by themselves, and each model gets the prompt in its own wording — Show what the models get.
    </p>

    <Dialog :open="Boolean(preview)" @update:open="(v) => !v && (preview = undefined)">
      <DialogContent class="sm:max-w-3xl">
        <DialogHeader><DialogTitle>Shot {{ label }}</DialogTitle></DialogHeader>
        <video v-if="preview?.video" :src="preview.url" controls autoplay class="w-full rounded-md bg-black" />
        <img v-else-if="preview" :src="preview.url" class="w-full rounded-md bg-black object-contain" alt="" />
      </DialogContent>
    </Dialog>
  </div>
</template>
