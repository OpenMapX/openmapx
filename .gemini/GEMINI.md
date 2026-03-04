# OpenMapX

## Project
OpenMapX is an open-data mapping platform (Google Maps alternative).
Monorepo: Turborepo + pnpm. All code is TypeScript.

## Architecture
- `apps/web` — Next.js 16 + App Router + Tailwind + MapLibre GL JS
- `packages/core` — platform-agnostic business logic (geocoding clients, routing clients, type definitions)
- `apps/api` — Fastify server proxying Pelias, Valhalla, Martin
- `infra/docker` — Docker Compose for PostGIS, Martin, TileServer GL, Pelias, Valhalla

## Conventions
- Strict TypeScript, no `any`
- Functional React components, server components by default, `"use client"` only when needed
- Barrel exports via `index.ts` in each package
- Use workspace protocol: `@openmapx/core`, `@openmapx/api`
- Biome for formatting and linting (configured at repo root via biome.json)
- Conventional commits (feat:, fix:, chore:, docs:)

## Key Commands
- `pnpm dev` — start all apps
- `pnpm build` — build all
- `pnpm lint` — lint all

## Stack Versions
- Node 24, pnpm latest, Next.js 16, React 19, MapLibre GL JS 5, Fastify 5

