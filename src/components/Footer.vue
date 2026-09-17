<script setup lang="ts">
import { RouterLink } from 'vue-router'

const navigation = [
  { name: 'Dashboard', path: '/' },
  { name: 'Citas', path: '/appointments' },
  { name: 'Paquetes', path: '/packages' },
  { name: 'Galería', path: '/gallery' }
]
</script>

<template>
  <footer class="bg-card border-t py-6 px-4 md:px-8">
    <div class="flex flex-col md:flex-row items-center justify-between gap-4">
      <!-- Mensaje de Copyright / Crédito -->
      <div class="flex items-center gap-1 text-sm text-muted-foreground">
        <span>© 2026, Designed</span>
        <span>by</span>
        <a 
          href="https://www.creative-tim.com" 
          target="_blank" 
          rel="noopener noreferrer"
          class="text-primary hover:underline"
        >
          Brahm Gallrdo
        </a>
        <span>for a better web.</span>
      </div>

      <!-- Rutas relativas de tu aplicación -->
      <div class="flex items-center gap-6 text-sm">
        <RouterLink 
          v-for="item in navigation" 
          :key="item.path" 
          :to="item.path"
          class="text-muted-foreground hover:text-primary transition-colors"
        >
          {{ item.name }}
        </RouterLink>
      </div>
    </div>
  </footer>
</template>