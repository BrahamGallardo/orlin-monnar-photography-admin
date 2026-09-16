<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { CheckCircle2, ImageOff, ImagePlus, Loader2, RotateCcw, TriangleAlert, X } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import { ApiError } from '@/lib/http'
import {
  ALLOWED_EXTENSIONS,
  MAX_UPLOAD_SIZE_MB,
  PHOTO_ALT_TEXT_MAX_LENGTH,
  PHOTO_TITLE_MAX_LENGTH,
  PHOTO_UPLOAD_RATE_LIMIT_PER_MINUTE,
  uploadGalleryPhoto,
  validatePhotoFile,
  type PhotoRejection
} from '@/services/gallery'
import type { PhotoDto } from '@/types/api'

/**
 * Upload queue of a gallery category.
 *
 * @remarks
 * The queue is sequential by server constraint, not by simplicity: the API derives three
 * WebP renditions per photograph and decoding a 20 MP original costs around 80 MB, so it
 * accepts one file per request and tolerates at most two at a time.
 *
 * Rejected files stay in the list instead of being dropped: an operator who selected
 * thirty files needs to see *which* two were refused and why.
 */

const props = defineProps<{
  /** Category the photographs are uploaded to. */
  categoryId: number
  /**
   * Display order the first upload of the batch takes.
   *
   * @remarks
   * The backend stores `DisplayOrder` verbatim, so the parent passes the number of
   * photographs already in the category and the queue numbers the batch after them.
   */
  displayOrderOffset: number
  /** Whether the picker is blocked, typically while the parent reloads. */
  disabled?: boolean
}>()

const emit = defineEmits<{
  (event: 'uploaded', photo: PhotoDto): void
  /** Raised once the queue drains after at least one successful upload. */
  (event: 'finished'): void
}>()

/** Lifecycle of a queued file. */
type QueueItemStatus = 'pending' | 'uploading' | 'done' | 'error'

/** One file waiting in, travelling through, or settled out of the queue. */
interface QueueItem {
  /** Local key. The server identifier only exists once the upload succeeds. */
  id: number
  file: File
  /** Object URL of the local preview. Revoked when the item leaves the list. */
  previewUrl: string
  /** Whether the browser refused to decode the preview, as `.heic` does outside Safari. */
  isPreviewBroken: boolean
  title: string
  altText: string
  isFeatured: boolean
  status: QueueItemStatus
  /** Completion of the transfer, between 0 and 100. */
  progress: number
  errorMessage: string | null
  /** Client side rejection, when the file never reached the server. */
  rejection: PhotoRejection | null
}

const items = ref<QueueItem[]>([])
const isRunning = ref(false)
const isDragging = ref(false)

/**
 * Whether the queue stopped on a rate limit.
 *
 * @remarks
 * A 429 stops the run instead of failing the rest of the batch: every remaining file
 * would hit the same fixed window, and forty individual retries is not a recovery.
 */
const isThrottled = ref(false)

/** Sequence of local keys. */
let nextItemId = 0

/** Accepted extensions, as the `accept` attribute of the picker spells them. */
const acceptAttribute = ALLOWED_EXTENSIONS.join(',')

/** Accepted extensions, as the operator reads them. */
const extensionsLabel = ALLOWED_EXTENSIONS.map((extension) => extension.replace('.', '')).join(', ')

/** Whether at least one file is waiting to be sent. */
const hasPending = computed((): boolean => items.value.some((item) => item.status === 'pending'))

/** Number of files already stored. */
const doneCount = computed(
  (): number => items.value.filter((item) => item.status === 'done').length
)

/** Whether the metadata of the queue can still be edited. */
const isIdle = computed((): boolean => !isRunning.value)

/**
 * Formats a size in bytes for the operator.
 *
 * @param bytes - Size as reported by the file.
 */
