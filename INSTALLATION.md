# Orlin Monnar Photography — Admin · Instalación

Guía para levantar el panel en una máquina de desarrollo y generar el build de producción. Qué hace el panel, sus convenciones y la API que consume están en el `README.md`.

---

## Requisitos

| Herramienta | Versión |
|---|---|
| Node.js | 18, o 20 y posteriores (lo exige Vite 5.4) |
| npm | el que trae Node |
| API `omp-api` | corriendo en el perfil `http` de Kestrel (`localhost:5081`) |

La API tiene sus propios requisitos (SDK de .NET 8, SQL Server, user secrets). Están en el README de **Orlin Monnar Photography Core**.

---

## 1. Instalar dependencias

```powershell
# desde la carpeta del panel
npm install
```

> `node_modules` depende del sistema operativo: Rollup instala un binario nativo por plataforma. Un `node_modules` instalado en Windows no sirve en Linux ni en WSL, y al revés. Si cambias de entorno, bórralo y vuelve a correr `npm install` ahí.

No se agregan paquetes nuevos al proyecto (ni `axios`, ni `pinia`, ni librerías de UI). El cliente HTTP, el store de sesión y los componentes base ya existen en `src/`.

---

## 2. Revisar la configuración

No hay archivos `.env`. La configuración está en JSON versionados, uno por ambiente:

```
src/config/app.config.development.json   → npm start
src/config/app.config.production.json    → npm run build
```

En desarrollo, `apiBaseUrl` debe apuntar a la API:

```json
{
  "apiBaseUrl": "http://localhost:5081",
  "storage": {
    "maxUploadSizeMb": 25,
    "allowedExtensions": [".jpg", ".jpeg", ".png", ".webp", ".heic"]
  }
}
```

Si levantas la API en otro puerto (por ejemplo con el perfil IIS Express), ajusta solo `apiBaseUrl`. Los valores de `storage` deben coincidir con la sección `Storage` del `appsettings.json` de la API.

En producción, `apiBaseUrl` se queda como `""`: el panel y la API comparten origen.

---

## 3. Permitir el origen del panel en la API

En `appsettings.Development.json` de `omp-api`, el origen del dev server debe aparecer en `Cors:AllowedOrigins`:

```json
"Cors": {
  "AllowedOrigins": [
    "http://localhost:4200",
    "http://127.0.0.1:4200"
  ]
}
```

Ya están incluidos. Solo hay que tocarlo si cambias el puerto del panel.

---

## 4. Levantar el panel

```powershell
npm start
```

Abre **`http://localhost:4200/admin/`**. La barra final importa: el panel vive bajo `/admin/` también en desarrollo.

Desde VS Code, **Run and Debug → Start (Dev)** hace lo mismo y abre Edge. Al detener la depuración, la tarea `kill: vite` libera el puerto 4200.

> El puerto 5000 que aparece en `vite.config.ts` solo aplica a `npm run preview`; `npm start` lo reemplaza con `--port 4200`.

### Comprobar que todo está conectado

1. Entra con el administrador del seed de la API (usuario y contraseña en el README de Core).
2. El dashboard debe mostrar totales, próximas citas y la gráfica por estatus sin avisos de error.
3. Recarga la página: la sesión debe mantenerse. Cierra la pestaña y vuelve a abrir: debe pedir el login.

Si el login responde *Sin conexión con el servidor*, la API no está corriendo o `apiBaseUrl` no apunta a ella.

---

## 5. Verificar tipos

```powershell
npx vue-tsc --noEmit -p tsconfig.json
```

Es el mismo chequeo que corre `npm run build` antes de empaquetar, pero sin generar archivos.

---

## 6. Build de producción

```powershell
npm run build      # vue-tsc -b && vite build  →  dist/
npm run preview    # sirve dist/ en http://localhost:4173/admin/ … o el puerto 5000 configurado
```

`dist/` es lo que se despliega. Todos sus activos ya llevan el prefijo `/admin/`.

### Publicar bajo `/admin`

El servidor debe cumplir dos cosas:

- Servir `dist/` en `/admin/`.
- Responder `index.html` para cualquier ruta bajo `/admin/` que no sea un archivo, porque el router usa *history mode*. Sin esto, recargar `/admin/appointments` da 404.

Referencia para nginx (la configuración definitiva del sitio es la tarea T30):

```nginx
location /admin/ {
    alias     /var/www/omp/admin/;
    try_files $uri $uri/ /admin/index.html;
}
```

> `server.js` es del template, sirve la ruta `/material-dashboard-shadcn-vue` y **no** se usa para desplegar el panel.

---

## Agregar una vista

Así se agregó cada módulo del panel (citas, galería, paquetes):

1. **Tipos.** Los DTO nuevos van en `src/types/api.ts`, en camelCase, tal como los serializa la API.
2. **Servicio.** Crea `src/services/<recurso>.ts` con una constante `BASE_PATH` y una función por endpoint sobre `http` de `@/lib/http`. Las longitudes máximas y los tamaños de página se exportan como constantes desde ahí.
3. **Vista.** Crea `src/views/<Recurso>.vue` con `<script setup lang="ts">`. La vista solo llama al servicio, lee sus filtros y su página de la querystring, y maneja los fallos por `ApiError.kind`.
4. **Ruta.** Agrégala como hija de `/` en `src/router/index.ts`. Así hereda `requiresAuth` y se pinta dentro de `MainLayout`:

```ts
   {
     path: 'resource',
     name: 'Resource',
     component: () => import('@/views/Resource.vue')
   }
```

5. **Menú.** Agrega la entrada al arreglo `navigation` de `src/layouts/MainLayout.vue`, con un icono de `lucide-vue-next`.

El JSDoc se escribe en inglés y los textos de la interfaz en español.

---

## Problemas comunes

**Error de CORS en la consola.** El origen del panel no está en `Cors:AllowedOrigins` de la API, o la API corre con un ambiente distinto de `Development`.

**Página en blanco o activos con 404 en desarrollo.** Entraste por `http://localhost:4200/` en lugar de `/admin/`.

**404 al recargar en producción.** Falta el *fallback* a `/admin/index.html` en el servidor.

**`Cannot find module @rollup/rollup-…`.** El `node_modules` es de otro sistema operativo. Reinstálalo en el entorno donde vas a compilar.

**El puerto 4200 está ocupado.** Corre la tarea `kill: vite` de VS Code o `npx kill-port 4200`.

**Te saca al login a media sesión.** El token expiró sin que se pudiera renovar (por ejemplo, la computadora estuvo suspendida más que la vida del token). Es el comportamiento esperado: la API no emite refresh token.

**"Demasiadas solicitudes" en el login.** El endpoint admite 5 intentos por minuto por IP. Espera un minuto.

**"Archivo demasiado grande" al subir fotos.** El archivo supera `Storage:MaxUploadSizeMB`. Si en producción aparece con archivos más chicos, el límite de cuerpo del proxy está por debajo del de la API.