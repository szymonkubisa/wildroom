import { ref, shallowRef } from 'vue'

export interface ConfirmOptions {
  title: string
  description?: string
  /** The confirm button's label (default "OK"). */
  confirmText?: string
  cancelText?: string
  /** Deletes or replaces something: the confirm button is red. */
  destructive?: boolean
}

/** The question ConfirmHost shows: kept while the dialog fades out, so its text doesn't vanish mid-animation. */
export const confirmShown = shallowRef<ConfirmOptions>()
export const confirmOpen = ref(false)
let settle: ((ok: boolean) => void) | undefined

/** Answers the open question (ConfirmHost's buttons, Esc, a click outside); later answers are ignored. */
export function answerConfirm(ok: boolean) {
  const resolve = settle
  settle = undefined
  confirmOpen.value = false
  resolve?.(ok)
}

/** Asks in the app's own dialog (one ConfirmHost in App.vue) instead of the browser's confirm(): true when confirmed. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  // One question at a time: a new one cancels the one on screen.
  answerConfirm(false)
  confirmShown.value = options
  confirmOpen.value = true
  return new Promise((resolve) => (settle = resolve))
}

/** `const confirm = useConfirm()` … `if (!(await confirm({ title, description, confirmText, destructive }))) return` */
export function useConfirm() {
  return confirmDialog
}
