<script setup lang="ts">
import { computed } from 'vue'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import { cn } from '@/lib/utils'

/** Maximum number of numbered buttons rendered around the current page. */
const MAX_PAGE_BUTTONS = 5

const props = defineProps<{
  /** One based index of the current page. */
  pageIndex: number
  /** Total number of pages reported by the backend. */
  totalPages: number
  /** Total number of items across every page. */
  totalCount: number
  /** Requested page size. */
  pageSize: number
  hasPreviousPage: boolean
  hasNextPage: boolean
  /** Blocks every control, while a page is being fetched. */
  disabled?: boolean
  /** Singular noun of the paged resource. Defaults to `cita`. */
  singularLabel?: string
  /** Plural noun of the paged resource. Defaults to `citas`. */
  pluralLabel?: string
  class?: string
}>()

const emit = defineEmits<{
  (event: 'change', pageIndex: number): void
}>()

/**
 * Noun matching the number of items reported by the backend.
 *
 * @remarks
 * The appointments wording is the default: it is the only caller that predates these
 * props, and keeping it here leaves that view untouched.
 */
const itemLabel = computed((): string =>
  props.totalCount === 1 ? (props.singularLabel ?? 'cita') : (props.pluralLabel ?? 'citas')
)

/**
 * Numbered pages to render, as a window centred on the current page.
 *
 * @remarks
 * The window is clamped on both ends so that it always holds
 * {@link MAX_PAGE_BUTTONS} entries whenever there are enough pages.
 */
const pages = computed((): number[] => {
  if (props.totalPages <= 0) {
    return []
  }

  const half = Math.floor(MAX_PAGE_BUTTONS / 2)
  const end = Math.min(props.totalPages, Math.max(1, props.pageIndex - half) + MAX_PAGE_BUTTONS - 1)
  const start = Math.max(1, end - MAX_PAGE_BUTTONS + 1)
  const result: number[] = []

  for (let page = start; page <= end; page += 1) {
    result.push(page)
  }

  return result
})

/** Position of the first item of the current page, one based. */
const rangeStart = computed((): number =>
  props.totalCount === 0 ? 0 : (props.pageIndex - 1) * props.pageSize + 1
)

/** Position of the last item of the current page. */
const rangeEnd = computed((): number =>
  Math.min(props.pageIndex * props.pageSize, props.totalCount)
)

/**
 * Requests a page change, ignoring out of range and redundant targets.
 *
 * @param pageIndex - One based index of the requested page.
 */
const goTo = (pageIndex: number): void => {
  if (
    props.disabled === true ||
    pageIndex === props.pageIndex ||
    pageIndex < 1 ||
    pageIndex > props.totalPages
  ) {
    return
  }

  emit('change', pageIndex)
}
</script>

<template>
  <div
    :class="cn('flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between', $props.class)"
  >
    <p class="text-sm text-muted-foreground">
      Mostrando {{ rangeStart }}–{{ rangeEnd }} de {{ totalCount }} {{ itemLabel }}
    </p>

    <nav class="flex items-center gap-1" aria-label="Paginación">
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label="Página anterior"
        :disabled="disabled === true || !hasPreviousPage"
        @click="goTo(pageIndex - 1)"
      >
        <ChevronLeft :size="16" />
      </Button>

      <Button
        v-for="page in pages"
        :key="page"
        type="button"
        :variant="page === pageIndex ? 'default' : 'outline'"
        size="icon"
        :aria-current="page === pageIndex ? 'page' : undefined"
        :disabled="disabled === true"
        @click="goTo(page)"
      >
        {{ page }}
      </Button>

      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label="Página siguiente"
        :disabled="disabled === true || !hasNextPage"
        @click="goTo(pageIndex + 1)"
      >
        <ChevronRight :size="16" />
      </Button>
    </nav>
  </div>
</template>