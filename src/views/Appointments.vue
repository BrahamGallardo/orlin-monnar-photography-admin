<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryValue } from 'vue-router'
import { CalendarX2, Eye, Loader2, RotateCcw } from 'lucide-vue-next'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import CardContent from '@/components/ui/CardContent.vue'
import Pagination from '@/components/ui/Pagination.vue'
import { ApiError } from '@/lib/http'
import { formatDateTime } from '@/lib/format'
import { APPOINTMENT_STATUSES, DEFAULT_PAGE_SIZE, getAppointments } from '@/services/appointments'
import type { AppointmentDto, AppointmentStatus, PaginatedList } from '@/types/api'

/**
 * Appointments list.
 *
 * @remarks
 * Status and date range compose: `GET /api/admin/appointments` takes both as optional
 * query string entries. The range is sent only when both ends are captured and the end
 * is not earlier than the start; the controller answers 400 otherwise, so the view
 * withholds an unusable range and keeps applying the status.
 */

/** Query string keys owned by this view. */
const QUERY_KEYS = {
  status: 'status',
  from: 'from',
  to: 'to',
  page: 'page',
  detail: 'detail'
} as const

/** Matches the `yyyy-MM-dd` value produced by an `input[type=date]`. */
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Spanish labels and badge variants, by status. */
const STATUS_PRESENTATION: Record<
  AppointmentStatus,
  { label: string; variant: 'default' | 'success' | 'warning' | 'destructive' }
> = {
  Pending: { label: 'Pendiente', variant: 'warning' },
  Confirmed: { label: 'Confirmada', variant: 'success' },
  Cancelled: { label: 'Cancelada', variant: 'destructive' },
  Completed: { label: 'Completada', variant: 'default' }
}

/** Filters as read from the query string. */
interface AppointmentFilters {
  status: AppointmentStatus | null
  /** Local `yyyy-MM-dd` start of the range, as captured by the user. */
  from: string | null
  /** Local `yyyy-MM-dd` end of the range, as captured by the user. */
  to: string | null
  pageIndex: number
}

const route = useRoute()
const router = useRouter()

const page = ref<PaginatedList<AppointmentDto> | null>(null)
const isLoading = ref(false)
const errorMessage = ref<string | null>(null)

/** In flight request, aborted whenever the filters change. */
let activeController: AbortController | null = null

/**
 * Reads a single query string entry.
 *
 * @param value - Raw entry, which may repeat.
 */
const readSingle = (value: LocationQueryValue | LocationQueryValue[]): string | null => {
  const raw = Array.isArray(value) ? value[0] : value

  return typeof raw === 'string' && raw !== '' ? raw : null
}

/**
 * Narrows a raw query string value to a known status.
 *
 * @param value - Raw entry.
 */
const readStatus = (value: LocationQueryValue | LocationQueryValue[]): AppointmentStatus | null => {
  const raw = readSingle(value)

  return APPOINTMENT_STATUSES.find((status) => status === raw) ?? null
}

/**
 * Narrows a raw query string value to a local date.
 *
 * @param value - Raw entry.
 */
const readLocalDate = (value: LocationQueryValue | LocationQueryValue[]): string | null => {
  const raw = readSingle(value)

  return raw !== null && LOCAL_DATE_PATTERN.test(raw) ? raw : null
}

/** Filters currently encoded in the URL. */
const filters = computed((): AppointmentFilters => {
  const rawPage = Number.parseInt(readSingle(route.query[QUERY_KEYS.page]) ?? '', 10)

  return {
    status: readStatus(route.query[QUERY_KEYS.status]),
    from: readLocalDate(route.query[QUERY_KEYS.from]),
    to: readLocalDate(route.query[QUERY_KEYS.to]),
    pageIndex: Number.isNaN(rawPage) || rawPage < 1 ? 1 : rawPage
  }
})

/** Whether both ends of the range are present and correctly ordered. */
const hasUsableRange = computed((): boolean => {
  const { from, to } = filters.value

  return from !== null && to !== null && from <= to
})

/** Message shown when the captured range cannot be sent to the backend. */
const rangeWarning = computed((): string | null => {
  const { from, to } = filters.value

  if (from === null && to === null) {
    return null
  }

  if (from === null || to === null) {
    return 'Captura ambas fechas para aplicar el filtro por rango.'
  }

  return from > to ? 'La fecha final debe ser posterior a la inicial.' : null
})

/** Whether any filter is active. */
const hasFilters = computed(
  (): boolean =>
    filters.value.status !== null || filters.value.from !== null || filters.value.to !== null
)

/**
 * Start of a local day, as an instant.
 *
 * @param value - Local `yyyy-MM-dd` date.
 * @remarks
 * The `Date` is built from local parts on purpose: the user picks a calendar day in
 * their own timezone and `toISOString` later shifts it to the UTC instant the backend
 * compares against.
 */
