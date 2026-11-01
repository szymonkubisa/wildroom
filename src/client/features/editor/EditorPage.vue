<script lang="ts">
/** The project the editor last opened (shared by every EditorPage): copied clips only paste back into it. */
let lastProjectId: string | undefined
</script>

<script setup lang="ts">
import { Loader2 } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import AssetsPanel from '@/features/assets/AssetsPanel.vue'
import ExportDialog from '@/features/export/ExportDialog.vue'
import ContinuityDialog from '@/features/tools/ContinuityDialog.vue'
import EditShotDialog from '@/features/tools/EditShotDialog.vue'
import ReframeDialog from '@/features/tools/ReframeDialog.vue'
import LookDesigner from '@/features/story/LookDesigner.vue'
import StoryWorkspace from '@/features/story/StoryWorkspace.vue'
import { storySkim } from '@/features/story/timelineDrawer'
import { useStory } from '@/features/story/useStory'
import { pendingBrief } from '@/features/story/brief'
import { openPlanStep } from '@/features/story/planStep'
import { isProjectKind } from '@shared/projects/meta'
import CanvasWorkspace from '@/features/canvas/CanvasWorkspace.vue'
import LibraryDrawer from '@/features/library/LibraryDrawer.vue'
import DirectorPanel from '@/features/director/DirectorPanel.vue'
import { useDirector } from '@/features/director/director'
import { useLibrary } from '@/features/library/library'
import { useComfyImports } from '@/features/gpu/useComfyImports'
import { addAssetsToBoard } from '@/features/canvas/useCanvasDoc'
import NewTimelineDialog from '@/features/timeline/NewTimelineDialog.vue'
import TimelinePanel from '@/features/timeline/TimelinePanel.vue'
import { currentTimelineId } from '@shared/timeline/timelines'
import { ownerAt } from '@shared/timeline'
import { formatTimecode } from '@shared/time/timecode'
import type { GenKind } from '@shared/types/jobs'
import Viewer from '@/features/viewer/Viewer.vue'
import Composer from '@/features/generate/Composer.vue'
import { nanoid } from 'nanoid'
import { api, errorMessage } from '@/lib/api'
import { onServerEvent } from '@/lib/sse'
import { fontSpecs, registerFonts } from '@/engine/fonts'
import { useAssetsStore } from '@/stores/assets'
import { LEGACY_BRAND_WORKSPACE, type Workspace, WORKSPACES, useEditorStore } from '@/stores/editor'
import { useCanvasStore } from '@/stores/canvas'
import { type GenerateTarget, useGenerateStore } from '@/stores/generate'
import { useJobsStore } from '@/stores/jobs'
import { useProjectStore } from '@/stores/project'
import CommandPalette from './CommandPalette.vue'
import EditorToolbar from './EditorToolbar.vue'
import RightPanel from './RightPanel.vue'
import WorkspaceRail from './WorkspaceRail.vue'
import { currentFrame, transport } from './transport'
import { useEditorHotkeys } from './useEditorHotkeys'

const props = defineProps<{ id: string }>()
const router = useRouter()
const route = useRoute()
const project = useProjectStore()
const assets = useAssetsStore()
const jobs = useJobsStore()
const editor = useEditorStore()

const ready = ref(false)
const exportOpen = ref(false)
const paletteOpen = ref(false)
const browserSkim = ref<{ assetId: string; seconds: number }>()
const fileInput = ref<HTMLInputElement>()
const canvas = useCanvasStore()
const library = useLibrary()
/** What the Library's Media tab skims shows in the open workspace's viewer: Edit's, or the one by Plan's timeline. */
const librarySkim = computed({
  get: () => (editor.workspace === 'edit' ? browserSkim.value : storySkim.value),
  set: (v) => {
    if (editor.workspace === 'edit') browserSkim.value = v
    else storySkim.value = v
  },
})

/**
 * The workspace a project opens in: `?ws=` from the new-project dialog, else where the user left it. The brand kit was
 * a workspace of its own: asked for or left there, the project opens in Create with Library › Brand open.
 */
