<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, type Component } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import Card from '@/components/ui/Card.vue'
import CardHeader from '@/components/ui/CardHeader.vue'
import CardTitle from '@/components/ui/CardTitle.vue'
import CardContent from '@/components/ui/CardContent.vue'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import { CalendarCheck, CalendarClock, FolderOpen, Images, Mail } from 'lucide-vue-next'
import { Bar } from 'vue-chartjs'
import {
  Chart as ChartJS,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  type ChartData,
  type ChartOptions
} from 'chart.js'
import { ApiError } from '@/lib/http'
import { formatDateTime } from '@/lib/format'
import { presentationOf } from '@/lib/appointmentStatus'
import {
  APPOINTMENT_STATUSES,
  getAppointments,
  getUpcomingAppointments
} from '@/services/appointments'
import { getAllGalleryCategories } from '@/services/gallery'
import { getContactMessagesByStatus } from '@/services/contactMessages'
import type { AppointmentDto, AppointmentStatus } from '@/types/api'

ChartJS.register(BarElement, CategoryScale, LinearScale, Tooltip)

/** Number of upcoming appointments listed. The backend clamps it to 1..50. */
const UPCOMING_TAKE = 5

/**
 * Query string key that opens the appointment detail in `Appointments.vue`.
 *
 * @remarks Mirrors `QUERY_KEYS.detail` of that view, which cannot export it.
 */
const DETAIL_QUERY_KEY = 'detail'

/** State of one independent dashboard query. */
interface CardQuery<T> {
  data: T | null
  errorMessage: string | null
  isLoading: boolean
  /** Runs the query again, aborting a previous run still in flight. */
  load: () => Promise<void>
}

/** Totals derived from the published gallery. */
interface GallerySummary {
  categoryCount: number
  photoCount: number
}

/** Controllers still in flight, aborted when the view unmounts. */
const inFlight = new Set<AbortController>()

/**
 * Turns a failure into a message for a card.
 *
 * @param error - Failure raised by a service.
 */
const toMessage = (error: unknown): string =>
  error instanceof ApiError ? error.detail : 'Ocurrió un error inesperado. Intenta de nuevo.'

/**
 * Wraps a fetcher in its own loading and error state.
 *
 * @param fetcher - Service call receiving the signal of the run.
 * @remarks
 * Every card owns one of these, so a failing request only empties its own card and the
 * rest of the view keeps rendering. Returned as a `reactive` object so the template
 * unwraps its members when it is reached through a nested property.
 */
function useCardQuery<T>(fetcher: (signal: AbortSignal) => Promise<T>): CardQuery<T> {
  let active: AbortController | null = null

  const state = reactive({
    data: null,
    errorMessage: null,
    isLoading: true,
    load: async (): Promise<void> => {
      active?.abort()

      const controller = new AbortController()
      active = controller
      inFlight.add(controller)

      state.isLoading = true
      state.errorMessage = null

      try {
        state.data = await fetcher(controller.signal)
      } catch (error) {
        if (error instanceof ApiError && error.kind === 'cancelled') {
          return
        }

        state.data = null
        state.errorMessage = toMessage(error)
      } finally {
        inFlight.delete(controller)

        if (active === controller) {
          state.isLoading = false
          active = null
        }
      }
    }
  }) as CardQuery<T>

  return state
}

/**
 * Reads how many appointments are in a status, optionally inside a date range.
 *
 * @param status - Status to count.
 * @param signal - Signal of the run.
 * @param range - Inclusive local range, or null for every date.
 * @remarks A single item page is enough: only `totalCount` is read.
 */
async function countAppointments(
  status: AppointmentStatus,
  signal: AbortSignal,
  range: { start: Date; end: Date } | null = null
): Promise<number> {
  const page = await getAppointments({
    status,
    startDate: range?.start ?? null,
    endDate: range?.end ?? null,
    pageIndex: 1,
    pageSize: 1,
    signal
  })

  return page.totalCount
}

/**
 * Bounds of the current month in the local timezone, as instants.
 *
 * @remarks
 * Built from local parts, like the range filter of `Appointments.vue`, so `toISOString`
 * later shifts them to the UTC instants the backend compares against. The end is
 * inclusive.
 */
