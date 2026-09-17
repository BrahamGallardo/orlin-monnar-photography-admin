import type { AppointmentStatus } from '@/types/api'

/**
 * Presentation and transition rules of an appointment status.
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
 * Actions the panel offers from each status.
 *
 * @remarks
 * Mirrors `AppointmentService.AllowedTransitions`. Keeping both in step matters:
 * anything this map opens and the server closes becomes a 400 the operator only finds
 * out about after confirming an action that emails the client.
 */
const ALLOWED_ACTIONS: Record<
  AppointmentStatus,
  { confirm: boolean; cancel: boolean; complete: boolean }
> = {
  Pending: { confirm: true, cancel: true, complete: false },
  Confirmed: { confirm: false, cancel: true, complete: true },
  Cancelled: { confirm: false, cancel: false, complete: false },
  Completed: { confirm: false, cancel: false, complete: false }
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

/**
 * Whether the panel offers to close an appointment in this status.
 *
 * @param status - Current status.
 * @remarks Only a confirmed appointment can be closed.
 */
export function canComplete(status: AppointmentStatus): boolean {
  return ALLOWED_ACTIONS[status]?.complete ?? false
}
