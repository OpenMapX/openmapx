// Server-side loader for /licenses. Combines the build-time static manifest
// (web + api + data manager + built-in integrations) with one group per installed community
// integration, sourced from the integration's `manifest.json` plus the
// optional `dist/licenses.json` shipped inside its artifact. Runs on every
// request so newly-installed integrations show up without rebuilding web.

import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LicenseNotice } from "@openmapx/core/licenses";
import { repoPaths } from "@openmapx/core/repo-paths";

export interface LicenseGroup {
  /** `core` for web/api/data-manager/built-in deps, or the community integration id. */
  scope: string;
  /** Human-readable label shown in the table heading. */
  label: string;
  /** Sub-heading describing what this group's notices represent. */
  description?: string;
  notices: LicenseNotice[];
}

export interface LicensesPageData {
  groups: LicenseGroup[];
  generatedAt: string | null;
  totalCount: number;
}

interface StaticPayload {
  generatedAt?: string;
  notices?: LicenseNotice[];
}

interface CommunityPayload {
  integrationId?: string;
  notices?: LicenseNotice[];
}

interface CommunityManifest {
  id?: string;
  name?: string;
  version?: string;
  license?: string | { type?: string; url?: string };
  author?: string;
  documentation?: string;
  description?: string;
}

export async function loadLicenseGroups(): Promise<LicensesPageData> {
  const groups: LicenseGroup[] = [];
  let generatedAt: string | null = null;

  const staticPayload = await loadStaticManifest();
  if (staticPayload?.notices?.length) {
    groups.push({
      scope: "core",
      label: "OpenMapX (web app, API, data manager, built-in integrations)",
      notices: staticPayload.notices,
    });
    generatedAt = staticPayload.generatedAt ?? null;
  }

  const seenInCore = new Set(staticPayload?.notices?.map((n) => `${n.name}@${n.version}`) ?? []);
  for (const group of loadCommunityGroups(seenInCore)) {
    groups.push(group);
  }

  const totalCount = groups.reduce((sum, g) => sum + g.notices.length, 0);
  return { groups, generatedAt, totalCount };
}

async function loadStaticManifest(): Promise<StaticPayload | null> {
  // Static import keeps Next's tracing aware of the file dependency; falling
  // back to a stub if the generator hasn't run yet lets `next dev` boot
  // without a build step.
  try {
    const mod = (await import("@/generated/open-source-licenses.json")) as {
      default?: StaticPayload;
    };
    return mod.default ?? null;
  } catch {
    return null;
  }
}

function loadCommunityGroups(skipKeys: Set<string>): LicenseGroup[] {
  const groups: LicenseGroup[] = [];
  let customDir: string;
  try {
    customDir = repoPaths().customIntegrationsDir;
  } catch {
    return groups;
  }
  if (!existsSync(customDir)) return groups;

  let entries: Dirent[];
  try {
    entries = readdirSync(customDir, { withFileTypes: true });
  } catch {
    return groups;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;

    const integrationDir = join(customDir, entry.name);
    const manifest = readCommunityManifest(integrationDir);
    if (!manifest) continue; // Skip half-extracted/staging dirs.

    const integrationId = manifest.id ?? entry.name;
    const integrationNotice = integrationSelfNotice(manifest, integrationId);

    const bundledNotices = readBundledLicenses(integrationDir).filter(
      (n) => !skipKeys.has(`${n.name}@${n.version}`),
    );

    groups.push({
      scope: entry.name,
      label: `Community integration · ${manifest.name ?? integrationId}`,
      description:
        bundledNotices.length > 0
          ? "Integration license and bundled runtime dependencies."
          : "Integration license. No bundled dependency manifest was shipped.",
      notices: [integrationNotice, ...bundledNotices],
    });
  }

  return groups.sort((a, b) => a.scope.localeCompare(b.scope));
}

function readCommunityManifest(dir: string): CommunityManifest | null {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CommunityManifest;
  } catch {
    return null;
  }
}

function readBundledLicenses(dir: string): LicenseNotice[] {
  const path = join(dir, "dist", "licenses.json");
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  let payload: CommunityPayload;
  try {
    payload = JSON.parse(raw) as CommunityPayload;
  } catch {
    return [];
  }
  return Array.isArray(payload.notices) ? payload.notices : [];
}

function integrationSelfNotice(manifest: CommunityManifest, id: string): LicenseNotice {
  let license = "Not specified";
  let licenseUrl: string | undefined;
  const raw = manifest.license;
  if (typeof raw === "string" && raw.trim()) {
    license = raw.trim();
  } else if (raw && typeof raw === "object") {
    if (raw.type?.trim()) license = raw.type.trim();
    if (raw.url) licenseUrl = raw.url;
  }
  return {
    name: id,
    version: manifest.version ?? "?",
    license,
    licenseUrl,
    projectUrl: manifest.documentation,
  };
}