function currentLocalMonth(): { start: Date; end: Date } {
  const now = new Date()

  return {
    start: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0),
    end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
  }
}

const pendingQuery = useCardQuery((signal) => countAppointments('Pending', signal))

const confirmedThisMonthQuery = useCardQuery((signal) =>
  countAppointments('Confirmed', signal, currentLocalMonth())
)

const galleryQuery = useCardQuery(async (signal): Promise<GallerySummary> => {
  const categories = await getAllGalleryCategories(signal)

  return {
    categoryCount: categories.length,
    photoCount: categories.reduce((total, category) => total + category.photoCount, 0)
  }
})

const pendingMessagesQuery = useCardQuery(async (signal) => {
  const page = await getContactMessagesByStatus('Pending', { pageIndex: 1, pageSize: 1, signal })

  return page.totalCount
})

const upcomingQuery = useCardQuery((signal): Promise<AppointmentDto[]> =>
  getUpcomingAppointments(UPCOMING_TAKE, signal)
)

const statusCountsQuery = useCardQuery(
  async (signal): Promise<Record<AppointmentStatus, number>> => {
    const counts = await Promise.all(
      APPOINTMENT_STATUSES.map((status) => countAppointments(status, signal))
    )

    return Object.fromEntries(
      APPOINTMENT_STATUSES.map((status, index) => [status, counts[index]])
    ) as Record<AppointmentStatus, number>
  }
)

/** One total tile. */
interface Tile {
  key: string
  title: string
  icon: Component
  query: CardQuery<unknown>
  value: number | null
  hint: string
}

const tiles = computed((): Tile[] => [
  {
    key: 'pending',
    title: 'Citas pendientes',
    icon: CalendarClock,
    query: pendingQuery,
    value: pendingQuery.data,
    hint: 'Esperan confirmación'
  },
  {
    key: 'confirmed-month',
    title: 'Confirmadas del mes',
    icon: CalendarCheck,
    query: confirmedThisMonthQuery,
    value: confirmedThisMonthQuery.data,
    hint: 'Sesiones programadas este mes'
  },
  {
    key: 'categories',
    title: 'Categorías publicadas',
    icon: FolderOpen,
    query: galleryQuery,
    value: galleryQuery.data?.categoryCount ?? null,
    hint: 'Visibles en la galería'
  },
  {
    key: 'photos',
    title: 'Fotos totales',
    icon: Images,
    query: galleryQuery,
    value: galleryQuery.data?.photoCount ?? null,
    hint: 'En categorías publicadas'
  },
  {
    key: 'messages',
    title: 'Mensajes pendientes',
    icon: Mail,
    query: pendingMessagesQuery,
    value: pendingMessagesQuery.data,
    hint: 'Contacto sin responder'
  }
])

/**
 * Primary color of the theme, read from the design tokens.
 *
 * @remarks
 * Chart.js paints on a canvas, so it cannot use the Tailwind classes; the `--primary`
 * token holds a bare HSL triplet.
 */
const primaryColor = `hsl(${getComputedStyle(document.documentElement)
  .getPropertyValue('--primary')
  .trim()})`

const hasAppointments = computed((): boolean =>
  statusCountsQuery.data === null
    ? false
    : APPOINTMENT_STATUSES.some((status) => (statusCountsQuery.data?.[status] ?? 0) > 0)
)

const statusChartData = computed<ChartData<'bar'>>(() => ({
  labels: APPOINTMENT_STATUSES.map((status) => presentationOf(status).label),
  datasets: [
    {
      label: 'Citas',
      data: APPOINTMENT_STATUSES.map((status) => statusCountsQuery.data?.[status] ?? 0),
      backgroundColor: primaryColor,
      borderRadius: 4,
      maxBarThickness: 48
    }
  ]
}))

const statusChartOptions: ChartOptions<'bar'> = {
  responsive: true,
  maintainAspectRatio: false,
  scales: {
    x: { grid: { display: false } },
    y: { beginAtZero: true, ticks: { precision: 0 } }
  }
}

/**
 * Route that opens the detail of an appointment.
 *
 * @param id - Appointment identifier.
 */
const detailRoute = (id: number): RouteLocationRaw => ({
  name: 'Appointments',
  query: { [DETAIL_QUERY_KEY]: String(id) }
})

