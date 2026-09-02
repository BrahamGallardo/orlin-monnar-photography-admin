<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle
} from 'radix-vue'
import { X } from 'lucide-vue-next'
import { cn } from '@/lib/utils'

/**
 * Modal dialog built on the radix-vue primitives.
 *
 * @remarks
 * The title and the description are required rather than optional: radix wires them
 * to `aria-labelledby` and `aria-describedby`, and warns in the console when either
 * is missing.
 */

const props = defineProps<{
  /** Controlled open state. */
  open: boolean
  /** Accessible name of the dialog. */
  title: string
  /** Accessible description, rendered under the title. */
  description: string
  /** Whether Escape and an outside click close the dialog. Defaults to true. */
  dismissible?: boolean
  class?: string
}>()

defineEmits<{
  (event: 'update:open', open: boolean): void
}>()

/**
 * Blocks a dismissal while the dialog is locked.
 *
 * @param event - Escape or outside interaction event raised by radix.
 * @remarks
 * Used while an action is in flight, so the operator does not lose the outcome of a
 * request the server is already processing.
 */
const onDismissAttempt = (event: Event): void => {
  if (props.dismissible === false) {
    event.preventDefault()
  }
}
</script>

<template>
  <DialogRoot :open="open" @update:open="$emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-50 bg-foreground/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0"
      />

      <DialogContent
        :class="
          cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[95vw] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-lg focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95',
            $props.class
          )
        "
        @escape-key-down="onDismissAttempt"
        @interact-outside="onDismissAttempt"
      >
        <div class="flex items-start justify-between gap-4 border-b p-4">
          <div class="space-y-1">
            <DialogTitle class="text-lg font-semibold leading-none tracking-tight">
              {{ title }}
            </DialogTitle>
            <DialogDescription class="text-sm text-muted-foreground">
              {{ description }}
            </DialogDescription>
          </div>

          <DialogClose
            class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            aria-label="Cerrar"
            :disabled="dismissible === false"
          >
            <X :size="18" />
          </DialogClose>
        </div>

        <div class="overflow-y-auto p-4">
          <slot />
        </div>

        <div v-if="$slots.footer" class="border-t bg-muted/40 p-4">
          <slot name="footer" />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>