<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryValue } from 'vue-router'
import { EyeOff, ImageOff, ImageUp, Images, Loader2, Pencil, Plus, Undo2 } from 'lucide-vue-next'
import GalleryPhotosDialog from '@/components/GalleryPhotosDialog.vue'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import CardContent from '@/components/ui/CardContent.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import Dialog from '@/components/ui/Dialog.vue'
import Pagination from '@/components/ui/Pagination.vue'
import { ApiError } from '@/lib/http'
import { mediaUrl } from '@/lib/media'
import {
  CATEGORY_DESCRIPTION_MAX_LENGTH,
  CATEGORY_NAME_MAX_LENGTH,
  CATEGORY_SLUG_MAX_LENGTH,
  DEFAULT_PAGE_SIZE,
  SLUG_PATTERN,
  createGalleryCategory,
  deactivateGalleryCategory,
  getGalleryCategories,
  reactivateGalleryCategory,
  toSlug,
  updateGalleryCategory,
  type GalleryCategoryPayload
} from '@/services/gallery'
import type { GalleryCategoryDto, PaginatedList } from '@/types/api'

/**
 * Gallery categories list.
 *
 * @remarks
 * Unpublished categories are hidden by the backend unless `includeDeactivated` is sent,
 * and publishing one again is only reachable from the list, so the flag is a filter of
 * this view rather than a fixed option. `GET /api/admin/gallery/categories/{id}` answers
 * 404 for an unpublished category, which is why the form is opened from the row already
 * in memory instead of reading the category again.
 *
 * Photographs are out of scope here: the cover and the count are read only projections
 * the backend computes from the active photographs of each category.
 */

/** Query string keys owned by this view. */
const QUERY_KEYS = {
  page: 'page',
  deactivated: 'deactivated'
} as const

/** Value written in the query string to include unpublished categories. */
const DEACTIVATED_FLAG = '1'

/** Action awaiting confirmation. */
type PendingAction = 'deactivate' | 'reactivate'

/** Fields of the form that can carry their own message. */
type FormField = 'name' | 'slug' | 'displayOrder'

/** Editable fields of a category, as captured in the dialog. */
interface CategoryForm {
  /** Identifier being edited. Null while creating a category. */
  id: number | null
  name: string
  slug: string
  description: string
  displayOrder: number
  /** Publication state of the category, sent back untouched. */
  activated: boolean
  /**
   * Whether the slug was typed by hand.
   *
   * @remarks
   * Once true the slug stops following the name: the slug is part of the public URL and
   * an operator who fixed it does not expect the next keystroke on the name to undo it.
   */
  isSlugManual: boolean
}

const route = useRoute()
const router = useRouter()

const page = ref<PaginatedList<GalleryCategoryDto> | null>(null)
const isLoading = ref(false)
const errorMessage = ref<string | null>(null)

const form = ref<CategoryForm | null>(null)
const isSaving = ref(false)
const formError = ref<string | null>(null)
const fieldErrors = ref<Partial<Record<FormField, string>>>({})

const pending = ref<{ category: GalleryCategoryDto; action: PendingAction } | null>(null)
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

/** Whether unpublished categories are being listed. */
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

