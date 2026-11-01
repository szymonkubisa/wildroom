<script setup lang="ts">
import { BookOpen, Plus } from '@lucide/vue'
import { addScene } from '@shared/story/structure'
import { nanoid } from 'nanoid'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useStory } from '../useStory'
import type { StoryBatch } from '../useStoryBatch'
import SceneBoard from './SceneBoard.vue'
import SceneInspector from './SceneInspector.vue'
import SceneOutline from './SceneOutline.vue'

/** Step 3, Shots: the chapters and scenes on the left, the chosen scene's shots in the middle, what the scene sets on the right. */
defineProps<{ batch: StoryBatch }>()
const emit = defineEmits<{ outline: [] }>()
const sceneId = defineModel<string | undefined>('sceneId')
const { story, update } = useStory()
const hasScenes = computed(() => Boolean(story.value.scenes?.length))

function firstScene() {
  const id = nanoid(8)
  update('Add scene', (st) => addScene(st, { id, title: 'Scene 1' }))
  sceneId.value = id
}
</script>

<template>
  <div v-if="!hasScenes" class="panel-card flex flex-col items-center justify-center gap-3 bg-sidebar text-center">
    <BookOpen class="size-6 text-muted-foreground" />
    <div class="text-sm font-medium">No scenes yet</div>
    <div class="max-w-sm text-xs text-muted-foreground">Create the scenes from the script in step 1, Script — the AI splits it into scenes — or start with a scene of your own.</div>
    <div class="flex gap-2">
      <Button @click="emit('outline')">Go to the script</Button>
      <Button variant="ghost" @click="firstScene"><Plus /> Add a scene</Button>
    </div>
  </div>
  <ResizablePanelGroup v-else direction="horizontal" auto-save-id="story-scenes" class="min-h-0">
    <ResizablePanel :default-size="20" :min-size="14"><SceneOutline v-model:scene-id="sceneId" class="panel-card h-full" /></ResizablePanel>
    <ResizableHandle class="panel-gutter" />
    <ResizablePanel :default-size="56" :min-size="35">
      <SceneBoard v-if="sceneId" :scene-id="sceneId" :batch="batch" class="panel-card h-full" @select="(id) => (sceneId = id)" />
    </ResizablePanel>
    <ResizableHandle class="panel-gutter" />
    <ResizablePanel :default-size="24" :min-size="16"><SceneInspector v-if="sceneId" :scene-id="sceneId" class="panel-card h-full" /></ResizablePanel>
  </ResizablePanelGroup>
</template>
