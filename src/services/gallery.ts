import { appConfig } from '@/config'
import { http, upload, type UploadProgress } from '@/lib/http'
import type { PagedQuery } from '@/services/appointments'
import type {
  GalleryCategoryDto,
  PaginatedList,
  PhotoDto,
  ReorderPhotosRequestDto
} from '@/types/api'

/**
 * Query and command functions for `api/admin/gallery`: categories and photographs.
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

/* -------------------------------------------------------------------------- */
/* Photographs                                                                 */
/* -------------------------------------------------------------------------- */

/** Base path of the photograph endpoints of the admin gallery controller. */
const PHOTOS_PATH = '/api/admin/gallery/photos'

/**
 * Names of the multipart parts bound by the upload endpoint.
 *
 * @remarks
 * The action takes the binary as an `IFormFile file` parameter and the rest as a
 * `[FromForm] PhotoUploadRequestDto`, which binds flat, without a prefix. Model binding
 * is case insensitive, so the casing here only documents the server side members.
 */
const UPLOAD_FIELDS = {
  file: 'file',
  categoryId: 'GalleryCategoryId',
  title: 'Title',
  altText: 'AltText',
  displayOrder: 'DisplayOrder',
  isFeatured: 'IsFeatured'
} as const

/** Page size used for the photographs of a category. Matches the backend default. */
export const PHOTOS_PAGE_SIZE = 30

/** Maximum length of `Title`, mirroring its `[StringLength(200)]` attribute. */
export const PHOTO_TITLE_MAX_LENGTH = 200

/** Maximum length of `AltText`, mirroring its `[StringLength(300)]` attribute. */
export const PHOTO_ALT_TEXT_MAX_LENGTH = 300

/** Maximum size of one upload, in megabytes, as configured on the server. */
export const MAX_UPLOAD_SIZE_MB = appConfig.storage.maxUploadSizeMb

/** Maximum size of one upload, in bytes. */
export const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024

/** Extensions accepted by the server, lowercase and dot prefixed. */
export const ALLOWED_EXTENSIONS: readonly string[] = appConfig.storage.allowedExtensions

/**
 * Uploads per minute the endpoint admits, per authenticated user.
 *
 * @remarks
 * Documented for the copy of the 429 message. The panel does not throttle against it:
 * a single upload takes seconds, so the fixed window is only reachable on a very large
 * batch. `QueueLimit` is zero on the server, so a rejected request is never queued.
 */
export const PHOTO_UPLOAD_RATE_LIMIT_PER_MINUTE = 60

/** Reason the panel rejected a file before sending it. */
export type PhotoRejection = 'extension' | 'size'

/** Fields captured for a photograph while it waits in the upload queue. */
export interface PhotoUploadPayload {
  /** File chosen by the operator. */
  file: File
  title: string | null
  altText: string | null
  /** Whether the photograph appears in the Home carousel. */
  isFeatured: boolean
  /**
   * Display order inside its category.
   *
   * @remarks
   * Stored verbatim: the backend does not compute it. Leaving every upload at zero
   * would make the order of a category depend on the identifier tiebreaker, so the
   * caller numbers the batch after the photographs already stored.
   */
  displayOrder: number
}

/** Editable metadata of an existing photograph. */
export interface PhotoMetadataPayload {
  title: string | null
  altText: string | null
  /** Whether the photograph appears in the Home carousel. */
  isFeatured: boolean
  /** Display order inside its category. */
  displayOrder: number
}

/** Options accepted by {@link uploadGalleryPhoto}. */
export interface PhotoUploadOptions {
  /** Called as the body travels. */
  onProgress?: (progress: UploadProgress) => void
  /** Caller owned signal. */
  signal?: AbortSignal
}

/** Options accepted by {@link getGalleryCategoryPhotos}. */
export type GalleryPhotoQuery = PagedQuery

/**
 * Returns the lowercase extension of a file name, including its dot.
 *
 * @param fileName - Name as reported by the file picker.
 * @returns The extension, or an empty string when the name carries none.
 */
export function getFileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.')

  return dotIndex === -1 ? '' : fileName.slice(dotIndex).toLowerCase()
}

/**
 * Checks a file against the limits the server enforces.
 *
 * @param file - Candidate file.
 * @returns The reason it would be rejected, or null when it can be sent.
 * @remarks
 * The extension is checked rather than the MIME type, because `EnsureExtensionIsAllowed`
 * on the server reads `Path.GetExtension` against `Storage:AllowedExtensions`. A browser
 * reports an empty or wrong `type` often enough that trusting it would reject valid
 * files, `.heic` above all.
 *
 * Sizes are compared against a *copy* of the server limit, so this is an early exit,
 * never the authority: a 413 is still handled when the two drift apart.
 */
export function validatePhotoFile(file: File): PhotoRejection | null {
  if (!ALLOWED_EXTENSIONS.includes(getFileExtension(file.name))) {
    return 'extension'
  }

  if (file.size > MAX_UPLOAD_SIZE_BYTES) {
    return 'size'
  }

  return null
}

/**
 * Reads a page of the photographs of a category.
 *
 * @param categoryId - Category identifier.
 * @param query - Pagination and cancellation options.
 * @remarks
 * The endpoint answers a paginated list, not a plain array. `PhotoSpecification` does
 * not call `ApplyIncludeDisabled`, so the root filter of `ISoftDeletable` applies and a
 * deleted photograph never reaches the panel.
 */
