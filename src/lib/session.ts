import { computed, ref, type ComputedRef } from 'vue'
import type { SessionDto } from '@/types/api'

/**
 * In-memory session state.
 *
 * @remarks
 * The access token is deliberately kept in memory and never in `localStorage` or
 * `sessionStorage`: a token readable from JavaScript storage survives a tab reload
 * but is also readable by any injected script. The trade-off is that a hard reload
 * signs the user out.
 */
const session = ref<SessionDto | null>(null)

/** Fraction of the token lifetime after which renewal is attempted. */
const RENEWAL_THRESHOLD = 0.8

/** Shortest delay, in milliseconds, allowed between renewal attempts. */
const MIN_RENEWAL_DELAY_MS = 10000

let renewalTimeoutId: number | null = null

/** Current session, or null when there is no authenticated user. */
export const currentSession: ComputedRef<SessionDto | null> = computed(() => session.value)

/** Whether there is an active session. */
export const isAuthenticated: ComputedRef<boolean> = computed(() => session.value !== null)

/**
 * Returns the access token to inject in the `Authorization` header.
 *
 * @returns The token, or null when there is no active session.
 */
export function getAccessToken(): string | null {
  return session.value === null ? null : session.value.token
}

/**
 * Replaces the active session and reschedules the proactive renewal.
 *
 * @param next - Session returned by login or refresh.
 */
export function setSession(next: SessionDto): void {
  session.value = next
  scheduleRenewal(next)
}

/** Drops the active session and cancels any pending renewal. */
export function clearSession(): void {
  session.value = null
  cancelRenewal()
}

/**
 * Callback invoked when the session must be renewed.
 *
 * @remarks
 * Registered by `@/lib/http` at module load. It lives here as an injected callback
 * instead of a direct import so that `session.ts` stays free of transport concerns
 * and the two modules do not import each other.
 */
let renewalHandler: (() => Promise<void>) | null = null

/**
 * Registers the routine that renews the session before the token expires.
 *
 * @param handler - Renewal routine. It must swallow its own errors.
 */
export function setRenewalHandler(handler: () => Promise<void>): void {
  renewalHandler = handler
}

/**
 * Schedules the proactive renewal of a session.
 *
 * @param value - Session whose `expiresAt` drives the schedule.
 * @remarks
 * The backend issues a rolling token with no refresh counterpart, so renewing
 * reactively after a 401 is impossible: `POST /api/auth/refresh` is `[Authorize]`
 * and would answer 401 as well. Renewal has to happen while the token is alive.
 */
function scheduleRenewal(value: SessionDto): void {
  cancelRenewal()

  if (renewalHandler === null) {
    return
  }

  const expiresAt = Date.parse(value.expiresAt)

  if (Number.isNaN(expiresAt)) {
    return
  }

  const lifetime = expiresAt - Date.now()

  if (lifetime <= MIN_RENEWAL_DELAY_MS) {
    return
  }

  const delay = Math.max(lifetime * RENEWAL_THRESHOLD, MIN_RENEWAL_DELAY_MS)

  if (lifetime <= MIN_RENEWAL_DELAY_MS) {
    return
  }

  renewalTimeoutId = window.setTimeout(() => {
    renewalTimeoutId = null

    if (renewalHandler !== null) {
      void renewalHandler()
    }
  }, delay)
}

/** Cancels the pending renewal, if any. */
function cancelRenewal(): void {
  if (renewalTimeoutId !== null) {
    window.clearTimeout(renewalTimeoutId)
    renewalTimeoutId = null
  }
}