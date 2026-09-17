import { http } from '@/lib/http'
import type { AppointmentDto, AppointmentStatus, AppointmentStatusChangeDto, PaginatedList } from '@/types/api'

/**
 * Query functions for `api/admin/appointments`.
 *
 * @remarks
 * Every endpoint of the controller is `[Authorize]`; the bearer token is injected by
 * `@/lib/http`, so nothing here deals with authentication. Dates travel as ISO 8601
 * strings in UTC: `Date.toISOString` always emits the `Z` designator and ASP.NET Core
 * binds a query string `DateTime` as UTC, so the instant reaches the server unshifted.
 */

/** Base path of the admin appointments controller. */
const BASE_PATH = '/api/admin/appointments'

/** Page size used by the panel. Matches the backend default. */
export const DEFAULT_PAGE_SIZE = 15

/** Every status accepted by `GET /status/{status}`, in display order. */
export const APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  'Pending',
  'Confirmed',
  'Cancelled',
  'Completed'
]

/** Maximum length of `AdminNotes`, mirroring the `[StringLength(1000)]` attribute. */
export const ADMIN_NOTES_MAX_LENGTH = 1000

/** Pagination and cancellation options shared by every paged query. */
export interface PagedQuery {
  /** One based page index. Defaults to 1. */
  pageIndex?: number
  /** Items per page. Defaults to {@link DEFAULT_PAGE_SIZE}. */
  pageSize?: number
  /** Caller owned signal, forwarded to the transport layer. */
  signal?: AbortSignal
}

/** Options accepted by {@link getAppointments}. */
export interface AppointmentQuery extends PagedQuery {
  /** Status to filter by. Null or omitted matches every status. */
  status?: AppointmentStatus | null
  /** Inclusive start of the range. Requires {@link AppointmentQuery.endDate}. */
  startDate?: Date | null
  /** Inclusive end of the range. Requires {@link AppointmentQuery.startDate}. */
  endDate?: Date | null
}

/**
 * Reads a page of appointments, optionally filtered by status and by date range.
 *
 * @param query - Filters and pagination options.
 * @throws {ApiError} `validation` when only one end of the range is supplied, or when
 * the end date precedes the start date. Both are rejected by the controller.
 * @remarks
 * `buildQueryString` in `@/lib/http` drops null and undefined entries, so an inactive
 * filter never reaches the wire.
 */
export function getAppointments(
  query: AppointmentQuery = {}
): Promise<PaginatedList<AppointmentDto>> {
  return http.get<PaginatedList<AppointmentDto>>(BASE_PATH, {
    query: {
      pageIndex: query.pageIndex ?? 1,
      pageSize: query.pageSize ?? DEFAULT_PAGE_SIZE,
      status: query.status,
      startDateUtc: query.startDate?.toISOString(),
      endDateUtc: query.endDate?.toISOString()
    },
    signal: query.signal
  })
}

/**
 * Reads the next appointments, for the dashboard.
 *
 * @param take - Maximum number of appointments. The backend clamps it to 1..50.
 * @param signal - Caller owned signal.
 * @remarks Not paged: the endpoint answers a plain array.
 */
export function getUpcomingAppointments(
  take: number = 5,
  signal?: AbortSignal
): Promise<AppointmentDto[]> {
  return http.get<AppointmentDto[]>(`${BASE_PATH}/upcoming`, { query: { take }, signal })
}

/**
 * Reads one appointment by identifier.
 *
 * @param id - Appointment identifier.
 * @param signal - Caller owned signal.
 * @throws {ApiError} `notFound` when the appointment does not exist.
 */
export function getAppointmentById(id: number, signal?: AbortSignal): Promise<AppointmentDto> {
  return http.get<AppointmentDto>(`${BASE_PATH}/${id}`, { signal })
}

/**
 * Confirms an appointment and notifies the client by email.
 *
 * @param id - Appointment identifier.
 * @param change - Optional administrator notes.
 * @returns The appointment as it was left by the transition.
 * @throws {ApiError} `validation` when the transition is rejected: the appointment is
 * already confirmed. The message written by the domain travels in `detail`.
 * @throws {ApiError} `notFound` when the appointment does not exist.
 * @remarks
 * Deliberately takes no `AbortSignal`: the server sends the email as part of the
 * request, so aborting the call locally would leave the panel unsure of the outcome.
 */
export function confirmAppointment(
  id: number,
  change: AppointmentStatusChangeDto
): Promise<AppointmentDto> {
  return http.post<AppointmentDto>(`${BASE_PATH}/${id}/confirm`, change)
}

/**
 * Cancels an appointment and notifies the client by email.
 *
 * @param id - Appointment identifier.
 * @param change - Optional administrator notes.
 * @returns The appointment as it was left by the transition.
 * @throws {ApiError} `validation` when the transition is rejected: the appointment is
 * already cancelled.
 * @throws {ApiError} `notFound` when the appointment does not exist.
 * @remarks See {@link confirmAppointment} on why no signal is accepted.
 */
export function cancelAppointment(
  id: number,
  change: AppointmentStatusChangeDto
): Promise<AppointmentDto> {
  return http.post<AppointmentDto>(`${BASE_PATH}/${id}/cancel`, change)
}

/**
 * Marks an appointment as delivered.
 *
 * @param id - Appointment identifier.
 * @param change - Optional administrator notes.
 * @returns The appointment as it was left by the transition.
 * @throws {ApiError} `validation` when the appointment is not confirmed, or already
 * sits in a final status. Only `Confirmed` admits this transition.
 * @throws {ApiError} `notFound` when the appointment does not exist.
 * @remarks
 * Unlike {@link confirmAppointment} and {@link cancelAppointment}, this one sends no
 * email: the backend closes the appointment without notifying the client.
 */
export function completeAppointment(
  id: number,
  change: AppointmentStatusChangeDto
): Promise<AppointmentDto> {
  return http.post<AppointmentDto>(`${BASE_PATH}/${id}/complete`, change)
}