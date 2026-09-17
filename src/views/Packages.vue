<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryValue } from 'vue-router'
import { EyeOff, Loader2, Package, Pencil, Plus, Undo2 } from 'lucide-vue-next'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import CardContent from '@/components/ui/CardContent.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import Dialog from '@/components/ui/Dialog.vue'
import Pagination from '@/components/ui/Pagination.vue'
import { formatCurrency } from '@/lib/format'
import { ApiError, type FieldErrors } from '@/lib/http'
import {
  DEFAULT_PACKAGE_CURRENCY,
  DEFAULT_PAGE_SIZE,
  PACKAGE_CURRENCY_LENGTH,
  PACKAGE_DESCRIPTION_MAX_LENGTH,
  PACKAGE_DURATION_MAX_LENGTH,
  PACKAGE_INCLUDES_MAX_LENGTH,
  PACKAGE_NAME_MAX_LENGTH,
  PACKAGE_PRICE_DECIMALS,
  PACKAGE_PRICE_MAX,
  createPackage,
  deactivatePackage,
  getPackages,
  reactivatePackage,
  updatePackage,
  type PackagePayload
} from '@/services/packages'
import type { PackageDto, PaginatedList } from '@/types/api'

/**
 * Photography packages list.
 *
 * @remarks
 * Unpublished packages are hidden by the backend unless `includeDeactivated` is sent,
 * and publishing one again is only reachable from the list, so the flag is a filter of
 * this view rather than a fixed option. `GET /api/packages/{id}` answers 404 for an
 * unpublished package, so the edit form starts from the row in memory.
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

/** Currencies offered by the form. A package stored with another one keeps it as an extra option. */
const CURRENCY_OPTIONS: readonly string[] = [DEFAULT_PACKAGE_CURRENCY, 'MXN']

/** Highest `DisplayOrder` the backend can bind: the upper bound of a .NET `int`. */
const DISPLAY_ORDER_MAX = 2147483647

/** Accepted price text: digits, optionally followed by up to {@link PACKAGE_PRICE_DECIMALS} decimals. */
const PRICE_PATTERN = new RegExp(`^\\d+(?:\\.\\d{1,${PACKAGE_PRICE_DECIMALS}})?$`)

/** Price text carrying more decimals than the `decimal(18,2)` column keeps. */
const PRICE_EXCESS_DECIMALS_PATTERN = new RegExp(`^\\d*\\.\\d{${PACKAGE_PRICE_DECIMALS + 1},}$`)

/** Action awaiting confirmation. */
type PendingAction = 'deactivate' | 'reactivate'

/** Fields of the form that can carry their own message. */
type FormField =
  | 'name'
  | 'duration'
  | 'price'
  | 'currency'
  | 'displayOrder'
  | 'description'
  | 'includes'

/**
 * Backend property names, lower cased, mapped to the form fields.
 *
 * @remarks
 * `ValidationProblemDetails` keys are not camelCase: data annotation failures use the C#
 * property name (`Name`) and body binding failures use a JSON path (`$.displayOrder`).
 * Keys are reduced to their last segment and lower cased before the lookup.
 */
const SERVER_FIELD_MAP: Readonly<Record<string, FormField>> = {
  name: 'name',
  duration: 'duration',
  price: 'price',
  currency: 'currency',
  displayorder: 'displayOrder',
  description: 'description',
  includes: 'includes'
}

/** Editable fields of a package, as captured in the dialog. */
interface PackageForm {
  /** Identifier being edited. Null while creating a package. */
  id: number | null
  name: string
  duration: string
  /** Price as typed. Kept as text so its decimals are checked before any rounding. */
  price: string
  currency: string
  /** Currency the package was stored with, kept as an option even when not offered. */
  originalCurrency: string
  displayOrder: number
  description: string
  includes: string
  /** Publication state of the package, sent back untouched. */
  activated: boolean
}

const route = useRoute()
const router = useRouter()

const page = ref<PaginatedList<PackageDto> | null>(null)
const isLoading = ref(false)
const errorMessage = ref<string | null>(null)

const form = ref<PackageForm | null>(null)
const isSaving = ref(false)
const formError = ref<string | null>(null)
const fieldErrors = ref<Partial<Record<FormField, string>>>({})

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
 * Splits `includes` into the items the landing renders.
 *
 * @param includes - Raw value, one item per line.
 * @remarks
 * Same rule as `includesList` in `investmentPage.js`: split on `\r?\n`, trim every line
 * and discard the blank ones. The table count and the form preview both read from here,
 * so neither can drift from `investment.html`.
 */
const toIncludesList = (includes: string | null): string[] =>
  (includes ?? '')
    .split(INCLUDES_LINE_BREAK)
    .map((line) => line.trim())
    .filter((line) => line !== '')

