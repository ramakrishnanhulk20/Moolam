/**
 * The reason's place while its sentence is formatted: a private-use character
 * no translation or library message can contain.
 */
const REASON_SLOT = "";

/** The slot with the colon before it, in the plain and the full-width form. */
const REASON_CUT = /\s*[:：]?\s*/u;

/**
 * Formats a failure sentence that carries a {reason} and cuts the reason out
 * again with the colon before it, so the translated sentence stands alone in
 * every language and the library's English waits under Details instead.
 *
 * `format` receives the value to pass as `reason`, for example
 * `withoutReason((reason) => t("error", { reason }))`.
 */
export function withoutReason(format: (reason: string) => string): string {
  return format(REASON_SLOT).replace(REASON_CUT, "");
}
