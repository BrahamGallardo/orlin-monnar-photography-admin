import { createRouter, createWebHistory } from 'vue-router'
import MainLayout from '@/layouts/MainLayout.vue'
import { useSession } from '@/stores/session'

/** Query string key carrying the route to restore after signing in. */
export const REDIRECT_QUERY_KEY = 'redirect'

declare module 'vue-router' {
  interface RouteMeta {
    /** Whether the route requires an active session. Defaults to false. */
    requiresAuth?: boolean
  }
}

const router = createRouter({
  history: createWebHistory('/admin/'),
  routes: [
    {
      path: '/login',
      name: 'Login',
      component: () => import('@/views/Login.vue')
    },
    {
      path: '/',
      component: MainLayout,
      meta: { requiresAuth: true },
      children: [
        {
          path: '',
          name: 'Dashboard',
          component: () => import('@/views/Dashboard.vue')
        },
        {
          path: 'appointments',
          name: 'Appointments',
          component: () => import('@/views/Appointments.vue')
        },
        {
          path: 'packages',
          name: 'Packages',
          component: () => import('@/views/Packages.vue')
        },
        {
          path: 'gallery',
          name: 'Gallery',
          component: () => import('@/views/Gallery.vue')
        }
      ]
    }
  ]
})

/**
 * Keeps private routes behind an active session.
 *
 * @remarks
 * The session survives a reload through `sessionStorage`, but closing the tab or an
 * expired token still lands any deep link here first. The intended route travels in
 * the `redirect` query entry, the same one `@/lib/http` writes when a 401 tears the
 * session down.
 */
router.beforeEach((to) => {
  const { isAuthenticated } = useSession()
  const requiresAuth = to.matched.some((record) => record.meta.requiresAuth === true)

  if (requiresAuth && !isAuthenticated.value) {
    return { name: 'Login', query: { [REDIRECT_QUERY_KEY]: to.fullPath } }
  }

  if (to.name === 'Login' && isAuthenticated.value) {
    return { name: 'Dashboard' }
  }

  return true
})

export default router