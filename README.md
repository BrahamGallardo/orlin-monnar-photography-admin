# Orlin Monnar Photography — Admin

Panel de administración del sitio de fotografía: citas, galería (categorías y fotografías), paquetes y un dashboard con los totales del día a día.

SPA en **Vue 3 + Vite + TypeScript** construida sobre el template *Material Dashboard Shadcn Vue* de Creative Tim. Se sirve bajo **`/admin/`** en el mismo dominio que la landing (`/`) y la API (`/api`).

---

## Stack

| Componente | Versión (`package.json`) |
|---|---|
| Vue | ^3.5.12 |
| Vue Router | ^4.4.5 |
| Vite / `@vitejs/plugin-vue` | ^5.4.10 / ^5.1.4 |
| TypeScript / `vue-tsc` | ~5.6.2 / ^2.1.6 |
| Tailwind CSS | ^3.4.14 |
| radix-vue (componentes estilo shadcn-vue) | ^1.9.7 |
| Chart.js / vue-chartjs | ^4.5.0 / ^5.3.2 |
| lucide-vue-next | ^0.453.0 |
| @vueuse/core | ^11.2.0 |

> **Restricción:** no se agregan dependencias ni se usa sintaxis o API posterior a lo declarado en `package.json` y `tsconfig.json` (`target: ES2020`). Por eso, por ejemplo, `AbortSignal.any` se compone a mano en `src/lib/http.ts`. **No hay Pinia ni librería de estado**: el store de sesión es un módulo singleton.

---

## Estructura

```
Orlin Monnar Photography Admin/
├── index.html                  activos con %BASE_URL%, nunca con / absoluto
├── vite.config.ts              base "/admin/" y alias @ → src
├── public/                     favicon (copia del de la landing)
└── src/
    ├── main.ts
    ├── App.vue
    ├── assets/index.css        tokens de color de Tailwind/shadcn
    ├── config/                 configuración por ambiente (JSON tipado)
    │   ├── app.config.development.json
    │   ├── app.config.production.json
    │   └── index.ts            exporta appConfig según import.meta.env.MODE
    ├── lib/
    │   ├── http.ts             cliente HTTP: token, errores, 401, subida con progreso
    │   ├── session.ts          estado de sesión, sessionStorage y renovación proactiva
    │   ├── media.ts            mediaUrl(): resuelve /media contra apiBaseUrl
    │   ├── format.ts           fechas y montos
    │   ├── appointmentStatus.ts
    │   └── utils.ts            cn() de shadcn
    ├── stores/session.ts       useSession(): login, logout, refresh
    ├── services/               un módulo por recurso de la API (sin fetch en las vistas)
    │   ├── appointments.ts  contactMessages.ts  gallery.ts  packages.ts
    ├── types/api.ts            DTO del backend, en camelCase
    ├── router/index.ts         rutas y guarda de sesión
    ├── layouts/MainLayout.vue  sidebar + navbar
    ├── components/
    │   ├── ui/                 Badge, Button, Card*, Dialog, ConfirmDialog, Pagination
    │   ├── AppointmentDetailDialog.vue
    │   ├── GalleryPhotosDialog.vue
    │   ├── PhotoUploadQueue.vue
    │   └── Navbar.vue  Footer.vue
    └── views/
        ├── Login.vue  Dashboard.vue  Appointments.vue
        └── Packages.vue  Gallery.vue
```

Capas: `views/components → services → lib/http → lib/session`. Las vistas nunca llaman a `fetch` ni a `XMLHttpRequest`.

---

## Configuración

La configuración vive en **JSON tipado resuelto en build**, no en archivos `.env`. Se consume siempre con `import { appConfig } from '@/config'`.

| Clave | Desarrollo | Producción |
|---|---|---|
| `apiBaseUrl` | `http://localhost:5081` | `''` (mismo origen) |
| `storage.maxUploadSizeMb` | 25 | 25 |
| `storage.allowedExtensions` | `.jpg .jpeg .png .webp .heic` | igual |

