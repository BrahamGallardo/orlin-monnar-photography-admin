<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryValue } from 'vue-router'
import { EyeOff, Loader2, Package, Undo2 } from 'lucide-vue-next'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import CardContent from '@/components/ui/CardContent.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import Pagination from '@/components/ui/Pagination.vue'
import { formatCurrency } from '@/lib/format'
import { ApiError } from '@/lib/http'
import {
  DEFAULT_PAGE_SIZE,
  deactivatePackage,
  getPackages,
  reactivatePackage
} from '@/services/packages'
import type { PackageDto, PaginatedList } from '@/types/api'

/**
 * Photography packages list.
 *
 * @remarks
 * Unpublished packages are hidden by the backend unless `includeDeactivated` is sent,
 * and publishing one again is only reachable from the list, so the flag is a filter of
 * this view rather than a fixed option. `GET /api/packages/{id}` answers 404 for an
 * unpublished package, so any future action on a row must start from the row in memory.
 *
 * The public API does not cache packages: a publication change shows on
 * `investment.html` and in the booking form on their next request.
 */

/** Query string keys owned by this view. */
const QUERY_KEYS = {
  page: 'page',
  deactivated: 'deactivated'
} as const

/** Value written in the query string to include unpublished packages. */
const DEACTIVATED_FLAG = '1'

/** Line separator of `includes`, the same one the landing splits on. */
const INCLUDES_LINE_BREAK = /\r?\n/

/** Action awaiting confirmation. */
type PendingAction = 'deactivate' | 'reactivate'

const route = useRoute()
const router = useRouter()

const page = ref<PaginatedList<PackageDto> | null>(null)
const isLoading = ref(false)
const errorMessage = ref<string | null>(null)

const pending = ref<{ item: PackageDto; action: PendingAction } | null>(null)
const isApplying = ref(false)
const pendingError = ref<string | null>(null)

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

/** One based page index encoded in the query string. */
const pageIndex = computed((): number => {
  const raw = Number.parseInt(readSingle(route.query[QUERY_KEYS.page]) ?? '', 10)

  return Number.isNaN(raw) || raw < 1 ? 1 : raw
})

/** Whether unpublished packages are being listed. */
const includeDeactivated = computed(
  (): boolean => readSingle(route.query[QUERY_KEYS.deactivated]) === DEACTIVATED_FLAG
)

/**
 * Turns a failure into a message for this view.
 *
 * @param error - Failure raised by the service.
 */
const toMessage = (error: unknown): string =>
  error instanceof ApiError ? error.detail : 'Ocurrió un error inesperado. Intenta de nuevo.'

/**
 * Rewrites the query string, dropping empty entries.
 *
 * @param changes - Entries to apply over the current filters.
 * @param mode - Whether the change adds a history entry or replaces the current one.
 * @remarks
 * Changing the visibility filter sends the operator back to the first page: the
 * requested index is meaningless against a different result set.
 */
const applyFilters = (
  changes: { page?: number; deactivated?: boolean },
  mode: 'push' | 'replace' = 'push'
): void => {
  const next: Record<string, string> = {}
  const deactivated = changes.deactivated ?? includeDeactivated.value
  const target = changes.deactivated !== undefined ? 1 : (changes.page ?? pageIndex.value)

  if (deactivated) {
    next[QUERY_KEYS.deactivated] = DEACTIVATED_FLAG
  }

  if (target > 1) {
    next[QUERY_KEYS.page] = String(target)
  }

  const location = { name: 'Packages', query: next }

  void (mode === 'replace' ? router.replace(location) : router.push(location))
}

/**
 * Fetches the page described by the current query string.
 *
 * @remarks
 * A page past the end is clamped to the last one instead of rendered empty. It happens
 * after unpublishing the only package of the last page, and an empty table would claim
 * that no package is published, which is false.
 */
