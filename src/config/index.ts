import developmentConfig from './app.config.development.json'
import productionConfig from './app.config.production.json'

/**
 * Application settings resolved at build time.
 */
export interface AppConfig {
  /** Base URL of the backend API. Empty string means same origin. */
  apiBaseUrl: string
}

const configByMode: Record<string, AppConfig> = {
  development: developmentConfig,
  production: productionConfig
}

export const appConfig: AppConfig = configByMode[import.meta.env.MODE] ?? developmentConfig
