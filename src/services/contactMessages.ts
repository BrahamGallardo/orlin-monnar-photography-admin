import { http } from '@/lib/http'
import type { PagedQuery } from '@/services/appointments'
import type { ContactMessageDto, ContactMessageStatus, PaginatedList } from '@/types/api'

/**
 * Query functions for `api/admin/contact-messages`.
 *
 * @remarks
 * Every endpoint of the controller is `[Authorize]`; the bearer token is injected by
 * `@/lib/http`, so nothing here deals with authentication.
 */

/** Base path of the admin contact messages controller. */
const BASE_PATH = '/api/admin/contact-messages'

/** Page size used by the panel. Matches the backend default. */
export const DEFAULT_PAGE_SIZE = 15

/**
 * Reads a page of contact messages in one status.
 *
 * @param status - Status to filter by.
 * @param query - Pagination and cancellation options.
 * @remarks
 * The controller exposes no combinable filter for this resource, so the status travels
 * in the route. `totalCount` is enough when only the number of messages is needed.
 */
export function getContactMessagesByStatus(
  status: ContactMessageStatus,
  query: PagedQuery = {}
): Promise<PaginatedList<ContactMessageDto>> {
  return http.get<PaginatedList<ContactMessageDto>>(`${BASE_PATH}/status/${status}`, {
    query: {
      pageIndex: query.pageIndex ?? 1,
      pageSize: query.pageSize ?? DEFAULT_PAGE_SIZE
    },
    signal: query.signal
  })
}