onMounted(() => {
  void pendingQuery.load()
  void confirmedThisMonthQuery.load()
  void galleryQuery.load()
  void pendingMessagesQuery.load()
  void upcomingQuery.load()
  void statusCountsQuery.load()
})

onBeforeUnmount(() => {
  inFlight.forEach((controller) => controller.abort())
  inFlight.clear()
})
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-xl font-bold tracking-tight">Dashboard</h1>
      <p class="text-muted-foreground">Resumen de citas, galería y contacto</p>
    </div>

    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      <Card v-for="tile in tiles" :key="tile.key">
        <CardHeader class="flex flex-row items-center justify-between pb-2">
          <CardTitle class="text-sm font-medium">{{ tile.title }}</CardTitle>
          <component :is="tile.icon" class="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div
            v-if="tile.query.isLoading"
            class="h-8 w-16 animate-pulse rounded bg-muted"
            aria-hidden="true"
          />
          <div v-else-if="tile.query.errorMessage !== null" class="space-y-1">
            <p class="text-xs text-destructive">{{ tile.query.errorMessage }}</p>
            <Button variant="link" size="sm" class="h-auto p-0" @click="tile.query.load()">
              Reintentar
            </Button>
          </div>
          <template v-else>
            <div class="text-2xl font-bold">{{ tile.value ?? '—' }}</div>
            <p class="text-xs text-muted-foreground">{{ tile.hint }}</p>
          </template>
        </CardContent>
      </Card>
    </div>

    <div class="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader class="flex flex-row items-center justify-between">
          <CardTitle>Próximas citas</CardTitle>
          <RouterLink :to="{ name: 'Appointments' }" class="text-sm text-primary hover:underline">
            Ver todas
          </RouterLink>
        </CardHeader>
        <CardContent>
          <div v-if="upcomingQuery.isLoading" class="space-y-3" aria-hidden="true">
            <div v-for="n in 3" :key="n" class="h-10 animate-pulse rounded bg-muted" />
          </div>
          <div v-else-if="upcomingQuery.errorMessage !== null" class="space-y-1">
            <p class="text-sm text-destructive">{{ upcomingQuery.errorMessage }}</p>
            <Button variant="link" size="sm" class="h-auto p-0" @click="upcomingQuery.load()">
              Reintentar
            </Button>
          </div>
          <p
            v-else-if="(upcomingQuery.data ?? []).length === 0"
            class="text-sm text-muted-foreground"
          >
            No hay citas próximas.
          </p>
          <ul v-else class="divide-y">
            <li v-for="appointment in upcomingQuery.data" :key="appointment.id">
              <RouterLink
                :to="detailRoute(appointment.id)"
                class="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-3 hover:bg-muted/50"
              >
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium">{{ appointment.fullName }}</p>
                  <p class="truncate text-xs text-muted-foreground">
                    {{ appointment.packageName ?? 'Paquete no disponible' }}
                  </p>
                </div>
                <div class="flex shrink-0 flex-col items-end gap-1">
                  <p class="text-xs">{{ formatDateTime(appointment.appointmentDate) }}</p>
                  <Badge :variant="presentationOf(appointment.status).variant">
                    {{ presentationOf(appointment.status).label }}
                  </Badge>
                </div>
              </RouterLink>
            </li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Citas por estatus</CardTitle>
        </CardHeader>
        <CardContent>
          <div
            v-if="statusCountsQuery.isLoading"
            class="h-[300px] animate-pulse rounded bg-muted"
            aria-hidden="true"
          />
          <div
            v-else-if="statusCountsQuery.errorMessage !== null"
            class="flex h-[300px] flex-col items-center justify-center gap-1"
          >
            <p class="text-sm text-destructive">{{ statusCountsQuery.errorMessage }}</p>
            <Button variant="link" size="sm" class="h-auto p-0" @click="statusCountsQuery.load()">
              Reintentar
            </Button>
          </div>
          <p
            v-else-if="!hasAppointments"
            class="flex h-[300px] items-center justify-center text-sm text-muted-foreground"
          >
            Aún no hay citas registradas.
          </p>
          <div v-else class="h-[300px]">
            <Bar :data="statusChartData" :options="statusChartOptions" />
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
