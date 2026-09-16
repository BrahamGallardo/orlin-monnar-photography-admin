import { appConfig } from '@/config'

/**
 * Resolves a media URL served by the API.
 *
 * @param url - Public URL as stored by the backend, root relative such as `/media/...`.
 * @remarks
 * `StorageSettings.PublicBaseUrl` is `/media`, so the URL resolves on its own only when
 * the panel and the API share an origin, which is the production layout. In development
 * `appConfig.apiBaseUrl` points at the API and has to prefix it.
 */
export function mediaUrl(url: string): string {
  return url.startsWith('/') ? `${appConfig.apiBaseUrl.replace(/\/+$/, '')}${url}` : url
}
