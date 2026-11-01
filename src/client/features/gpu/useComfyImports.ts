import type { ComfyImportMode } from '@shared/types/runpod'
import { onBeforeUnmount } from 'vue'
import { currentFrame } from '@/features/editor/transport'
import { useTimelineCommands } from '@/features/timeline/commands'
import { onServerEvent } from '@/lib/sse'
import { useAssetsStore } from '@/stores/assets'
import { useProjectStore } from '@/stores/project'

/**
 * Outputs of prompts queued from ComfyUI land in the project's Assets (the server saves them); with Append or
 * Insert at playhead the open editor also puts them on the timeline — here, because the editor is the only writer
 * of the project document. Audio stays in Assets.
 */
export function useComfyImports() {
  const project = useProjectStore()
  const assets = useAssetsStore()
  const commands = useTimelineCommands()

  async function place(ids: string[], mode: ComfyImportMode) {
    const settled = await Promise.allSettled(ids.map((id) => assets.whenReady(id)))
    const ready = settled.flatMap((r) => (r.status === 'fulfilled' && r.value.kind !== 'audio' ? [r.value.id] : []))
    if (!ready.length) return
    if (mode === 'append') commands.appendAssets(ready)
    else commands.insertAssets(ready, currentFrame())
  }

  const off = onServerEvent((event) => {
    if (event.type !== 'comfy.imported' || event.projectId !== project.id) return
    if (event.mode === 'append' || event.mode === 'insert') void place(event.assetIds, event.mode)
  })
  onBeforeUnmount(off)
}
