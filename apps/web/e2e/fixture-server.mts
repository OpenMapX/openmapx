import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { crc32, deflateSync } from "node:zlib";

/**
 * A minimal Mapbox Vector Tile encoder for the browser journeys.
 *
 * Every tile is the same synthetic geometry, so the fixtures carry no map data
 * and no licence: one `water` polygon covering the whole tile. The OpenMapX
 * style paints that layer a known colour, which a journey can read back from
 * the canvas to prove the basemap actually rendered.
 */

const EXTENT = 4096;

function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return bytes;
}

function zigzag(value: number): number {
  return (value << 1) ^ (value >> 31);
}

function key(field: number, wireType: number): number[] {
  return varint((field << 3) | wireType);
}

function lengthDelimited(field: number, payload: number[]): number[] {
  return [...key(field, 2), ...varint(payload.length), ...payload];
}

function packed(field: number, values: number[]): number[] {
  return lengthDelimited(
    field,
    values.flatMap((value) => varint(value)),
  );
}

function command(id: number, count: number): number {
  return (id & 0x7) | (count << 3);
}

/**
 * Ring commands for a square slightly larger than the tile, so tile seams never
 * show. Clockwise in tile coordinates, as the spec requires for exterior rings.
 */
function squareGeometry(): number[] {
  const min = -64;
  const max = EXTENT + 64;
  const points: [number, number][] = [
    [min, min],
    [max, min],
    [max, max],
    [min, max],
  ];
  const geometry: number[] = [];
  let cursorX = 0;
  let cursorY = 0;
  points.forEach(([x, y], index) => {
    if (index === 0) geometry.push(command(1, 1));
    if (index === 1) geometry.push(command(2, points.length - 1));
    geometry.push(zigzag(x - cursorX), zigzag(y - cursorY));
    cursorX = x;
    cursorY = y;
  });
  geometry.push(command(7, 1));
  return geometry;
}

const POLYGON = 3;

function encodeVectorTile(): Uint8Array {
  const feature = [
    ...key(1, 0),
    ...varint(1),
    ...key(3, 0),
    ...varint(POLYGON),
    ...packed(4, squareGeometry()),
  ];
  const name = [...new TextEncoder().encode("water")];
  const layer = [
    ...key(15, 0),
    ...varint(2),
    ...lengthDelimited(1, name),
    ...lengthDelimited(2, feature),
    ...key(5, 0),
    ...varint(EXTENT),
  ];
  return Uint8Array.from(lengthDelimited(3, layer));
}

