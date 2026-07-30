# OpenMapX web application

This workspace contains the OpenMapX map UI. It is a Next.js 16 App Router
application built with React 19, MapLibre GL JS 5, MUI 9, Tailwind 4, Zustand,
TanStack Query, next-intl, and Serwist. It is designed to run with `apps/api`;
browser-facing provider requests normally go through that API.

## Develop

Run setup from the repository root:

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
pnpm dev
```

To run only this app, use `pnpm --filter web dev`. The web app defaults to
`NEXT_PUBLIC_API_URL=http://localhost:3001`; see `.env.example` for map style,
tile, traffic, and legal-page settings. MapTiler credentials are configured in
the API environment, not exposed to browser JavaScript.

## Useful paths

- `src/app/` — App Router pages, layouts, admin surfaces, and legal pages
- `src/components/map/` — MapLibre map shell, layers, viewers, and controls
- `src/components/navigation/` — ground and transit navigation UI
- `src/components/panels/` — directions, places, saved places, and detail panels
- `src/lib/` — environment parsing, map helpers, navigation logic, and caches
- `src/sw.ts` — Serwist service worker
- `public/` — static and generated runtime assets

Built-in integration frontends are imported from the repository-level
`integrations/` workspace. Shared state, API hooks, and domain types live in
`@openmapx/core`; translations live in `@openmapx/i18n`.

## Check and build

```bash
pnpm lint
pnpm check-types
pnpm test --project web
pnpm --filter web build
```

The production build uses Next.js standalone output and then builds the service
worker and copies static assets into the standalone tree. Start that output with
`pnpm --filter web start`.

See the root `README.md`, `CONTRIBUTING.md`, and `docs/docs/developer/` for the
full architecture and contribution conventions.
