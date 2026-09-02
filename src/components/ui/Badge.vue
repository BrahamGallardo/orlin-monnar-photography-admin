<script setup lang="ts">
import { computed } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{
  variant?: 'default' | 'success' | 'warning' | 'destructive' | 'muted'
  class?: string
}>()

const badgeClass = computed(() => {
  const baseClass =
    'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors whitespace-nowrap'

  const variantClasses = {
    default: 'border-transparent bg-primary/10 text-primary',
    success: 'border-transparent bg-emerald-500/10 text-emerald-700',
    warning: 'border-transparent bg-amber-500/10 text-amber-700',
    destructive: 'border-transparent bg-destructive/10 text-destructive',
    muted: 'border-transparent bg-muted text-muted-foreground'
  }

  return cn(baseClass, variantClasses[props.variant || 'default'], props.class)
})
</script>

<template>
  <span :class="badgeClass">
    <slot />
  </span>
</template>