/** A 256 px PNG of one colour. */
function solidPng([red, green, blue]: readonly [number, number, number]): Uint8Array {
  const size = 256;
  const row = [0, ...Array.from({ length: size }, () => [red, green, blue]).flat()];
  const pixels = Buffer.from(Array.from({ length: size }, () => row).flat());
  const chunk = (type: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * The fixture API. It answers on the origin the production build falls back to
 * when no API URL was baked in, so any `pnpm --filter @openmapx/web build` can be tested.
 * Unknown paths answer 404 and are logged, so a missing fixture shows up in the
 * run output instead of hiding behind a retry.
 */
const port = Number(process.env.FIXTURE_PORT ?? 3001);
const origin = `http://127.0.0.1:${port}`;

type Body = string | Uint8Array | object | null;
type Route = (url: URL) => { status?: number; body: Body; contentType?: string };

const json = (body: Body, status = 200) => ({ status, body });

/** Every satellite tile is this colour, so a journey can tell the imagery is drawn. */
const SATELLITE_RGB = [34, 85, 51] as const;

/** The one searchable place. Synthetic: a name and a point, no provider data. */
const FIXTURE_PLACE = {
  id: "fixture-harbour",
  label: "Fixture Harbour, Testport",
  name: "Fixture Harbour",
  coordinates: [13.405, 52.52],
  type: "poi",
  confidence: 1,
  contributors: [],
};

function haversineMeters(a: [number, number], b: [number, number]): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_378_137 * Math.asin(Math.sqrt(h));
}

/**
 * A route straight through the requested waypoints. Two-point requests keep the
 * historical 4.2 km / 14 min shape; multi-stop requests split into one leg per
 * pair with geometry-derived distances and an intermediate arrive step.
 */
function directions(url: URL) {
  const waypoints = (url.searchParams.get("waypoints") ?? "")
    .split(";")
    .map((pair) => pair.split(",").map(Number) as [number, number]);
  const step = (
    instruction: string,
    at: [number, number],
    type: string,
    coordinates: [number, number][] = [at],
  ) => ({
    contributors: [],
    instruction,
    distance: 0,
    duration: 0,
    coordinates,
    maneuver: { type },
  });
  const [start] = waypoints;
  const end = waypoints.at(-1);
  if (!start || !end) throw new Error("A fixture route needs a start and an end");
  const mode = url.searchParams.get("mode") ?? "driving";

  if (waypoints.length <= 2) {
    const steps = [
      { ...step("Head east", start, "depart"), distance: 4200, duration: 840 },
      step("You have arrived", end, "arrive"),
    ];
    const leg = { contributors: [], distance: 4200, duration: 840, geometry: waypoints, steps };
    return {
      waypoints,
      activeRouteIndex: 0,
      provider: "fixture",
      routes: [
        {
          contributors: [],
          distance: 4200,
          duration: 840,
          geometry: waypoints,
          legs: [leg],
          steps,
          mode,
        },
      ],
    };
  }

  const legs = waypoints.slice(0, -1).map((from, index) => {
    const to = waypoints[index + 1];
    if (!to) throw new Error("Missing next waypoint");
    const distance = Math.max(1, Math.round(haversineMeters(from, to)));
    const duration = Math.max(1, Math.round(distance / 10));
    const departInstruction = index === 0 ? "Head east" : `Continue after stop ${index}`;
    const arriveInstruction =
      index < waypoints.length - 2 ? `Arrive at stop ${index + 1}` : "You have arrived";
    const legSteps = [
      {
        ...step(departInstruction, from, "depart", [from, to]),
        distance,
        duration,
      },
      step(arriveInstruction, to, "arrive", [to]),
    ];
    return {
      contributors: [],
      distance,
      duration,
      geometry: [from, to] as [number, number][],
      steps: legSteps,
    };
  });
  const geometry = legs.flatMap((leg) => leg.geometry);
  const steps = legs.flatMap((leg) => leg.steps);
  const distance = legs.reduce((sum, leg) => sum + leg.distance, 0);
  const duration = legs.reduce((sum, leg) => sum + leg.duration, 0);
  return {
    waypoints,
    activeRouteIndex: 0,
    provider: "fixture",
    routes: [
      {
        contributors: [],
        distance,
        duration,
        geometry,
        legs,
        steps,
        mode,
      },
    ],
  };
}

const routes: Record<string, Route> = {
  "/api/integrations/routing/directions": (url) => json(directions(url)),
  "/api/integrations/routing/match": () =>
    json({ geometry: [], edges: [], points: [], mode: "driving" }),
  "/api/integrations/routing/navigation/alerts": () => json({ alerts: [] }),
  "/api/integrations/transit/planning-capabilities": () => json({ providers: [] }),
  "/api/integrations/road-conditions/events": () =>
    json({ type: "FeatureCollection", features: [] }),
  "/api/integrations/road-conditions/flow-along-route": () => json({ routes: [] }),
  "/api/integrations/geocoding/geocode/country": () => json({ countryCode: "de" }),
  "/api/integrations/geocoding/autocomplete": (url) =>
    json(
      (url.searchParams.get("q") ?? "").toLowerCase().startsWith("fixture")
        ? [{ ...FIXTURE_PLACE, sublabel: "Testport" }]
        : [],
    ),
  "/api/integrations/geocoding/geocode": (url) =>
    json(
      (url.searchParams.get("q") ?? "").toLowerCase().startsWith("fixture") ? [FIXTURE_PLACE] : [],
    ),
  "/api/integrations/geocoding/geocode/reverse": () => json(null),
  "/api/integrations/reviews/aggregate": () =>
    json({
      aggregate: {
        contributors: [],
        count: 0,
        opinionCount: 0,
        positiveCount: 0,
        confirmedCount: 0,
        quality: 0,
        stars: 0,
      },
    }),
  "/api/integrations/weather/current": (url) =>
    json({
      contributors: [],
      location: [Number(url.searchParams.get("lng")), Number(url.searchParams.get("lat"))],
      current: { temperature: 12, weatherCode: 1, isDay: true, time: "2026-06-01T12:00:00Z" },
      source: "fixture",
    }),
  "/api/integrations/poi-search/search": () => json({ results: [], partial: false }),
  "/api/integrations/poi-search/preset-suggest": () => json({ matches: [] }),
  "/api/integrations/poi-search/brand-suggest": () => json({ matches: [] }),
  "/api/integrations/search-suggestions/search": () =>
    json({ suggestions: [], attributions: [], partial: false }),
  "/api/map-config": () =>
    json({
      hostedBasemapProvider: "auto",
      maptilerConfigured: false,
      selfHostedTilesUrl: "",
      selfHostedGlyphsUrl: "",
      streetDetailTilesUrl: "",
    }),
  "/api/auth/get-session": () => json(null),
  "/api/capabilities": () => json({ services: {}, features: { osmContributions: false } }),
  "/api/integrations": () =>
    json({ integrations: [], frameworkStrings: {}, disclosures: [], revision: "0".repeat(64) }),
  "/api/integrations/data-source": () => json({ sources: [] }),
  "/api/integrations/poi-search/chip-translations": () => json({ translations: {} }),
  "/api/street-level-imagery/providers": () => json([]),
  "/api/mapterhorn/tiles.json": () =>
    json({
      tilejson: "3.0.0",
      tiles: [`${origin}/api/mapterhorn/{z}/{x}/{y}.png`],
      minzoom: 0,
      maxzoom: 12,
      tileSize: 256,
    }),
  "/tiles/data/openmapx.json": () =>
    json({
      tilejson: "3.0.0",
      tiles: [`${origin}/tiles/data/openmapx/{z}/{x}/{y}.pbf`],
      minzoom: 0,
      maxzoom: 14,
    }),
};

/**
 * Static administration answers, shaped by the admin contracts (a unit test
 * checks each one), so admin pages render populated. The administrator is
 * signed in only for a browser that carries {@link ADMIN_COOKIE}; journeys
 * without it stay signed out.
 */
const adminFixtures: Record<string, Body> = JSON.parse(
  readFileSync(new URL("./admin-fixtures.json", import.meta.url), "utf8"),
);
const ADMIN_COOKIE = "openmapx-fixture-admin=1";
const SESSION_ROUTES = new Set(["/api/me", "/api/auth/get-session"]);

function resolve(url: URL, request: IncomingMessage): ReturnType<Route> | undefined {
  const adminFixture = adminFixtures[url.pathname];
  if (
    adminFixture !== undefined &&
    SESSION_ROUTES.has(url.pathname) &&
    request.headers.cookie?.includes(ADMIN_COOKIE)
  )
    return json(adminFixture);
  const route = routes[url.pathname];
  if (route) return route(url);
  if (adminFixture !== undefined && !SESSION_ROUTES.has(url.pathname)) return json(adminFixture);
  if (url.pathname.startsWith("/tiles/data/openmapx/")) {
    return { body: encodeVectorTile(), contentType: "application/x-protobuf" };
  }
  if (/^\/api\/integrations\/data-source\/[a-z0-9-]+\/search$/.test(url.pathname)) {
    return json({
      data: [],
      attributions: [],
      freshness: { fetchedAt: new Date().toISOString(), hasRealtimeData: false, isStale: false },
    });
  }
  if (/^\/api\/integrations\/knowledge-[a-z-]+\/(tides|marine)$/.test(url.pathname)) {
    // No station or marine grid near the fixture place.
    return { status: 204, body: "" };
  }
  if (url.pathname.startsWith("/api/mapterhorn/")) {
    // Terrarium-encoded sea level: relief layers draw without a hill anywhere.
    return { body: solidPng([128, 0, 0]), contentType: "image/png" };
  }
  if (url.pathname.startsWith("/api/maptiler/tiles/satellite-v2/")) {
    return { body: solidPng(SATELLITE_RGB), contentType: "image/png" };
  }
  if (url.pathname.startsWith("/tiles/fonts/")) {
    // An empty glyph set: labels render without text, and nothing reports an error.
    return { body: new Uint8Array(), contentType: "application/x-protobuf" };
  }
  return undefined;
}

function send(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: Body,
  contentType = "application/json",
): void {
  const allowedOrigin = request.headers.origin;
  response.writeHead(status, {
    "content-type": contentType,
    // What the admin API sends; contracts such as coverage require it.
    "cache-control": "private, no-store",
    ...(allowedOrigin
      ? {
          "access-control-allow-origin": allowedOrigin,
          "access-control-allow-credentials": "true",
          "access-control-allow-headers": request.headers["access-control-request-headers"] ?? "*",
          "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          vary: "origin",
        }
      : {}),
  });
  response.end(
    typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
  );
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", origin);
  if (request.method === "OPTIONS") {
    send(request, response, 204, "", "text/plain");
    return;
  }
  const answer = resolve(url, request);
  if (answer) {
    send(request, response, answer.status ?? 200, answer.body, answer.contentType);
    return;
  }
  // Line breaks in a request target would forge extra log lines.
  const target = `${request.method} ${url.pathname}${url.search}`.replace(/\n|\r/g, "");
  console.log(`[fixture] unhandled ${target}`);
  send(request, response, 404, { error: "No fixture" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[fixture] listening on ${origin}`);
});