/**
 * Counts the items listed in `includes`.
 *
 * @param includes - Raw value, one item per line.
 */
const countIncludes = (includes: string | null): number => toIncludesList(includes).length

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
/* Create and edit                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Opens the form on a new package.
 *
 * @remarks
 * The order starts at the listed `totalCount` so the new package lands last instead of
 * tying at 0. A tie matters: the backend breaks it by `Id` and the landing by name, so
 * the panel and `investment.html` would disagree. It is only a starting value: it does
 * not count packages hidden by the visibility filter, nor gaps in the sequence.
 */
const startCreate = (): void => {
  formError.value = null
  fieldErrors.value = {}
  form.value = {
    id: null,
    name: '',
    duration: '',
    price: '',
    currency: DEFAULT_PACKAGE_CURRENCY,
    originalCurrency: DEFAULT_PACKAGE_CURRENCY,
    displayOrder: page.value?.totalCount ?? 0,
    description: '',
    includes: '',
    activated: true
  }
}

/**
 * Opens the form on an existing package.
 *
 * @param item - Row to edit, as listed.
 * @remarks
 * Started from the row in memory: `GET /api/packages/{id}` answers 404 for an unpublished
 * package, which is exactly one the operator may need to fix before publishing it again.
 */
const startEdit = (item: PackageDto): void => {
  formError.value = null
  fieldErrors.value = {}
  form.value = {
    id: item.id,
    name: item.name,
    duration: item.duration ?? '',
    price: String(item.price),
    currency: item.currency,
    originalCurrency: item.currency,
    displayOrder: item.displayOrder,
    description: item.description ?? '',
    includes: item.includes ?? '',
    activated: item.activated
  }
}

/** Whether the form is open. */
const isFormOpen = computed((): boolean => form.value !== null)

/** Closes the form, unless a save is in flight. */
const onFormOpenChange = (open: boolean): void => {
  if (!open && !isSaving.value) {
    form.value = null
  }
}

/** Currencies of the select, including the stored one when it is not offered. */
const currencyOptions = computed((): readonly string[] => {
  const original = form.value?.originalCurrency ?? ''

  return original === '' || CURRENCY_OPTIONS.includes(original)
    ? CURRENCY_OPTIONS
    : [...CURRENCY_OPTIONS, original]
})

/** Items of `includes` as `investment.html` will render them. */
const includesPreview = computed((): string[] => toIncludesList(form.value?.includes ?? null))

/**
 * Trims a text field, turning an empty value into null.
 *
 * @param value - Text as typed.
 */
const toNullable = (value: string): string | null => {
  const trimmed = value.trim()

  return trimmed === '' ? null : trimmed
}

/**
 * Validates the captured fields against the data annotations of `PackageDto`.
 *
 * @returns Whether the form can be sent.
 */
const validate = (): boolean => {
  const current = form.value

  if (current === null) {
    return false
  }

  const errors: Partial<Record<FormField, string>> = {}
  const name = current.name.trim()
  const price = current.price.trim()

  if (name === '') {
    errors.name = 'El nombre es obligatorio.'
  } else if (name.length > PACKAGE_NAME_MAX_LENGTH) {
    errors.name = `El nombre admite hasta ${PACKAGE_NAME_MAX_LENGTH} caracteres.`
  }

  if (current.duration.trim().length > PACKAGE_DURATION_MAX_LENGTH) {
    errors.duration = `La duración admite hasta ${PACKAGE_DURATION_MAX_LENGTH} caracteres.`
  }

  if (price === '') {
    errors.price = 'El precio es obligatorio.'
  } else if (PRICE_EXCESS_DECIMALS_PATTERN.test(price)) {
    errors.price = `El precio admite como máximo ${PACKAGE_PRICE_DECIMALS} decimales.`
  } else if (!PRICE_PATTERN.test(price)) {
    errors.price =
      'Escribe el precio solo con números y punto decimal, sin signo ni separadores de miles.'
  } else if (Number(price) > PACKAGE_PRICE_MAX) {
    errors.price = `El precio no puede superar ${PACKAGE_PRICE_MAX.toLocaleString('en-US')}.`
  }

  if (current.currency.length !== PACKAGE_CURRENCY_LENGTH) {
    errors.currency = 'Selecciona una moneda.'
  }

  if (
    !Number.isInteger(current.displayOrder) ||
    current.displayOrder < 0 ||
    current.displayOrder > DISPLAY_ORDER_MAX
  ) {
    errors.displayOrder = 'El orden debe ser un número entero mayor o igual que cero.'
  }

  if (current.description.trim().length > PACKAGE_DESCRIPTION_MAX_LENGTH) {
    errors.description = `La descripción admite hasta ${PACKAGE_DESCRIPTION_MAX_LENGTH} caracteres.`
  }

  if (current.includes.trim().length > PACKAGE_INCLUDES_MAX_LENGTH) {
    errors.includes = `«Incluye» admite hasta ${PACKAGE_INCLUDES_MAX_LENGTH} caracteres.`
  }

  fieldErrors.value = errors

  return Object.keys(errors).length === 0
}

