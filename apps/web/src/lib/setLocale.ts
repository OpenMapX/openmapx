/**
 * Set the next-intl locale cookie and reload the page.
 * Shared between LanguageMenu and HamburgerMenu.
 */
export function setLocaleAndReload(newLocale: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: next-intl locale cookie must be set synchronously before reload
  document.cookie = `NEXT_LOCALE=${newLocale};path=/;max-age=${365 * 24 * 60 * 60};samesite=lax`;
  window.location.reload();
}
