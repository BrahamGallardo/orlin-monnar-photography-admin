import type { AppointmentStatus } from '@/types/api'

/**
 * Presentation and UI transition rules for an appointment status.
 *
 * @remarks
 * Kept out of `@/services/appointments`, which mirrors the wire contract and carries
 * no presentation concerns.
 */

/** Variants admitted by `@/components/ui/Badge.vue`. */
type BadgeVariant = 'default' | 'success' | 'warning' | 'destructive' | 'muted'

/** How a status is rendered. */
interface StatusPresentation {
  label: string
  variant: BadgeVariant
}

/** Spanish labels and badge variants, by status. */
const STATUS_PRESENTATION: Record<AppointmentStatus, StatusPresentation> = {
  Pending: { label: 'Pendiente', variant: 'warning' },
  Confirmed: { label: 'Confirmada', variant: 'success' },
  Cancelled: { label: 'Cancelada', variant: 'destructive' },
  Completed: { label: 'Completada', variant: 'default' }
}

/**
 * Presentation of a status, falling back for a value the panel does not know.
 *
 * @param status - Status reported by the backend.
 */
export function presentationOf(status: AppointmentStatus): StatusPresentation {
  return STATUS_PRESENTATION[status] ?? { label: status, variant: 'default' }
}

/**
 * Statuses from which the panel offers each action.
 *
 * @remarks
 * Stricter than the backend on purpose. `ChangeStatusAsync` only rejects a repeated
 * status and `Cancelled -> Confirmed`, so it would accept acting on a `Completed`
 * appointment; doing so emails the client that a session already delivered was just
 * confirmed or cancelled. The panel treats `Completed` as terminal. Widening this map
 * is the only change needed to follow the server rules literally.
 */
const ALLOWED_ACTIONS: Record<AppointmentStatus, { confirm: boolean; cancel: boolean }> = {
  Pending: { confirm: true, cancel: true },
  Confirmed: { confirm: false, cancel: true },
  Cancelled: { confirm: false, cancel: false },
  Completed: { confirm: false, cancel: false }
}

/**
 * Whether the panel offers to confirm an appointment in this status.
 *
 * @param status - Current status.
 */
export function canConfirm(status: AppointmentStatus): boolean {
  return ALLOWED_ACTIONS[status]?.confirm ?? false
}

/**
 * Whether the panel offers to cancel an appointment in this status.
 *
 * @param status - Current status.
 */
export function canCancel(status: AppointmentStatus): boolean {
  return ALLOWED_ACTIONS[status]?.cancel ?? false
}