function initialWorkspace(id: string): Workspace {
  const asked = route.query.ws as string | undefined
  const saved = localStorage.getItem(`workspace.${id}`)
  const ws = asked && (WORKSPACES.includes(asked as Workspace) || asked === LEGACY_BRAND_WORKSPACE) ? asked : saved
  if (ws === LEGACY_BRAND_WORKSPACE) {
    library.show('brand')
    // Once: the next visit opens where the user goes from here.
    localStorage.setItem(`workspace.${id}`, 'canvas')
    return 'canvas'
  }
  return ws && WORKSPACES.includes(ws as Workspace) ? (ws as Workspace) : 'edit'
}
// The project's font files, ready for the board, the viewer and PNG exports.
watch(
  () => JSON.stringify(fontSpecs(assets.list)),
  (specs) => void registerFonts(document.fonts, JSON.parse(specs)),
  { immediate: true },
)
watch(
  () => editor.workspace,
  (ws) => {
    if (ready.value) localStorage.setItem(`workspace.${props.id}`, ws)
  },
)

/** What Edit puts at the playhead: shots, pictures and sound (Upscale and the board's tools keep to Assets). */
const TIMELINE_KINDS = new Set<GenKind>(['video', 'image', 'lipsync', 'speech', 'dialogue', 'music', 'sfx', 'foley'])
const generate = useGenerateStore()
/**
 * In Edit a generation without a target of its own lands on the timeline at the playhead, as Create puts one on the
 * board: above the storyline clip there (V2), into the storyline where there is none, sound on an audio lane.
 */
function playheadTarget(): GenerateTarget | undefined {
  if (!TIMELINE_KINDS.has(generate.kind)) return undefined
  const frame = currentFrame()
  const at = formatTimecode(frame, project.doc.settings.fps)
  const sound = ['speech', 'dialogue', 'music', 'sfx', 'foley'].includes(generate.kind)
  const owner = ownerAt(project.layout, frame)
  const lane = sound ? 'audio' : !owner || owner.item.kind === 'gap' ? 'storyline' : 'V2'
  return { frame, playhead: true, label: `Timeline · ${lane} at ${at}` }
}
watch(
  () => ready.value && editor.workspace === 'edit',
  (inEdit) => {
    if (inEdit) generate.defaultTarget = playheadTarget
    else if (generate.defaultTarget === playheadTarget) generate.defaultTarget = undefined
  },
  { immediate: true },
)

/**
 * Home's brief (`?brief=`, `?kind=`) for the project it just made: in Plan the Director takes it (its panel opens on
 * Plan › Script, writes the script, scenes and shots, then proposes what to generate); on the board it fills Brief →
 * asset set, which waits for the user to plan it.
 */
const director = useDirector()
function takeHomeBrief(id: string) {
  const text = typeof route.query.brief === 'string' ? route.query.brief.trim() : ''
  if (!text) return
  const kind = isProjectKind(route.query.kind) ? route.query.kind : 'film'
  if (editor.workspace === 'story') {
    pendingBrief.value = { projectId: id, text, kind }
    openPlanStep('story')
    director.open = true
  } else if (editor.workspace === 'canvas') {
    canvas.briefDraft = text
    canvas.dialog = 'asset-set'
  }
}

function openImport() {
  fileInput.value?.click()
}

/** Imports picked files into the project; on the canvas they also go on the board. */
async function onFiles(list: FileList | null | undefined) {
  if (!list?.length) return
  const pid = project.id
  const imported = await assets.importFiles([...list])
  // Not onto the board of a project opened while they uploaded.
  if (editor.workspace === 'canvas' && project.id === pid) addAssetsToBoard(imported.map((a) => a.id))
}

/**
 * Claude asked (over MCP) to export this project: the export dialog runs it with its defaults and reports back. A
 * request that comes while the project is still loading (Claude opened it just before) waits for it; one that comes
 * while the user has Export open is left to fail (the server tells Claude to close it).
 */
const exportRequest = ref<{ id: string; name?: string }>()
const offAppRequests = onServerEvent((event) => {
  if (event.type !== 'app.request' || event.action !== 'export' || event.projectId !== props.id || exportRequest.value || exportOpen.value) return
  void (async () => {
    const granted = await api.appRequests.claim(event.requestId).then(
      (r) => r.granted,
      () => false,
    )
    if (!granted) return
    exportRequest.value = { id: event.requestId, name: typeof event.options.name === 'string' ? event.options.name : undefined }
    if (ready.value && project.id === props.id) runExportRequest()
  })()
})

function runExportRequest() {
  editor.workspace = 'edit'
  exportOpen.value = true
}