`storage` es una **copia** de la sección `Storage` de `appsettings.json` de la API, solo para rechazar un archivo antes de gastar una petición. Si la API cambia sus límites hay que actualizar ambos JSON; mientras tanto, el 413 del servidor sigue siendo la autoridad.

Si la API se muda a otro dominio, basta con mover la configuración a un JSON en `public/` cambiando únicamente `src/config/index.ts`.

**Ruta base.** `base: "/admin/"` en `vite.config.ts` y `createWebHistory('/admin/')` en `src/router/index.ts` deben mantenerse sincronizados.

---

## Ejecución

Requiere Node.js compatible con Vite 5 y la API corriendo en el **perfil `http` de Kestrel** (`dotnet run --project omp-api` → `localhost:5081`).

```powershell
npm install
npm start          # vite --port 4200  →  http://localhost:4200/admin/
npm run build      # vue-tsc -b && vite build  →  dist/
npm run preview    # sirve dist/ en el puerto 5000
```

El origen del dev server debe estar en `Cors:AllowedOrigins` de `appsettings.Development.json` de la API; `localhost` y `127.0.0.1` en el puerto 4200 ya están. En VS Code, la configuración **Start (Dev)** de `.vscode/launch.json` levanta Vite y abre Edge.

Solo para revisar tipos sin compilar: `npx vue-tsc --noEmit -p tsconfig.json`.

**Credencial de arranque:** la del seed de la API (ver README de Core). Cambiarla antes de producción.

### Producción

`dist/` se publica bajo `/admin/` del dominio, con fallback de `/admin/*` a `/admin/index.html` porque el router usa history mode. CORS no aplica: panel y API comparten origen.

> `server.js` es del template y apunta a `/material-dashboard-shadcn-vue`; **no se usa** para servir el panel. `INSTALLATION.md` y `CHANGELOG.md` también describen el template original.

---

## Convenciones

Estas reglas salieron de romper cosas y no son opcionales.

**Sesión.** El token viaja como `Bearer` y la sesión se guarda en `sessionStorage` (`omp-admin.session`): recargar no pide login, cerrar la pestaña sí. `localStorage` se evita a propósito para que el token no sobreviva a la pestaña.

**Renovación proactiva, no reactiva.** La API emite un token rodante sin refresh token: `POST /api/auth/refresh` es `[Authorize]` y responde 401 si el token ya expiró. Por eso `src/lib/session.ts` renueva al **80 % de la vida del token** a partir de `expiresAt`. El reintento único ante un 401 que hace `http.ts` solo sirve dentro de la ventana de *clock skew*; si falla, se limpia la sesión y se redirige a `/login?redirect=<ruta>`.

**Modelo de errores único.** Todo fallo sale como `ApiError` con `kind` (`validation`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `payloadTooLarge`, `rateLimit`, `cancelled`, `server`, `network`, `timeout`). `fieldErrors` solo se llena con los `errors` de `ValidationProblemDetails`; un 400 del handler global llega sin campos y la UI debe tolerarlo. **413 y 429 llegan sin cuerpo** y se cortan antes de leerlo.

**Contrato de la API.** El JSON viaja en **camelCase** aunque los DTO de C# estén en PascalCase, y los nulos sí se serializan. `SessionDto` trae el usuario **anidado** en `user`. Los DTO del núcleo están en los DLL de BrahmCQRS: para conocer un contrato se revisa el DLL y el DDL, nunca se infiere del nombre.

**Filtros en la querystring.** Los listados leen sus filtros y página de la ruta (`status`, `from`, `to`, `page`, `detail`, `deactivated`…) para que cada vista sea enlazable y recargable. Las fechas de la ruta son locales (`yyyy-MM-dd`); la conversión a UTC ocurre al llamar al servicio, con fin de día inclusivo.

**Publicar y despublicar.** Se usan los endpoints dedicados (`DELETE /{id}` y `POST /{id}/reactivate`), nunca un `PUT` con el flag cambiado. En categorías, `activated` **siempre** viaja en el cuerpo del alta y la edición: omitirlo republica en silencio. El formulario de edición se abre con los datos de la fila, porque el `GET` por id responde 404 para lo despublicado.

