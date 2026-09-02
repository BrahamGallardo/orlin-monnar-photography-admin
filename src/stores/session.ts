import { computed, type ComputedRef } from 'vue'
import { ApiError, http, renewSession } from '@/lib/http'
import { clearSession, currentSession, isAuthenticated, setSession } from '@/lib/session'
import type { AuthUserDto, SessionDto } from '@/types/api'

/**
 * Session store.
 *
 * @remarks
 * The project has no state management library on purpose: this is a plain module
 * singleton exposing the reactive state held by `@/lib/session` plus the actions
 * that talk to `api/auth`.
 *
 * The state itself deliberately stays in `@/lib/session`, which `@/lib/http` imports
 * to build the `Authorization` header. Moving it here would make the two modules
 * import each other.
 */

/** Credentials accepted by `POST /api/auth/login`. */
export interface LoginRequest {
  /** Administrator email. */
  email: string
  /** Administrator password. */
  password: string
}

/** Public surface of the session store. */
export interface SessionStore {
  /** Active session, or null when there is no authenticated user. */
  readonly session: ComputedRef<SessionDto | null>
  /** Profile of the authenticated user, or null when signed out. */
  readonly user: ComputedRef<AuthUserDto | null>
  /** Whether there is an active session. */
  readonly isAuthenticated: ComputedRef<boolean>
  login: (credentials: LoginRequest) => Promise<SessionDto>
  logout: () => Promise<void>
  refresh: () => Promise<boolean>
}

/**
 * Signs the administrator in and stores the resulting session.
 *
 * @param credentials - Email and password.
 * @returns The session issued by the backend.
 * @throws {ApiError} `unauthorized` on wrong credentials, `rateLimit` once the five
 * attempts per minute allowed by the endpoint are spent.
 * @remarks
 * The call is anonymous so that a stale token is never sent along with the
 * credentials.
 */
async function login(credentials: LoginRequest): Promise<SessionDto> {
  const session = await http.post<SessionDto>('/api/auth/login', credentials, {
    anonymous: true
  })

  setSession(session)

  return session
}

/**
 * Revokes the session on the server and drops it locally.
 *
 * @remarks
 * The endpoint reads the user identifier from the token claims, so it takes no body
 * and must run *before* the local state is cleared. A failure of that call is
 * swallowed: the local session is dropped either way, otherwise a network glitch
 * would leave the user locked inside the panel. Navigation is left to the caller so
 * that this module does not import the router, which imports it back.
 */
async function logout(): Promise<void> {
  try {
    await http.post<void>('/api/auth/logout')
  } catch (error) {
    if (!(error instanceof ApiError)) {
      throw error
    }
  } finally {
    clearSession()
  }
}

/**
 * Renews the access token.
 *
 * @returns Whether the session was renewed.
 * @remarks
 * Delegates to the transport layer, which already coalesces concurrent renewals with
 * the proactive one scheduled by `@/lib/session`.
 */
function refresh(): Promise<boolean> {
  return renewSession()
}

/** Profile of the authenticated user, unwrapped from the active session. */
const user: ComputedRef<AuthUserDto | null> = computed(
  () => currentSession.value?.user ?? null
)

/** The single store instance shared by the whole application. */
const store: SessionStore = {
  session: currentSession,
  user,
  isAuthenticated,
  login,
  logout,
  refresh
}

/**
 * Returns the session store.
 *
 * @remarks Always the same instance; the composable shape is only for ergonomics.
 */
export function useSession(): SessionStore {
  return store
}