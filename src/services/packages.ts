import { http } from '@/lib/http'
import type { PagedQuery } from '@/services/appointments'
import type { PackageDto, PaginatedList } from '@/types/api'

/**
 * Query and command functions for `api/packages`.
 *
 * @remarks
 * Every endpoint the panel calls is `[Authorize]`; the bearer token is injected by
 * `@/lib/http`, so nothing here deals with authentication. The anonymous
 * `GET /api/packages` belongs to the landing and is deliberately not wrapped here.
 *
 * `Activated` does double duty on this resource, as it does on gallery categories: it is
 * the soft delete flag *and* the published flag. A package is never removed, only
 * unpublished and published again. The public API does not cache packages, so either
 * change reaches `investment.html` and the package selector of `booking.html` on their
 * next request. Appointments store their own `packageName`, so unpublishing a package
 * never rewrites them.
 */

/** Base path of the packages controller. */
const BASE_PATH = '/api/packages'

/** Path of the admin list, the only one that can include unpublished packages. */
const ADMIN_LIST_PATH = `${BASE_PATH}/admin`

/** Page size used by the panel. Sent explicitly, like in every other list. */
export const DEFAULT_PAGE_SIZE = 15

/** Maximum length of `Name`, mirroring the DTO data annotations. */
export const PACKAGE_NAME_MAX_LENGTH = 200

/** Maximum length of `Description`, mirroring the DTO data annotations. */
export const PACKAGE_DESCRIPTION_MAX_LENGTH = 1000

/** Maximum length of `Includes`, mirroring the DTO data annotations. One item per line. */
export const PACKAGE_INCLUDES_MAX_LENGTH = 2000

/** Maximum length of `Duration`, mirroring the DTO data annotations. */
export const PACKAGE_DURATION_MAX_LENGTH = 100

/** Lowest accepted `Price`, mirroring its range annotation. */
export const PACKAGE_PRICE_MIN = 0

/** Highest accepted `Price`, mirroring its range annotation. */
export const PACKAGE_PRICE_MAX = 9999999

/** Decimal places kept for `Price`, mirroring its `decimal(18,2)` column. */
export const PACKAGE_PRICE_DECIMALS = 2

/** Exact length of `Currency`, an ISO 4217 code. */
export const PACKAGE_CURRENCY_LENGTH = 3

/** Currency the backend assigns when none is captured. */
export const DEFAULT_PACKAGE_CURRENCY = 'MXN'

/** Options accepted by {@link getPackages}. */
export interface PackageQuery extends PagedQuery {
  /**
   * Whether unpublished packages are included.
   *
   * @remarks
   * Defaults to false on the backend, which hides them from the list. The panel needs
   * true to offer publishing one again.
   */
  includeDeactivated?: boolean
}

/**
 * Editable fields of a package, as sent to the create and update endpoints.
 *
 * @remarks
 * Both endpoints bind the full `PackageDto`, but the identifier travels in the route and
 * the audit dates are ignored by the mapping, so sending less keeps the payload honest
 * about what it can change.
 */
export interface PackagePayload {
  name: string
  description: string | null
  /** Included items, one per line. */
  includes: string | null
  /** Approximate session length, as free text. */
  duration: string | null
  /** Price with at most {@link PACKAGE_PRICE_DECIMALS} decimal places. */
  price: number
  /** ISO 4217 code of exactly {@link PACKAGE_CURRENCY_LENGTH} letters. */
  currency: string
  /** Display order. Lower value comes first. */
  displayOrder: number
  /**
   * Publication state to leave the package in.
   *
   * @remarks
   * Not optional on purpose. The update maps `Activated` from the DTO and
   * `BaseDto.Activated` defaults to `true` in the backend, so omitting it on the edit of
   * an unpublished package would silently publish it again, straight into
   * `investment.html` and the booking form.
   */
  activated: boolean
}

/**
 * Reads a page of packages for the admin panel.
 *
 * @param query - Pagination and visibility options.
 * @remarks
 * `buildQueryString` in `@/lib/http` drops null and undefined entries, so an omitted
 * flag never reaches the wire and the backend applies its own default.
 */
export function getPackages(query: PackageQuery = {}): Promise<PaginatedList<PackageDto>> {
  return http.get<PaginatedList<PackageDto>>(ADMIN_LIST_PATH, {
    query: {
      pageIndex: query.pageIndex ?? 1,
      pageSize: query.pageSize ?? DEFAULT_PAGE_SIZE,
      includeDeactivated: query.includeDeactivated
    },
    signal: query.signal
  })
}

/**
 * Reads one package by identifier.
 *
 * @param id - Package identifier.
 * @param signal - Caller owned signal.
 * @throws {ApiError} `notFound` when the package does not exist *or was deactivated*:
 * the service reads it with `onlyActive: true`, so an appointment can legitimately
 * point at a package this endpoint no longer returns. Callers must degrade instead of
 * treating it as a failure.
 */
export function getPackageById(id: number, signal?: AbortSignal): Promise<PackageDto> {
  return http.get<PackageDto>(`${BASE_PATH}/${id}`, { signal })
}

/**
 * Registers a new package.
 *
 * @param payload - Captured fields.
 * @returns The package as the server stored it.
 * @throws {ApiError} `validation` when a field breaks its data annotations.
 */
export function createPackage(payload: PackagePayload): Promise<PackageDto> {
  return http.post<PackageDto>(BASE_PATH, payload)
}

/**
 * Updates an existing package.
 *
 * @param id - Package identifier.
 * @param payload - Captured fields, including the publication state to keep.
 * @returns The package as the server left it.
 * @throws {ApiError} `validation` when a field breaks its data annotations.
 * @throws {ApiError} `notFound` when the package does not exist.
 * @remarks
 * Unlike {@link getPackageById}, this endpoint accepts unpublished packages, so the
 * editor must start from the row of {@link getPackages} rather than reading it again.
 */
export function updatePackage(id: number, payload: PackagePayload): Promise<PackageDto> {
  return http.put<PackageDto>(`${BASE_PATH}/${id}`, payload)
}

/**
 * Unpublishes a package without deleting it.
 *
 * @param id - Package identifier.
 * @throws {ApiError} `notFound` when the package does not exist.
 * @remarks
 * Answers 204: nothing is returned, so the caller reloads the list. The package leaves
 * `investment.html` and the booking selector at once; when no published package is left,
 * the Investment page falls back to its reference set. {@link reactivatePackage} undoes it.
 */
export function deactivatePackage(id: number): Promise<void> {
  return http.delete<void>(`${BASE_PATH}/${id}`)
}

/**
 * Publishes an unpublished package again.
 *
 * @param id - Package identifier.
 * @throws {ApiError} `notFound` when the package does not exist.
 * @remarks
 * Answers 204. Preferred over an update carrying `activated: true`: it states the intent,
 * and it does not need the rest of the fields to travel intact.
 */
export function reactivatePackage(id: number): Promise<void> {
  return http.post<void>(`${BASE_PATH}/${id}/reactivate`)
}
