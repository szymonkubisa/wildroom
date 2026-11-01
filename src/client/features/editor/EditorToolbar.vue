<script setup lang="ts">
import { ArrowLeft, Brush, Check, CloudOff, Download, FileText, Loader2, RectangleVertical, Redo2, ScanSearch, Sparkles, Undo2, Upload } from '@lucide/vue'
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import GpuSessionChip from '@/features/gpu/GpuSessionChip.vue'
import RendersPanel from '@/features/jobs/RendersPanel.vue'
import BudgetChip from '@/features/story/BudgetChip.vue'
import { useStory } from '@/features/story/useStory'
import DirectorIcon from '@/features/director/DirectorIcon.vue'
import { useDirector } from '@/features/director/director'
import { cn } from '@/lib/utils'
import { useProjectSpend } from '@/features/story/useStoryBatch'
import { useEditorStore } from '@/stores/editor'
import { useProjectStore } from '@/stores/project'

const emit = defineEmits<{ import: []; export: []; palette: [] }>()
const router = useRouter()
const project = useProjectStore()
const editor = useEditorStore()
const editingName = ref(false)
const director = useDirector()
const nameDraft = ref('')

// What this project's generations cost, in every workspace; the budget is the story's (batches warn against it).
const story = useStory()
const { spend, refreshSpend } = useProjectSpend()
function setBudget(usd: number | undefined) {
  story.update(usd ? 'Set budget' : 'Clear budget', (s) => (s.budgetUsd = usd))
}

function startRename() {
  nameDraft.value = project.name
  editingName.value = true
}

async function finishRename() {
  editingName.value = false
  const v = nameDraft.value.trim()
  if (v && v !== project.name) await project.rename(v)
}
</script>

<template>
  <header class="flex h-12 shrink-0 items-center gap-1.5 bg-background pr-2.5 pl-3">
    <Tooltip>
      <TooltipTrigger as-child>
        <Button variant="ghost" size="icon-sm" class="rounded-full text-muted-foreground hover:text-foreground" @click="router.push({ name: 'projects' })"><ArrowLeft /></Button>
      </TooltipTrigger>
      <TooltipContent>All projects</TooltipContent>
    </Tooltip>
    <Input
      v-if="editingName"
      v-model="nameDraft"
      class="h-8 w-56 rounded-lg text-[13px]"
      autofocus
      @keydown.enter="finishRename"
      @keydown.escape="editingName = false"
      @blur="finishRename"
    />
    <button v-else class="max-w-72 truncate rounded-lg px-2 py-1 text-[13px] font-semibold tracking-tight hover:bg-accent" @dblclick="startRename" @click="startRename">
      {{ project.name }}
    </button>
    <span class="flex items-center gap-1 rounded-full bg-field px-2 py-0.5 text-[11px] text-muted-foreground">
      <Loader2 v-if="project.saveState === 'saving'" class="size-3 animate-spin" />
      <Check v-else-if="project.saveState === 'saved'" class="size-3" />
      <CloudOff v-else-if="project.saveState === 'error'" class="size-3 text-destructive" />
      {{ project.saveState === 'saved' ? 'Saved' : project.saveState === 'saving' ? 'Saving…' : project.saveState === 'error' ? 'Not saved' : 'Edited' }}
    </span>
    <!-- Undo and redo for every workspace (the timeline, the story, the board and the brand share one history). -->
    <Tooltip>
      <TooltipTrigger as-child>
        <Button variant="ghost" size="icon-sm" class="rounded-full text-muted-foreground hover:text-foreground" aria-label="Undo" data-top-undo="" :disabled="!project.canUndo" @click="project.undo()"><Undo2 /></Button>
      </TooltipTrigger>
      <TooltipContent>{{ project.undoLabel ? `Undo ${project.undoLabel}` : 'Undo' }} (⌘Z)</TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger as-child>
        <Button variant="ghost" size="icon-sm" class="-ml-1 rounded-full text-muted-foreground hover:text-foreground" aria-label="Redo" data-top-redo="" :disabled="!project.canRedo" @click="project.redo()"><Redo2 /></Button>
      </TooltipTrigger>
      <TooltipContent>{{ project.redoLabel ? `Redo ${project.redoLabel}` : 'Redo' }} (⇧⌘Z)</TooltipContent>
    </Tooltip>
    <div class="flex-1" />
    <Button data-tour="commands" variant="ghost" size="sm" class="rounded-full text-muted-foreground hover:text-foreground" @click="emit('palette')">
      Commands <Kbd class="text-[10px]">⌘K</Kbd>
    </Button>
    <DropdownMenu v-if="editor.workspace === 'edit'">
      <DropdownMenuTrigger as-child>
        <Button data-tour="ai-tools" variant="outline" size="sm" class="rounded-full px-3.5"><Sparkles class="text-brand" /> AI tools</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-[21rem]">
        <DropdownMenuLabel>AI tools</DropdownMenuLabel>
        <DropdownMenuItem @select="editor.dialog = 'edit-shot'"><Brush /> Edit inside the shot at playhead… <span class="menu-badge ml-auto">AI</span></DropdownMenuItem>
        <DropdownMenuItem @select="editor.dialog = 'continuity'"><ScanSearch /> Check continuity between shots… <span class="menu-badge ml-auto">AI</span></DropdownMenuItem>
        <DropdownMenuItem @select="editor.dialog = 'reframe'"><RectangleVertical /> Smart reframe (9:16, 1:1…)… <span class="menu-badge ml-auto">AI</span></DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem @select="editor.rightTab = 'transcript'"><FileText /> Edit by transcript</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <Button variant="outline" size="sm" class="rounded-full px-3.5" @click="emit('import')"><Upload /> Import</Button>
    <BudgetChip :spend="spend" :budget="story.story.value.budgetUsd" class="h-8 rounded-full px-3" @open="refreshSpend" @update:budget="setBudget" />
    <GpuSessionChip />
    <RendersPanel />
    <Tooltip>
      <TooltipTrigger as-child>
        <Button
          variant="ghost"
          size="sm"
          :class="cn('rounded-full px-3 text-muted-foreground hover:text-foreground', director.open && 'bg-accent text-foreground')"
          :aria-pressed="director.open"
          data-top-director=""
          @click="director.toggle()"
        >
          <DirectorIcon class="size-4 text-role-titles" /> <span class="max-[900px]:hidden">Director</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>The Director: plans with their cost, runs them when you approve (⌘D)</TooltipContent>
    </Tooltip>
    <Button data-tour="export" size="sm" class="rounded-full bg-brand px-4 text-brand-foreground hover:bg-brand/90" @click="emit('export')"><Download /> Export</Button>
  </header>
</template>
