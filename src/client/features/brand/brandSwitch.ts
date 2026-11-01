import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { useProjectStore } from '@/stores/project'

const key = (projectId: string) => `gen.brand.${projectId}`

function read(projectId: string | undefined): boolean {
  if (!projectId) return true
  try {
    return localStorage.getItem(key(projectId)) !== 'off'
  } catch {
    return true
  }
}

/**
 * "Use the look in every generation": with the project's brand kit on, Generate adds its style and palette to prompts
 * and its style images as references. One switch per project (Generate's "Brand" row and Library › Brand show the
 * same one), remembered in this browser under `gen.brand.<project>`.
 */
export const useBrandSwitch = defineStore('brandSwitch', () => {
  const project = useProjectStore()
  const on = ref(read(project.id))
  watch(
    () => project.id,
    (pid) => (on.value = read(pid)),
  )
  watch(on, (value) => {
    if (!project.id) return
    try {
      localStorage.setItem(key(project.id), value ? 'on' : 'off')
    } catch {
      // Storage off (private window): the switch still holds for this session.
    }
  })
  return { on }
})
