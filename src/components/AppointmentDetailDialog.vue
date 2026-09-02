<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CalendarCheck, CalendarX2, Loader2 } from 'lucide-vue-next'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import Dialog from '@/components/ui/Dialog.vue'
import { ApiError } from '@/lib/http'
import { canCancel, canConfirm, presentationOf } from '@/lib/appointmentStatus'
import { formatCurrency, formatDateTime } from '@/lib/format'
import {
  ADMIN_NOTES_MAX_LENGTH,
  cancelAppointment,
  confirmAppointment,
  getAppointmentById
} from '@/services/appointments'
import { getPackageById } from '@/services/packages'
import type { AppointmentDto, AppointmentStatusChangeDto, PackageDto } from '@/types/api'

/**
 * Appointment detail, with the confirm and cancel actions.
 *
 * @remarks
 * Opened from the `detail` query string entry owned by `@/views/Appointments.vue`, so
 * the panel keeps a shareable link to a single appointment.
 */

/** Action awaiting confirmation. */
type PendingAction = 'confirm' | 'cancel'

const props = defineProps<{
  /** Appointment to display. Null keeps the dialog closed. */
  appointmentId: number | null
}>()

const emit = defineEmits<{
  (event: 'close'): void
  /** Raised after a successful transition, with the appointment as the server left it. */
  (event: 'updated', appointment: AppointmentDto): void
}>()

const appointment = ref<AppointmentDto | null>(null)
const packageDetail = ref<PackageDto | null>(null)
const isLoading = ref(false)
const errorMessage = ref<string | null>(null)

const pendingAction = ref<PendingAction | null>(null)
const adminNotes = ref('')
const isSubmitting = ref(false)
const actionError = ref<string | null>(null)

/** In flight read, aborted whenever the appointment changes. */
let activeController: AbortController | null = null

const isOpen = computed((): boolean => props.appointmentId !== null)

/**
 * Turns a failure into a message for this dialog.
 *
 * @param error - Failure raised by a service.
 * @remarks
 * `ApiError.detail` already carries the message written by the domain, which is what
 * makes the 400 of an invalid transition readable without mapping anything here.
 */
const toMessage = (error: unknown): string =>
  error instanceof ApiError ? error.detail : 'Ocurrió un error inesperado. Intenta de nuevo.'

/**
 * Reads the appointment and, when possible, the package it points at.
 *
 * @param id - Appointment identifier.
 * @remarks
 * A missing package is not a failure: `GET /api/packages/{id}` reads with
 * `onlyActive: true`, so a deactivated package answers 404 while the appointment keeps
 * its `packageName`. The detail degrades to that name.
 */
const load = async (id: number): Promise<void> => {
  activeController?.abort()

  const controller = new AbortController()
  activeController = controller

  isLoading.value = true
  errorMessage.value = null
  packageDetail.value = null

  try {
    const current = await getAppointmentById(id, controller.signal)
    appointment.value = current

    try {
      packageDetail.value = await getPackageById(current.packageId, controller.signal)
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'cancelled') {
        return
      }

      packageDetail.value = null
    }
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'cancelled') {
      return
    }

    appointment.value = null
    errorMessage.value = toMessage(error)
  } finally {
    if (activeController === controller) {
      isLoading.value = false
      activeController = null
    }
  }
}

watch(
  () => props.appointmentId,
  (id) => {
    pendingAction.value = null
    actionError.value = null

    if (id === null) {
      activeController?.abort()
      appointment.value = null
      packageDetail.value = null
      errorMessage.value = null

      return
    }

    void load(id)
  },
  { immediate: true }
)

/**
 * Opens the confirmation step of an action.
 *
 * @param action - Action to confirm.
 * @remarks
 * The notes field starts from the stored notes: the backend overwrites `AdminNotes`
 * with whatever non blank value it receives, so starting empty would look like a way
 * to keep them and starting from them makes the overwrite explicit.
 */
const startAction = (action: PendingAction): void => {
  actionError.value = null
  adminNotes.value = appointment.value?.adminNotes ?? ''
  pendingAction.value = action
}

