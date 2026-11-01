import type { ProjectErrorDetails, ProjectLockInfo } from '@shared/types/api'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import { api, ApiRequestError, errorMessage } from '@/lib/api'
import { chooseProjectPath, desktop } from '@/lib/desktop'
import { router } from '@/router'

/** A project another computer (or app instance) has open, waiting for the user's decision. */
export interface LockPrompt {
  path: string
  name: string
  lockedBy: ProjectLockInfo
}

const bundleName = (path: string) => (path.split('/').pop() ?? path).replace(/\.wildroom$/i, '')

/**
 * Opening project bundles by path: from the Projects page, the Open… dialog, the desktop app's File menu, or a
 * double-click in Finder. A project that is open on another computer asks before opening it here.
 */
export const useProjectOpener = defineStore('projectOpener', () => {
  const lockPrompt = ref<LockPrompt>()
  const opening = ref(false)

  async function openPath(path: string, opts: { force?: boolean; name?: string } = {}): Promise<boolean> {
    opening.value = true
    try {
      const project = await api.projects.open(path, !!opts.force)
      lockPrompt.value = undefined
      desktop?.addRecentDocument?.(project.path)
      await router.push({ name: 'editor', params: { id: project.id } })
      return true
    } catch (err) {
      const details = err instanceof ApiRequestError ? (err.details as ProjectErrorDetails | undefined) : undefined
      if (details?.code === 'locked') {
        lockPrompt.value = { path, name: opts.name ?? bundleName(path), lockedBy: details.lockedBy }
        return false
      }
      toast.error('Could not open the project', { description: errorMessage(err) })
      return false
    } finally {
      opening.value = false
    }
  }

  async function openWithDialog(defaultPath?: string) {
    try {
      const path = await chooseProjectPath(defaultPath)
      if (path) await openPath(path)
    } catch (err) {
      toast.error('Could not show the Open dialog', { description: errorMessage(err) })
    }
  }

  return { lockPrompt, opening, openPath, openWithDialog }
})
