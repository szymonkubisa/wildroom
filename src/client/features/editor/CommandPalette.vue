<script setup lang="ts">
import type { GenKind } from '@shared/types/jobs'
import type { TitleTemplate } from '@shared/types/project-doc'
import { useRouter } from 'vue-router'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import { useLibrary } from '@/features/library/library'
import { useDirector } from '@/features/director/director'
import { openPlanStep } from '@/features/story/planStep'
import { useStory } from '@/features/story/useStory'
import { okToReplaceStoryCut } from '@/features/story/useStoryBatch'
import { useTimelineCommands } from '@/features/timeline/commands'
import { useClipTools } from '@/features/tools/useClipTools'
import { useTourStore } from '@/stores/tour'
import { useSplitShots } from '@/features/timeline/splitShots'
import { useTimelines } from '@/features/timeline/timelines'
import { timelineZoom } from '@/features/timeline/zoom'
import { FRAME_PRESETS } from '@shared/canvas/framePresets'
import { computed } from 'vue'
import { toast } from 'vue-sonner'
import { errorMessage } from '@/lib/api'
import { assetItems, runImageTool, useAsReference } from '@/features/canvas/canvasActions'
import { addFrame } from '@/features/canvas/frames'
import { addBoard } from '@/features/canvas/useCanvasDoc'
import { useCanvasStore } from '@/stores/canvas'
import { openSettings } from '@/features/settings/settingsSheet'
import { type Workspace, useEditorStore } from '@/stores/editor'
import { useGenerateStore } from '@/stores/generate'
import { transport } from './transport'

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ import: []; export: [] }>()
const router = useRouter()
const editor = useEditorStore()
const commands = useTimelineCommands()
const { splitIntoShots } = useSplitShots()
const generate = useGenerateStore()
const clipTools = useClipTools()
const canvas = useCanvasStore()
const timelines = useTimelines()
const story = useStory()
const library = useLibrary()
const director = useDirector()

/** The frame under the playhead as a new image in Assets (the timeline stays as it is). */
async function saveFrameToAssets() {
  if (editor.playing) transport.pause()
  try {
    if (await commands.grabFrameAtPlayhead()) toast.success('Frame added to Assets')
  } catch (err) {
    toast.error('Could not save the frame', { description: errorMessage(err) })
  }
}

interface Item {
  /** List key when the label may repeat (timeline names). */
  id?: string
  label: string
  shortcut?: string
  run: () => void
}

