import { useLocalStorage } from '@vueuse/core'
import { useEditorStore } from '@/stores/editor'
import { useProjectStore } from '@/stores/project'

export type PlanStep = 'story' | 'cast' | 'scenes' | 'render'

/** The steps' names: the ids stay what they were (they key `story.ui`), the names are Plan's. */
export const PLAN_STEP_LABEL: Record<PlanStep, string> = { story: 'Script', cast: 'Cast & Places', scenes: 'Shots', render: 'Film' }

/** Opens Plan on one of its steps. StorySteps keeps each project's step under `story.ui` (the same key here, so the open view follows). */
export function openPlanStep(step: PlanStep) {
  const id = useProjectStore().id ?? ''
  const storyUi = useLocalStorage<Record<string, { step?: PlanStep; sceneId?: string }>>('story.ui', {})
  storyUi.value = { ...storyUi.value, [id]: { ...storyUi.value[id], step } }
  useEditorStore().workspace = 'story'
}

/**
 * Opens Plan › Shots on one scene (a toast's or the Director's "Show"): from any workspace and whichever step is open,
 * even once the component that asked has gone (a Script step left while Update scenes ran).
 */
export function openPlanScene(sceneId: string) {
  const id = useProjectStore().id ?? ''
  const storyUi = useLocalStorage<Record<string, { step?: PlanStep; sceneId?: string }>>('story.ui', {})
  storyUi.value = { ...storyUi.value, [id]: { ...storyUi.value[id], step: 'scenes', sceneId } }
  useEditorStore().workspace = 'story'
}
