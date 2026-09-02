/**
 * TypeScript contracts for the backend DTOs.
 *
 * Property names are camelCase because the API serializes with the System.Text.Json
 * default policy: `AddControllers()` in Program.cs does not override
 * `JsonSerializerOptions.PropertyNamingPolicy`.
 *
 * Every date travels as an ISO 8601 string in UTC. Format them with `@/lib/format`.
 */

/** Fields shared by every DTO derived from an auditable entity. */
export interface BaseDto {
  /** Entity identifier. */
  id: number
  /** Whether the record is active or published. */
  activated: boolean
  /** Creation date, as an ISO 8601 UTC string. Read only. */
  createdDate: string
  /** Last update date, as an ISO 8601 UTC string. Read only. */
  updatedDate: string | null
}

/**
 * A page of results, mirroring the backend `IPaginatedList<T>`.
 *
 * @typeParam T - Type of the items in the page.
 */
export interface PaginatedList<T> {
  /** Items of the current page. */
  items: T[]
  /** Current page index, one based. */
  pageIndex: number
  /** Requested page size. */
  pageSize: number
  /** Total number of items across every page. */
  totalCount: number
  /** Total number of pages. */
  totalPages: number
  hasPreviousPage: boolean
  hasNextPage: boolean
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Authenticated user, as nested in {@link SessionDto} and returned by
 * `GET /api/auth/me`.
 *
 * @remarks
 * It deliberately does not extend {@link BaseDto}: the backend `AuthUserDto` exposes
 * `createdDate` but no `updatedDate`, even though the `AuthUsers` table has that
 * column.
 */
export interface AuthUserDto {
  /** User identifier. */
  id: number
  /** Given name. */
  name: string
  /** Family name. Null: the column admits it. */
  lastName: string | null
  /** Email address, used as the sign in identifier. */
  email: string
  /** Identifier of the assigned role. */
  roleId: number
  /** Display name of the role, such as `Admin`. */
  roleName: string
  /** Whether the email address was confirmed. */
  emailVerified: boolean
  /** Whether the account has a password set. */
  hasPassword: boolean
  /** Whether the account is enabled. */
  activated: boolean
  /** Creation date, as an ISO 8601 UTC string. */
  createdDate: string
}

/**
 * Session returned by `POST /api/auth/login` and `POST /api/auth/refresh`.
 *
 * @remarks
 * The backend issues a rolling access token: there is no separate refresh token.
 * `POST /api/auth/refresh` is `[Authorize]` and reads the user identifier from the
 * token itself, so the session must be renewed *before* `expiresAt` elapses.
 */
export interface SessionDto {
  /** Identifier of the authenticated user. Same value as `user.id`. */
  userId: number
  /** JWT access token, sent as `Authorization: Bearer <token>`. */
  token: string
  /** Token expiration instant, as an ISO 8601 UTC string. */
  expiresAt: string
  /** Profile of the authenticated user. */
  user: AuthUserDto
}

/* -------------------------------------------------------------------------- */
/* Packages                                                                    */
/* -------------------------------------------------------------------------- */

/** Photography package published on the Investment page. */
export interface PackageDto extends BaseDto {
  /** Commercial name of the package. */
  name: string
  description: string | null
  /** Included items, one per line. */
  includes: string | null
  /** Approximate session length, as free text. */
  duration: string | null
  /** Package price. Serialized from a .NET `decimal`. */
  price: number
  /** ISO 4217 currency code. Defaults to `MXN` on the backend. */
  currency: string
  /** Display order. Lower value comes first. */
  displayOrder: number
}

/* -------------------------------------------------------------------------- */
/* Appointments                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Valid appointment statuses.
 *
 * @remarks Mirrors the `omp_domain.Common.AppointmentStatus` constants.
 */
export type AppointmentStatus = 'Pending' | 'Confirmed' | 'Cancelled' | 'Completed'

/** Booked appointment, as consumed by the admin panel. */
export interface AppointmentDto extends BaseDto {
  fullName: string
  email: string
  phone: string
  /** Identifier of the selected package. */
  packageId: number
  /** Name of the selected package. Null when the package was removed. */
  packageName: string | null
  /** Requested date and time, as an ISO 8601 UTC string. */
  appointmentDate: string
  location: string | null
  /** Comments written by the client. */
  notes: string | null
  status: AppointmentStatus
  confirmedDate: string | null
  cancelledDate: string | null
  /** Internal notes written by the administrator. */
  adminNotes: string | null
}

/* -------------------------------------------------------------------------- */
/* Gallery                                                                     */
/* -------------------------------------------------------------------------- */

/** Gallery photograph with the public URLs of its three derivatives. */
export interface PhotoDto extends BaseDto {
  galleryCategoryId: number
  title: string | null
  /** Alternative text for accessibility and SEO. */
  altText: string | null
  /** Public URL of the thumb derivative, around 500 px. */
  thumbUrl: string
  /** Public URL of the medium derivative, around 1200 px. */
  mediumUrl: string
  /** Public URL of the large derivative, around 2560 px. */
  largeUrl: string
  /** Width in pixels of the large derivative. */
  width: number
  /** Height in pixels of the large derivative. */
  height: number
  /** Display order inside its category. */
  displayOrder: number
  /** Whether the photograph appears in the Home carousel. */
  isFeatured: boolean
}

/** Gallery category or album. */
export interface GalleryCategoryDto extends BaseDto {
  name: string
  /** Human readable identifier used in the public URL. */
  slug: string
  description: string | null
  /** Display order. Lower value comes first. */
  displayOrder: number
  /**
   * Cover photograph. Null when the category has no active photographs.
   *
   * @remarks
   * Marking a photograph as featured can change its category cover: the backend
   * breaks the tie by `isFeatured` before `displayOrder`.
   */
  coverPhoto: PhotoDto | null
  /** Number of active photographs in the category. */
  photoCount: number
  /**
   * Photographs of the category.
   *
   * @remarks
   * Always empty in list responses. Populated only by the detail queries by slug
   * or by identifier.
   */
  photos: PhotoDto[]
}

/* -------------------------------------------------------------------------- */
/* Contact                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Valid contact message statuses.
 *
 * @remarks Mirrors the `omp_domain.Common.ContactMessageStatus` constants.
 */
export type ContactMessageStatus = 'Pending' | 'Responded' | 'Archived'

/** Contact form message, as consumed by the admin panel. */
export interface ContactMessageDto extends BaseDto {
  name: string
  email: string
  phone: string | null
  subject: string
  message: string
  status: ContactMessageStatus
  /** Reply date, as an ISO 8601 UTC string. */
  respondedAt: string | null
}