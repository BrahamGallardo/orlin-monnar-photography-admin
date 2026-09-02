/**
 * Date and currency formatting helpers.
 *
 * The API sends every date in UTC and every price as a plain number paired with an
 * ISO 4217 code, so presentation lives entirely on the client.
 */

/** Locale used across the admin panel. */
const DEFAULT_LOCALE = 'es-MX'

/** Currency assumed when a DTO carries no explicit code. */
const DEFAULT_CURRENCY = 'MXN'

/** Placeholder rendered for a null or unparsable value. */
const EMPTY_PLACEHOLDER = '—'

/** Matches an ISO 8601 string that already carries a timezone designator. */
const TIMEZONE_SUFFIX = /(?:Z|[+-]\d{2}:?\d{2})$/i

/** Memoized formatters. Building an `Intl` formatter is expensive. */
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>()
const numberFormatters = new Map<string, Intl.NumberFormat>()

/**
 * Parses an ISO 8601 string coming from the API into a `Date`.
 *
 * @param value - ISO 8601 string, or null.
 * @returns The parsed date, or null when the value is absent or invalid.
 * @remarks
 * The backend documents every date as UTC, but System.Text.Json omits the `Z`
 * designator when a `DateTime` reaches it with `Kind = Unspecified`, which is how
 * EF Core materializes a SQL Server `datetime2`. Without the designator the runtime
 * would read the instant as local time and shift it by the offset, so a missing
 * designator is treated as UTC here.
 */
export function parseApiDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const normalized = TIMEZONE_SUFFIX.test(value) ? value : `${value}Z`
  const parsed = new Date(normalized)

  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * Returns a memoized `Intl.DateTimeFormat`.
 *
 * @param options - Formatting options.
 */
function getDateTimeFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options)
  let formatter = dateTimeFormatters.get(key)

  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(DEFAULT_LOCALE, options)
    dateTimeFormatters.set(key, formatter)
  }

  return formatter
}

/**
 * Formats a UTC date from the API in the local timezone.
 *
 * @param value - ISO 8601 string, or null.
 * @param options - Overrides for the default options.
 * @example formatDate('2026-08-14T18:00:00Z') // '14 de agosto de 2026'
 */
export function formatDate(
  value: string | null | undefined,
  options?: Intl.DateTimeFormatOptions
): string {
  const date = parseApiDate(value)

  if (date === null) {
    return EMPTY_PLACEHOLDER
  }

  return getDateTimeFormatter(options ?? { dateStyle: 'long' }).format(date)
}

/**
 * Formats a UTC date and time from the API in the local timezone.
 *
 * @param value - ISO 8601 string, or null.
 * @example formatDateTime('2026-08-14T18:00:00Z') // '14 de agosto de 2026, 12:00 p.m.'
 */
export function formatDateTime(value: string | null | undefined): string {
  return formatDate(value, { dateStyle: 'long', timeStyle: 'short' })
}

/**
 * Formats only the time of a UTC instant in the local timezone.
 *
 * @param value - ISO 8601 string, or null.
 */
export function formatTime(value: string | null | undefined): string {
  return formatDate(value, { timeStyle: 'short' })
}

/**
 * Formats a UTC date as a compact numeric value, suited to table cells.
 *
 * @param value - ISO 8601 string, or null.
 * @example formatShortDate('2026-08-14T18:00:00Z') // '14/08/2026'
 */
export function formatShortDate(value: string | null | undefined): string {
  return formatDate(value, { day: '2-digit', month: '2-digit', year: 'numeric' })
}

/**
 * Returns a memoized `Intl.NumberFormat` for a currency.
 *
 * @param currency - ISO 4217 code.
 */
function getCurrencyFormatter(currency: string): Intl.NumberFormat {
  let formatter = numberFormatters.get(currency)

  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })

    numberFormatters.set(currency, formatter)
  }

  return formatter
}

/**
 * Formats an amount as currency.
 *
 * @param amount - Amount to format, or null.
 * @param currency - ISO 4217 code. Defaults to `MXN`.
 * @example formatCurrency(4500, 'MXN') // '$4,500.00'
 */
export function formatCurrency(
  amount: number | null | undefined,
  currency: string = DEFAULT_CURRENCY
): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) {
    return EMPTY_PLACEHOLDER
  }

  return getCurrencyFormatter(currency).format(amount)
}