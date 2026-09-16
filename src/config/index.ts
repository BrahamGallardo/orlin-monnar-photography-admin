import developmentConfig from './app.config.development.json'
import productionConfig from './app.config.production.json'

/**
 * Mirror of the backend `Storage` section, limited to what the panel needs to reject a
 * file before spending a request on it.
 *
 * @remarks
 * These values are configuration, not data annotations: the API reads them from
 * `appsettings.json` and a deployment can change them, which is why they live here
 * instead of next to the length constants of `@/services/gallery`. They are a *copy*:
 * if the API raises its limit and this file is not updated, the panel keeps rejecting
 * a file the server would have accepted, so the 413 handling stays the authority.
 */
export interface StorageConfig {
  /** Maximum size of a single upload, in megabytes. Mirrors `Storage:MaxUploadSizeMB`. */
  maxUploadSizeMb: number
  /** Accepted extensions, lowercase and dot prefixed. Mirrors `Storage:AllowedExtensions`. */
  allowedExtensions: string[]
}

/**
 * Application settings resolved at build time.
 */
export interface AppConfig {
  /** Base URL of the backend API. Empty string means same origin. */
  apiBaseUrl: string
  /** Upload limits enforced by the API. */
  storage: StorageConfig
}

const configByMode: Record<string, AppConfig> = {
  development: developmentConfig,
  production: productionConfig
}

export const appConfig: AppConfig = configByMode[import.meta.env.MODE] ?? developmentConfig
