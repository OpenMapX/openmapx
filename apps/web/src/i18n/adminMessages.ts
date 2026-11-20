import type { AbstractIntlMessages } from "next-intl";

/**
 * Catalogue namespaces only admin pages read. The root layout leaves them out
 * of every page's payload, and the admin layout provides the full catalogue
 * to its own pages. Admin code rendered on public pages, such as the
 * impersonation banner and the unsaved-draft guard, reads public namespaces.
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
