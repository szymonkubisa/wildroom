import type { AssetDTO } from './assets'
import type { GenerationDTO } from './jobs'
import type { ComfyImportMode, GpuSessionDTO, VolumeSetupDTO } from './runpod'

export type ServerEvent =
  | { type: 'hello'; serverStart: string }
  | { type: 'asset.upserted'; asset: AssetDTO }
  | { type: 'asset.removed'; assetId: string; projectId?: string }
  | { type: 'generation.upserted'; generation: GenerationDTO }
  | { type: 'export.progress'; exportId: string; stage: string; progress: number; message?: string }
  | { type: 'settings.changed' }
  /** The Projects page should refresh (created, renamed, duplicated, trashed, opened, closed). */
  | { type: 'projects.changed' }
  | { type: 'project.closed'; projectId: string }
  /** The open project can't be written any more: its folder vanished, or another machine took it over. */
  | { type: 'project.suspended'; projectId: string; reason: 'missing' | 'lock-lost' }
  /** The project's document was saved by something other than its editor (a motion import): open editors reload it. */
  | { type: 'project.doc.saved'; projectId: string; revision: number; source: 'import' }
  /** project.json was changed on disk by someone else; their version was kept in the bundle's Conflicts folder. */
  | { type: 'project.conflict'; projectId: string; file: string }
  /** The rented GPU (RunPod) changed state: starting, ready, idle countdown, stopped. */
  | { type: 'gpu.session'; session: GpuSessionDTO }
  /** Progress of preparing a RunPod volume. */
  | { type: 'gpu.setup'; setup: VolumeSetupDTO }
  /** A prompt queued from the ComfyUI page finished and its outputs were saved to the project's Assets. */
  | { type: 'comfy.imported'; promptId: string; projectId: string; assetIds: string[]; mode: ComfyImportMode }
  /**
   * Claude (over MCP) asks the app's window to do what only a page can: open the project in the editor, or export it.
   * The first page able to do it claims it (`POST /api/app-requests/:id/claim`) and reports back (`…/done`).
   */
  | { type: 'app.request'; requestId: string; action: AppRequestAction; projectId: string; options: Record<string, unknown> }
  /** A prompt queued from the ComfyUI page failed, or its outputs could not be saved. */
  | { type: 'comfy.import.failed'; promptId: string; projectId: string; error: string }

export type AppRequestAction = 'open-project' | 'export'