const timelineGroups: { heading: string; items: Item[] }[] = [
  {
    heading: 'Generate',
    items: (
      [
        ['video', 'Generate video shot'],
        ['image', 'Generate image / still'],
        ['speech', 'Generate voice-over'],
        ['dialogue', 'Generate dialogue'],
        ['music', 'Generate music'],
        ['sfx', 'Generate sound effect'],
      ] as [GenKind, string][]
    ).map(([kind, label]) => ({ label, run: () => generate.open(kind) })),
  },
  {
    heading: 'Edit',
    items: [
      { label: 'Generate shot at playhead', run: () => commands.generateHere() },
      { label: 'Blade at playhead', shortcut: '⌘B', run: () => commands.bladeAtPlayhead() },
      { label: 'Blade all', shortcut: '⇧⌘B', run: () => commands.bladeAtPlayhead(true) },
      { label: 'Add cross dissolve', shortcut: '⌘T', run: () => commands.addTransition('dissolve') },
      { label: 'Add dip to black', run: () => commands.addTransition('dip-black') },
      ...(['basic', 'centered', 'lower-third', 'caption'] as TitleTemplate[]).map((t) => ({
        label: `Add title — ${t.replace('-', ' ')}`,
        run: () => commands.addTitle(t),
      })),
      { label: 'Add solid colour', run: () => commands.addGenerator() },
      { label: 'Add marker', shortcut: 'M', run: () => commands.addMarker() },
      { label: 'Add to-do marker', run: () => commands.addMarker('todo') },
      { label: 'Detach audio', shortcut: '⌃⇧S', run: () => commands.detachAudio() },
      { label: 'Lift from storyline', shortcut: '⌥⌘↑', run: () => commands.liftFromStoryline() },
      { label: 'Overwrite to primary storyline', shortcut: '⌥⌘↓', run: () => commands.overwriteToPrimary() },
      { label: 'Next take', shortcut: '⌃→', run: () => commands.cycleTake(1) },
      { label: 'Generate captions from dialogue', run: () => commands.generateCaptions() },
      { label: 'Split selected clip into shots', run: () => editor.selection[0] && void splitIntoShots(editor.selection[0]) },
      { label: 'Export captions (.srt)', run: () => commands.exportCaptions('srt') },
      { label: 'Copy selected clips', shortcut: '⌘C', run: () => commands.copySelection() },
      { label: 'Paste at playhead', shortcut: '⌘V', run: () => commands.paste() },
      { label: 'Duplicate selected clips', shortcut: '⌘D', run: () => commands.duplicateSelection() },
      { label: 'Freeze frame at playhead', shortcut: '⌥F', run: () => void clipTools.freezeFrame() },
      { label: 'Save frame at playhead to Assets', run: () => void saveFrameToAssets() },
    ],
  },
  {
    heading: 'AI tools',
    items: [
      { label: 'Edit inside the shot (remove / replace / add)', run: () => (editor.dialog = 'edit-shot') },
      { label: 'Check continuity between shots', run: () => (editor.dialog = 'continuity') },
      { label: 'Start the walkthrough', run: () => useTourStore().start() },
      { label: 'Browse all features', run: () => void router.push({ name: 'features' }) },
      { label: 'Smart reframe for vertical / square', run: () => (editor.dialog = 'reframe') },
      { label: 'Edit by transcript (remove words, fillers, pauses)', run: () => (editor.rightTab = 'transcript') },
      { label: 'Generate more after the selected clip’s last frame', run: () => editor.selection[0] && void clipTools.extendClip(editor.selection[0]) },
      { label: 'Generate more before the selected clip’s first frame', run: () => editor.selection[0] && void clipTools.extendBeforeClip(editor.selection[0]) },
      { label: 'Isolate voice in selected clip', run: () => editor.selection[0] && void clipTools.isolateVoice(editor.selection[0]) },
      { label: 'Detect beats in selected clip', run: () => editor.selection[0] && void clipTools.detectBeats(editor.selection[0]) },
    ],
  },
  {
    heading: 'View & playback',
    items: [
      { label: 'Zoom to fit', shortcut: '⇧Z', run: () => timelineZoom.fit() },
      { label: 'Toggle snapping', shortcut: 'N', run: () => (editor.snapping = !editor.snapping) },
      { label: 'Toggle skimming', shortcut: 'S', run: () => (editor.skimming = !editor.skimming) },
      { label: 'Go to start', shortcut: 'Home', run: () => transport.goStart() },
      { label: 'Go to end', shortcut: 'End', run: () => transport.goEnd() },
      { label: 'Clear range', shortcut: '⌥X', run: () => editor.clearRange() },
    ],
  },
  {
    heading: 'Project',
    items: [
      { label: 'Import media…', shortcut: '⌘I', run: () => emit('import') },
      { label: 'Export…', shortcut: '⌘E', run: () => emit('export') },
      { label: 'Export for Final Cut Pro (FCPXML)', run: () => void commands.exportFcpxml() },
      { label: 'Settings', shortcut: '⌘,', run: () => openSettings() },
      { label: 'All projects', run: () => void router.push({ name: 'projects' }) },
    ],
  },
]

const workspaceGroup: { heading: string; items: Item[] } = {
  heading: 'Workspace',
  items: [
    ...(
      [
        ['story', 'Plan — script, cast and shots'],
        ['canvas', 'Create — images, web and social assets'],
        ['edit', 'Edit — the video editor'],
      ] as [Workspace, string][]
    ).map(([ws, label]) => ({ label: `Go to ${label}`, run: () => void (editor.workspace = ws) })),
    // The Library opens over any of them: media, cast, places and the brand kit.
    { label: 'Open the Library', shortcut: '⌘L', run: () => library.show() },
    { label: 'Library — Media', run: () => library.show('media') },
    { label: 'Library — Cast', run: () => library.show('cast') },
    { label: 'Library — Places', run: () => library.show('places') },
    { label: 'Brand kit — colours, fonts, logos and style (Library › Brand)', run: () => library.show('brand') },
  ],
}

async function assembleStory() {
  if (!(await okToReplaceStoryCut(story))) return
  try {
    await story.assemble()
  } catch (err) {
    toast.error('Could not update the timeline', { description: errorMessage(err) })
  }
}

const planGroup: { heading: string; items: Item[] } = {
  heading: 'Plan',
  items: [
    { label: 'Plan — 1 Script: the script and its scenes', run: () => openPlanStep('story') },
    { label: 'Plan — 2 Cast & Places', run: () => openPlanStep('cast') },
    { label: 'Plan — 3 Shots: stills and takes, scene by scene', run: () => openPlanStep('scenes') },
    { label: 'Plan — 4 Film: finals, animatic and the Story cut', run: () => openPlanStep('render') },
    { label: 'Update timeline — the story on the Story cut', run: () => void assembleStory() },
  ],
}

