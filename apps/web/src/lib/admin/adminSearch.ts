import { SCORE_CUTOFF, scoreCommand } from "@openmapx/command-palette";
import { type AdminNavigationAccess, adminDestinations } from "./adminNavigation";
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
export function buildAdminSearchEntries(
  access: AdminNavigationAccess,
  metadata: AdminSearchMetadata = {},
): AdminSearchEntry[] {
  const entries: AdminSearchEntry[] = adminDestinations(access).map((entry) => ({
    id: entry.id,
    title: entry.label,
    description: entry.description,
    href: entry.href,
    keywords: entry.keywords,
  }));
  if (access.role !== "admin") return entries;
  entries.push({
    id: "email-smtp",
    title: "SMTP",
    description: "Email delivery provider",
    href: "/admin/settings/email?field=smtpHost",
    keywords: ["mail server", "email", "E-Mail"],
  });
  if (access.selfHosted !== false)
    entries.push({
      id: "transit-sources",
      title: "GTFS",
      description: "Transit source acquisition",
      href: "/admin/data#transit-sources",
      keywords: ["transit feeds", "sources", "Fahrplandaten"],
    });
  if (access.selfHosted !== false)
    entries.push(
      {
        id: "backup-retention",
        title: "Backup retention",
        description: "Backup expiry and retention days",
        href: "/admin/system/deployment#backup-retention",
        keywords: ["backup expiry", "Aufbewahrung", "Sicherung"],
      },
      {
        id: "release-selector",
        title: "Release channel",
        description: "Release selector and update channel",
        href: "/admin/system/deployment#release-selector",
        keywords: ["release channel", "Version", "Kanal"],
      },
    );
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
      description: "Integration",
      href: `/admin/integrations/${encodeURIComponent(entry.id)}`,
      keywords: [entry.id],
    });
  if (access.selfHosted !== false)
    for (const entry of metadata.services ?? [])
      entries.push({
        id: `service:${entry.id}`,
        title: entry.name,
        description: "Service",
        href: `/admin/system/services/${encodeURIComponent(entry.id)}`,
        keywords: [entry.id],
      });
  for (const entry of access.selfHosted === false ? [] : (metadata.operations ?? []))
    entries.push({
      id: `operation:${entry.id}`,
      title: entry.title,
      description: entry.description,
      href: `/admin/data#operation-${encodeURIComponent(entry.id)}`,
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
