# Google Maps Clone — Full Tech Stack & Project Structure (Web Only)

## Tech Stack

### Monorepo & Tooling
| Tool | Purpose |
|---|---|
| **Turborepo** | Monorepo orchestration |
| **pnpm** | Package manager (workspace support, disk-efficient) |
| **TypeScript** | Everywhere — no exceptions at this scale |
| **Biome** | Linting + formatting (replaces ESLint + Prettier, much faster) |

### Web — `apps/web`
| Tool | Purpose |
|---|---|
| **Next.js 16+** | Framework (SSR for SEO pages, CSR for the map app) |
| **MapLibre GL JS** | Map renderer — open-source fork of Mapbox GL JS, renders vector tiles |
| **Material UI (MUI)** | Google's Material Design components out of the box |
| **Framer Motion** | Animations (bottom sheets, panel transitions, route previews) |

### Shared Logic — `packages/core`
| Tool | Purpose |
|---|---|
| **Zustand** | Lightweight global state (search, routing, selected place, layers) |
| **TanStack Query (React Query)** | Data fetching, caching, deduplication for all API calls |
| **Zod** | Runtime validation of API responses |

### Map Data & Tile Pipeline
| Source / Tool | Purpose |
|---|---|
| **OpenStreetMap** | Base vector data |
| **OpenMapTiles** or **Protomaps** | Self-hostable vector tile schema/pipeline |
| **Martin** (Mapbox) or **pg_tileserv** | Tile server from PostGIS |
| **Natural Earth Data** | Low-zoom country/ocean/boundary layers |
| **OpenStreetMap Americana** or custom **MapLibre Style Spec** | Style JSON to replicate Google's visual language |
| **Planetiler** | Fast planet-scale tile generation from OSM PBF |

### APIs (Open Replacements for Google Services)
| Google Feature | Open Replacement |
|---|---|
| Geocoding | **Pelias** (self-hosted) or **Nominatim** |
| Reverse Geocoding | **Nominatim** |
| Places / POI Search | **Pelias** + custom POI index from OSM |
| Autocomplete | **Pelias** with its `/autocomplete` endpoint |
| Directions / Routing | **OSRM** (car) + **Valhalla** (multi-modal, turn-by-turn) |
| Traffic | **OpenTrafficCam** or **TomTom** free tier API |
| Transit / Public Transport | **OpenTripPlanner (OTP)** with GTFS feeds |
| Elevation | **Open-Elevation** API or self-hosted SRTM data |
| Street View | **Mapillary** API (crowd-sourced street-level imagery) |
| Satellite Imagery | **Sentinel-2** (Copernicus) / **ESRI World Imagery** tile layer |
| Weather overlay | **Open-Meteo** API |

### Backend — `apps/api`
| Tool | Purpose |
|---|---|
| **Node.js + Fastify** | API gateway / BFF (Backend for Frontend) |
| **PostgreSQL + PostGIS** | Spatial data, custom POIs, user data |
| **Redis** | Caching geocoding/routing results, session data |
| **Typesense** or **Meilisearch** | Fast fuzzy search for places (supplements Pelias) |
| **Docker Compose → Kubernetes** | Orchestrate Pelias, OSRM, Valhalla, OTP, tile server |

### Infrastructure & DevOps
| Tool | Purpose |
|---|---|
| **Docker** | Containerize everything |
| **GitHub Actions** | CI/CD |
| **Terraform** | IaC if deploying to AWS/GCP |
| **Cloudflare R2 + CDN** | Tile caching/serving at edge (massive cost savings vs S3) |
| **Sentry** | Error monitoring |
| **PostHog** | Open-source analytics |

Always use the latest stable versions of all tools and libraries.
Ensure proper abstraction layers so you can swap out components (e.g., switch from Pelias to Nominatim) without major refactoring. Focus on modularity and separation of concerns from day one to keep the codebase maintainable as features grow.

---

## Phased Build Order

| Phase | Scope |
|---|---|
| **1** | Monorepo setup, MapLibre rendering with OpenMapTiles, basic pan/zoom |
| **2** | Google-like Material Design shell (search bar, side panel, controls) |
| **3** | Geocoding + autocomplete via Pelias |
| **4** | Place details panel (OSM POI data) |
| **5** | Routing via OSRM/Valhalla with drawn polylines |
| **6** | Layers — satellite, transit, traffic |
| **7** | Street-level imagery via Mapillary |
| **8** | Public transit directions via OTP |
| **9** | Embed mode (`/embed` route for iframe usage) |
| **10** | Performance — tile caching at edge, service workers, offline support |

---

## Key Architecture Decisions

- **The API gateway (`apps/api`) abstracts all open-source services** — the frontend never calls Pelias/OSRM directly. This lets you swap implementations without touching the client.
- **Map styles live in their own package** so they're versioned and testable independently.
- **`packages/core` remains platform-agnostic TypeScript.** If you ever add a mobile app (native or React Native), this entire layer transfers without changes.
- **Tile serving is your biggest infrastructure cost.** Start with **Protomaps (static PMTiles on Cloudflare R2)** — no tile server needed, just a CDN. Graduate to Martin/PostGIS when you need dynamic tiles.
- **The monorepo is intentionally not flat.** Even without mobile, separating `core`, `map-styles`, `ui`, and `config` into packages enforces clean boundaries and prevents the web app from becoming a monolith as complexity grows.
