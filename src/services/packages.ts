import { http } from '@/lib/http'
import type { PackageDto } from '@/types/api'

/**
 * Query functions for `api/packages`.
 *
 * @remarks Only the read used by the appointment detail is implemented so far.
 */

/** Base path of the packages controller. */
const BASE_PATH = '/api/packages'

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