/** Closes the confirmation step, unless the action is in flight. */
const onPendingOpenChange = (open: boolean): void => {
  if (!open && !isSubmitting.value) {
    pendingAction.value = null
  }
}

/** Applies the pending action. */
const submit = async (): Promise<void> => {
  const id = props.appointmentId
  const action = pendingAction.value

  if (id === null || action === null || isSubmitting.value) {
    return
  }

  const notes = adminNotes.value.trim()
  const change: AppointmentStatusChangeDto = { adminNotes: notes === '' ? null : notes }

  isSubmitting.value = true
  actionError.value = null

  try {
    const updated =
      action === 'confirm'
        ? await confirmAppointment(id, change)
        : await cancelAppointment(id, change)

    appointment.value = updated
    pendingAction.value = null
    emit('updated', updated)
  } catch (error) {
    actionError.value = toMessage(error)

    // A rejected transition or a missing appointment means the panel is looking at a
    // stale status, so the detail is read again to catch up with the server.
    if (error instanceof ApiError && (error.kind === 'validation' || error.kind === 'notFound')) {
      void load(id)
    }
  } finally {
    isSubmitting.value = false
  }
}

/** Copy of the confirmation step, by action. */
const pendingCopy = computed(() => {
  if (appointment.value === null || pendingAction.value === null) {
    return null
  }

  const email = appointment.value.email

  return pendingAction.value === 'confirm'
    ? {
        title: 'Confirmar la cita',
        description: `Se enviará un correo a ${email} avisando que su sesión quedó confirmada.`,
        confirmLabel: 'Confirmar y notificar',
        destructive: false
      }
    : {
        title: 'Cancelar la cita',
        description: `Se enviará un correo a ${email} avisando que su sesión fue cancelada.`,
        confirmLabel: 'Cancelar y notificar',
        destructive: true
      }
})

