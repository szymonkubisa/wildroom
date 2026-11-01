<script setup lang="ts">
import { useLocalStorage } from '@vueuse/core'
import { watch } from 'vue'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import CanvasInspector from '@/features/canvas/CanvasInspector.vue'
import FeedInspector from '@/features/canvas/FeedInspector.vue'
import Inspector from '@/features/inspector/Inspector.vue'
import TranscriptPanel from '@/features/transcript/TranscriptPanel.vue'
import { type RightTab, useEditorStore } from '@/stores/editor'

/** The right panel: the Inspector, and in Edit the Transcript. Generating is the Composer's, at the bottom of each workspace. */
const editor = useEditorStore()
/** Create's Board or Feed (CanvasWorkspace keeps it under the same key). */
const createMode = useLocalStorage<'board' | 'feed'>('create.mode', 'board')

// The transcript belongs to the video timeline: other workspaces fall back to the Inspector.
watch(
  () => editor.workspace,
  (ws) => {
    if (ws !== 'edit' && editor.rightTab === 'transcript') editor.rightTab = 'inspector'
  },
  { immediate: true },
)
</script>

<template>
  <Tabs
    :model-value="editor.rightTab"
    class="flex h-full min-h-0 flex-col gap-0 bg-sidebar"
    @update:model-value="(v) => (editor.rightTab = v as RightTab)"
  >
    <div v-if="editor.workspace === 'edit'" class="px-2.5 pt-2.5 pb-1.5">
      <TabsList class="h-9 w-full">
        <TabsTrigger value="inspector" class="text-[12.5px]">Inspector</TabsTrigger>
        <TabsTrigger value="transcript" class="text-[12.5px]">Transcript</TabsTrigger>
      </TabsList>
    </div>
    <div v-else class="px-3.5 pt-3 pb-1 text-[12.5px] font-medium">Inspector</div>
    <TabsContent value="inspector" class="mt-0 min-h-0 flex-1">
      <FeedInspector v-if="editor.workspace === 'canvas' && createMode === 'feed'" />
      <CanvasInspector v-else-if="editor.workspace === 'canvas'" />
      <Inspector v-else />
    </TabsContent>
    <TabsContent v-if="editor.workspace === 'edit'" value="transcript" class="mt-0 min-h-0 flex-1">
      <TranscriptPanel />
    </TabsContent>
  </Tabs>
</template>
