import type { ComfyFile, ComfyHistoryEntry } from './comfy'

/** Reading a finished prompt from ComfyUI's history: shared by the app's own renders and the ComfyUI inbox. */

/** Why the prompt failed (ComfyUI's `execution_error`), or undefined when it ran through. */
export function historyError(entry: ComfyHistoryEntry): { message: string; nodeType?: string } | undefined {
  const messages = entry.status?.messages ?? []
  const error = messages.find((m) => m[0] === 'execution_error')?.[1] as { exception_message?: string; node_type?: string } | undefined
  if (!error && entry.status?.status_str !== 'error') return undefined
  return { message: error?.exception_message?.trim() || 'unknown error', nodeType: error?.node_type }
}

/** Every file the prompt's nodes reported (saved outputs and temp previews alike), in node order. */
export function historyFiles(entry: ComfyHistoryEntry): ComfyFile[] {
  return Object.values(entry.outputs ?? {}).flatMap((out) =>
    Object.values(out).flatMap((list) =>
      (Array.isArray(list) ? (list as Partial<ComfyFile>[]) : [])
        .filter((f) => typeof f?.filename === 'string' && f.filename)
        .map((f) => ({ filename: f.filename!, subfolder: f.subfolder ?? '', type: f.type ?? 'output' })),
    ),
  )
}

/** How long ComfyUI spent on the prompt (from its own start/success timestamps). */
export function historyRenderMs(entry: ComfyHistoryEntry): number | undefined {
  const messages = entry.status?.messages ?? []
  const started = messages.find((m) => m[0] === 'execution_start')?.[1]?.timestamp as number | undefined
  const ended = messages.find((m) => m[0] === 'execution_success')?.[1]?.timestamp as number | undefined
  return started && ended ? ended - started : undefined
}

/** GPU time in dollars, rounded to 1/100 of a cent. */
export function renderCost(renderMs: number | undefined, ratePerHr: number | undefined): number | undefined {
  return renderMs && ratePerHr ? Math.round((renderMs / 3_600_000) * ratePerHr * 10_000) / 10_000 : undefined
}