const canvasGroups = (): { heading: string; items: Item[] }[] => [
  {
    heading: 'Canvas',
    items: [
      { label: 'Generate an image onto the board', run: () => generate.open('image') },
      { label: 'Generate from the selected images', run: () => canvas.selectedImageIds.length && useAsReference(canvas.selectedImageIds) },
      { label: 'Remove background of the selected images', run: () => void runImageTool('cutout', assetItems(canvas.selectedItems)) },
      { label: 'Vectorize the selected images to SVG', run: () => void runImageTool('vectorize', assetItems(canvas.selectedItems)) },
      { label: 'Plan a set of assets from a brief…', run: () => (canvas.dialog = 'asset-set') },
      { label: 'Export frames and images…', shortcut: '⌘E', run: () => (canvas.dialog = 'export') },
      { label: 'Favicon & app icons from the selected image…', run: () => (canvas.dialog = 'favicon') },
      ...FRAME_PRESETS.filter((p) => ['og', 'ig-post', 'story', 'hero', 'logo', 'yt-thumb', 'fb-link'].includes(p.id)).map((p) => ({
        label: `Add frame — ${p.label} (${p.w}×${p.h})`,
        run: () => void addFrame(p),
      })),
      { label: 'New board', run: () => void addBoard() },
      { label: 'Zoom to fit', shortcut: '⇧1', run: () => canvas.requestZoom('fit') },
      { label: 'Zoom to selection', shortcut: '⇧2', run: () => canvas.requestZoom('selection') },
      { label: 'Toggle lineage links', run: () => (canvas.showLineage = !canvas.showLineage) },
    ],
  },
]

/** The project's timelines: new, duplicate, and open any other one (they are also cards in Assets). */
const timelineGroup = computed(() => ({
  heading: 'Timelines',
  items: [
    { label: 'New timeline…', run: () => (editor.dialog = 'new-timeline') },
    { label: `Duplicate timeline “${timelines.active.value.name}”`, run: () => void timelines.duplicate(timelines.active.value.id) },
    ...timelines.list.value
      .filter((t) => !t.active)
      .map((t): Item => ({ id: `open:${t.id}`, label: `Open timeline — ${t.name}`, run: () => timelines.open(t.id) })),
  ] as Item[],
}))

/** The Director's chat: a plan with its cost for anything asked, run once approved. */
const directorGroup: { heading: string; items: Item[] } = {
  heading: 'Director',
  items: [
    { label: 'Ask the Director… (a plan with its cost, run when you approve)', run: () => director.show(true) },
    { label: 'Show or hide the Director', shortcut: '⌘D', run: () => director.toggle() },
    { label: 'Director — plan stills, voices and draft takes for every shot', run: () => director.ask('Plan stills, voices and draft takes for every shot that needs them') },
    { label: 'Director — write music for the film', run: () => director.ask('Write music for the film') },
  ],
}

const generateGroup = timelineGroups[0]!
const projectGroup = timelineGroups.at(-1)!
const groups = computed(() => {
  if (editor.workspace === 'canvas') return [...canvasGroups(), directorGroup, generateGroup, workspaceGroup, planGroup, projectGroup]
  if (editor.workspace === 'edit') return [...timelineGroups, directorGroup, timelineGroup.value, workspaceGroup, planGroup]
  if (editor.workspace === 'story') return [planGroup, directorGroup, generateGroup, timelineGroup.value, workspaceGroup, projectGroup]
  return [directorGroup, generateGroup, timelineGroup.value, workspaceGroup, planGroup, projectGroup]
})

function select(item: Item) {
  open.value = false
  requestAnimationFrame(item.run)
}
</script>

<template>
  <CommandDialog v-model:open="open">
    <CommandInput placeholder="Type a command…" />
    <CommandList>
      <CommandEmpty>No matching command.</CommandEmpty>
      <CommandGroup v-for="g in groups" :key="g.heading" :heading="g.heading">
        <CommandItem v-for="item in g.items" :key="item.id ?? item.label" :value="`${g.heading} ${item.id ?? ''} ${item.label}`" @select="select(item)">
          {{ item.label }}
          <CommandShortcut v-if="item.shortcut">{{ item.shortcut }}</CommandShortcut>
        </CommandItem>
      </CommandGroup>
    </CommandList>
  </CommandDialog>
</template>
