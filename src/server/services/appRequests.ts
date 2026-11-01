import { nanoid } from 'nanoid'
import type { AppRequestAction } from '../../shared/types/events'
import { ApiError } from '../http'
import type { EventBus } from './events'

/**
 * Asking the app's window to do what only a page can: open a project in the editor, or export its timeline (the
 * export renders with the page's own engine). The request goes out as an `app.request` event; the first page that
 * can do it claims it (so two tabs never both export) and reports back when done.
 */

type Outcome = { ok: true; result: unknown } | { ok: false; error: string }

interface Pending {
  claimed: boolean
  onClaim: () => void
  settle: (outcome: Outcome) => void
}

export class NotClaimedError extends ApiError {
  constructor(message: string) {
    super(409, message, { code: 'not_claimed' })
  }
}

export class AppRequests {
  private pending = new Map<string, Pending>()

  constructor(private readonly events: EventBus) {}

  /**
   * Resolves with what the page reported. Rejects with NotClaimedError when no page takes it within `claimMs`, or
   * with the page's error; `doneMs` bounds the wait once claimed.
   */
  ask<T = unknown>(action: AppRequestAction, projectId: string, options: Record<string, unknown>, timing: { claimMs: number; doneMs: number }): Promise<T> {
    const requestId = nanoid(12)
    return new Promise<T>((resolve, reject) => {
      let doneTimer: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        clearTimeout(claimTimer)
        clearTimeout(doneTimer)
        this.pending.delete(requestId)
      }
      const claimTimer = setTimeout(() => {
        finish()
        reject(new NotClaimedError('No Wildroom window took the request: is the app open?'))
      }, timing.claimMs)
      this.pending.set(requestId, {
        claimed: false,
        onClaim: () => {
          clearTimeout(claimTimer)
          doneTimer = setTimeout(() => {
            finish()
            reject(new ApiError(504, `The app did not finish "${action}" in ${Math.round(timing.doneMs / 1000)} s`))
          }, timing.doneMs)
        },
        settle: (outcome) => {
          finish()
          if (outcome.ok) resolve(outcome.result as T)
          else reject(new ApiError(502, outcome.error))
        },
      })
      this.events.publish({ type: 'app.request', requestId, action, projectId, options })
    })
  }

  /** A page wants to do it: only the first one gets it. */
  claim(requestId: string): boolean {
    const p = this.pending.get(requestId)
    if (!p || p.claimed) return false
    p.claimed = true
    p.onClaim()
    return true
  }

  /** The page that claimed it is done (or failed). */
  done(requestId: string, outcome: Outcome): boolean {
    const p = this.pending.get(requestId)
    if (!p?.claimed) return false
    p.settle(outcome)
    return true
  }
}
