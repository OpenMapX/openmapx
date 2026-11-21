import { SCORE_CUTOFF, scoreCommand } from "@openmapx/command-palette";
import { adminDataOperationHref } from "./adminDataNavigation";
import { type AdminNavigationAccess, adminDestinations } from "./adminNavigation";
import type { AdminTranslator } from "./adminTranslator";
export interface AdminSearchEntry {
  id: string;
  title: string;
  description: string;
  href: string;
  keywords?: readonly string[];
}
export interface AdminSearchMetadata {
  settings?: readonly {
    key: string;
    group: string;
    subgroup?: string;
    label: string;
    description?: string;
  }[];
  services?: readonly { id: string; name: string }[];
  integrations?: readonly { id: string; name: string }[];
  operations?: readonly {
    id: string;
    title: string;
    description: string;
    fields?: readonly { label: string }[];
  }[];
}
const SETTINGS_OWNERS: Record<string, string> = {
  general: "general",
  auth: "authentication",
  email: "email",
  map: "map",
  policy: "data-use",
};
export function adminSettingHref(setting: { group: string; subgroup?: string; key: string }) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(setting.key)) return null;
  if (setting.group === "legal")
    return `/admin/privacy-setup?field=${encodeURIComponent(setting.key)}#${setting.subgroup === "retention" || setting.subgroup === "sources" ? "retention" : "operator"}`;
  const owner = SETTINGS_OWNERS[setting.group];
  return owner ? `/admin/settings/${owner}?field=${encodeURIComponent(setting.key)}` : null;
}
/** Controls inside a page that search offers directly; keys name their `adminShared.search` copy. */
const SHORTCUTS = [
  {
    id: "email-smtp",
    href: "/admin/settings/email?field=smtpHost",
    hostOnly: false,
    titleKey: "emailSmtpTitle",
    descriptionKey: "emailSmtpDescription",
    keywordsKey: "emailSmtpKeywords",
  },
  {
    id: "transit-sources",
    href: "/admin/data/transit?tab=sources",
    hostOnly: false,
    titleKey: "transitSourcesTitle",
    descriptionKey: "transitSourcesDescription",
    keywordsKey: "transitSourcesKeywords",
  },
  {
    id: "backup-retention",
    href: "/admin/system/backups#backup-retention",
    hostOnly: true,
    titleKey: "backupRetentionTitle",
    descriptionKey: "backupRetentionDescription",
    keywordsKey: "backupRetentionKeywords",
  },
  {
    id: "release-selector",
    href: "/admin/system/updates#release-selector",
    hostOnly: true,
    titleKey: "releaseSelectorTitle",
    descriptionKey: "releaseSelectorDescription",
    keywordsKey: "releaseSelectorKeywords",
  },
] as const;
type AdminSearchShortcut = (typeof SHORTCUTS)[number];

/** Search copy in the reader's language. */
export interface AdminSearchCopy {
  destination(id: string): { title: string; description: string };
  shortcut(shortcut: AdminSearchShortcut): {
    title: string;
    description: string;
    keywords: readonly string[];
  };
  integration: string;
  service: string;
}

/**
 * Builds search copy from the `adminNavigation` and `adminShared` catalogues.
 * Shortcut keywords are one comma-separated message per locale.
 */
export function adminSearchCopy(
  navigation: AdminTranslator<"adminNavigation">,
  shared: AdminTranslator<"adminShared">,
): AdminSearchCopy {
  return {
    destination: (id) => ({
      title: navigation(`destinations.${id}.label`),
      description: navigation(`destinations.${id}.description`),
    }),
    shortcut: (shortcut) => ({
      title: shared(`search.${shortcut.titleKey}`),
      description: shared(`search.${shortcut.descriptionKey}`),
      keywords: shared(`search.${shortcut.keywordsKey}`)
        .split(",")
        .map((keyword) => keyword.trim())
        .filter(Boolean),
    }),
    integration: shared("search.integration"),
    service: shared("search.service"),
  };
}

export function buildAdminSearchEntries(
  access: AdminNavigationAccess,
  copy: AdminSearchCopy,
  metadata: AdminSearchMetadata = {},
): AdminSearchEntry[] {
  const entries: AdminSearchEntry[] = adminDestinations(access).map((entry) => ({
    id: entry.id,
    ...copy.destination(entry.id),
    href: entry.href,
  }));
  if (access.role !== "admin") return entries;
  for (const shortcut of SHORTCUTS)
    if (!shortcut.hostOnly || access.selfHosted !== false)
      entries.push({ id: shortcut.id, ...copy.shortcut(shortcut), href: shortcut.href });
  for (const setting of metadata.settings ?? []) {
    const href = adminSettingHref(setting);
    if (href)
      entries.push({
        id: `setting:${setting.key}`,
        title: setting.label,
        description: setting.description ?? setting.group,
        href,
        keywords: [setting.key],
      });
  }
  for (const entry of metadata.integrations ?? [])
    entries.push({
      id: `integration:${entry.id}`,
      title: entry.name,
      description: copy.integration,
      href: `/admin/integrations/${encodeURIComponent(entry.id)}`,
      keywords: [entry.id],
    });
  if (access.selfHosted !== false)
    for (const entry of metadata.services ?? [])
      entries.push({
        id: `service:${entry.id}`,
        title: entry.name,
        description: copy.service,
        href: `/admin/system/services/${encodeURIComponent(entry.id)}`,
        keywords: [entry.id],
      });
  for (const entry of access.selfHosted === false ? [] : (metadata.operations ?? []))
    entries.push({
      id: `operation:${entry.id}`,
      title: entry.title,
      description: entry.description,
      href: adminDataOperationHref(entry.id),
      keywords: [entry.id, ...(entry.fields ?? []).map((field) => field.label)],
    });
  return entries;
}
export function searchAdminEntries(entries: AdminSearchEntry[], query: string): AdminSearchEntry[] {
  if (query.length > 200) return [];
  if (!query.trim()) return entries.slice(0, 30);
  return entries
    .map((entry) => ({
      entry,
      score: scoreCommand(query, {
        id: entry.id,
        group: "actions",
        iconKey: "",
        label: entry.title,
        sublabel: entry.description,
        keywords: [...(entry.keywords ?? [])],
        run() {},
      }),
    }))
    .filter(({ score }) => score >= SCORE_CUTOFF)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30)
    .map(({ entry }) => entry);
}
