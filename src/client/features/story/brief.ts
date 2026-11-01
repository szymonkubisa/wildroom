import type { ProjectKind } from '@shared/projects/meta'
import { shallowRef } from 'vue'

/**
 * A brief typed on Home ("What are we making?") for the project it just made: the editor takes it from `?brief=`
 * as it opens the project, and the Director's panel runs it (the script, the scenes and their shots, then a plan of
 * what to generate, to approve) — once. Not in the document: reopening the project must not run it again.
 */
export interface PendingBrief {
  projectId: string
  text: string
  kind: ProjectKind
}

export const pendingBrief = shallowRef<PendingBrief>()

/** The brief for this project, taken (it runs once). */
export function takeBrief(projectId: string | undefined): PendingBrief | undefined {
  const brief = pendingBrief.value
  if (!brief || !projectId || brief.projectId !== projectId) return undefined
  pendingBrief.value = undefined
  return brief
}

/** What the Director is asked to write from: an ad says it is one. */
export function briefIdea(brief: Pick<PendingBrief, 'text' | 'kind'>): string {
  const text = brief.text.trim()
  return brief.kind === 'ad' && !/\b(ad|advert|commercial|spot)\b/i.test(text) ? `A short ad (about 30 seconds): ${text}` : text
}
