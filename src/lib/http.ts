import { appConfig } from '@/config'
import { clearSession, getAccessToken, setRenewalHandler, setSession } from '@/lib/session'
import type { SessionDto } from '@/types/api'

/** Default request timeout, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30000

/**
 * Client Closed Request. An nginx convention the backend reuses for cancellations
 * and that this client reproduces for locally aborted requests.
 */
const STATUS_CLIENT_CLOSED_REQUEST = 499

/** Route name the client falls back to when the session ends. */
const LOGIN_ROUTE_NAME = 'Login'

/* -------------------------------------------------------------------------- */
/* Error model                                                                 */
/* -------------------------------------------------------------------------- */

/** Uniform classification of every failure surfaced by the client. */
export type ApiErrorKind =
  | 'validation'
  | 'unauthorized'
  | 'forbidden'
  | 'notFound'
  | 'conflict'
  | 'payloadTooLarge'
  | 'rateLimit'
  | 'cancelled'
  | 'server'
  | 'network'
  | 'timeout'

/** Field name to messages map, as produced by ASP.NET `ValidationProblemDetails`. */
export type FieldErrors = Readonly<Record<string, readonly string[]>>

/** RFC 7807 payload, as written by the backend `GlobalExceptionHandler`. */
interface ProblemDetails {
  status?: number
  title?: string
  detail?: string
  instance?: string
  /** Present only on model validation failures produced by `[ApiController]`. */
  errors?: Record<string, string[]>
}

/** Every failure of the API client, normalized to a single shape. */
export class ApiError extends Error {
  /** Coarse classification, meant for branching in the UI. */
  readonly kind: ApiErrorKind
  /** HTTP status code, or 0 when the request never reached the server. */
  readonly status: number
  /** Short, displayable summary. */
  readonly title: string
  /** Displayable description. */
  readonly detail: string
  /** Per field messages. Empty unless `kind` is `validation`. */
  readonly fieldErrors: FieldErrors

  constructor(
    kind: ApiErrorKind,
    status: number,
    title: string,
    detail: string,
    fieldErrors: FieldErrors = {}
  ) {
    super(detail)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.title = title
    this.detail = detail
    this.fieldErrors = fieldErrors
  }
}

/* -------------------------------------------------------------------------- */
/* Request options                                                             */
/* -------------------------------------------------------------------------- */

/** HTTP verbs used by the panel. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** Value admitted in a query string entry. */
export type QueryValue = string | number | boolean | null | undefined

/** Query string parameters. Null and undefined entries are dropped. */
export type QueryParams = Record<string, QueryValue | readonly QueryValue[]>

/** Options accepted by {@link request}. */
export interface RequestOptions {
  method?: HttpMethod
  /** Payload. A `FormData` instance is sent as is; anything else as JSON. */
  body?: unknown
  query?: QueryParams
  headers?: Record<string, string>
  /** Caller owned signal, composed with the internal timeout. */
  signal?: AbortSignal
  /** Timeout in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Skips the `Authorization` header. Use for anonymous endpoints. */
  anonymous?: boolean
  /**
   * Skips the single refresh and retry performed on a 401.
   *
   * @internal Set by the client itself to keep the retry from recursing.
   */
  skipAuthRetry?: boolean
    /**
   * Skips both the refresh and retry and the session teardown performed on a 401.
   *
   * @internal Set on the refresh call itself, whose 401 is handled by its caller.
   */
  skipAuthHandling?: boolean
}

/* -------------------------------------------------------------------------- */
/* URL building                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Builds the absolute or same origin URL of an endpoint.
 *
 * @param path - Path starting at `/api`.
 * @param query - Optional query string parameters.
 * @remarks
 * `appConfig.apiBaseUrl` is an empty string in production, where the panel and the
 * API share an origin. The result is then a relative URL, which `fetch` resolves
 * against the current document.
 */
function buildUrl(path: string, query?: QueryParams): string {
  const base = appConfig.apiBaseUrl.replace(/\/+$/, '')
  const normalizedPath = path.startsWith('/') ? path : `/${path}`

  return `${base}${normalizedPath}${buildQueryString(query)}`
}

/**
 * Serializes query string parameters, dropping null and undefined entries.
 *
 * @param query - Parameters to serialize.
 * @returns The query string including its leading `?`, or an empty string.
 */
function buildQueryString(query?: QueryParams): string {
  if (query === undefined) {
    return ''
  }

  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        appendParam(params, key, item)
      }
    } else {
      appendParam(params, key, value as QueryValue)
    }
  }

  const serialized = params.toString()

  return serialized === '' ? '' : `?${serialized}`
}

/**
 * Appends one query string entry, ignoring empty values.
 *
 * @param params - Accumulator.
 * @param key - Parameter name.
 * @param value - Parameter value.
 */