const load = async (): Promise<void> => {
  activeController?.abort()

  const controller = new AbortController()
  activeController = controller

  isLoading.value = true
  errorMessage.value = null

  try {
    const result = await getPackages({
      pageIndex: pageIndex.value,
      pageSize: DEFAULT_PAGE_SIZE,
      includeDeactivated: includeDeactivated.value,
      signal: controller.signal
    })

    if (result.items.length === 0 && result.totalPages > 0 && pageIndex.value > result.totalPages) {
      applyFilters({ page: result.totalPages }, 'replace')

      return
    }

    page.value = result
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
 * Same reason as in `@/views/Gallery.vue`: a getter returning an object would refetch on
 * every unrelated query string change.
 */
const filtersKey = computed((): string =>
  [pageIndex.value, includeDeactivated.value ? DEACTIVATED_FLAG : ''].join('|')
)

watch(filtersKey, () => void load(), { immediate: true })

/**
 * Counts the items listed in `includes`.
 *
 * @param includes - Raw value, one item per line.
 * @remarks
 * Mirrors the landing: split on `\r?\n`, trim and discard blank lines, so the number
 * shown here matches the bullets rendered on `investment.html`.
 */
const countIncludes = (includes: string | null): number =>
  includes === null
    ? 0
    : includes.split(INCLUDES_LINE_BREAK).filter((line) => line.trim() !== '').length

/**
 * Label of the included items count.
 *
 * @param includes - Raw value, one item per line.
 */
const includesLabel = (includes: string | null): string => {
  const count = countIncludes(includes)

  return count === 1 ? '1 concepto' : `${count} conceptos`
}

/* -------------------------------------------------------------------------- */
/* Publish and unpublish                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Opens the confirmation step of a publication change.
 *
 * @param item - Package to act on.
 * @param action - Action to confirm.
 */
const startAction = (item: PackageDto, action: PendingAction): void => {
  pendingError.value = null
  pending.value = { item, action }
}

/** Closes the confirmation step, unless the action is in flight. */
const onPendingOpenChange = (open: boolean): void => {
  if (!open && !isApplying.value) {
    pending.value = null
  }
}

/**
 * Copy of the confirmation step, by action.
 *
 * @remarks
 * `warning` and `notice` are always passed explicitly: this is not the appointments
 * wording, and neither action notifies anyone.
 */
const pendingCopy = computed(() => {
  const current = pending.value

  if (current === null) {
    return null
  }

  return current.action === 'deactivate'
    ? {
        title: 'Despublicar el paquete',
        description:
          `«${current.item.name}» se ocultará del sitio público. No se borra nada y puedes ` +
          'volver a publicarlo cuando quieras.',
        confirmLabel: 'Despublicar',
        warning:
          'Deja de mostrarse al instante en la página Investment y en el formulario de reserva. ' +
          'Si es el último paquete publicado, Investment mostrará los paquetes de referencia.',
        notice: 'Las citas existentes no se afectan: conservan el nombre del paquete.',
        destructive: true
      }
    : {
        title: 'Publicar el paquete',
        description: `«${current.item.name}» volverá a estar disponible en el sitio público.`,
        confirmLabel: 'Publicar',
        warning: null,
        notice:
          'Se mostrará al instante en la página Investment y en el formulario de reserva.',
        destructive: false
      }
})

/** Applies the pending publication change. */
const submitAction = async (): Promise<void> => {
  const current = pending.value

  if (current === null || isApplying.value) {
    return
  }

  isApplying.value = true
  pendingError.value = null

  try {
    if (current.action === 'deactivate') {
      await deactivatePackage(current.item.id)
    } else {
      await reactivatePackage(current.item.id)
    }

    pending.value = null
    await load()
  } catch (error) {
    pendingError.value = toMessage(error)

    // A 404 means the panel is looking at a stale list, so it catches up with the server.
    if (error instanceof ApiError && error.kind === 'notFound') {
      await load()
    }
  } finally {
    isApplying.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-xl font-bold tracking-tight">Paquetes</h1>
      <p class="text-muted-foreground">
        Administra los paquetes publicados en la página Investment y en el formulario de reserva.
      </p>
    </div>

    <Card>
      <CardContent class="flex flex-wrap items-center gap-3 p-4">
        <label class="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            class="h-4 w-4 rounded border-input"
            :checked="includeDeactivated"
            @change="applyFilters({ deactivated: ($event.target as HTMLInputElement).checked })"
          />
          Mostrar despublicados
        </label>

        <p class="text-xs text-muted-foreground">
          Un paquete despublicado no se ofrece en el sitio; las citas que ya lo usan no cambian.
        </p>
      </CardContent>
    </Card>

    <Card>
      <CardContent class="p-0">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="border-b bg-muted/50 text-left">
              <tr>
                <th scope="col" class="px-4 py-3 font-medium">Orden</th>
                <th scope="col" class="px-4 py-3 font-medium">Nombre</th>
                <th scope="col" class="px-4 py-3 font-medium">Duración</th>
                <th scope="col" class="px-4 py-3 text-right font-medium">Precio</th>
                <th scope="col" class="px-4 py-3 font-medium">Incluye</th>
                <th scope="col" class="px-4 py-3 font-medium">Estado</th>
                <th scope="col" class="px-4 py-3 text-right font-medium">Acciones</th>
              </tr>
            </thead>

            <tbody>
              <tr v-if="isLoading">
                <td colspan="7" class="px-4 py-12 text-center text-muted-foreground">
                  <Loader2 :size="20" class="mx-auto mb-2 animate-spin" />
                  Cargando paquetes…
                </td>
              </tr>

              <tr v-else-if="errorMessage !== null">
                <td colspan="7" class="px-4 py-12 text-center">
                  <p role="alert" class="text-sm text-destructive">{{ errorMessage }}</p>
                  <Button type="button" variant="outline" size="sm" class="mt-3" @click="load">
                    Reintentar
                  </Button>
                </td>
              </tr>

              <tr v-else-if="page === null || page.totalCount === 0">
                <td colspan="7" class="px-4 py-12 text-center text-muted-foreground">
                  <Package :size="24" class="mx-auto mb-2" />
                  <p>
                    {{
                      includeDeactivated
                        ? 'Todavía no hay paquetes registrados.'
                        : 'No hay paquetes publicados. Activa «Mostrar despublicados» para ver los ocultos.'
                    }}
                  </p>
                  <p class="mt-1 text-xs">
                    Mientras no haya paquetes publicados, la página Investment muestra paquetes de
                    referencia.
                  </p>
                </td>
              </tr>

              <template v-else>
                <tr
                  v-for="item in page.items"
                  :key="item.id"
                  class="border-b last:border-b-0 hover:bg-accent/50"
                >
                  <td class="px-4 py-3">{{ item.displayOrder }}</td>

                  <td class="px-4 py-3">
                    <p class="font-medium">{{ item.name }}</p>
                    <p
                      v-if="item.description"
                      class="max-w-xs truncate text-xs text-muted-foreground"
                    >
                      {{ item.description }}
                    </p>
                  </td>

                  <td class="px-4 py-3">{{ item.duration ?? '—' }}</td>

                  <td class="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                    {{ formatCurrency(item.price, item.currency) }}
                  </td>

                  <td class="px-4 py-3 text-muted-foreground">{{ includesLabel(item.includes) }}</td>

                  <td class="px-4 py-3">
                    <Badge :variant="item.activated ? 'success' : 'muted'">
                      {{ item.activated ? 'Publicado' : 'Despublicado' }}
                    </Badge>
                  </td>

                  <td class="px-4 py-3">
                    <div class="flex justify-end gap-1">
                      <Button
                        v-if="item.activated"
                        type="button"
                        variant="ghost"
                        size="sm"
                        :aria-label="`Despublicar ${item.name}`"
                        @click="startAction(item, 'deactivate')"
                      >
                        <EyeOff :size="16" class="mr-2" />
                        Despublicar
                      </Button>

                      <Button
                        v-else
                        type="button"
                        variant="ghost"
                        size="sm"
                        :aria-label="`Publicar ${item.name}`"
                        @click="startAction(item, 'reactivate')"
                      >
                        <Undo2 :size="16" class="mr-2" />
                        Publicar
                      </Button>
                    </div>
                  </td>
                </tr>
              </template>
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
      singular-label="paquete"
      plural-label="paquetes"
      @change="applyFilters({ page: $event })"
    />

    <ConfirmDialog
      v-if="pendingCopy !== null"
      :open="pending !== null"
      :title="pendingCopy.title"
      :description="pendingCopy.description"
      :confirm-label="pendingCopy.confirmLabel"
      :warning="pendingCopy.warning"
      :notice="pendingCopy.notice"
      :destructive="pendingCopy.destructive"
      :is-busy="isApplying"
      :error-message="pendingError"
      @update:open="onPendingOpenChange"
      @confirm="submitAction"
    />
  </div>
</template>
