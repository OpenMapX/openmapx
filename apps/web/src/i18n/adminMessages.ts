import type { AbstractIntlMessages } from "next-intl";

/**
 * Catalogue namespaces only admin pages read. The root layout leaves them out
 * of every page's payload; the admin layout sends only these namespaces, and
 * `AdminMessagesProvider` merges them with the public catalogue already on
 * the page. Admin code rendered on public pages, such as the impersonation
 * banner and the unsaved-draft guard, reads public namespaces.
 */
export const ADMIN_NAMESPACES: ReadonlySet<string> = new Set([
  "adminActivity",
  "adminCoverage",
  "adminExtensions",
  "adminIntegrations",
  "adminNavigation",
  "adminOverview",
  "adminPages",
  "adminSearchIndex",
  "adminServices",
  "adminSettings",
  "adminShared",
  "adminTransit",
  "adminUsers",
  "privacyAdmin",
  "privacySetup",
]);

export function withoutAdminMessages(messages: AbstractIntlMessages): AbstractIntlMessages {
  return Object.fromEntries(
    Object.entries(messages).filter(([namespace]) => !ADMIN_NAMESPACES.has(namespace)),
  );
}

/** The admin namespaces alone, which admin pages add to the public catalogue. */
export function onlyAdminMessages(messages: AbstractIntlMessages): AbstractIntlMessages {
  return Object.fromEntries(
    Object.entries(messages).filter(([namespace]) => ADMIN_NAMESPACES.has(namespace)),
  );
}