function appendParam(params: URLSearchParams, key: string, value: QueryValue): void {
  if (value !== null && value !== undefined) {
    params.append(key, String(value))
  }
}

/* -------------------------------------------------------------------------- */
/* Abort handling                                                              */
/* -------------------------------------------------------------------------- */

/** Composition of the internal timeout with the caller owned signal. */
interface AbortBridge {
  readonly signal: AbortSignal
  /** Whether the abort came from the timeout rather than from the caller. */
  timedOut: () => boolean
  /** Releases the timer and the listener. Always call it. */
  dispose: () => void
}

/**
 * Creates a signal that aborts on timeout or when the caller aborts.
 *
 * @param timeoutMs - Timeout in milliseconds.
 * @param externalSignal - Caller owned signal, if any.
 * @remarks
 * `AbortSignal.any` would express this in one line but it is not part of the ES2020
 * target this project compiles against, so the composition is manual.
 */
function createAbortBridge(timeoutMs: number, externalSignal?: AbortSignal): AbortBridge {
  const controller = new AbortController()
  let timedOut = false

  const timeoutId = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const forwardAbort = (): void => controller.abort()

  if (externalSignal !== undefined) {
    if (externalSignal.aborted) {
      forwardAbort()
    } else {
      externalSignal.addEventListener('abort', forwardAbort)
    }
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      window.clearTimeout(timeoutId)

      if (externalSignal !== undefined) {
        externalSignal.removeEventListener('abort', forwardAbort)
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Response parsing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Reads the `ProblemDetails` body of a failed response.
 *
 * @param response - Failed response.
 * @returns The parsed payload, or null when the response carries no JSON body.
 */
async function readProblemDetails(response: Response): Promise<ProblemDetails | null> {
  const contentType = response.headers.get('content-type')

  if (contentType === null || !contentType.includes('json')) {
    return null
  }

  try {
    return (await response.json()) as ProblemDetails
  } catch {
    return null
  }
}

/**
 * Maps a status code to its error classification and default message.
 *
 * @param status - HTTP status code.
 */
function classify(status: number): { kind: ApiErrorKind; title: string; detail: string } {
  switch (status) {
    case 400:
      return {
        kind: 'validation',
        title: 'Solicitud inválida',
        detail: 'Revisa los datos capturados e inténtalo de nuevo.'
      }
    case 401:
      return {
        kind: 'unauthorized',
        title: 'Sesión no válida',
        detail: 'Tu sesión expiró o las credenciales son incorrectas.'
      }
    case 403:
      return {
        kind: 'forbidden',
        title: 'Acceso denegado',
        detail: 'No tienes permiso para realizar esta operación.'
      }
    case 404:
      return {
        kind: 'notFound',
        title: 'Recurso no encontrado',
        detail: 'El recurso solicitado ya no existe.'
      }
    case 409:
      return {
        kind: 'conflict',
        title: 'El recurso ya existe',
        detail: 'Ya hay un registro con esos datos.'
      }
    case STATUS_CLIENT_CLOSED_REQUEST:
      return {
        kind: 'cancelled',
        title: 'Solicitud cancelada',
        detail: 'La solicitud se canceló antes de completarse.'
      }
    default:
      return {
        kind: 'server',
        title: 'Error interno',
        detail: 'Ocurrió un error al procesar la solicitud. Intenta de nuevo más tarde.'
      }
  }
}

/**
 * Turns a failed response into an {@link ApiError}.
 *
 * @param response - Response whose status is not in the 2xx range.
 * @remarks
 * 413 and 429 are answered without a body and must not be read: Kestrel closes the
 * connection on an oversized upload before the exception handler runs, and the rate
 * limiter only sets `RejectionStatusCode`. Both messages are produced here.
 */
async function toApiError(response: Response): Promise<ApiError> {
  if (response.status === 413) {
    return new ApiError(
      'payloadTooLarge',
      413,
      'Archivo demasiado grande',
      'El archivo supera el tamaño máximo permitido por el servidor. Reduce su peso e inténtalo de nuevo.'
    )
  }

  if (response.status === 429) {
    return new ApiError(
      'rateLimit',
      429,
      'Demasiadas solicitudes',
      'Alcanzaste el límite de solicitudes. Espera un momento e inténtalo de nuevo.'
    )
  }

  const problem = await readProblemDetails(response)
  const fallback = classify(response.status)

  const title = problem?.title ?? fallback.title
  const detail = problem?.detail ?? fallback.detail
  const fieldErrors: FieldErrors = problem?.errors ?? {}

  const kind = fallback.kind

  return new ApiError(kind, response.status, title, detail, fieldErrors)
}

/**
 * Reads the body of a successful response.
 *
 * @param response - Successful response.
 * @typeParam T - Expected payload type.
 */
async function readBody<T>(response: Response): Promise<T> {
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T
  }

  const contentType = response.headers.get('content-type')

  if (contentType !== null && contentType.includes('json')) {
    return (await response.json()) as T
  }

  return (await response.text()) as T
}

/* -------------------------------------------------------------------------- */
/* Session renewal and 401 handling                                            */
/* -------------------------------------------------------------------------- */

/** In flight renewal, shared so that concurrent 401s trigger a single call. */
let renewalInFlight: Promise<boolean> | null = null

/**
 * Renews the session once, coalescing concurrent callers.
 *
 * @returns Whether the session was renewed.
 */
function renewSession(): Promise<boolean> {
  if (renewalInFlight === null) {
    renewalInFlight = runRenewal().then(
      (renewed) => {
        renewalInFlight = null
        return renewed
      },
      () => {
        renewalInFlight = null
        return false
      }
    )
  }

  return renewalInFlight
}

/**
 * Calls `POST /api/auth/refresh` and stores the resulting session.
 *
 * @returns Whether the call succeeded.
 * @remarks
 * The endpoint is `[Authorize]` and reads the user identifier from the token, so it
 * only succeeds while the current token is still valid. That is why the panel also
 * renews proactively from `@/lib/session`.
 */
async function runRenewal(): Promise<boolean> {
  if (getAccessToken() === null) {
    return false
  }

  try {
    const session = await request<SessionDto>('/api/auth/refresh', {
      method: 'POST',
      skipAuthHandling: true
    })

    setSession(session)

    return true
  } catch {
    return false
  }
}

/**
 * Drops the session and sends the user to the login view.
 *
 * @remarks
 * The router is imported dynamically to keep `http.ts` out of the module graph that
 * `main.ts` resolves at startup, which would otherwise be cyclic. The route name is
 * checked first so that a 401 raised from the login view does not loop.
 */
async function endSession(): Promise<void> {
  clearSession()

  const { default: router } = await import('@/router')
  const current = router.currentRoute.value

  if (current.name !== LOGIN_ROUTE_NAME) {
    await router.replace({ name: LOGIN_ROUTE_NAME, query: { redirect: current.fullPath } })
  }
}

/* -------------------------------------------------------------------------- */
/* Core request                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Performs a request against the backend API.
 *
 * @param path - Path starting at `/api`.
 * @param options - Request options.
 * @typeParam T - Expected payload type.
 * @throws {ApiError} On any transport, timeout or non 2xx outcome.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    body,
    query,
    headers = {},
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    anonymous = false,
    skipAuthRetry = false,
    skipAuthHandling = false
  } = options

  const isFormData = body instanceof FormData
  const requestHeaders: Record<string, string> = { Accept: 'application/json', ...headers }

  if (body !== undefined && !isFormData) {
    requestHeaders['Content-Type'] = 'application/json'
  }

  if (!anonymous) {
    const token = getAccessToken()

    if (token !== null) {
      requestHeaders.Authorization = `Bearer ${token}`
    }
  }

  const bridge = createAbortBridge(timeoutMs, signal)
  let response: Response

  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body),
      signal: bridge.signal
    })
  } catch (error) {
    if (bridge.timedOut()) {
      throw new ApiError(
        'timeout',
        0,
        'Tiempo de espera agotado',
        'El servidor no respondió a tiempo. Verifica tu conexión e inténtalo de nuevo.'
      )
    }

    if (bridge.signal.aborted) {
      throw new ApiError(
        'cancelled',
        STATUS_CLIENT_CLOSED_REQUEST,
        'Solicitud cancelada',
        'La solicitud se canceló antes de completarse.'
      )
    }

    throw new ApiError(
      'network',
      0,
      'Sin conexión con el servidor',
      error instanceof Error ? error.message : 'No fue posible contactar al servidor.'
    )
  } finally {
    bridge.dispose()
  }

  if (response.ok) {
    return readBody<T>(response)
  }

  // A 401 tears the session down. The single refresh and retry only helps inside the
  // token clock skew window: once the token is truly expired, the refresh endpoint
  // answers 401 as well.
  if (response.status === 401 && !anonymous && !skipAuthHandling) {
    if (!skipAuthRetry) {
      const renewed = await renewSession()

      if (renewed) {
        return request<T>(path, { ...options, skipAuthRetry: true })
      }
    }

    await endSession()
  }

  throw await toApiError(response)
}

/* -------------------------------------------------------------------------- */
/* Verb helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Thin verb helpers over {@link request}. */
export const http = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
    request<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
    request<T>(path, { ...options, method: 'POST', body }),

  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
    request<T>(path, { ...options, method: 'PUT', body }),

  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
    request<T>(path, { ...options, method: 'PATCH', body }),

  delete: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
    request<T>(path, { ...options, method: 'DELETE' })
}

// Wires the proactive renewal declared in @/lib/session to the transport layer.
setRenewalHandler(async () => {
  const renewed = await renewSession()

  if (!renewed) {
    await endSession()
  }
})