const formatSize = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`

/**
 * Builds the message of a client side rejection.
 *
 * @param rejection - Reason the file was refused.
 * @param file - File that was refused.
 */
const toRejectionMessage = (rejection: PhotoRejection, file: File): string =>
  rejection === 'extension'
    ? `Formato no admitido. El servidor solo acepta ${extensionsLabel}.`
    : `El archivo pesa ${formatSize(file.size)} y el límite del servidor es de ${MAX_UPLOAD_SIZE_MB} MB.`

/**
 * Turns a failed upload into a message for its card.
 *
 * @param error - Failure raised by the service.
 * @remarks
 * The 413 and the 429 arrive without a body, so `@/lib/http` classifies them by status
 * and the wording is spelled out here: without it the operator would read a blank error
 * on the one failure the panel can explain precisely.
 */
const toItemMessage = (error: unknown): string => {
  if (!(error instanceof ApiError)) {
    return 'Ocurrió un error inesperado. Intenta de nuevo.'
  }

  switch (error.kind) {
    case 'payloadTooLarge':
      return `El servidor rechazó el archivo por tamaño. El límite es de ${MAX_UPLOAD_SIZE_MB} MB.`
    case 'rateLimit':
      return `El servidor admite ${PHOTO_UPLOAD_RATE_LIMIT_PER_MINUTE} subidas por minuto. Espera un momento y reanuda la cola.`
    case 'notFound':
      return 'La categoría ya no está disponible. Puede haberse despublicado: solo se admiten subidas a categorías publicadas.'
    case 'validation': {
      // The extension check of the server raises an InvalidOperationException, so its
      // detail already lists the accepted extensions. A model validation failure instead
      // fills fieldErrors, and its first entry is the useful one.
      const messages = Object.values(error.fieldErrors).flatMap((entry) => entry)

      return messages.length > 0 ? messages[0] : error.detail
    }
    default:
      return error.detail
  }
}

/**
 * Adds files to the queue, validating each one before it takes a slot.
 *
 * @param files - Selection from the picker or from a drop.
 */
const addFiles = (files: FileList | null): void => {
  if (files === null || props.disabled === true) {
    return
  }

  for (const file of Array.from(files)) {
    const rejection = validatePhotoFile(file)

    items.value.push({
      id: nextItemId++,
      file,
      previewUrl: URL.createObjectURL(file),
      isPreviewBroken: false,
      title: '',
      altText: '',
      isFeatured: false,
      status: rejection === null ? 'pending' : 'error',
      progress: 0,
      errorMessage: rejection === null ? null : toRejectionMessage(rejection, file),
      rejection
    })
  }
}

/**
 * Reads a selection and clears the native control.
 *
 * @param event - Change event of the file input.
 * @remarks
 * The value is reset so that choosing the same file twice in a row still raises a
 * change event.
 */
const onPick = (event: Event): void => {
  const input = event.target as HTMLInputElement

  addFiles(input.files)
  input.value = ''
}

/**
 * Accepts a native drop.
 *
 * @param event - Drop event of the zone.
 */
const onDrop = (event: DragEvent): void => {
  isDragging.value = false
  addFiles(event.dataTransfer?.files ?? null)
}

/**
 * Drops one item from the list.
 *
 * @param item - Item to discard.
 */
const removeItem = (item: QueueItem): void => {
  if (item.status === 'uploading') {
    return
  }

  URL.revokeObjectURL(item.previewUrl)
  items.value = items.value.filter((entry) => entry.id !== item.id)
}

/** Drops every settled item, keeping what is still pending. */
const clearSettled = (): void => {
  for (const item of items.value) {
    if (item.status === 'done' || item.status === 'error') {
      URL.revokeObjectURL(item.previewUrl)
    }
  }

  items.value = items.value.filter((item) => item.status === 'pending')
}

/**
 * Sends one item.
 *
 * @param item - Item to upload.
 * @param displayOrder - Position the photograph takes inside its category.
 */
const send = async (item: QueueItem, displayOrder: number): Promise<void> => {
  item.status = 'uploading'
  item.progress = 0
  item.errorMessage = null

  const title = item.title.trim()
  const altText = item.altText.trim()

  try {
    const photo = await uploadGalleryPhoto(
      props.categoryId,
      {
        file: item.file,
        title: title === '' ? null : title,
        altText: altText === '' ? null : altText,
        isFeatured: item.isFeatured,
        displayOrder
      },
      {
        onProgress: (progress) => {
          item.progress =
            progress.ratio === null ? item.progress : Math.round(progress.ratio * 100)
        }
      }
    )

    item.status = 'done'
    item.progress = 100
    emit('uploaded', photo)
  } catch (error) {
    item.status = 'error'
    item.errorMessage = toItemMessage(error)

    if (error instanceof ApiError && error.kind === 'rateLimit') {
      isThrottled.value = true
    }
  }
}

/**
 * Drains the queue one file at a time.
 *
 * @remarks
 * The pending item is looked up on every turn instead of iterating a snapshot: the
 * operator can add files or retry a failed one while the queue is running.
 */
const run = async (): Promise<void> => {
  if (isRunning.value) {
    return
  }

  isRunning.value = true
  isThrottled.value = false

  const before = doneCount.value

  try {
    for (;;) {
      const next = items.value.find((item) => item.status === 'pending')

      if (next === undefined || isThrottled.value) {
        break
      }

      await send(next, props.displayOrderOffset + doneCount.value)
    }
  } finally {
    isRunning.value = false
  }

  if (doneCount.value > before) {
    emit('finished')
  }
}

/**
 * Sends one failed item again.
 *
 * @param item - Item to retry.
 */
const retry = (item: QueueItem): void => {
  if (item.rejection !== null) {
    return
  }

  item.status = 'pending'
  item.errorMessage = null
  void run()
}

onBeforeUnmount((): void => {
  for (const item of items.value) {
    URL.revokeObjectURL(item.previewUrl)
  }
})
</script>

<template>
  <div class="space-y-4">
    <div
      class="rounded-lg border border-dashed p-6 text-center transition-colors"
      :class="isDragging ? 'border-primary bg-accent/50' : 'border-input'"
      @dragenter.prevent="isDragging = true"
      @dragover.prevent="isDragging = true"
      @dragleave.prevent="isDragging = false"
      @drop.prevent="onDrop"
    >
      <ImagePlus :size="24" class="mx-auto mb-2 text-muted-foreground" />
      <p class="text-sm font-medium">Arrastra las fotografías aquí</p>
      <p class="mt-1 text-xs text-muted-foreground">
        {{ extensionsLabel }} · hasta {{ MAX_UPLOAD_SIZE_MB }} MB por archivo
      </p>

      <label
        class="mt-3 inline-flex h-9 cursor-pointer items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
        :class="{ 'pointer-events-none opacity-50': disabled }"
      >
        Seleccionar archivos
        <input
          type="file"
          class="sr-only"
          multiple
          :accept="acceptAttribute"
          :disabled="disabled"
          @change="onPick"
        />
      </label>
    </div>

    <div v-if="items.length > 0" class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-xs text-muted-foreground">
          {{ doneCount }} de {{ items.length }} subidas.
          <span v-if="isRunning">Se suben de una en una para no saturar el servidor.</span>
        </p>

        <div class="flex gap-2">
          <Button type="button" variant="outline" size="sm" :disabled="isRunning" @click="clearSettled">
            Limpiar terminadas
          </Button>

          <Button type="button" size="sm" :disabled="isRunning || !hasPending" @click="run">
            <Loader2 v-if="isRunning" :size="16" class="mr-2 animate-spin" />
            {{ isThrottled ? 'Reanudar' : 'Subir' }}
          </Button>
        </div>
      </div>

      <p
        v-if="isThrottled"
        role="alert"
        class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
      >
        La cola se detuvo: el servidor admite {{ PHOTO_UPLOAD_RATE_LIMIT_PER_MINUTE }} subidas por
        minuto. Espera un minuto y pulsa «Reanudar».
      </p>

      <ul class="space-y-3">
        <li
          v-for="item in items"
          :key="item.id"
          class="flex gap-3 rounded-lg border p-3"
          :class="{ 'border-destructive/50': item.status === 'error' }"
        >
          <img
            v-if="!item.isPreviewBroken"
            :src="item.previewUrl"
            :alt="`Previsualización de ${item.file.name}`"
            class="h-20 w-20 shrink-0 rounded-md border object-cover"
            @error="item.isPreviewBroken = true"
          />
          <div
            v-else
            class="flex h-20 w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-md border bg-muted px-1 text-center text-muted-foreground"
            :aria-label="`Sin previsualización de ${item.file.name}`"
          >
            <ImageOff :size="16" />
            <span class="text-[10px] leading-tight">Sin vista previa</span>
          </div>

          <div class="min-w-0 flex-1 space-y-2">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="truncate text-sm font-medium">{{ item.file.name }}</p>
                <p class="text-xs text-muted-foreground">{{ formatSize(item.file.size) }}</p>
              </div>

              <div class="flex shrink-0 items-center gap-1">
                <CheckCircle2 v-if="item.status === 'done'" :size="16" class="text-emerald-600" />
                <TriangleAlert
                  v-else-if="item.status === 'error'"
                  :size="16"
                  class="text-destructive"
                />
                <Loader2
                  v-else-if="item.status === 'uploading'"
                  :size="16"
                  class="animate-spin text-muted-foreground"
                />

                <Button
                  v-if="item.status === 'error' && item.rejection === null"
                  type="button"
                  variant="ghost"
                  size="sm"
                  :disabled="isRunning"
                  :aria-label="`Reintentar ${item.file.name}`"
                  @click="retry(item)"
                >
                  <RotateCcw :size="14" class="mr-1" />
                  Reintentar
                </Button>

                <Button
                  v-if="item.status !== 'uploading'"
                  type="button"
                  variant="ghost"
                  size="icon"
                  class="h-8 w-8"
                  :aria-label="`Quitar ${item.file.name}`"
                  @click="removeItem(item)"
                >
                  <X :size="14" />
                </Button>
              </div>
            </div>

            <div
              v-if="item.status === 'uploading'"
              class="h-1.5 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              :aria-valuenow="item.progress"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-label="`Progreso de ${item.file.name}`"
            >
              <div
                class="h-full bg-primary transition-[width]"
                :style="{ width: `${item.progress}%` }"
              ></div>
            </div>

            <p v-if="item.errorMessage !== null" role="alert" class="text-xs text-destructive">
              {{ item.errorMessage }}
            </p>

            <div v-if="item.status !== 'done' && item.rejection === null" class="grid gap-2 sm:grid-cols-2">
              <input
                v-model="item.title"
                type="text"
                placeholder="Título (opcional)"
                :maxlength="PHOTO_TITLE_MAX_LENGTH"
                :disabled="!isIdle"
                class="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
                :aria-label="`Título de ${item.file.name}`"
              />

              <input
                v-model="item.altText"
                type="text"
                placeholder="Texto alternativo (accesibilidad y SEO)"
                :maxlength="PHOTO_ALT_TEXT_MAX_LENGTH"
                :disabled="!isIdle"
                class="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
                :aria-label="`Texto alternativo de ${item.file.name}`"
              />

              <label class="flex items-center gap-2 text-xs font-medium sm:col-span-2">
                <input
                  v-model="item.isFeatured"
                  type="checkbox"
                  class="h-4 w-4 rounded border-input"
                  :disabled="!isIdle"
                />
                Mostrar en el carrusel del Home
              </label>
            </div>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>
