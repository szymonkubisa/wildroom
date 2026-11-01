import { type OpContext, type TimelineRecipe as Recipe, applyOp, layoutTimeline, resolveGeneration } from '@shared/timeline'
import type { ProjectSettings } from '@shared/types/project-doc'
import { type ProjectDoc, createEmptyDoc } from '@shared/types/project-doc'
import { type Patch, applyPatches, enablePatches, produce } from 'immer'
import { applyCanvasResolutions, canvasResolutions } from '@shared/canvas/resolve'
import { sanitizeBrand } from '@shared/types/brand'
import { sanitizeCanvas } from '@shared/types/canvas'
import { sanitizeMotionClips } from '@shared/motion/sanitize'
import { sanitizeStory } from '@shared/story/structure'
import { sanitizeDirector } from '@shared/director/plan'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { toast } from 'vue-sonner'
import type { ProjectErrorDetails } from '@shared/types/api'
import { ApiRequestError, api, errorMessage } from '@/lib/api'
import { onServerEvent } from '@/lib/sse'
import { useAssetsStore } from './assets'
import { useJobsStore } from './jobs'

enablePatches()

interface HistoryEntry {
  label: string
  patches: Patch[]
  inverse: Patch[]
  /** Frame-rate auto-lock recorded by resolvePendingTakes (not a user edit). */
  fpsLock?: boolean
}

interface DragSession {
  base: ProjectDoc
  label: string
  recipe?: Recipe
  /** A generation finished during the drag: its takes are filled in once the drag ends. */
  resolve?: boolean
}

const HISTORY_LIMIT = 300
const SAVE_DEBOUNCE_MS = 600
/** Chromium refuses keepalive requests over 64 KiB (counting all of them in flight). */
const KEEPALIVE_MAX_BYTES = 60_000
const CONFLICT_TOAST = 'project-conflict'

/**
 * The open project document. The browser is its only writer: every edit is an immer recipe run through
 * `applyOp` (op + normalize), recorded as patches for undo/redo, then autosaved with optimistic revisions.
 */