const startOfLocalDay = (value: string): Date => {
  const [year, month, day] = value.split('-').map(Number)

  return new Date(year, month - 1, day, 0, 0, 0, 0)
}

/**
 * End of a local day, as an instant.
 *
 * @param value - Local `yyyy-MM-dd` date.
 * @remarks Inclusive, so an appointment booked late in the day still matches.
 */
const endOfLocalDay = (value: string): Date => {
  const [year, month, day] = value.split('-').map(Number)

  return new Date(year, month - 1, day, 23, 59, 59, 999)
}

/**
 * Fetches the page described by the active filters.
 *
 * @param current - Filters to apply.
 * @param signal - Abort signal of the request.
 */
const fetchPage = (
  current: AppointmentFilters,
  signal: AbortSignal
): Promise<PaginatedList<AppointmentDto>> =>
  getAppointments({
    pageIndex: current.pageIndex,
    pageSize: DEFAULT_PAGE_SIZE,
    signal,
    status: current.status,
    startDate: hasUsableRange.value ? startOfLocalDay(current.from as string) : null,
    endDate: hasUsableRange.value ? endOfLocalDay(current.to as string) : null
  })

/**
 * Turns a failure into a message for this view.
 *
 * @param error - Failure raised by the service.
 */
const toMessage = (error: unknown): string =>
  error instanceof ApiError ? error.detail : 'Ocurrió un error inesperado. Intenta de nuevo.'

/** Fetches the page described by the current query string. */
const load = async (): Promise<void> => {
  activeController?.abort()

  const controller = new AbortController()
  activeController = controller

  isLoading.value = true
  errorMessage.value = null

  try {
    page.value = await fetchPage(filters.value, controller.signal)
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'cancelled') {
      return
    }

    page.value = null
    errorMessage.value = toMessage(error)
  } finally {
    if (activeController === controller) {
      isLoading.value = false
      activeController = null
    }
  }
}

/**
 * Serialized filters, used as the watch key.
 *
 * @remarks
 * A getter returning the object itself would refetch on every unrelated query string
 * change, since Vue compares the result by identity.
 */
const filtersKey = computed((): string =>
  [
    filters.value.status ?? '',
    filters.value.from ?? '',
    filters.value.to ?? '',
    filters.value.pageIndex
  ].join('|')
)

watch(filtersKey, () => void load(), { immediate: true })

/**
 * Rewrites the query string, dropping empty entries.
 *
 * @param changes - Entries to apply over the current filters.
 * @remarks
 * Any change other than the page itself sends the user back to the first page: the
 * requested index is meaningless against a different result set.
 */
const applyFilters = (changes: Partial<Record<keyof typeof QUERY_KEYS, string | null>>): void => {
  const next: Record<string, string> = {}
  const merged = {
    status: changes.status !== undefined ? changes.status : filters.value.status,
    from: changes.from !== undefined ? changes.from : filters.value.from,
    to: changes.to !== undefined ? changes.to : filters.value.to,
    page: changes.page !== undefined ? changes.page : String(filters.value.pageIndex)
  }

  const resetsPage = changes.page === undefined

  if (merged.status !== null && merged.status !== '') {
    next[QUERY_KEYS.status] = merged.status
  }

  if (merged.from !== null && merged.from !== '') {
    next[QUERY_KEYS.from] = merged.from
  }

  if (merged.to !== null && merged.to !== '') {
    next[QUERY_KEYS.to] = merged.to
  }

  if (!resetsPage && merged.page !== null && merged.page !== '1') {
    next[QUERY_KEYS.page] = merged.page
  }

  void router.push({ name: 'Appointments', query: next })
}

/**
 * Reads the value of a native control event.
 *
 * @param event - Change event of a select or an input.
 */
const readControlValue = (event: Event): string =>
  (event.target as HTMLSelectElement | HTMLInputElement).value

/**
 * Opens the detail of an appointment.
 *
 * @param id - Appointment identifier.
 * @remarks
 * The detail view belongs to the next task. Leaving the identifier in the query string
 * keeps the link shareable and gives that task its entry point, without adding a route
 * that does not exist yet.
 */
const viewDetail = (id: number): void => {
  void router.push({
    name: 'Appointments',
    query: { ...route.query, [QUERY_KEYS.detail]: String(id) }
  })
}

