#!/usr/bin/env -S pnpm exec tsx

const args = process.argv.slice(2);

function value(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(`benchmark-motis-reachability: ${message}`);
  process.exit(1);
}

const rawBaseUrl = value("--base-url");
if (!rawBaseUrl) fail("--base-url is required");
const baseUrl = new URL(rawBaseUrl);
const allowRemote = args.includes("--allow-remote");
const host = baseUrl.hostname.replace(/^\[|\]$/g, "");
const privateTarget =
  host === "localhost" ||
  host === "::1" ||
  /^127\./.test(host) ||
  /^10\./.test(host) ||
  /^192\.168\./.test(host) ||
  (() => {
    const match = host.match(/^172\.(\d+)\./);
    const second = Number(match?.[1]);
    return match !== null && second >= 16 && second <= 31;
  })();
if (!privateTarget && !allowRemote) {
  fail("refusing a non-loopback/non-private target; pass --allow-remote deliberately");
}

const originLat = Number(value("--lat") ?? "52.525");
const originLng = Number(value("--lng") ?? "13.369");
if (!Number.isFinite(originLat) || !Number.isFinite(originLng)) fail("invalid --lat/--lng");

const endpoint = new URL("/api/experimental/one-to-many-intermodal", baseUrl);
const WARMUPS = 2;
const MEASUREMENTS = 10;
const BATCH_SIZE = 128;

function destinations(count: number): string[] {
  // A deterministic compact spiral, entirely within roughly 2 km of the
  // origin. It exercises batching without requiring a country-scale extract.
  return Array.from({ length: count }, (_, index) => {
    const ring = Math.floor(index / 16) + 1;
    const angle = ((index % 16) / 16) * Math.PI * 2;
    const lat = originLat + Math.sin(angle) * ring * 0.0012;
    const lng = originLng + Math.cos(angle) * ring * 0.0018;
    return `${lat.toFixed(6)},${lng.toFixed(6)}`;
  });
}

function departureMinute(): string {
  const date = new Date();
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

async function oneRun(count: number): Promise<number> {
  const many = destinations(count);
  const queryTime = departureMinute();
  const signal = AbortSignal.timeout(30_000);
  const started = performance.now();
  for (let offset = 0; offset < many.length; offset += BATCH_SIZE) {
    const batch = many.slice(offset, offset + BATCH_SIZE);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        one: `${originLat},${originLng}`,
        many: batch,
        time: queryTime,
        arriveBy: false,
        maxTravelTime: 90,
        pedestrianProfile: "FOOT",
        pedestrianSpeed: 1.2,
        preTransitModes: ["WALK"],
        postTransitModes: ["WALK"],
        directMode: "WALK",
        maxPreTransitTime: 900,
        maxPostTransitTime: 900,
        maxDirectTime: 900,
      }),
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as {
      street_durations?: unknown[];
      transit_durations?: unknown[];
    };
    if (
      data.street_durations?.length !== batch.length ||
      data.transit_durations?.length !== batch.length
    ) {
      throw new Error("response arrays do not align with the destination batch");
    }
  }
  return performance.now() - started;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? Infinity;
}

let failed = false;
for (const count of [1, 128, 200]) {
  for (let index = 0; index < WARMUPS; index += 1) await oneRun(count);
  const timings: number[] = [];
  let successes = 0;
  for (let index = 0; index < MEASUREMENTS; index += 1) {
    try {
      timings.push(await oneRun(count));
      successes += 1;
    } catch (error) {
      failed = true;
      console.error(`destinations=${count} run=${index + 1} failed: ${(error as Error).message}`);
    }
  }
  const median = percentile(timings, 0.5);
  const p95 = percentile(timings, 0.95);
  const max = timings.length > 0 ? Math.max(...timings) : Infinity;
  console.log(
    `destinations=${count} median_ms=${median.toFixed(1)} p95_ms=${p95.toFixed(1)} max_ms=${max.toFixed(1)} success=${successes}/${MEASUREMENTS}`,
  );
  if (count === 200 && p95 > 30_000) failed = true;
}

if (failed) fail("gate failed (measured failure or 200-destination p95 above 30000 ms)");
console.log("benchmark-motis-reachability: gate passed");