/**
 * Splits the model validation messages of a 400 between the form fields.
 *
 * @param errors - `ApiError.fieldErrors`, possibly empty.
 * @returns The first message of each known field, and the first message no field owns.
 */
const splitServerErrors = (
  errors: FieldErrors
): { fields: Partial<Record<FormField, string>>; general: string | null } => {
  const fields: Partial<Record<FormField, string>> = {}
  let general: string | null = null

  for (const [key, messages] of Object.entries(errors)) {
    const message = messages[0]

    if (message === undefined) {
      continue
    }

    const segment = (key.split('.').pop() ?? key).toLowerCase()
    const field: FormField | undefined = SERVER_FIELD_MAP[segment]

    if (field === undefined) {
      general = general ?? message
    } else if (fields[field] === undefined) {
      fields[field] = message
    }
  }

  return { fields, general }
}

/**
 * Turns a failed save into messages for the form.
 *
 * @param error - Failure raised by the service.
 * @param current - Form that was being saved.
 * @remarks
 * A 400 comes in two shapes: `ValidationProblemDetails` from `[ApiController]`, with
 * `errors`, and `ProblemDetails` from the global handler, without them. Only the first
 * one can mark fields. A 404 on an edit means the list is stale, so it is reloaded.
 */
const applyFailure = (error: unknown, current: PackageForm): void => {
  if (!(error instanceof ApiError)) {
    formError.value = toMessage(error)

    return
  }

  if (error.kind === 'notFound' && current.id !== null) {
    formError.value =
      'Este paquete ya no existe. El listado se actualizó; cierra el formulario para continuar.'
    void load()

    return
  }

  if (error.kind === 'validation') {
    const { fields, general } = splitServerErrors(error.fieldErrors)

    fieldErrors.value = fields
    formError.value =
      Object.keys(fields).length > 0
        ? (general ?? 'El servidor rechazó algunos datos. Revisa los campos marcados.')
        : (general ?? error.detail)

    return
  }

  formError.value = toMessage(error)
}

/**
 * Saves the captured package.
 *
 * @remarks
 * `activated` always travels: the update maps it and the backend defaults it to true, so
 * omitting it would publish an unpublished package. The reload keeps page and filter
 * because both live in the query string.
 */
