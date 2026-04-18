# OpenMapX Services

Each subdirectory is a self-hosted backend service plugin. A service is described by a single `service.json` manifest validated against the Zod schema in `packages/core/src/services/manifest-schema.ts`.

## Authoring a service

Minimum manifest:

```json
{
  "id": "my-service",
  "name": "My Service",
  "version": "1.0.0",
  "quality": "built-in",
  "container": {
    "image": "owner/image",
    "tag": "1.0.0",
    "expose": [8080]
  },
  "provides": ["my-capability"]
}
```

## Field reference

See the spec at [docs/superpowers/specs/2026-04-18-modular-services-architecture-design.md](../docs/superpowers/specs/2026-04-18-modular-services-architecture-design.md), Section 4.

## Network exposure

Services are reachable only on the internal `openmapx` Docker network by default. To bind a host port or expose via Traefik, set `exposure.hostPorts` or `exposure.proxy.enabled` explicitly.

## Capabilities

Capabilities are free-form strings. Common ones today:
- `routing-engine` (Valhalla, OSRM, MOTIS)
- `geocoder` (Nominatim, Pelias, Photon)
- `transit-engine` (MOTIS, OTP)
- `tile-server` (TileServer GL, Martin)
- `osm-query` (Overpass)
- `osm-data`, `gtfs-data`, `database`, `cache`, `proxy`

## Validating

```
pnpm openmapx services list
pnpm openmapx services get <id>
pnpm openmapx compose render --domain example.com
```