export function getGalleryCategoryPhotos(
  categoryId: number,
  query: GalleryPhotoQuery = {}
): Promise<PaginatedList<PhotoDto>> {
  return http.get<PaginatedList<PhotoDto>>(`${BASE_PATH}/${categoryId}/photos`, {
    query: {
      pageIndex: query.pageIndex ?? 1,
      pageSize: query.pageSize ?? PHOTOS_PAGE_SIZE
    },
    signal: query.signal
  })
}

/**
 * Uploads one photograph with its metadata.
 *
 * @param categoryId - Category the photograph belongs to.
 * @param payload - File and captured metadata.
 * @param options - Progress callback and cancellation.
 * @returns The photograph as the server stored it.
 * @throws {ApiError} `payloadTooLarge` when the file exceeds `Storage:MaxUploadSizeMB`.
 * The answer carries no body: Kestrel aborts the request before the exception handler.
 * @throws {ApiError} `validation` when the extension is not in `Storage:AllowedExtensions`.
 * The server raises an `InvalidOperationException`, which the global handler translates
 * to a 400 whose `detail` already lists the accepted extensions.
 * @throws {ApiError} `notFound` when the category does not exist *or is unpublished*:
 * the upload reads it with `onlyActive: true`.
 * @throws {ApiError} `rateLimit` when the per user fixed window is exhausted.
 * @remarks
 * One photograph per request is a server constraint, not a client choice: the original
 * is decoded in memory to derive the thumb, medium and large WebP renditions and is
 * discarded afterwards. The metadata travels in the same body, so a stored photograph
 * never needs a second request to carry its title.
 */
export function uploadGalleryPhoto(
  categoryId: number,
  payload: PhotoUploadPayload,
  options: PhotoUploadOptions = {}
): Promise<PhotoDto> {
  const body = new FormData()

  body.append(UPLOAD_FIELDS.file, payload.file, payload.file.name)
  body.append(UPLOAD_FIELDS.categoryId, String(categoryId))
  body.append(UPLOAD_FIELDS.displayOrder, String(payload.displayOrder))
  body.append(UPLOAD_FIELDS.isFeatured, String(payload.isFeatured))

  if (payload.title !== null) {
    body.append(UPLOAD_FIELDS.title, payload.title)
  }

  if (payload.altText !== null) {
    body.append(UPLOAD_FIELDS.altText, payload.altText)
  }

  return upload<PhotoDto>(PHOTOS_PATH, body, {
    onProgress: options.onProgress,
    signal: options.signal
  })
}

/**
 * Updates the metadata of a photograph without touching its files.
 *
 * @param id - Photograph identifier.
 * @param payload - Editable fields.
 * @returns The photograph as the server left it.
 * @throws {ApiError} `notFound` when the photograph does not exist.
 * @remarks
 * `isFeatured` means the photograph appears in the Home carousel, not that it is the
 * cover of its category. The cover is a projection the backend computes breaking the tie
 * by `isFeatured` before `displayOrder`, so marking one can change the cover as a side
 * effect and the category list has to be reloaded afterwards.
 */
export function updateGalleryPhoto(
  id: number,
  payload: PhotoMetadataPayload
): Promise<PhotoDto> {
  return http.put<PhotoDto>(`${PHOTOS_PATH}/${id}`, payload)
}

/**
 * Reads every photograph of a category, walking the pages in order.
 *
 * @param categoryId - Category identifier.
 * @param signal - Caller owned signal.
 * @returns The photographs sorted as the server sorts them: `displayOrder`, then `id`.
 * @remarks
 * Needed by reordering, because {@link reorderGalleryPhotos} rewrites the positions of
 * the identifiers it receives only. The pages are requested one after the other: the
 * tiebreaker on the primary key keeps them from repeating or skipping rows, and a
 * parallel burst would buy nothing for the size of a category.
 */
export async function getAllGalleryCategoryPhotos(
  categoryId: number,
  signal?: AbortSignal
): Promise<PhotoDto[]> {
  const photos: PhotoDto[] = []
  let pageIndex = 1
  let hasNextPage = true

  while (hasNextPage) {
    const page = await getGalleryCategoryPhotos(categoryId, {
      pageIndex,
      pageSize: PHOTOS_PAGE_SIZE,
      signal
    })

    photos.push(...page.items)
    hasNextPage = page.hasNextPage
    pageIndex += 1
  }

  return photos
}

/**
 * Stores a new order for the photographs of a category.
 *
 * @param photoIds - Every photograph of the category, in the desired order.
 * @throws {ApiError} `validation` when the list is empty.
 * @remarks
 * Answers 204. The server numbers the positions from zero, so a partial list would
 * collide with the photographs left out. See {@link ReorderPhotosRequestDto}.
 */
export function reorderGalleryPhotos(photoIds: readonly number[]): Promise<void> {
  const body: ReorderPhotosRequestDto = { photoIds: [...photoIds] }

  return http.put<void>(`${PHOTOS_PATH}/reorder`, body)
}

/**
 * Deletes a photograph and its files. Irreversible.
 *
 * @param id - Photograph identifier.
 * @throws {ApiError} `notFound` when the photograph does not exist or was already deleted.
 * @remarks
 * Answers 204. The row is soft deleted first and then the thumb, medium and large WebP
 * renditions are removed from disk, so it cannot be brought back: the panel offers no
 * reactivation for photographs. The public category list is cached for 60 seconds on the
 * server, so the cover and the count on the landing may lag behind for up to a minute.
 */
export function deleteGalleryPhoto(id: number): Promise<void> {
  return http.delete<void>(`${PHOTOS_PATH}/${id}`)
}