const submitForm = async (): Promise<void> => {
  const current = form.value

  if (current === null || isSaving.value || !validate()) {
    return
  }

  const payload: PackagePayload = {
    name: current.name.trim(),
    description: toNullable(current.description),
    includes: toNullable(current.includes),
    duration: toNullable(current.duration),
    price: Number(current.price.trim()),
    currency: current.currency,
    displayOrder: current.displayOrder,
    activated: current.activated
  }

  isSaving.value = true
  formError.value = null

  try {
    if (current.id === null) {
      await createPackage(payload)
    } else {
      await updatePackage(current.id, payload)
    }

    form.value = null
    await load()
  } catch (error) {
    applyFailure(error, current)
  } finally {
    isSaving.value = false
  }
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
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold tracking-tight">Paquetes</h1>
        <p class="text-muted-foreground">
          Administra los paquetes publicados en la página Investment y en el formulario de reserva.
        </p>
      </div>

      <Button type="button" @click="startCreate">
        <Plus :size="16" class="mr-2" />
        Nuevo paquete
      </Button>
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
                        type="button"
                        variant="ghost"
                        size="sm"
                        :aria-label="`Editar ${item.name}`"
                        @click="startEdit(item)"
                      >
                        <Pencil :size="16" class="mr-2" />
                        Editar
                      </Button>

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

    <Dialog
      :open="isFormOpen"
      :dismissible="!isSaving"
      :title="form !== null && form.id === null ? 'Nuevo paquete' : 'Editar paquete'"
      description="Los cambios se reflejan al instante en la página Investment y en el formulario de reserva."
      class="max-w-2xl"
      @update:open="onFormOpenChange"
    >
      <form
        v-if="form !== null"
        id="package-form"
        class="space-y-4"
        novalidate
        @submit.prevent="submitForm"
      >
        <p
          v-if="form.id !== null && !form.activated"
          class="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
        >
          Este paquete está despublicado y seguirá así al guardar.
        </p>

        <div class="space-y-1.5">
          <label for="package-name" class="text-sm font-medium">Nombre</label>
          <input
            id="package-name"
            v-model="form.name"
            type="text"
            :maxlength="PACKAGE_NAME_MAX_LENGTH"
            :disabled="isSaving"
            class="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
          />
          <p v-if="fieldErrors.name" role="alert" class="text-xs text-destructive">
            {{ fieldErrors.name }}
          </p>
        </div>

        <div class="grid gap-4 sm:grid-cols-3">
          <div class="space-y-1.5">
            <label for="package-duration" class="text-sm font-medium">Duración (opcional)</label>
            <input
              id="package-duration"
              v-model="form.duration"
              type="text"
              placeholder="2 horas"
              :maxlength="PACKAGE_DURATION_MAX_LENGTH"
              :disabled="isSaving"
              class="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
            />
            <p v-if="fieldErrors.duration" role="alert" class="text-xs text-destructive">
              {{ fieldErrors.duration }}
            </p>
          </div>

          <div class="space-y-1.5">
            <label for="package-price" class="text-sm font-medium">Precio</label>
            <input
              id="package-price"
              v-model="form.price"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              placeholder="4500"
              :disabled="isSaving"
              class="w-full rounded-md border bg-background px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
            />
            <p v-if="fieldErrors.price" role="alert" class="text-xs text-destructive">
              {{ fieldErrors.price }}
            </p>
            <p v-else class="text-xs text-muted-foreground">
              Sin separadores de miles; hasta {{ PACKAGE_PRICE_DECIMALS }} decimales.
            </p>
          </div>

          <div class="space-y-1.5">
            <label for="package-currency" class="text-sm font-medium">Moneda</label>
            <select
              id="package-currency"
              v-model="form.currency"
              :disabled="isSaving"
              class="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
            >
              <option v-for="code in currencyOptions" :key="code" :value="code">{{ code }}</option>
            </select>
            <p v-if="fieldErrors.currency" role="alert" class="text-xs text-destructive">
              {{ fieldErrors.currency }}
            </p>
          </div>
        </div>

        <div class="space-y-1.5 sm:w-40">
          <label for="package-order" class="text-sm font-medium">Orden</label>
          <input
            id="package-order"
            v-model.number="form.displayOrder"
            type="number"
            min="0"
            step="1"
            :disabled="isSaving"
            class="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
          />
          <p v-if="fieldErrors.displayOrder" role="alert" class="text-xs text-destructive">
            {{ fieldErrors.displayOrder }}
          </p>
          <p v-else class="text-xs text-muted-foreground">Menor valor, primero.</p>
        </div>

        <div class="space-y-1.5">
          <label for="package-description" class="text-sm font-medium">
            Descripción (opcional)
          </label>
          <textarea
            id="package-description"
            v-model="form.description"
            rows="3"
            :maxlength="PACKAGE_DESCRIPTION_MAX_LENGTH"
            :disabled="isSaving"
            class="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
          ></textarea>
          <p v-if="fieldErrors.description" role="alert" class="text-xs text-destructive">
            {{ fieldErrors.description }}
          </p>
          <p v-else class="text-xs text-muted-foreground">
            {{ form.description.length }} / {{ PACKAGE_DESCRIPTION_MAX_LENGTH }} caracteres.
          </p>
        </div>

        <div class="space-y-1.5">
          <label for="package-includes" class="text-sm font-medium">Incluye (opcional)</label>
          <textarea
            id="package-includes"
            v-model="form.includes"
            rows="5"
            :maxlength="PACKAGE_INCLUDES_MAX_LENGTH"
            :disabled="isSaving"
            aria-describedby="package-includes-help"
            class="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
          ></textarea>
          <p v-if="fieldErrors.includes" role="alert" class="text-xs text-destructive">
            {{ fieldErrors.includes }}
          </p>
          <p v-else id="package-includes-help" class="text-xs text-muted-foreground">
            Un concepto por renglón. {{ form.includes.length }} /
            {{ PACKAGE_INCLUDES_MAX_LENGTH }} caracteres.
          </p>

          <div class="rounded-md border bg-muted/40 p-3">
            <p class="mb-2 text-xs font-medium text-muted-foreground">Vista previa en Investment</p>
            <ul v-if="includesPreview.length > 0" class="list-disc space-y-1 pl-5 text-sm">
              <li v-for="(line, index) in includesPreview" :key="index">{{ line }}</li>
            </ul>
            <p v-else class="text-xs text-muted-foreground">Sin conceptos que mostrar.</p>
          </div>
        </div>

        <p v-if="formError !== null" role="alert" class="text-sm text-destructive">
          {{ formError }}
        </p>
      </form>

      <template #footer>
        <div class="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            :disabled="isSaving"
            @click="onFormOpenChange(false)"
          >
            Cancelar
          </Button>

          <Button type="submit" form="package-form" :disabled="isSaving">
            <Loader2 v-if="isSaving" :size="16" class="mr-2 animate-spin" />
            Guardar
          </Button>
        </div>
      </template>
    </Dialog>

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
