<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRoute, useRouter, type LocationQueryValue, type RouteLocationRaw } from 'vue-router'
import { LogIn, Loader2 } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import CardContent from '@/components/ui/CardContent.vue'
import CardHeader from '@/components/ui/CardHeader.vue'
import CardTitle from '@/components/ui/CardTitle.vue'
import { ApiError } from '@/lib/http'
import { REDIRECT_QUERY_KEY } from '@/router'
import { useSession } from '@/stores/session'

const route = useRoute()
const router = useRouter()
const { login } = useSession()

const email = ref('')
const password = ref('')
const isSubmitting = ref(false)
const errorMessage = ref<string | null>(null)

/**
 * Turns a failure into a message for this view.
 *
 * @param error - Failure raised by the store.
 * @remarks
 * `ApiError` carries Spanish copy meant for the rest of the panel, so the login view
 * branches on `kind` and writes its own English messages instead of showing `detail`.
 */
const toMessage = (error: unknown): string => {
  if (!(error instanceof ApiError)) {
    return 'Something went wrong. Please try again.'
  }

  switch (error.kind) {
    case 'unauthorized':
      return 'Invalid email or password.'
    case 'rateLimit':
      return 'Too many sign-in attempts. Please wait a minute and try again.'
    case 'validation':
      return 'Please check the information entered and try again.'
    case 'network':
      return 'Cannot reach the server. Check your connection and try again.'
    case 'timeout':
      return 'The server took too long to respond. Please try again.'
    default:
      return 'Something went wrong. Please try again later.'
  }
}

/**
 * Resolves where to go after a successful sign in.
 *
 * @param value - Raw `redirect` query entry.
 * @remarks Only same site absolute paths are accepted, to rule out an open redirect.
 */
const resolveRedirect = (
  value: LocationQueryValue | LocationQueryValue[]
): RouteLocationRaw => {
  const target = Array.isArray(value) ? value[0] : value

  if (typeof target === 'string' && target.startsWith('/') && !target.startsWith('//')) {
    return target
  }

  return { name: 'Dashboard' }
}

const handleSubmit = async (): Promise<void> => {
  if (isSubmitting.value) {
    return
  }

  isSubmitting.value = true
  errorMessage.value = null

  try {
    await login({ email: email.value.trim(), password: password.value })
    await router.replace(resolveRedirect(route.query[REDIRECT_QUERY_KEY]))
  } catch (error) {
    errorMessage.value = toMessage(error)
    password.value = ''
  } finally {
    isSubmitting.value = false
  }
}

const canSubmit = computed(
  (): boolean => !isSubmitting.value && email.value.trim() !== '' && password.value !== ''
)
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-background p-4">
    <Card class="w-full max-w-sm">
      <CardHeader class="p-8 pb-4 text-center">
        <div
          class="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground"
        >
          <LogIn :size="22" />
        </div>
        <CardTitle class="pt-2">Orlin Monnar Photography</CardTitle>
        <p class="text-sm text-muted-foreground">Sign in to the admin panel</p>
      </CardHeader>

      <CardContent class="p-8 pt-0">
        <form class="space-y-4" novalidate @submit.prevent="handleSubmit">
          <div class="space-y-1.5">
            <label for="email" class="text-sm font-medium">Email</label>
            <input
              id="email"
              v-model="email"
              type="email"
              name="email"
              autocomplete="username"
              required
              autofocus
              :disabled="isSubmitting"
              class="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
            />
          </div>

          <div class="space-y-1.5">
            <label for="password" class="text-sm font-medium">Password</label>
            <input
              id="password"
              v-model="password"
              type="password"
              name="password"
              autocomplete="current-password"
              required
              :disabled="isSubmitting"
              class="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
            />
          </div>

          <p
            v-if="errorMessage !== null"
            role="alert"
            class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {{ errorMessage }}
          </p>

          <Button type="submit" class="w-full" :disabled="!canSubmit">
            <Loader2 v-if="isSubmitting" :size="18" class="mr-2 animate-spin" />
            <span>{{ isSubmitting ? 'Signing in…' : 'Sign in' }}</span>
          </Button>
        </form>
      </CardContent>
    </Card>
  </div>
</template>