/** A claimed export that never reached the dialog (the project failed to load, or the editor left it). */
function dropExportRequest(error: string) {
  const request = exportRequest.value
  if (!request || exportOpen.value) return
  exportRequest.value = undefined
  void api.appRequests.done(request.id, { ok: false, error }).catch(() => {})
}

function openExport() {
  if (editor.workspace === 'canvas') canvas.dialog = 'export'
  else exportOpen.value = true
}

/** This page's claim on the open project: the server keeps it open until this page (not just any page) closes it. */
const session = nanoid()
const story = useStory()

async function load(id: string) {
  ready.value = false
  try {
    await Promise.all([project.load(id, session), assets.load(id), jobs.load(id)])
    // Another project opened meanwhile (its load sets the editor up), or the editor left.
    if (project.id !== id) return
    // Clips copied in another project would paste with media this one doesn't have.
    if (lastProjectId !== id) editor.clipboard = []
    lastProjectId = id
    editor.select([])
    editor.selectedAssetIds = []
    // Every project's first timeline is 'main': a card selected in the last project must not stay selected here.
    editor.selectedTimelineId = undefined
    editor.previewAssetId = undefined
    editor.playhead = 0
    editor.clearRange()
    editor.workspace = initialWorkspace(id)
    takeHomeBrief(id)
    // `?ws=` and `?brief=` are one-offs: a reload should reopen where the user is, not where the project started.
    if (route.query.ws || route.query.brief) void router.replace({ query: { ...route.query, ws: undefined, brief: undefined, kind: undefined } })
    project.resolvePendingTakes()
    // Older story takes are called after their prompt: named after their shots (once per project and session).
    void story.nameStoryTakes().catch(() => undefined)
    ready.value = true
    // Once Plan is on screen: the Director runs Home's brief (once — it is taken).
    void nextTick(() => director.takeHomeBrief())
    if (exportRequest.value) runExportRequest()
  } catch (err) {
    if (id !== props.id) return
    dropExportRequest(`The project could not be opened: ${errorMessage(err)}`)
    toast.error('Could not open project', { description: errorMessage(err) })
    await router.replace({ name: 'projects' })
  }
}

let offFinished: (() => void) | undefined
// Outputs of prompts queued from ComfyUI: on the timeline too when asked to.
useComfyImports()
const flush = () => {
  if (project.saveState !== 'saved') project.flushOnUnload()
  // Let the server close the project (and release its folder) as the tab goes away.
  void fetch(`/api/projects/${props.id}/close`, {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', 'X-Studio': '1' },
    body: JSON.stringify({ session }),
  }).catch(() => {})
}

onMounted(() => {
  void load(props.id)
  offFinished = jobs.onFinished(() => project.resolvePendingTakes())
  window.addEventListener('beforeunload', flush)
})

/**
 * Saves what changed and stops the store writing to the project (a late autosave would re-open it on the server),
 * then tells the server the editor left it (it stays open there while jobs run in it).
 */
async function leave(id: string) {
  await project.release(id)
  await api.projects.close(id, session).catch(() => {})
}

onBeforeUnmount(() => {
  offFinished?.()
  offAppRequests()
  dropExportRequest('The editor was closed')
  if (generate.defaultTarget === playheadTarget) generate.defaultTarget = undefined
  window.removeEventListener('beforeunload', flush)
  void leave(props.id)
  jobs.release()
})

watch(
  () => props.id,
  async (id, previous) => {
    dropExportRequest('The editor opened another project')
    if (previous) await leave(previous)
    void load(id)
  },
)

/**
 * Switching timelines (opening one, or undo/redo of an open): clip ids of the old timeline mean nothing in the new
 * one, so the selection and range go; each timeline gets back the playhead it had.
 */
const playheads = new Map<string, number>()
watch(
  () => (ready.value ? `${project.id}\n${currentTimelineId(project.doc)}` : undefined),
  (key, previous) => {
    if (!key || !previous || key === previous || key.split('\n')[0] !== previous.split('\n')[0]) return
    if (editor.playing) transport.pause()
    playheads.set(previous, editor.playhead)
    editor.select([])
    editor.clearRange()
    editor.previewAssetId = undefined
    // Renders that finished while this timeline was closed (e.g. it opened because the open one was deleted).
    project.resolvePendingTakes()
    // After this flush, once the viewer's player has the new timeline (seeking the old one would clamp the frame).
    void nextTick(() => transport.seek(Math.min(playheads.get(key) ?? 0, Math.max(0, project.layout.duration - 1))))
  },
)

