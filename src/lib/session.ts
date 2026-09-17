import { computed, ref, type ComputedRef } from 'vue'
import type { SessionDto } from '@/types/api'

/** Fraction of the token lifetime after which renewal is attempted. */
const RENEWAL_THRESHOLD = 0.8

/** Shortest delay, in milliseconds, allowed between renewal attempts. */
const MIN_RENEWAL_DELAY_MS = 10000

/** `sessionStorage` key under which the session survives a page reload. */
const STORAGE_KEY = 'omp-admin.session'

/**
 * Session state, mirrored to `sessionStorage`.
 *
 * @remarks
 * The session is persisted per tab so that a reload keeps the user signed in. The
 * trade-off is that the token becomes readable by any injected script while the tab
 * is open; closing the tab discards it. `localStorage` is avoided on purpose so the
 * token does not outlive the tab. A proper fix would be an HttpOnly cookie issued by
 * `omp-api`, which the backend does not offer today.
 *
 * The constants above must stay declared before this line: the initializer reads
 * them at module evaluation.
 */
const session = ref<SessionDto | null>(readStoredSession())

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
 * Replaces the active session, persists it and reschedules the proactive renewal.
 *
 * @param next - Session returned by login or refresh.
 */
export function setSession(next: SessionDto): void {
  session.value = next
  writeStoredSession(next)
  scheduleRenewal(next)
}

/** Drops the active session, its persisted copy and any pending renewal. */
export function clearSession(): void {
  session.value = null
  removeStoredSession()
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
 * @remarks
 * A session restored from `sessionStorage` is loaded before any handler exists, so
 * its renewal is scheduled here, once the transport layer wires itself in.
 */
export function setRenewalHandler(handler: () => Promise<void>): void {
  renewalHandler = handler

  if (session.value !== null) {
    scheduleRenewal(session.value)
  }
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

/**
 * Reads the session persisted for this tab, discarding it when it is unusable.
 *
 * @returns The stored session, or null when there is none, it is malformed or its
 * token is expired or too close to expiring to be renewed.
 */
function readStoredSession(): SessionDto | null {
  let raw: string | null

  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }

  if (raw === null) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(raw)

    if (isUsableSession(parsed)) {
      return parsed
    }
  } catch {
    // Malformed payload: dropped below.
  }

  removeStoredSession()

  return null
}

/**
 * Checks that a persisted value has the shape of a session with a live token.
 *
 * @param value - Parsed payload.
 */
function isUsableSession(value: unknown): value is SessionDto {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Partial<SessionDto>

  if (
    typeof candidate.token !== 'string' ||
    typeof candidate.expiresAt !== 'string' ||
    typeof candidate.user !== 'object' ||
    candidate.user === null
  ) {
    return false
  }

  const expiresAt = Date.parse(candidate.expiresAt)

  return !Number.isNaN(expiresAt) && expiresAt - Date.now() > MIN_RENEWAL_DELAY_MS
}

/**
 * Persists the session for this tab. Storage failures are ignored.
 *
 * @param value - Session to persist.
 */
function writeStoredSession(value: SessionDto): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Storage unavailable (private mode, quota): the session stays in memory only.
  }
}

/** Removes the persisted session. Storage failures are ignored. */
function removeStoredSession(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}
