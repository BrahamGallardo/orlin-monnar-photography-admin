import { http } from '@/lib/http'
import type { PagedQuery } from '@/services/appointments'
import type { GalleryCategoryDto, PaginatedList } from '@/types/api'

/**
 * Query and command functions for `api/admin/gallery`, categories only.
 *
 * @remarks
 * Every endpoint of the controller is `[Authorize]`; the bearer token is injected by
 * `@/lib/http`, so nothing here deals with authentication.
 *
 * `Activated` does double duty on this resource: it is the soft delete flag *and* the
 * published flag. A category is therefore never removed, only unpublished and published
 * again, and its slug stays reserved by the unique index in the meantime.
 */

/** Base path of the category endpoints of the admin gallery controller. */
const BASE_PATH = '/api/admin/gallery/categories'

/** Page size used by the panel. Matches the backend default. */
export const DEFAULT_PAGE_SIZE = 15

/** Maximum length of `Name`, mirroring its `[StringLength(150)]` attribute. */
export const CATEGORY_NAME_MAX_LENGTH = 150

/** Maximum length of `Slug`, mirroring its `[StringLength(150)]` attribute. */
export const CATEGORY_SLUG_MAX_LENGTH = 150

/** Maximum length of `Description`, mirroring its `[StringLength(1000)]` attribute. */
export const CATEGORY_DESCRIPTION_MAX_LENGTH = 1000

/**
 * Shape accepted for a slug.
 *
 * @remarks
 * Copied from the `[RegularExpression]` attribute of `GalleryCategoryDto`, so the panel
 * rejects an invalid slug before spending a round trip on a 400.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Combining marks left behind by an NFD normalization. */
const DIACRITIC_PATTERN = /[\u0300-\u036f]/g

/** Runs of characters a slug does not admit. */
const NON_SLUG_PATTERN = /[^a-z0-9]+/g

/** Leading and trailing separators of a slug. */
const EDGE_SEPARATOR_PATTERN = /^-+|-+$/g

/** Options accepted by {@link getGalleryCategories}. */
export interface GalleryCategoryQuery extends PagedQuery {
  /**
   * Whether unpublished categories are included.
   *
   * @remarks
   * Defaults to false on the backend, which hides them from the list. The panel needs
   * true to offer publishing one again.
   */
  includeDeactivated?: boolean
}

/**
 * Editable fields of a category, as sent to the create and update endpoints.
 *
 * @remarks
 * Both endpoints bind the full `GalleryCategoryDto`, but only these members are read:
 * the identifier travels in the route, the audit dates are ignored by the mapping
 * profile, and `CoverPhoto`, `PhotoCount` and `Photos` are computed from the active
 * photographs. Sending less keeps the payload honest about what it can change.
 */
export interface GalleryCategoryPayload {
  name: string
  /** Unique, lowercase and hyphenated. See {@link SLUG_PATTERN}. */
  slug: string
  description: string | null
  /** Display order. Lower value comes first. */
  displayOrder: number
  /**
   * Publication state to leave the category in.
   *
   * @remarks
   * Not optional on purpose. The mapping profile maps `Activated` from the DTO and
   * `BaseDto.Activated` defaults to `true` in the backend, so omitting it on the edit of
   * an unpublished category would silently publish it again.
   */
  activated: boolean
}

/**
 * Derives a slug from a display name.
 *
 * @param value - Name captured by the operator.
 * @returns A slug matching {@link SLUG_PATTERN}, or an empty string.
 * @remarks
 * Lives next to the pattern it has to satisfy, which is a wire contract: the backend
 * validates the slug with the same regular expression. The NFD normalization is what
 * turns `Sesion Intima` written with accents into `sesion-intima` instead of dropping
 * the accented letters.
 */
export function toSlug(value: string): string {
  return value
    .normalize('NFD')
    .replace(DIACRITIC_PATTERN, '')
    .toLowerCase()
    .replace(NON_SLUG_PATTERN, '-')
    .replace(EDGE_SEPARATOR_PATTERN, '')
    .slice(0, CATEGORY_SLUG_MAX_LENGTH)
    .replace(EDGE_SEPARATOR_PATTERN, '')
}

/**
 * Reads a page of categories.
 *
 * @param query - Pagination and visibility options.
 * @remarks
 * `buildQueryString` in `@/lib/http` drops null and undefined entries, so an omitted
 * flag never reaches the wire and the backend applies its own default.
 */
export function getGalleryCategories(
  query: GalleryCategoryQuery = {}
): Promise<PaginatedList<GalleryCategoryDto>> {
  return http.get<PaginatedList<GalleryCategoryDto>>(BASE_PATH, {
    query: {
      pageIndex: query.pageIndex ?? 1,
      pageSize: query.pageSize ?? DEFAULT_PAGE_SIZE,
      includeDeactivated: query.includeDeactivated
    },
    signal: query.signal
  })
}

/**
 * Reads one category with its active photographs.
 *
 * @param id - Category identifier.
 * @param signal - Caller owned signal.
 * @throws {ApiError} `notFound` when the category does not exist *or is unpublished*:
 * the specification behind this endpoint does not lift the soft delete filter. Callers
 * that need to work on an unpublished category must start from the list instead.
 */
export function getGalleryCategoryById(
  id: number,
  signal?: AbortSignal
): Promise<GalleryCategoryDto> {
  return http.get<GalleryCategoryDto>(`${BASE_PATH}/${id}`, { signal })
}

/**
 * Registers a new category.
 *
 * @param payload - Captured fields.
 * @returns The category as the server stored it.
 * @throws {ApiError} `validation` when a field breaks its data annotations.
 * @throws {ApiError} `conflict` when the slug is taken, *including by an unpublished
 * category*: the unique index on `Slug` does not honour the soft delete.
 */
export function createGalleryCategory(
  payload: GalleryCategoryPayload
): Promise<GalleryCategoryDto> {
  return http.post<GalleryCategoryDto>(BASE_PATH, payload)
}

/**
 * Updates an existing category.
 *
 * @param id - Category identifier.
 * @param payload - Captured fields, including the publication state to keep.
 * @returns The category as the server left it.
 * @throws {ApiError} `validation` when a field breaks its data annotations.
 * @throws {ApiError} `notFound` when the category does not exist.
 * @throws {ApiError} `conflict` when the new slug is taken. The check is skipped when the
 * slug does not change, so renaming without touching it never conflicts.
 */
export function updateGalleryCategory(
  id: number,
  payload: GalleryCategoryPayload
): Promise<GalleryCategoryDto> {
  return http.put<GalleryCategoryDto>(`${BASE_PATH}/${id}`, payload)
}

/**
 * Unpublishes a category without deleting it.
 *
 * @param id - Category identifier.
 * @throws {ApiError} `notFound` when the category does not exist.
 * @remarks
 * Answers 204: nothing is returned, so the caller reloads the list. The row keeps its
 * photographs and its slug, and {@link reactivateGalleryCategory} undoes it.
 */
export function deactivateGalleryCategory(id: number): Promise<void> {
  return http.delete<void>(`${BASE_PATH}/${id}`)
}

/**
 * Publishes an unpublished category again.
 *
 * @param id - Category identifier.
 * @throws {ApiError} `notFound` when the category does not exist.
 * @remarks
 * Answers 204. Preferred over an update carrying `activated: true`: it states the intent,
 * and it does not need the rest of the fields to travel intact.
 */
export function reactivateGalleryCategory(id: number): Promise<void> {
  return http.post<void>(`${BASE_PATH}/${id}/reactivate`)
}