/** Fetches the page described by the current query string. */
const load = async (): Promise<void> => {
  activeController?.abort()

  const controller = new AbortController()
  activeController = controller

  isLoading.value = true
  errorMessage.value = null

  try {
    page.value = await getGalleryCategories({
      pageIndex: pageIndex.value,
      pageSize: DEFAULT_PAGE_SIZE,
      includeDeactivated: includeDeactivated.value,
      signal: controller.signal
    })
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
 * Same reason as in `@/views/Appointments.vue`: a getter returning an object would
 * refetch on every unrelated query string change.
 */
const filtersKey = computed((): string =>
  [pageIndex.value, includeDeactivated.value ? DEACTIVATED_FLAG : ''].join('|')
)

watch(filtersKey, () => void load(), { immediate: true })

/**
 * Rewrites the query string, dropping empty entries.
 *
 * @param changes - Entries to apply over the current filters.
 * @remarks
 * Changing the visibility filter sends the operator back to the first page: the
 * requested index is meaningless against a different result set.
 */
const applyFilters = (changes: { page?: number; deactivated?: boolean }): void => {
  const next: Record<string, string> = {}
  const deactivated = changes.deactivated ?? includeDeactivated.value
  const target = changes.deactivated !== undefined ? 1 : (changes.page ?? pageIndex.value)

  if (deactivated) {
    next[QUERY_KEYS.deactivated] = DEACTIVATED_FLAG
  }

  if (target > 1) {
    next[QUERY_KEYS.page] = String(target)
  }

  void router.push({ name: 'Gallery', query: next })
}

/**
 * Reads the value of a native control event.
 *
 * @param event - Input or change event of a text control.
 */
const readControlValue = (event: Event): string =>
  (event.target as HTMLInputElement).value

/* -------------------------------------------------------------------------- */
/* Create and edit                                                             */
/* -------------------------------------------------------------------------- */

/** Opens the form on a new category. */
const startCreate = (): void => {
  formError.value = null
  fieldErrors.value = {}
  form.value = {
    id: null,
    name: '',
    slug: '',
    description: '',
    displayOrder: 0,
    activated: true,
    isSlugManual: false
  }
}

/**
 * Opens the form on an existing category.
 *
 * @param category - Row to edit, as listed.
 * @remarks
 * The slug starts as manual: it is already published in a public URL, so it must not
 * follow a correction of the name unless the operator rewrites it.
 */
const startEdit = (category: GalleryCategoryDto): void => {
  formError.value = null
  fieldErrors.value = {}
  form.value = {
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description ?? '',
    displayOrder: category.displayOrder,
    activated: category.activated,
    isSlugManual: true
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

/**
 * Keeps the slug in sync with the name while it was not edited by hand.
 *
 * @param value - Name as typed.
 */
const onNameInput = (value: string): void => {
  const current = form.value

  if (current === null) {
    return
  }

  current.name = value

  if (!current.isSlugManual) {
    current.slug = toSlug(value)
  }
}

/**
 * Applies a slug typed by hand.
 *
 * @param value - Slug as typed.
 * @remarks
 * Not normalized on every keystroke: rewriting the value under the caret would fight the
 * operator while typing. It is normalized on blur and validated before saving.
 */
const onSlugInput = (value: string): void => {
  const current = form.value

  if (current === null) {
    return
  }

  current.slug = value
  current.isSlugManual = true
}

/** Normalizes the slug once the field loses focus. */
const onSlugBlur = (): void => {
  const current = form.value

  if (current !== null && current.slug !== '') {
    current.slug = toSlug(current.slug)
  }
}

/**
 * Validates the captured fields against the data annotations of the DTO.
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
  const slug = current.slug.trim()

  if (name === '') {
    errors.name = 'El nombre es obligatorio.'
  } else if (name.length > CATEGORY_NAME_MAX_LENGTH) {
    errors.name = `El nombre admite hasta ${CATEGORY_NAME_MAX_LENGTH} caracteres.`
  }

  if (slug === '') {
    errors.slug = 'El slug es obligatorio.'
  } else if (!SLUG_PATTERN.test(slug)) {
    errors.slug =
      'El slug solo admite minúsculas, números y guiones, sin guiones al inicio ni al final.'
  }

  if (!Number.isInteger(current.displayOrder) || current.displayOrder < 0) {
    errors.displayOrder = 'El orden debe ser un número entero mayor o igual que cero.'
  }

  fieldErrors.value = errors

  return Object.keys(errors).length === 0
}

/**
 * Turns a failed save into messages for the form.
 *
 * @param error - Failure raised by the service.
 * @remarks
 * The 409 is spelled out here rather than shown as it arrives: the backend reports a
 * duplicate slug even when the category holding it is unpublished, and that category is
 * invisible in the list until the visibility filter is on. Its `detail` does not say so.
 */
const applyFailure = (error: unknown): void => {
  if (error instanceof ApiError && error.kind === 'conflict') {
    fieldErrors.value = { ...fieldErrors.value, slug: 'Este slug ya está en uso.' }
    formError.value =
      'Ya existe una categoría con ese slug. Puede tratarse de una categoría despublicada, ' +
      'que conserva su slug: activa «Mostrar despublicadas» para revisarlo.'

    return
  }

  formError.value = toMessage(error)
}

/** Saves the captured category. */
const submitForm = async (): Promise<void> => {
  const current = form.value

  if (current === null || isSaving.value || !validate()) {
    return
  }

  const description = current.description.trim()
  const payload: GalleryCategoryPayload = {
    name: current.name.trim(),
    slug: current.slug.trim(),
    description: description === '' ? null : description,
    displayOrder: current.displayOrder,
    activated: current.activated
  }

  isSaving.value = true
  formError.value = null

  try {
    if (current.id === null) {
      await createGalleryCategory(payload)
    } else {
      await updateGalleryCategory(current.id, payload)
    }

    form.value = null
    await load()
  } catch (error) {
    applyFailure(error)
  } finally {
    isSaving.value = false
  }
}

/* -------------------------------------------------------------------------- */
/* Photographs                                                                 */
/* -------------------------------------------------------------------------- */

/** Category whose photographs are open, or null. */
const photosCategory = ref<GalleryCategoryDto | null>(null)

/**
 * Opens the photographs of a category.
 *
 * @param category - Row to manage, as listed.
 * @remarks
 * Opened from the row already in memory, for the same reason the form is: the detail
 * endpoint answers 404 for an unpublished category.
 */
const startPhotos = (category: GalleryCategoryDto): void => {
  photosCategory.value = category
}

/** Closes the photographs dialog. */
const onPhotosOpenChange = (open: boolean): void => {
  if (!open) {
    photosCategory.value = null
  }
}

/* -------------------------------------------------------------------------- */
/* Publish and unpublish                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Opens the confirmation step of a publication change.
 *
 * @param category - Category to act on.
 * @param action - Action to confirm.
 */
const startAction = (category: GalleryCategoryDto, action: PendingAction): void => {
  pendingError.value = null
  pending.value = { category, action }
}

/** Closes the confirmation step, unless the action is in flight. */
const onPendingOpenChange = (open: boolean): void => {
  if (!open && !isApplying.value) {
    pending.value = null
  }
}

/** Copy of the confirmation step, by action. */
const pendingCopy = computed(() => {
  const current = pending.value

  if (current === null) {
    return null
  }

  return current.action === 'deactivate'
    ? {
        title: 'Despublicar la categoría',
        description:
          `«${current.category.name}» dejará de aparecer en el sitio público junto con sus ` +
          'fotografías. No se borra nada y puedes volver a publicarla cuando quieras.',
        confirmLabel: 'Despublicar',
        warning:
          'El slug sigue reservado mientras esté despublicada, así que no podrás reutilizarlo en otra categoría.',
        destructive: true
      }
    : {
        title: 'Publicar la categoría',
        description: `«${current.category.name}» volverá a aparecer en el sitio público con sus fotografías activas.`,
        confirmLabel: 'Publicar',
        warning: null,
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
      await deactivateGalleryCategory(current.category.id)
    } else {
      await reactivateGalleryCategory(current.category.id)
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
        <h1 class="text-xl font-bold tracking-tight">Galería</h1>
        <p class="text-muted-foreground">Administra las categorías publicadas en el sitio.</p>
      </div>

      <Button type="button" @click="startCreate">
        <Plus :size="16" class="mr-2" />
        Nueva categoría
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
          Mostrar despublicadas
        </label>

        <p class="text-xs text-muted-foreground">
          Una categoría despublicada conserva sus fotografías y su slug.
        </p>
      </CardContent>
    </Card>

    <Card>
      <CardContent class="p-0">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="border-b bg-muted/50 text-left">
              <tr>
                <th scope="col" class="px-4 py-3 font-medium">Portada</th>
                <th scope="col" class="px-4 py-3 font-medium">Nombre</th>
                <th scope="col" class="px-4 py-3 font-medium">Slug</th>
                <th scope="col" class="px-4 py-3 font-medium">Fotos</th>
                <th scope="col" class="px-4 py-3 font-medium">Orden</th>
                <th scope="col" class="px-4 py-3 font-medium">Estado</th>
                <th scope="col" class="px-4 py-3 text-right font-medium">Acciones</th>
              </tr>
            </thead>

            <tbody>
              <tr v-if="isLoading">
                <td colspan="7" class="px-4 py-12 text-center text-muted-foreground">
                  <Loader2 :size="20" class="mx-auto mb-2 animate-spin" />
                  Cargando categorías…
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

              <tr v-else-if="page === null || page.items.length === 0">
                <td colspan="7" class="px-4 py-12 text-center text-muted-foreground">
                  <Images :size="24" class="mx-auto mb-2" />
                  {{
                    includeDeactivated
                      ? 'Todavía no hay categorías registradas.'
                      : 'No hay categorías publicadas. Activa «Mostrar despublicadas» para ver las ocultas.'
                  }}
                </td>
              </tr>

              <template v-else>
                <tr
                  v-for="category in page.items"
                  :key="category.id"
                  class="border-b last:border-b-0 hover:bg-accent/50"
                >
                  <td class="px-4 py-3">
                    <img
                      v-if="category.coverPhoto !== null"
                      :src="mediaUrl(category.coverPhoto.thumbUrl)"
                      :alt="category.coverPhoto.altText ?? `Portada de ${category.name}`"
                      loading="lazy"
                      class="h-12 w-16 rounded-md border object-cover"
                    />
                    <div
                      v-else
                      class="flex h-12 w-16 items-center justify-center rounded-md border bg-muted text-muted-foreground"
                      :aria-label="`${category.name} no tiene portada`"
                    >
                      <ImageOff :size="16" />
                    </div>
                  </td>

                  <td class="px-4 py-3">
                    <p class="font-medium">{{ category.name }}</p>
                    <p
                      v-if="category.description"
                      class="max-w-xs truncate text-xs text-muted-foreground"
                    >
                      {{ category.description }}
                    </p>
                  </td>

                  <td class="px-4 py-3">
                    <code class="rounded bg-muted px-1.5 py-0.5 text-xs">{{ category.slug }}</code>
                  </td>

                  <td class="px-4 py-3">{{ category.photoCount }}</td>
                  <td class="px-4 py-3">{{ category.displayOrder }}</td>

                  <td class="px-4 py-3">
                    <Badge :variant="category.activated ? 'success' : 'muted'">
                      {{ category.activated ? 'Publicada' : 'Despublicada' }}
                    </Badge>
                  </td>

                  <td class="px-4 py-3">
                    <div class="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        :aria-label="`Fotografías de ${category.name}`"
                        @click="startPhotos(category)"
                      >
                        <ImageUp :size="16" class="mr-2" />
                        Fotos
                      </Button>

                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        :aria-label="`Editar ${category.name}`"
                        @click="startEdit(category)"
                      >
                        <Pencil :size="16" class="mr-2" />
                        Editar
                      </Button>

                      <Button
                        v-if="category.activated"
                        type="button"
                        variant="ghost"
                        size="sm"
                        :aria-label="`Despublicar ${category.name}`"
                        @click="startAction(category, 'deactivate')"
                      >
                        <EyeOff :size="16" class="mr-2" />
                        Despublicar
                      </Button>

                      <Button
                        v-else
                        type="button"
                        variant="ghost"
                        size="sm"
                        :aria-label="`Publicar ${category.name}`"
                        @click="startAction(category, 'reactivate')"
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
      singular-label="categoría"
      plural-label="categorías"
      @change="applyFilters({ page: $event })"
    />

    <Dialog
      :open="isFormOpen"
      :dismissible="!isSaving"
      :title="form !== null && form.id === null ? 'Nueva categoría' : 'Editar categoría'"
      description="El slug forma parte de la URL pública de la categoría y debe ser único."
      class="max-w-xl"
      @update:open="onFormOpenChange"
    >
      <form v-if="form !== null" id="category-form" class="space-y-4" @submit.prevent="submitForm">
        <div class="space-y-1.5">
          <label for="category-name" class="text-sm font-medium">Nombre</label>
          <input
            id="category-name"
            :value="form.name"
            type="text"
            :maxlength="CATEGORY_NAME_MAX_LENGTH"
            :disabled="isSaving"
            class="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
            @input="onNameInput(readControlValue($event))"
          />
          <p v-if="fieldErrors.name" role="alert" class="text-xs text-destructive">
            {{ fieldErrors.name }}
          </p>
        </div>

        <div class="space-y-1.5">
          <label for="category-slug" class="text-sm font-medium">Slug</label>
          <input
            id="category-slug"
            :value="form.slug"
            type="text"
            :maxlength="CATEGORY_SLUG_MAX_LENGTH"
            :disabled="isSaving"
            class="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
            @input="onSlugInput(readControlValue($event))"
            @blur="onSlugBlur"
          />
          <p v-if="fieldErrors.slug" role="alert" class="text-xs text-destructive">
            {{ fieldErrors.slug }}
          </p>
          <p v-else class="text-xs text-muted-foreground">
            Se genera desde el nombre mientras no lo edites. Solo minúsculas, números y guiones.
          </p>
        </div>

        <div class="space-y-1.5">
          <label for="category-description" class="text-sm font-medium">
            Descripción (opcional)
          </label>
          <textarea
            id="category-description"
            v-model="form.description"
            rows="3"
            :maxlength="CATEGORY_DESCRIPTION_MAX_LENGTH"
            :disabled="isSaving"
            class="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
          ></textarea>
          <p class="text-xs text-muted-foreground">
            {{ form.description.length }} / {{ CATEGORY_DESCRIPTION_MAX_LENGTH }} caracteres.
          </p>
        </div>

        <div class="space-y-1.5 sm:w-40">
          <label for="category-order" class="text-sm font-medium">Orden</label>
          <input
            id="category-order"
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

          <Button type="submit" form="category-form" :disabled="isSaving">
            <Loader2 v-if="isSaving" :size="16" class="mr-2 animate-spin" />
            Guardar
          </Button>
        </div>
      </template>
    </Dialog>

    <GalleryPhotosDialog
      :open="photosCategory !== null"
      :category="photosCategory"
      @update:open="onPhotosOpenChange"
      @changed="load"
    />

    <ConfirmDialog
      v-if="pendingCopy !== null"
      :open="pending !== null"
      :title="pendingCopy.title"
      :description="pendingCopy.description"
      :confirm-label="pendingCopy.confirmLabel"
      :warning="pendingCopy.warning"
      :destructive="pendingCopy.destructive"
      :is-busy="isApplying"
      :error-message="pendingError"
      @update:open="onPendingOpenChange"
      @confirm="submitAction"
    />
  </div>
</template>