/** Presentation of a status, falling back for a value the panel does not know. */
const presentationOf = (status: AppointmentStatus) =>
  STATUS_PRESENTATION[status] ?? { label: status, variant: 'default' as const }
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-xl font-bold tracking-tight">Citas</h1>
      <p class="text-muted-foreground">Consulta y filtra las citas agendadas.</p>
    </div>

    <Card>
      <CardContent class="flex flex-col gap-4 p-4 lg:flex-row lg:items-end">
        <div class="space-y-1.5 lg:w-56">
          <label for="status-filter" class="text-sm font-medium">Estatus</label>
          <select
            id="status-filter"
            :value="filters.status ?? ''"
            class="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            @change="applyFilters({ status: readControlValue($event) })"
          >
            <option value="">Todos</option>
            <option v-for="status in APPOINTMENT_STATUSES" :key="status" :value="status">
              {{ presentationOf(status).label }}
            </option>
          </select>
        </div>

        <div class="space-y-1.5 lg:w-48">
          <label for="from-filter" class="text-sm font-medium">Desde</label>
          <input
            id="from-filter"
            type="date"
            :value="filters.from ?? ''"
            class="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            @change="applyFilters({ from: readControlValue($event) })"
          />
        </div>

        <div class="space-y-1.5 lg:w-48">
          <label for="to-filter" class="text-sm font-medium">Hasta</label>
          <input
            id="to-filter"
            type="date"
            :value="filters.to ?? ''"
            class="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            @change="applyFilters({ to: readControlValue($event) })"
          />
        </div>

        <Button
          v-if="hasFilters"
          type="button"
          variant="ghost"
          @click="applyFilters({ status: null, from: null, to: null })"
        >
          <RotateCcw :size="16" class="mr-2" />
          Limpiar
        </Button>
      </CardContent>

      <CardContent v-if="rangeWarning !== null" class="px-4 pb-4 pt-0">
        <p class="text-xs text-amber-700">{{ rangeWarning }}</p>
      </CardContent>
    </Card>

    <Card>
      <CardContent class="p-0">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="border-b bg-muted/50 text-left">
              <tr>
                <th scope="col" class="px-4 py-3 font-medium">Cliente</th>
                <th scope="col" class="px-4 py-3 font-medium">Contacto</th>
                <th scope="col" class="px-4 py-3 font-medium">Paquete</th>
                <th scope="col" class="px-4 py-3 font-medium">Fecha</th>
                <th scope="col" class="px-4 py-3 font-medium">Estatus</th>
                <th scope="col" class="px-4 py-3 text-right font-medium">Acciones</th>
              </tr>
            </thead>

            <tbody>
              <tr v-if="isLoading">
                <td colspan="6" class="px-4 py-12 text-center text-muted-foreground">
                  <Loader2 :size="20" class="mx-auto mb-2 animate-spin" />
                  Cargando citas…
                </td>
              </tr>

              <tr v-else-if="errorMessage !== null">
                <td colspan="6" class="px-4 py-12 text-center">
                  <p role="alert" class="text-sm text-destructive">{{ errorMessage }}</p>
                  <Button type="button" variant="outline" size="sm" class="mt-3" @click="load">
                    Reintentar
                  </Button>
                </td>
              </tr>

              <tr v-else-if="page === null || page.items.length === 0">
                <td colspan="6" class="px-4 py-12 text-center text-muted-foreground">
                  <CalendarX2 :size="24" class="mx-auto mb-2" />
                  {{
                    hasFilters
                      ? 'No hay citas que coincidan con los filtros.'
                      : 'Todavía no hay citas agendadas.'
                  }}
                </td>
              </tr>

              <tr
                v-for="appointment in page?.items ?? []"
                v-else
                :key="appointment.id"
                class="border-b last:border-b-0 hover:bg-accent/50"
              >
                <td class="px-4 py-3 font-medium">{{ appointment.fullName }}</td>
                <td class="px-4 py-3">
                  <p>{{ appointment.email }}</p>
                  <p class="text-xs text-muted-foreground">{{ appointment.phone }}</p>
                </td>
                <td class="px-4 py-3">{{ appointment.packageName ?? '—' }}</td>
                <td class="px-4 py-3 whitespace-nowrap">
                  {{ formatDateTime(appointment.appointmentDate) }}
                </td>
                <td class="px-4 py-3">
                  <Badge :variant="presentationOf(appointment.status).variant">
                    {{ presentationOf(appointment.status).label }}
                  </Badge>
                </td>
                <td class="px-4 py-3 text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    :aria-label="`Ver detalle de la cita de ${appointment.fullName}`"
                    @click="viewDetail(appointment.id)"
                  >
                    <Eye :size="16" class="mr-2" />
                    Ver detalle
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>

    <Pagination
      v-if="page !== null && page.totalPages > 1"
      :page-index="page.pageIndex"
      :total-pages="page.totalPages"
      :total-count="page.totalCount"
      :page-size="page.pageSize"
      :has-previous-page="page.hasPreviousPage"
      :has-next-page="page.hasNextPage"
      :disabled="isLoading"
      @change="applyFilters({ page: String($event) })"
    />
  </div>
</template>