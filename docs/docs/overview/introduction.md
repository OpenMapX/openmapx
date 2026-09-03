---
title: Introduction
description: OpenMapX is a self-hosted, open-data platform for maps, search, navigation, and public transit.
slug: /
sidebar_position: 1
---

# OpenMapX

OpenMapX is a fully self-hostable mapping platform, assembled from
open-source services and open data. It gives you a
modern map application — place and voice search, traffic-aware and EV
directions, public-transit planning and navigation, map layers, crowd reports,
and street-level imagery — that runs on infrastructure you control.

The lightweight application, proxy, database, cache, data-manager, and ops-agent
form the core deployment. Heavy or provider-specific engines are not locked in:
routing, geocoding, transit, tiles, and most user-facing features are plugins,
and the whole Docker deployment is generated from their manifests. You decide
which optional engines and data sources to run.

## What you get

- **A complete mapping app** — geocoding and autocomplete, turn-by-turn
  directions and EV charge planning, public-transit journey planning and live
  navigation, points of interest, map overlays, crowd reports, weather,
  reviews, and place enrichment.
- **A pluggable backend** — each daemon (the routing engine, the geocoder, the
  transit engine, the tile server, …) is described by a manifest and runs as a
  container.
- **A pluggable feature set** — 105 built-in *integrations* span search,
  routing, transit, live mobility, places, overlays, weather, and more.
  Community extensions — integrations, services, or bundles of both —
  install from one unified **Extensions** store.
- **Open data throughout** — OpenStreetMap, GTFS (via Transitous), Wikidata,
  Wikipedia, Mapillary, and a long list of public agency feeds.
- **Privacy by default** — no third-party analytics, and provider API and image
  requests are normally proxied through your server. Explicit link-outs and
  browser capabilities such as Web Speech follow the browser/provider privacy
  model and are called out in the relevant feature documentation.
- **A modern stack** — Next.js, Fastify, MapLibre GL JS, MUI, PostgreSQL +
  PostGIS, Valkey (Redis-compatible), Drizzle ORM, and TypeScript end to end.

## Two kinds of plugins

Almost everything in OpenMapX is one of two plugin types. Knowing which is which
makes the rest of the documentation easier to follow.

|                  | Services                                                                                                      | Integrations                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Live in**      | `services/<slug>/`                                                                                            | `integrations/<id>/`                                                                                    |
| **Described by** | `service.json`                                                                                               | `manifest.json`                                                                                          |
| **Are**          | Backend daemons that run as containers — databases, routing engines, geocoders, transit engines, tile servers | App-level features that consume services and external APIs to deliver functionality to users            |
| **Declare**      | Image, ports, volumes, the capabilities they *provide*, the data they *consume*, host/proxy exposure          | Domain, frontend components, backend routes, config schema, attribution, the services they *require*    |

The compose renderer turns the enabled **services** (29 built-in plus community additions) into a generated
`docker-compose` stack — there is no hand-maintained compose file. The API
server hosts the **integrations** and resolves each integration's `requires:`
against the running services.

## Where to go next

- **[How it works](./how-it-works.md)** — the architecture, and how services and
  integrations fit together.
- **[Getting started](../install/getting-started.md)** — running the stack with
  Docker Compose.
