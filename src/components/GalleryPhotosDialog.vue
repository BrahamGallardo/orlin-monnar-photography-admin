<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  Check,
  GripVertical,
  ImageOff,
  Loader2,
  Star,
  Trash2
} from 'lucide-vue-next'
import PhotoUploadQueue from '@/components/PhotoUploadQueue.vue'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import Dialog from '@/components/ui/Dialog.vue'
import Pagination from '@/components/ui/Pagination.vue'
import { ApiError } from '@/lib/http'
import { mediaUrl } from '@/lib/media'
import {
  PHOTOS_PAGE_SIZE,
  deleteGalleryPhoto,
  getAllGalleryCategoryPhotos,
  getGalleryCategoryPhotos,
  reorderGalleryPhotos
} from '@/services/gallery'
import type { GalleryCategoryDto, PaginatedList, PhotoDto } from '@/types/api'

/**
 * Photographs of one gallery category: grid, ordering, deletion and upload queue.
 *
 * @remarks
 * Ordering works on a draft of the *whole* category, not on the visible page:
 * `PUT photos/reorder` numbers from zero the identifiers it receives and leaves the rest
 * untouched, so saving a single page would interleave it with the others. The draft is
 * sent in one request when the operator saves, never on every move.
 *
 * Both mutations are optimistic. The grid reflects the change before the request settles
 * and is restored if it fails. A 404 on delete is taken as success: the photograph is
 * already gone on the server.
 *
 * Uploading to an unpublished category answers 404: `UploadPhotoAsync` reads the
 * category with `onlyActive: true`. The queue is therefore hidden rather than left to
 * fail on every file.
 */

/**
 * Data type that marks a drag started on this grid.
 *
 * @remarks
 * Firefox does not start a drag without `setData`, and checking the type on `dragover`
 * keeps files dragged from the desktop, or anything else, from being accepted as a move.
 */
const DRAG_TYPE = 'application/x-omp-photo'

const props = defineProps<{
  /** Controlled open state. */
  open: boolean
  /** Category being managed. Null while the dialog is closed. */
  category: GalleryCategoryDto | null
}>()

const emit = defineEmits<{
  (event: 'update:open', open: boolean): void
  /** Raised when the category list needs to catch up: cover and count are projections. */
  (event: 'changed'): void
}>()

const page = ref<PaginatedList<PhotoDto> | null>(null)
const pageIndex = ref(1)
const isLoading = ref(false)
const errorMessage = ref<string | null>(null)

/** Whole category in the order being edited. Null outside ordering mode. */
const orderDraft = ref<PhotoDto[] | null>(null)
const isPreparingOrder = ref(false)
const isSavingOrder = ref(false)
const orderError = ref<string | null>(null)
/** Text read by assistive technology after every move. */
const orderAnnouncement = ref('')
const draggedIndex = ref<number | null>(null)
const dropIndex = ref<number | null>(null)

const photoToDelete = ref<PhotoDto | null>(null)
const isDeleting = ref(false)
const deleteError = ref<string | null>(null)

/** Identifiers of the category as loaded, to tell whether the draft moved anything. */
let orderBaseline: number[] = []

/** In flight request, aborted whenever the category or the page changes. */
let activeController: AbortController | null = null

/** In flight read of the whole category, aborted when the dialog closes. */
let orderController: AbortController | null = null

/** Whether the category admits uploads. */
const canUpload = computed((): boolean => props.category?.activated === true)

/** Whether the grid is being ordered. */
const isOrderMode = computed((): boolean => orderDraft.value !== null)

/** Whether a request that changes the server state is in flight. */
const isMutating = computed((): boolean => isSavingOrder.value || isDeleting.value)

/** Whether the draft differs from the order it was loaded with. */
const hasOrderChanges = computed((): boolean => {
  const draft = orderDraft.value

  return draft !== null && draft.map((photo) => photo.id).join(',') !== orderBaseline.join(',')
})

/** Whether ordering can be offered: it takes at least two photographs. */
const canOrder = computed(
  (): boolean =>
    !isOrderMode.value &&
    !isLoading.value &&
    !isMutating.value &&
    page.value !== null &&
    page.value.totalCount > 1
)