export const useProjectStore = defineStore('project', () => {
  const id = ref<string>()
  const name = ref('')
  /** The project's folder (`<name>.wildroom`) on disk. */
  const path = ref('')
  const doc = shallowRef<ProjectDoc>(createEmptyDoc())
  const revision = ref(0)
  const loaded = ref(false)
  const saveState = ref<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const undoStack = shallowRef<HistoryEntry[]>([])
  const redoStack = shallowRef<HistoryEntry[]>([])
  let drag: DragSession | undefined
  /** Set after undoing an fps auto-lock: pending takes stay unresolved until redo or the next edit. */
  let holdAutoLock = false
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let saving: Promise<void> | undefined
  /** A save met a newer revision (another window saved): nothing is saved until the user picks a version. */
  let conflicted = false
  /** The editor page's claim on the project (see `load`), for reloading it after a conflict. */
  let editorSession: string | undefined
  /** Bumped by every load and by `release`: a load answered after a newer one (or after the editor left) is dropped. */
  let loads = 0
  /** Bumped when the store takes a project (again) or lets it go: a save answered after that leaves the new state alone. */
  let opened = 0

  /** The document without a drag's preview: what gets saved, so Escape never finds a half-dragged clip on disk. */
  const committed = () => drag?.base ?? doc.value

  const layout = computed(() => layoutTimeline(doc.value))
  const fps = computed(() => doc.value.settings.fps)
  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)
  /** What Undo would take back and Redo do again (the top bar's tooltips). */
  const undoLabel = computed(() => undoStack.value.at(-1)?.label)
  const redoLabel = computed(() => redoStack.value.at(-1)?.label)

  function opContext(): OpContext & { media: NonNullable<OpContext['media']> } {
    const assets = useAssetsStore()
    return {
      newId: () => nanoid(10),
      media: (assetId: string) => {
        const a = assets.get(assetId)
        // Fonts never go on a timeline.
        if (!a || a.kind === 'font') return undefined
        return { kind: a.kind, durationFlicks: a.durationFlicks, hasVideo: a.hasVideo, hasAudio: a.hasAudio, fps: a.fps }
      },
    }
  }

  function pushHistory(entry: HistoryEntry) {
    undoStack.value = [...undoStack.value.slice(-(HISTORY_LIMIT - 1)), entry]
    redoStack.value = []
  }

  /** Runs an edit; returns false when nothing changed. */
  function apply(recipe: Recipe, label = 'Edit'): boolean {
    if (drag) commitDrag()
    const result = applyOp(doc.value, recipe, opContext())
    if (!result.patches.length) return false
    doc.value = result.doc
    pushHistory({ label, patches: result.patches, inverse: result.inversePatches })
    scheduleSave()
    if (holdAutoLock) {
      holdAutoLock = false
      resolvePendingTakes()
    }
    return true
  }

  /**
   * Records a fact the app found on its own (e.g. where a rendered clip really cuts, a cached temp voice) without an
   * undo step: plain produce, then autosave. Never for user edits — those go through `apply`. Like the canvas
   * resolutions, it only adds or replaces values, so the undo patches around it still apply.
   */
  function applyFact(recipe: (draft: ProjectDoc) => void): boolean {
    const next = produce(doc.value, recipe)
    if (next === doc.value) return false
    doc.value = next
    // A drag in progress rebuilds from its base: keep the fact there too.
    if (drag) drag.base = produce(drag.base, recipe)
    scheduleSave()
    return true
  }

  // Drags recompute the op from the drag's starting document on every move, so the history gets one entry.
  function beginDrag(label: string) {
    drag = { base: doc.value, label }
  }

  function previewDrag(recipe: Recipe) {
    if (!drag) beginDrag('Edit')
    drag!.recipe = recipe
    doc.value = applyOp(drag!.base, recipe, opContext()).doc
  }

  function commitDrag() {
    const session = drag
    drag = undefined
    if (!session) return
    if (session.recipe) {
      const result = applyOp(session.base, session.recipe, opContext())
      doc.value = result.doc
      if (result.patches.length) {
        pushHistory({ label: session.label, patches: result.patches, inverse: result.inversePatches })
        scheduleSave()
      }
    } else doc.value = session.base
    if (session.resolve) resolvePendingTakes()
  }

  function cancelDrag() {
    const session = drag
    drag = undefined
    if (!session) return
    doc.value = session.base
    if (session.resolve) resolvePendingTakes()
  }

  const dragging = () => drag !== undefined

  function undo() {
    // ⌘Z mid-drag takes back the drag, not the edit before it as well.
    if (drag) return void cancelDrag()
    const entry = undoStack.value.at(-1)
    if (!entry) return
    undoStack.value = undoStack.value.slice(0, -1)
    redoStack.value = [...redoStack.value, entry]
    doc.value = applyPatches(doc.value, entry.inverse)
    if (entry.fpsLock) holdAutoLock = true
    resolvePendingTakes()
    scheduleSave()
    return entry.label
  }

  function redo() {
    // Its patches are for the document under the drag's preview, which the next move would rebuild without them.
    if (drag) return void cancelDrag()
    const entry = redoStack.value.at(-1)
    if (!entry) return
    redoStack.value = redoStack.value.slice(0, -1)
    undoStack.value = [...undoStack.value, entry]
    doc.value = applyPatches(doc.value, entry.patches)
    if (entry.fpsLock) holdAutoLock = false
    resolvePendingTakes()
    scheduleSave()
    return entry.label
  }

  /**
   * Fills `assetId` on takes whose generation has finished. Not recorded in history (it is a fact, not an
   * edit), and re-run after undo/redo so restored takes never fall back to "pending".
   */
  function resolvePendingTakes() {
    // A drag rebuilds from its base on every move (and a frame-rate lock would rescale the frames it works in):
    // what finished meanwhile is filled in when it ends.
    if (drag) return void (drag.resolve = true)
    const jobs = useJobsStore()
    const canvasChanged = resolveCanvasItems()
    const pending = new Map<string, string>()
    for (const clip of [...doc.value.spine, ...doc.value.connected.map((c) => c.clip)]) {
      if (clip.kind !== 'media') continue
      for (const take of clip.takes) {
        if (take.assetId || !take.generationId || pending.has(take.generationId)) continue
        const job = jobs.byId[take.generationId]
        const assetId = job?.status === 'succeeded' ? job.outputAssetIds[0] : undefined
        if (assetId) pending.set(take.generationId, assetId)
      }
    }
    if (!pending.size) {
      if (canvasChanged) scheduleSave()
      return
    }
    const fpsBefore = doc.value.settings.fps
    const result = applyOp(
      doc.value,
      (draft, ctx) => {
        for (const [generationId, assetId] of pending) resolveGeneration(generationId, assetId)(draft, ctx)
      },
      opContext(),
    )
    const locked = result.doc.settings.fps !== fpsBefore
    // An fps auto-lock rescales every frame value, so it becomes its own undo step (older patches only apply
    // to the pre-lock document). After that step is undone, wait for redo or a new edit before locking again.
    if (locked && holdAutoLock) {
      if (canvasChanged) scheduleSave()
      return
    }
    doc.value = result.doc
    if (locked) {
      undoStack.value = [
        ...undoStack.value.slice(-(HISTORY_LIMIT - 1)),
        { label: `Frame rate set to ${result.doc.settings.fps} fps`, patches: result.patches, inverse: result.inversePatches, fpsLock: true },
      ]
      redoStack.value = []
      toast(`Project frame rate set to ${result.doc.settings.fps} fps`, { description: 'Taken from the first video clip. Undo to change it back.', duration: 2500 })
    }
    scheduleSave()
  }

  /** Canvas placeholders whose generation finished get its result; new items take their image's aspect ratio. */
  function resolveCanvasItems(): boolean {
    const jobs = useJobsStore()
    const assets = useAssetsStore()
    const list = canvasResolutions(doc.value.canvas, (gid) => jobs.byId[gid], (aid) => assets.get(aid))
    if (!list.length) return false
    // Plain produce, not applyOp: a canvas fact must never trigger the timeline's frame-rate auto-lock.
    doc.value = produce(doc.value, (draft) => {
      if (draft.canvas) applyCanvasResolutions(draft.canvas, list)
    })
    return true
  }

  function scheduleSave() {
    if (!id.value) return
    // After a conflict nothing is saved until the user picks a version (its toast comes back if it was closed).
    if (conflicted) return showConflict()
    saveState.value = 'dirty'
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void save(), SAVE_DEBOUNCE_MS)
  }

  async function save(): Promise<void> {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = undefined
    if (saving) {
      // One at a time, each on the revision the last one got back (two on the same base revision would 409), and
      // only for what changed meanwhile.
      while (saving) await saving
      if (saveState.value !== 'dirty') return
    }
    // Nothing changed (an export, Back): an unchanged project.json is not rewritten — sync services would upload it again.
    if (!id.value || conflicted || saveState.value === 'saved') return
    const projectId = id.value
    const mine = opened
    const snapshot = committed()
    saveState.value = 'saving'
    saving = (async () => {
      try {
        const res = await api.projects.saveDoc(projectId, snapshot, revision.value)
        // The store has another project (or this one reloaded) by now: this answer's revision isn't its own.
        if (mine !== opened) return
        revision.value = res.revision
        saveState.value = committed() === snapshot ? 'saved' : 'dirty'
      } catch (err) {
        if (mine !== opened) return
        saveState.value = 'error'
        const code = err instanceof ApiRequestError ? (err.details as ProjectErrorDetails | undefined)?.code : undefined
        if (code === 'missing') {
          toast.error('The project folder is gone', {
            description: 'It was moved, renamed or deleted outside the app. Open it again from the Projects page.',
          })
        } else if (code === 'lock-lost') {
          toast.error('This project was opened somewhere else', {
            description: 'Another computer or app took it over — your last change was not saved. Reopen it here to continue.',
          })
        } else if (err instanceof ApiRequestError && err.status === 409) {
          // Every later save would meet the same newer revision: stop and ask once.
          conflicted = true
          showConflict()
        } else {
          toast.error('Autosave failed', { description: errorMessage(err) })
        }
      } finally {
        saving = undefined
      }
    })()
    await saving
    if ((saveState.value as string) === 'dirty') scheduleSave()
  }

  /** Best-effort flush when the tab is closing. */
  function flushOnUnload() {
    if (!id.value || saveState.value === 'saved' || conflicted) return
    const body = new TextEncoder().encode(JSON.stringify({ doc: committed(), baseRevision: revision.value }))
    // Chromium rejects a keepalive body over 64 KiB (a story-heavy project), and sendBeacon can't send the X-Studio
    // header the API requires: a bigger one goes as a plain request, which the local server gets unless the page is
    // torn down first.
    void fetch(`/api/projects/${id.value}/doc`, {
      method: 'PUT',
      keepalive: body.byteLength <= KEEPALIVE_MAX_BYTES,
      headers: { 'X-Studio': '1', 'Content-Type': 'application/json' },
      body,
    }).catch(() => {})
  }

  async function load(projectId: string, session?: string) {
    const mine = ++loads
    loaded.value = false
    // A save still on its way (the page that had it open just left) lands first: read before it, the project would
    // open a revision behind and its next save would conflict.
    while (saving) await saving
    const project = await api.projects.get(projectId, session)
    // A later load, or the editor leaving, owns the store now.
    if (mine !== loads) return
    opened++
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = undefined
    drag = undefined
    if (conflicted) {
      conflicted = false
      toast.dismiss(CONFLICT_TOAST)
    }
    editorSession = session
    id.value = project.id
    name.value = project.name
    path.value = project.path
    sanitizeMotionClips(project.doc)
    const canvas = sanitizeCanvas(project.doc.canvas)
    const brand = sanitizeBrand(project.doc.brand)
    // Stories from before scenes get them (from their shots' places and headings); saved with the next edit.
    const story = sanitizeStory(project.doc.story)
    const fixed = canvas || brand || project.doc.canvas || project.doc.brand ? { ...project.doc, canvas, brand } : project.doc
    // The Director's chat: its last messages, a run cut short by closing the project marked as stopped.
    const director = project.doc.director === undefined ? undefined : sanitizeDirector(project.doc.director)
    const withChat = project.doc.director === undefined ? fixed : director ? { ...fixed, director } : (({ director: _drop, ...rest }) => rest)(fixed)
    doc.value = story ? { ...withChat, story } : withChat
    revision.value = project.revision
    undoStack.value = []
    redoStack.value = []
    holdAutoLock = false
    saveState.value = 'saved'
    loaded.value = true
  }

  /**
   * The editor left `projectId`: what changed is saved, then nothing more is written to it. `id` goes back to
   * undefined, so a late autosave or a story run still going can't re-open the project on the server, and an opening
   * of it still in flight is dropped.
   */
  async function release(projectId: string) {
    const mine = loads
    if (id.value === projectId) await save()
    // Opened again (this project or another) while that saved: that opening has the store now.
    if (mine !== loads) return
    loads++
    opened++
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = undefined
    id.value = undefined
    if (conflicted) {
      conflicted = false
      toast.dismiss(CONFLICT_TOAST)
    }
  }

  /** One toast however many edits follow (same id); closing it leaves autosave paused. */
  function showConflict() {
    toast.error('This project was changed in another window', {
      id: CONFLICT_TOAST,
      duration: Number.POSITIVE_INFINITY,
      description: 'Changes here are not saved until you choose: reload the saved version (losing them), or keep yours and save over it.',
      action: { label: 'Reload', onClick: () => void reloadFromDisk() },
      cancel: { label: 'Keep mine', onClick: () => void keepMine() },
    })
  }

  async function reloadFromDisk() {
    const projectId = id.value
    if (!projectId || !conflicted) return
    try {
      await load(projectId, editorSession)
      resolvePendingTakes()
    } catch (err) {
      toast.error('Could not reload the project', { description: errorMessage(err) })
      showConflict()
    }
  }

  /** Saves this version over the other one, on the revision the server has now. */
  async function keepMine() {
    const projectId = id.value
    if (!projectId || !conflicted) return
    let current: number
    try {
      current = (await api.projects.get(projectId, editorSession)).revision
    } catch (err) {
      toast.error('Could not read the saved project', { description: errorMessage(err) })
      return showConflict()
    }
    if (id.value !== projectId || !conflicted) return
    revision.value = current
    conflicted = false
    saveState.value = 'dirty'
    await save()
  }

  async function rename(value: string) {
    if (!id.value) return
    const res = await api.projects.rename(id.value, value)
    name.value = res.name
    path.value = res.path
  }

  onServerEvent((event) => {
    if (!id.value) return
    if (event.type === 'project.suspended' && event.projectId === id.value) {
      saveState.value = 'error'
      toast.error(event.reason === 'missing' ? 'The project folder is gone' : 'This project was opened somewhere else', {
        description:
          event.reason === 'missing'
            ? 'It was moved, renamed or deleted outside the app — changes can no longer be saved. Open it again from the Projects page.'
            : 'Another computer or app took it over — changes here are no longer saved. Reopen it to continue.',
        duration: Infinity,
      })
    } else if (event.type === 'project.doc.saved' && event.projectId === id.value && event.revision > revision.value) {
      // A motion import changed the project: take it in now, unless there are edits here not saved yet.
      const projectId = id.value
      const reload = () => void load(projectId, editorSession).then(() => toast.success('The project was updated by an import'))
      if (saveState.value === 'saved') reload()
      else
        toast.warning('The project was changed by an import', {
          description: 'Your latest edits here aren’t saved yet. Reload to see the import (your unsaved edits are dropped).',
          action: { label: 'Reload', onClick: reload },
          duration: Infinity,
        })
    } else if (event.type === 'project.conflict' && event.projectId === id.value) {
      toast.warning('The project was also changed somewhere else', {
        description: `Your version was kept; the other one is saved as “${event.file}” in the project's Conflicts folder.`,
      })
    }
  })

  function updateSettings(patch: Partial<ProjectSettings>) {
    apply((draft) => {
      Object.assign(draft.settings, patch)
    }, 'Project settings')
  }

  return {
    id,
    name,
    path,
    doc,
    revision,
    loaded,
    saveState,
    layout,
    fps,
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
    undoStack,
    apply,
    applyFact,
    beginDrag,
    previewDrag,
    commitDrag,
    cancelDrag,
    dragging,
    undo,
    redo,
    resolvePendingTakes,
    save,
    flushOnUnload,
    load,
    release,
    rename,
    updateSettings,
    opContext,
  }
})