**Subida de fotografías.** Multipart con la parte `file` y metadatos planos (`GalleryCategoryId`, `Title`, `AltText`, `DisplayOrder`, `IsFeatured`). Va por `upload()` de `http.ts`, que usa `XMLHttpRequest` solo para reportar progreso, con timeout de 120 s. La cola (`PhotoUploadQueue.vue`) es **estrictamente secuencial**, numera `DisplayOrder` a partir del total de la categoría y se detiene completa ante un 429. El backend nunca responde 415.

**Imágenes.** Las rutas `/media/...` se resuelven con `mediaUrl()` contra `apiBaseUrl`; en desarrollo el panel y la API están en puertos distintos.

**Componentes.** Un prop booleano opcional con default `true` se declara con `withDefaults`: Vue convierte el prop ausente en `false`. `ConfirmDialog` (`warning`) y `Pagination` (`singularLabel`/`pluralLabel`) reciben su copy por props; sus defaults son los de citas.

**Estilo.** JSDoc en inglés; textos de la interfaz en español.

---

## API consumida

Todo bajo `Authorization: Bearer`, salvo el login.

| Método | Ruta | Usado en |
|---|---|---|
| POST | `/api/auth/login` · `/refresh` · `/logout` | Login, sesión |
| GET | `/api/admin/appointments?status&startDateUtc&endDateUtc&pageIndex&pageSize` | Citas, Dashboard |
| GET | `/api/admin/appointments/upcoming?take=n` | Dashboard |
| GET | `/api/admin/appointments/{id}` | Detalle de cita |
| POST | `/api/admin/appointments/{id}/confirm` · `/cancel` · `/complete` | Detalle de cita |
| GET | `/api/admin/contact-messages/status/{status}` | Dashboard |
| GET · POST | `/api/admin/gallery/categories` | Galería |
| GET · PUT · DELETE | `/api/admin/gallery/categories/{id}` | Galería |
| POST | `/api/admin/gallery/categories/{id}/reactivate` | Galería |
| GET | `/api/admin/gallery/categories/{id}/photos` | Fotos de la categoría |
| POST | `/api/admin/gallery/photos` (multipart) | Subida |
| PUT · DELETE | `/api/admin/gallery/photos/{id}` | Fotos de la categoría |
| PUT | `/api/admin/gallery/photos/reorder` | Fotos de la categoría |
| GET | `/api/packages/admin` | Paquetes |
| POST | `/api/packages` | Paquetes |
| GET · PUT · DELETE | `/api/packages/{id}` | Paquetes |
| POST | `/api/packages/{id}/reactivate` | Paquetes |

Límites relevantes del backend: el login admite 5 intentos por minuto por IP y las subidas 60 por minuto por usuario.

---

## Estado

| Tarea | Estado |
|---|---|
| A1a — Saneado del template y base `/admin` | Completo |
| A1b — Cliente HTTP con JWT | Completo |
| A2 — Login, sesión y guardas de ruta | Completo (la sesión sobrevive a la recarga) |
| A3a — Listado de citas | Completo |
| A3b — Detalle de cita y acciones | Completo (confirmar, cancelar y completar) |
| A4a — CRUD de categorías de galería | Completo |
| A4b — Subida de fotografías | Completo |
| A4c — Reordenamiento y borrado de fotografías | Completo |
| A5 — Dashboard | Completo |
| A6a — Listado de paquetes | Completo |
| A6b — Alta y edición de paquetes | Completo |
| T30 — Reverse proxy y rutas de producción | Pendiente |

Los mensajes de contacto solo se cuentan en el dashboard; no hay vista para gestionarlos.

Referencia completa: `Plan de Arquitectura y Roadmap Técnico - Orlin Monnar Photography.docx` y `Plan de Trabajo y Prompts - Orlin Monnar Photography.md`.