/** Included items of the package, one per line. */
const packageIncludes = computed((): string[] =>
  (packageDetail.value?.includes ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
)
</script>

<template>
  <Dialog
    :open="isOpen"
    :dismissible="!isSubmitting"
    title="Detalle de la cita"
    description="Información completa de la cita, el paquete solicitado y las acciones disponibles."
    @update:open="(open: boolean) => { if (!open) emit('close') }"
  >
    <div v-if="isLoading" class="py-12 text-center text-muted-foreground">
      <Loader2 :size="20" class="mx-auto mb-2 animate-spin" />
      Cargando la cita…
    </div>

    <p v-else-if="errorMessage !== null" role="alert" class="py-12 text-center text-sm text-destructive">
      {{ errorMessage }}
    </p>

    <div v-else-if="appointment !== null" class="space-y-6">
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="text-base font-semibold">{{ appointment.fullName }}</h2>
        <Badge :variant="presentationOf(appointment.status).variant">
          {{ presentationOf(appointment.status).label }}
        </Badge>
      </div>

      <section class="space-y-2">
        <h3 class="text-sm font-medium text-muted-foreground">Cliente</h3>
        <dl class="grid gap-3 sm:grid-cols-2">
          <div>
            <dt class="text-xs text-muted-foreground">Correo</dt>
            <dd>
              <a class="text-primary underline-offset-4 hover:underline" :href="`mailto:${appointment.email}`">
                {{ appointment.email }}
              </a>
            </dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">Teléfono</dt>
            <dd>
              <a class="text-primary underline-offset-4 hover:underline" :href="`tel:${appointment.phone}`">
                {{ appointment.phone }}
              </a>
            </dd>
          </div>
        </dl>
      </section>

      <section class="space-y-2">
        <h3 class="text-sm font-medium text-muted-foreground">Sesión</h3>
        <dl class="grid gap-3 sm:grid-cols-2">
          <div>
            <dt class="text-xs text-muted-foreground">Fecha solicitada</dt>
            <dd>{{ formatDateTime(appointment.appointmentDate) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">Ubicación</dt>
            <dd>{{ appointment.location ?? '—' }}</dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">Agendada el</dt>
            <dd>{{ formatDateTime(appointment.createdDate) }}</dd>
          </div>
          <div v-if="appointment.confirmedDate !== null">
            <dt class="text-xs text-muted-foreground">Confirmada el</dt>
            <dd>{{ formatDateTime(appointment.confirmedDate) }}</dd>
          </div>
          <div v-if="appointment.cancelledDate !== null">
            <dt class="text-xs text-muted-foreground">Cancelada el</dt>
            <dd>{{ formatDateTime(appointment.cancelledDate) }}</dd>
          </div>
        </dl>
      </section>

      <section class="space-y-2">
        <h3 class="text-sm font-medium text-muted-foreground">Paquete</h3>

        <div class="rounded-md border p-3">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <p class="font-medium">
              {{ packageDetail?.name ?? appointment.packageName ?? '—' }}
            </p>
            <p v-if="packageDetail !== null" class="text-sm font-medium">
              {{ formatCurrency(packageDetail.price, packageDetail.currency) }}
            </p>
          </div>

          <p v-if="packageDetail?.duration" class="mt-1 text-xs text-muted-foreground">
            Duración aproximada: {{ packageDetail.duration }}
          </p>

          <p v-if="packageDetail?.description" class="mt-2 text-sm">
            {{ packageDetail.description }}
          </p>

          <ul v-if="packageIncludes.length > 0" class="mt-2 list-inside list-disc text-sm">
            <li v-for="item in packageIncludes" :key="item">{{ item }}</li>
          </ul>

          <p v-if="packageDetail === null" class="mt-1 text-xs text-muted-foreground">
            El paquete ya no está publicado; sólo se conserva el nombre registrado en la cita.
          </p>
        </div>
      </section>

      <section class="space-y-2">
        <h3 class="text-sm font-medium text-muted-foreground">Notas</h3>
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <p class="text-xs text-muted-foreground">Del cliente</p>
            <p class="whitespace-pre-line text-sm">{{ appointment.notes ?? '—' }}</p>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">Del administrador</p>
            <p class="whitespace-pre-line text-sm">{{ appointment.adminNotes ?? '—' }}</p>
          </div>
        </div>
      </section>
    </div>

    <template #footer>
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <p class="text-xs text-muted-foreground sm:mr-auto">
          Confirmar o cancelar envía un correo al cliente.
        </p>

        <Button
          type="button"
          variant="outline"
          :disabled="appointment === null || !canCancel(appointment.status)"
          @click="startAction('cancel')"
        >
          <CalendarX2 :size="16" class="mr-2" />
          Cancelar cita
        </Button>

        <Button
          type="button"
          :disabled="appointment === null || !canConfirm(appointment.status)"
          @click="startAction('confirm')"
        >
          <CalendarCheck :size="16" class="mr-2" />
          Confirmar cita
        </Button>
      </div>
    </template>
  </Dialog>

  <ConfirmDialog
    v-if="pendingCopy !== null"
    :open="pendingAction !== null"
    :title="pendingCopy.title"
    :description="pendingCopy.description"
    :confirm-label="pendingCopy.confirmLabel"
    :destructive="pendingCopy.destructive"
    :is-busy="isSubmitting"
    :error-message="actionError"
    @update:open="onPendingOpenChange"
    @confirm="submit"
  >
    <div class="space-y-1.5">
      <label for="admin-notes" class="text-sm font-medium">Notas del administrador (opcional)</label>
      <textarea
        id="admin-notes"
        v-model="adminNotes"
        rows="3"
        :maxlength="ADMIN_NOTES_MAX_LENGTH"
        :disabled="isSubmitting"
        class="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
        placeholder="Uso interno. No se incluyen en el correo del cliente."
      ></textarea>
      <p class="text-xs text-muted-foreground">
        {{ adminNotes.length }} / {{ ADMIN_NOTES_MAX_LENGTH }} caracteres. Sólo visibles en el panel.
      </p>
    </div>
  </ConfirmDialog>
</template>