<script setup lang="ts">
import {
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle
} from 'radix-vue'
import { AlertTriangle, Loader2 } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'

/**
 * Confirmation step for an action that cannot be undone.
 *
 * @remarks
 * `AlertDialogAction` is not used: it extends `DialogCloseProps` and would dismiss the
 * dialog on click, before the request settles. The parent owns the open state instead,
 * so a failure keeps the dialog open showing {@link errorMessage}.
 */

const props = defineProps<{
  /** Controlled open state. */
  open: boolean
  /** Accessible name of the dialog. */
  title: string
  /** What the action does, including its side effects. */
  description: string
  /** Label of the confirming button. */
  confirmLabel: string
  /** Whether the confirming button is styled as destructive. */
  destructive?: boolean
  /** Whether the action is in flight. Locks every control. */
  isBusy?: boolean
  /** Failure of the last attempt, if any. */
  errorMessage?: string | null
}>()

const emit = defineEmits<{
  (event: 'update:open', open: boolean): void
  (event: 'confirm'): void
}>()

/**
 * Blocks a dismissal while the action is in flight.
 *
 * @param event - Escape or outside interaction event raised by radix.
 */
const onDismissAttempt = (event: Event): void => {
  if (props.isBusy === true) {
    event.preventDefault()
  }
}
</script>

<template>
  <AlertDialogRoot :open="open" @update:open="emit('update:open', $event)">
    <AlertDialogPortal>
      <AlertDialogOverlay
        class="fixed inset-0 z-50 bg-foreground/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0"
      />

      <AlertDialogContent
        class="fixed left-1/2 top-1/2 z-50 w-[95vw] max-w-md -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-lg border bg-card p-4 text-card-foreground shadow-lg focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0"
        @escape-key-down="onDismissAttempt"
        @interact-outside="onDismissAttempt"
      >
        <div class="space-y-1.5">
          <AlertDialogTitle class="text-lg font-semibold leading-none tracking-tight">
            {{ title }}
          </AlertDialogTitle>
          <AlertDialogDescription class="text-sm text-muted-foreground">
            {{ description }}
          </AlertDialogDescription>
        </div>

        <div class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
          <AlertTriangle :size="16" class="mt-0.5 shrink-0 text-amber-700" />
          <p class="text-xs text-amber-700">
            Esta acción envía un correo automático al cliente. No se puede deshacer.
          </p>
        </div>

        <slot />

        <p v-if="errorMessage" role="alert" class="text-sm text-destructive">
          {{ errorMessage }}
        </p>

        <div class="flex justify-end gap-2">
          <AlertDialogCancel as-child>
            <Button type="button" variant="outline" :disabled="isBusy === true">Volver</Button>
          </AlertDialogCancel>

          <Button
            type="button"
            :variant="destructive === true ? 'default' : 'default'"
            :class="destructive === true ? 'bg-destructive hover:bg-destructive/90' : undefined"
            :disabled="isBusy === true"
            @click="emit('confirm')"
          >
            <Loader2 v-if="isBusy === true" :size="16" class="mr-2 animate-spin" />
            {{ confirmLabel }}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>