useEditorHotkeys({
  openImport,
  openExport,
  openPalette: () => (paletteOpen.value = true),
  toggleLibrary: () => ready.value && library.toggle(),
  toggleDirector: () => ready.value && director.toggle(),
})
</script>

<template>
  <div class="flex h-full flex-col">
    <EditorToolbar @import="openImport" @export="openExport" @palette="paletteOpen = true" />
    <!-- relative: on a narrow window the Director slides over the work, under the top bar. -->
    <div class="relative flex min-h-0 flex-1">
    <WorkspaceRail />
    <!-- The work area: the Library docked on the left (when open), then the open workspace in the room left. -->
    <div class="relative flex min-h-0 min-w-0 flex-1">
    <LibraryDrawer v-if="ready" v-model:skim="librarySkim" />
    <div v-if="!ready" class="flex flex-1 items-center justify-center text-muted-foreground">
      <Loader2 class="size-5 animate-spin" />
    </div>
    <StoryWorkspace v-else-if="editor.workspace === 'story'" class="pr-1.5 pb-1.5" />
    <CanvasWorkspace v-else-if="editor.workspace === 'canvas'" @import="openImport" />
    <ResizablePanelGroup v-else direction="vertical" auto-save-id="editor-vertical" class="min-h-0 min-w-0 flex-1 pr-1.5 pb-1.5">
      <ResizablePanel :default-size="62" :min-size="34" class="flex flex-col">
        <ResizablePanelGroup direction="horizontal" auto-save-id="editor-horizontal" class="min-h-0 flex-1">
          <ResizablePanel :default-size="23" :min-size="14">
            <AssetsPanel v-model:skim="browserSkim" data-tour="assets" class="panel-card" />
          </ResizablePanel>
          <ResizableHandle class="panel-gutter" />
          <ResizablePanel :default-size="50" :min-size="25">
            <Viewer :browser-skim="browserSkim" data-tour="viewer" class="panel-card" />
          </ResizablePanel>
          <ResizableHandle class="panel-gutter" />
          <ResizablePanel :default-size="27" :min-size="18">
            <RightPanel data-tour="right-panel" class="panel-card" />
          </ResizablePanel>
        </ResizablePanelGroup>
        <!-- The Composer under the viewer, above the timeline: what it makes lands at the playhead. -->
        <div class="flex shrink-0 justify-center px-2 pt-2" data-edit-composer="">
          <Composer />
        </div>
      </ResizablePanel>
      <ResizableHandle class="panel-gutter" />
      <ResizablePanel :default-size="38" :min-size="16">
        <TimelinePanel data-tour="timeline" class="panel-card bg-timeline" />
      </ResizablePanel>
    </ResizablePanelGroup>
    </div>
    <!-- The Director: a chat whose answers are plans to approve, beside every workspace. -->
    <DirectorPanel v-if="ready" />
    </div>
    <input
      ref="fileInput"
      type="file"
      multiple
      accept="video/*,audio/*,image/*,.ttf,.otf,.woff,.woff2"
      class="hidden"
      @change="onFiles(($event.target as HTMLInputElement).files); ($event.target as HTMLInputElement).value = ''"
    />
    <ExportDialog v-model:open="exportOpen" :request="exportRequest" @request-done="exportRequest = undefined" />
    <ContinuityDialog :open="editor.dialog === 'continuity'" @update:open="(v) => (editor.dialog = v ? 'continuity' : undefined)" />
    <EditShotDialog v-if="editor.dialog === 'edit-shot'" :open="true" @update:open="(v) => (editor.dialog = v ? 'edit-shot' : undefined)" />
    <ReframeDialog v-if="editor.dialog === 'reframe'" :open="true" @update:open="(v) => (editor.dialog = v ? 'reframe' : undefined)" />
    <NewTimelineDialog v-if="editor.dialog === 'new-timeline'" :open="true" @update:open="(v) => (editor.dialog = v ? 'new-timeline' : undefined)" />
    <CommandPalette v-model:open="paletteOpen" @import="openImport" @export="openExport" />
    <!-- The look designer for a character or place, from Plan or from Library › Cast / Places in any workspace. -->
    <LookDesigner v-if="ready" />
  </div>
</template>