/**
 * Display order the next upload takes.
 *
 * @remarks
 * The backend stores `DisplayOrder` verbatim, so a batch is numbered after the
 * photographs already registered. It only has to be monotonic: saving an order rewrites
 * the whole sequence from zero.
 */
const displayOrderOffset = computed((): number => page.value?.totalCount ?? 0)

/**
 * Turns a failure into a message for this dialog.
 *
 * @param error - Failure raised by the service.
 */
const toMessage = (error: unknown): string =>
  error instanceof ApiError ? error.detail : 'Ocurrió un error inesperado. Intenta de nuevo.'

/**
 * Short name of a photograph for labels and messages.
 *
 * @param photo - Photograph to name.
 * @param index - Zero based position, used when the photograph has no title.
 */
const photoName = (photo: PhotoDto, index: number): string =>
  photo.title ?? `fotografía ${index + 1}`

/** Reads the current page of photographs of the open category. */
const load = async (): Promise<void> => {
  const category = props.category

  if (category === null) {
    return
  }

  activeController?.abort()

  const controller = new AbortController()
  activeController = controller

  isLoading.value = true
  errorMessage.value = null

  try {
    page.value = await getGalleryCategoryPhotos(category.id, {
      pageIndex: pageIndex.value,
      pageSize: PHOTOS_PAGE_SIZE,
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

/** Clears the drag feedback. */
const resetDrag = (): void => {
  draggedIndex.value = null
  dropIndex.value = null
}

/** Leaves ordering mode without saving. */
const discardOrder = (): void => {
  orderController?.abort()
  orderController = null
  isPreparingOrder.value = false
  orderDraft.value = null
  orderBaseline = []
  orderAnnouncement.value = ''
  resetDrag()
}

/**
 * Serialized state of the request, used as the watch key.
 *
 * @remarks
 * Null while the dialog is closed, which tears the state down instead of leaving the
 * previous category rendered behind the overlay of the next one.
 */
const requestKey = computed((): string | null =>
  props.open && props.category !== null ? `${props.category.id}|${pageIndex.value}` : null
)

watch(
  requestKey,
  (key): void => {
    if (key === null) {
      activeController?.abort()
      discardOrder()
      page.value = null
      errorMessage.value = null
      orderError.value = null
      deleteError.value = null
      photoToDelete.value = null
      pageIndex.value = 1

      return
    }

    void load()
  },
  { immediate: true }
)

/**
 * Moves to another page.
 *
 * @param target - One based page index.
 */
const goToPage = (target: number): void => {
  pageIndex.value = target
}

/**
 * Refreshes the grid once the queue drains.
 *
 * @remarks
 * The grid is reloaded rather than appended to: the server assigns the derivative URLs
 * and the dimensions, and a photograph marked as featured can change the cover of its
 * category, which the list behind this dialog also has to pick up. An open draft is
 * discarded because it no longer lists every photograph of the category.
 */
const onQueueFinished = async (): Promise<void> => {
  if (isOrderMode.value) {
    discardOrder()
    orderError.value =
      'Se agregaron fotografías mientras ordenabas. Vuelve a pulsar «Ordenar» para incluirlas.'
  }

  if (pageIndex.value !== 1) {
    // The watch on the key reloads it, so the explicit load below is skipped.
    pageIndex.value = 1
    emit('changed')

    return
  }

  await load()
  emit('changed')
}

/* -------------------------------------------------------------------------- */
/* Ordering                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Enters ordering mode with every photograph of the category.
 *
 * @remarks
 * A category that fits in one page reuses the page already in memory. Otherwise every
 * page is read, because the reorder endpoint only rewrites what it receives.
 */
const startOrder = async (): Promise<void> => {
  const category = props.category
  const current = page.value

  if (category === null || current === null || !canOrder.value || isPreparingOrder.value) {
    return
  }

  orderError.value = null
  deleteError.value = null

  if (current.totalPages <= 1) {
    orderBaseline = current.items.map((photo) => photo.id)
    orderDraft.value = current.items.slice()

    return
  }

  const controller = new AbortController()
  orderController = controller
  isPreparingOrder.value = true

  try {
    const photos = await getAllGalleryCategoryPhotos(category.id, controller.signal)

    orderBaseline = photos.map((photo) => photo.id)
    orderDraft.value = photos
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'cancelled') {
      return
    }

    orderError.value = toMessage(error)
  } finally {
    if (orderController === controller) {
      isPreparingOrder.value = false
      orderController = null
    }
  }
}

/**
 * Moves a photograph of the draft to another position.
 *
 * @param from - Zero based position it leaves.
 * @param to - Zero based position it takes.
 */
const movePhoto = (from: number, to: number): void => {
  const draft = orderDraft.value

  if (draft === null || from === to || to < 0 || to >= draft.length) {
    return
  }

  const next = draft.slice()

  next.splice(to, 0, ...next.splice(from, 1))
  orderDraft.value = next
  orderAnnouncement.value = `Fotografía movida a la posición ${to + 1} de ${next.length}.`
}

/**
 * Starts dragging a photograph of the draft.
 *
 * @param index - Zero based position of the photograph.
 * @param event - Native drag event.
 */
const onDragStart = (index: number, event: DragEvent): void => {
  if (event.dataTransfer === null) {
    return
  }

  event.dataTransfer.setData(DRAG_TYPE, String(index))
  event.dataTransfer.effectAllowed = 'move'
  draggedIndex.value = index
}

/**
 * Accepts a drag over a photograph, only when it started on this grid.
 *
 * @param index - Zero based position under the pointer.
 * @param event - Native drag event.
 */
const onDragOver = (index: number, event: DragEvent): void => {
  if (
    draggedIndex.value === null ||
    event.dataTransfer === null ||
    !event.dataTransfer.types.includes(DRAG_TYPE)
  ) {
    return
  }

  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  dropIndex.value = index
}

/**
 * Applies the move once the photograph is dropped.
 *
 * @param index - Zero based position it is dropped on.
 * @param event - Native drag event.
 */
const onDrop = (index: number, event: DragEvent): void => {
  const from = draggedIndex.value

  if (from === null) {
    return
  }

  event.preventDefault()
  movePhoto(from, index)
  resetDrag()
}

/**
 * Stores the draft in a single request.
 *
 * @remarks
 * Optimistic: the visible page takes the new order and the new positions before the
 * request settles. On failure the page is restored and the draft reopened, so the
 * operator can retry without redoing the moves.
 */
const saveOrder = async (): Promise<void> => {
  const draft = orderDraft.value
  const current = page.value

  if (draft === null || current === null || isMutating.value) {
    return
  }

  if (!hasOrderChanges.value) {
    discardOrder()

    return
  }

  const baseline = orderBaseline
  const previousItems = current.items
  const start = (current.pageIndex - 1) * current.pageSize

  current.items = draft
    .map((photo, position): PhotoDto => ({ ...photo, displayOrder: position }))
    .slice(start, start + current.pageSize)

  discardOrder()
  isSavingOrder.value = true
  orderError.value = null

  try {
    await reorderGalleryPhotos(draft.map((photo) => photo.id))
    emit('changed')
  } catch (error) {
    current.items = previousItems
    orderBaseline = baseline
    orderDraft.value = draft
    orderError.value = `No se guardó el orden. ${toMessage(error)}`
  } finally {
    isSavingOrder.value = false
  }
}

/* -------------------------------------------------------------------------- */
/* Deletion                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Opens the confirmation step of a deletion.
 *
 * @param photo - Photograph to delete.
 */
const startDelete = (photo: PhotoDto): void => {
  if (isMutating.value || isOrderMode.value) {
    return
  }

  deleteError.value = null
  orderError.value = null
  photoToDelete.value = photo
}

/** Closes the confirmation step. */
const onDeleteOpenChange = (open: boolean): void => {
  if (!open) {
    photoToDelete.value = null
  }
}

/** Copy of the confirmation step. */
const deleteCopy = computed(() => {
  const photo = photoToDelete.value

  if (photo === null) {
    return null
  }

  const name = photo.title === null ? 'Esta fotografía' : `«${photo.title}»`

  return {
    description: `${name} desaparecerá del panel y del sitio público.`,
    warning:
      'Esta acción es IRREVERSIBLE. Se borran del servidor los tres archivos de la fotografía ' +
      '(miniatura, mediana y grande) y el panel no permite recuperar fotografías eliminadas. ' +
      'Para volver a publicarla tendrás que subir de nuevo el archivo original.'
  }
})

/**
 * Deletes the photograph awaiting confirmation.
 *
 * @remarks
 * Optimistic: the photograph leaves the grid as soon as the operator confirms and comes
 * back to its position if the request fails. Afterwards the page is read again only when
 * something has to fill the gap: a following page, or an emptied page that is not the
 * first one.
 */
const confirmDelete = async (): Promise<void> => {
  const photo = photoToDelete.value
  const current = page.value

  if (photo === null || current === null || isMutating.value) {
    return
  }

  const previousItems = current.items
  const previousTotal = current.totalCount

  photoToDelete.value = null
  current.items = previousItems.filter((item) => item.id !== photo.id)
  current.totalCount = previousTotal - 1
  isDeleting.value = true
  deleteError.value = null

  try {
    await deleteGalleryPhoto(photo.id)
  } catch (error) {
    // A 404 means it was already deleted, so the optimistic state is the truth.
    if (!(error instanceof ApiError && error.kind === 'notFound')) {
      current.items = previousItems
      current.totalCount = previousTotal
      deleteError.value = `No se eliminó la fotografía. ${toMessage(error)}`

      return
    }
  } finally {
    isDeleting.value = false
  }

  emit('changed')

  if (current.items.length === 0 && pageIndex.value > 1) {
    // The watch on the key reloads the previous page.
    pageIndex.value -= 1

    return
  }

  if (current.hasNextPage) {
    await load()
  }
}
</script>

<template>
  <Dialog
    :open="open"
    :dismissible="!isMutating"
    :title="category === null ? 'Fotografías' : `Fotografías de ${category.name}`"
    description="El servidor genera tres versiones WebP de cada fotografía y descarta el archivo original."
    class="max-w-4xl"
    @update:open="emit('update:open', $event)"
  >
    <div v-if="category !== null" class="space-y-6">
      <section class="space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-sm font-medium">En la categoría</h3>

          <div v-if="isOrderMode" class="flex gap-2">
            <Button type="button" variant="outline" size="sm" @click="discardOrder">
              Descartar cambios
            </Button>

            <Button type="button" size="sm" :disabled="!hasOrderChanges" @click="saveOrder">
              <Check :size="16" class="mr-2" />
              Guardar orden
            </Button>
          </div>

          <Button
            v-else-if="canOrder"
            type="button"
            variant="outline"
            size="sm"
            :disabled="isPreparingOrder"
            @click="startOrder"
          >
            <Loader2 v-if="isPreparingOrder" :size="16" class="mr-2 animate-spin" />
            <ArrowUpDown v-else :size="16" class="mr-2" />
            Ordenar
          </Button>

          <p
            v-else-if="isMutating"
            class="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <Loader2 :size="14" class="animate-spin" />
            Guardando…
          </p>
        </div>

        <p v-if="orderError !== null" role="alert" class="text-sm text-destructive">
          {{ orderError }}
        </p>

        <p v-if="deleteError !== null" role="alert" class="text-sm text-destructive">
          {{ deleteError }}
        </p>

        <template v-if="orderDraft !== null">
          <p class="text-xs text-muted-foreground">
            Arrastra las fotografías o usa las flechas. El orden no se guarda hasta que pulses
            «Guardar orden».
          </p>

          <ul class="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Orden de las fotografías">
            <li
              v-for="(photo, index) in orderDraft"
              :key="photo.id"
              draggable="true"
              class="space-y-1 rounded-md p-1 transition-shadow"
              :class="{
                'opacity-50': draggedIndex === index,
                'ring-2 ring-primary': dropIndex === index && draggedIndex !== index
              }"
              @dragstart="onDragStart(index, $event)"
              @dragover="onDragOver(index, $event)"
              @drop="onDrop(index, $event)"
              @dragend="resetDrag"
            >
              <div class="relative">
                <img
                  :src="mediaUrl(photo.thumbUrl)"
                  :alt="photo.altText ?? photo.title ?? `Fotografía de ${category.name}`"
                  draggable="false"
                  loading="lazy"
                  class="aspect-square w-full cursor-grab rounded-md border object-cover"
                />

                <span
                  class="absolute left-1 top-1 rounded bg-background/80 px-1.5 text-xs font-medium"
                >
                  {{ index + 1 }}
                </span>

                <GripVertical
                  :size="16"
                  aria-hidden="true"
                  class="absolute right-1 top-1 rounded bg-background/80 text-muted-foreground"
                />
              </div>

              <div class="flex items-center justify-between gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  class="h-8 w-8"
                  :disabled="index === 0"
                  :aria-label="`Subir ${photoName(photo, index)} a la posición ${index}`"
                  @click="movePhoto(index, index - 1)"
                >
                  <ArrowLeft :size="14" />
                </Button>

                <p class="truncate text-xs">{{ photo.title }}</p>

                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  class="h-8 w-8"
                  :disabled="index === orderDraft.length - 1"
                  :aria-label="`Bajar ${photoName(photo, index)} a la posición ${index + 2}`"
                  @click="movePhoto(index, index + 1)"
                >
                  <ArrowRight :size="14" />
                </Button>
              </div>
            </li>
          </ul>

          <p class="sr-only" aria-live="polite">{{ orderAnnouncement }}</p>
        </template>

        <p v-else-if="isLoading" class="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 :size="16" class="animate-spin" />
          Cargando fotografías…
        </p>

        <div v-else-if="errorMessage !== null">
          <p role="alert" class="text-sm text-destructive">{{ errorMessage }}</p>
          <Button type="button" variant="outline" size="sm" class="mt-3" @click="load">
            Reintentar
          </Button>
        </div>

        <p
          v-else-if="page === null || page.items.length === 0"
          class="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <ImageOff :size="16" />
          Esta categoría todavía no tiene fotografías.
        </p>

        <template v-else>
          <ul class="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <li v-for="(photo, index) in page.items" :key="photo.id" class="space-y-1">
              <div class="relative">
                <img
                  :src="mediaUrl(photo.thumbUrl)"
                  :alt="photo.altText ?? photo.title ?? `Fotografía de ${category.name}`"
                  loading="lazy"
                  class="aspect-square w-full rounded-md border object-cover"
                />

                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  class="absolute right-1 top-1 h-8 w-8"
                  :disabled="isMutating"
                  :aria-label="`Eliminar ${photoName(photo, index)}`"
                  @click="startDelete(photo)"
                >
                  <Trash2 :size="14" class="text-destructive" />
                </Button>
              </div>

              <p v-if="photo.title" class="truncate text-xs">{{ photo.title }}</p>

              <Badge v-if="photo.isFeatured" variant="success">
                <Star :size="12" class="mr-1" />
                En el Home
              </Badge>
            </li>
          </ul>

          <Pagination
            v-if="page.totalPages > 1"
            :page-index="page.pageIndex"
            :total-pages="page.totalPages"
            :total-count="page.totalCount"
            :page-size="page.pageSize"
            :has-previous-page="page.hasPreviousPage"
            :has-next-page="page.hasNextPage"
            :disabled="isLoading || isMutating"
            singular-label="fotografía"
            plural-label="fotografías"
            @change="goToPage"
          />
        </template>
      </section>

      <section class="space-y-3 border-t pt-4">
        <h3 class="text-sm font-medium">Subir fotografías</h3>

        <p
          v-if="!canUpload"
          class="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
        >
          La categoría está despublicada y el servidor no admite subidas a categorías
          despublicadas. Publícala desde el listado para agregar fotografías.
        </p>

        <PhotoUploadQueue
          v-else
          :category-id="category.id"
          :display-order-offset="displayOrderOffset"
          :disabled="isLoading || isOrderMode || isMutating"
          @finished="onQueueFinished"
        />
      </section>

      <ConfirmDialog
        v-if="deleteCopy !== null"
        :open="photoToDelete !== null"
        title="Eliminar fotografía"
        :description="deleteCopy.description"
        confirm-label="Eliminar definitivamente"
        :warning="deleteCopy.warning"
        destructive
        @update:open="onDeleteOpenChange"
        @confirm="confirmDelete"
      />
    </div>
  </Dialog>
</template>
