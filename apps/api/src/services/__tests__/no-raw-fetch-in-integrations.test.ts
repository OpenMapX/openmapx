import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every integration's upstream HTTP call must be bounded by a timeout.
 * `fetchJson` (`@openmapx/core`) is the convergence target: 10s default
 * timeout, shared User-Agent, labeled errors. A bare global `fetch(...)`
 * call site opts out of all of that, so this scan bans it repo-wide unless
 * the file is in the allowlist below.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/api/src/services/__tests__ → repo root → integrations/
const INTEGRATIONS_DIR = resolve(__dirname, "../../../../../integrations");

/**
 * Files allowed to call bare fetch(). Every entry needs a reason: raw
 * Response access (streaming, binary, non-JSON bodies, custom redirect
 * handling) that fetchJson cannot express. Each raw call in these files
 * must still bound itself with AbortSignal.timeout (or carry a comment
 * saying why it is deliberately unbounded).
 */
const RAW_FETCH_ALLOWLIST: Record<string, string> = {
  "integrations/car-sharing/providers/static-car-sharing-client.ts":
    "caller-supplied parser: response body may be XML/CSV/etc., not JSON",
  "integrations/geocoding-motis/provider.ts":
    "isMotisLocalReachable() reachability probe: reads only res.status, never the body",
  "integrations/hotels/official.ts":
    "manual per-hop redirect loop with SSRF re-check + binary HTML byte cap",
  "integrations/knowledge-tides-norway/index.ts": "Kartverket tide feeds are XML, not JSON",
  "integrations/overlay-hiking/index.ts":
    "tile proxy: forwards the binary PNG tile body and status verbatim",
  "integrations/overlay-nautical/index.ts":
    "WMS/tile proxies: forward binary imagery + content-type headers verbatim",
  "integrations/overlay-nautical/stations.ts":
    "Kartverket station list is XML, not JSON (regex-parsed, no XML dependency)",
  "integrations/overlay-satellite/index.ts":
    "GetCapabilities XML + binary legend/tile proxies — none are JSON",
  "integrations/overlay-weather-alerts/index.ts": "MeteoAlarm Atom+CAP feeds are XML, not JSON",
  "integrations/overlay-weather/index.ts":
    "RainViewer + OWM tile proxies: forward binary PNG tiles verbatim",
  "integrations/overlay-wildfires/effis.ts":
    "EFFIS may return XML exception bodies for its GeoJSON endpoint, so the adapter inspects content type and raw text",
  "integrations/overlay-wildfires/firms.ts": "FIRMS wildfire feed is CSV, not JSON",
  "integrations/overlay-wildfires/nifc.ts":
    "adapter maps timeout, network, HTTP status, and malformed ArcGIS JSON to provider-specific source errors",
  "integrations/overlay-wildfires/noaa-smoke.ts":
    "adapter maps timeout, network, HTTP status, malformed JSON, and ArcGIS error envelopes to provider-specific source errors",
  "integrations/overlay-winter-sports/index.ts":
    "tile proxy: forwards the binary PNG tile body and status verbatim",
  "integrations/restaurants/menu.ts":
    "manual per-hop redirect loop with SSRF re-check + binary HTML byte cap",
  "integrations/search-nlp/index.ts":
    "Ollama generate/pull: streaming responses and multi-minute model downloads",
  "integrations/street-level-imagery-panoramax/index.ts":
    "tile proxy: forwards the binary MVT tile body, content-type and status verbatim",
  "integrations/street-level-imagery-mapillary/index.ts":
    "Mapillary vector tiles: forwards the binary tile body, content-type, and status verbatim",
  "integrations/transit-otp/provider.ts":
    "isOtpAvailable() reachability probe: reads only res.ok, never the body",
  "integrations/webcam/providers/osm.ts":
    "checkUrlReachable() HEAD probe: reads only res.ok, never the body",
  "integrations/webcam/providers/traffic-camera.ts":
    "Hong Kong uses UTF-16 CSV and Spain/Norway use XML, so raw response bodies are parsed with bounded requests",
};

// Matches a bare, unqualified `fetch(` call — NOT `fetchJson(`,
// `impersonatingFetch(`, or `something.fetch(`.
const BARE_FETCH_RE = /(?<![.\w$])fetch\s*\(/;

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith("_")) continue;
    if (entry.name === "__tests__") continue;
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

function findBareFetchCalls(file: string): { line: number; snippet: string }[] {
  const src = readFileSync(file, "utf8");
  const hits: { line: number; snippet: string }[] = [];
  src.split("\n").forEach((rawLine, idx) => {
    const line = rawLine.replace(/\/\/.*$/, "");
    if (BARE_FETCH_RE.test(line)) {
      hits.push({ line: idx + 1, snippet: rawLine.trim().slice(0, 120) });
    }
  });
  return hits;
}

describe("no bare fetch() in integrations outside the allowlist", () => {
  const files = existsSync(INTEGRATIONS_DIR) ? collectTsFiles(INTEGRATIONS_DIR) : [];

  it("scans the integrations directory", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("every bare fetch() call site is in the allowlist", () => {
    const repoRoot = resolve(INTEGRATIONS_DIR, "..");
    const offenders: string[] = [];
    for (const file of files) {
      const relPath = relative(repoRoot, file).replace(/\\/g, "/");
      if (relPath in RAW_FETCH_ALLOWLIST) continue;
      for (const hit of findBareFetchCalls(file)) {
        offenders.push(`${relPath}:${hit.line}  ${hit.snippet}`);
      }
    }
    expect(
      offenders,
      `Bare fetch() outside the allowlist — use fetchJson from "@openmapx/core" ` +
        `(10s default timeout, shared User-Agent, labeled errors) instead. If the raw ` +
        `Response is genuinely needed (streaming, binary, non-JSON parsing), add the file ` +
        `to RAW_FETCH_ALLOWLIST with a reason:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("every allowlist entry still exists and still needs bare fetch()", () => {
    const repoRoot = resolve(INTEGRATIONS_DIR, "..");
    const stale: string[] = [];
    for (const relPath of Object.keys(RAW_FETCH_ALLOWLIST)) {
      const abs = resolve(repoRoot, relPath);
      if (!existsSync(abs)) {
        stale.push(`${relPath}  (file no longer exists)`);
        continue;
      }
      if (findBareFetchCalls(abs).length === 0) {
        stale.push(`${relPath}  (no bare fetch() left — remove from the allowlist)`);
      }
    }
    expect(
      stale,
      `Stale allowlist entries — these files were converted and no longer need to be ` +
        `listed:\n${stale.join("\n")}`,
    ).toEqual([]);
  });
});
