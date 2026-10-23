---
title: OpenMapX documentation
description: Use OpenMapX, host your own map, or build an integration.
slug: /
sidebar_position: 1
---

# OpenMapX documentation

OpenMapX is a map application for place search, directions, public transit, and
map layers. You can use an existing instance or host it on your own infrastructure.
The features and geographic coverage available on an instance depend on its
enabled integrations, data sources, and services.

<div className="docs-paths">
  <a className="docs-path" href="/overview/using-openmapx">
    <strong>Use the map</strong>
    <span>Find a place, plan a journey, and save the places you want to return to.</span>
  </a>
  <a className="docs-path" href="/install/getting-started">
    <strong>Host OpenMapX</strong>
    <span>Prepare a server, configure the application, and start your deployment.</span>
  </a>
  <a className="docs-path" href="/administration/admin-panel">
    <strong>Administer an instance</strong>
    <span>Manage services and integrations, look after accounts, and protect your data.</span>
  </a>
  <a className="docs-path" href="/developer/development-setup">
    <strong>Contribute and develop</strong>
    <span>Run the code locally, understand the architecture, and build extensions.</span>
  </a>
</div>

## What runs on your server

The core deployment includes the web app, API, PostgreSQL/PostGIS database, Valkey
cache, reverse proxy, data-manager, and operations agent. You can add routing,
geocoding, transit, and map-tile engines as needed. Some integrations use hosted
providers; check their credentials, coverage, licences, and privacy requirements
before enabling them.

OpenMapX has two kinds of plugins:

| Plugin      | Purpose                                                      | Examples                                         |
| ----------- | ------------------------------------------------------------ | ------------------------------------------------ |
| Service     | A container that supplies infrastructure or a backend engine | PostgreSQL, Valhalla, MOTIS, Photon              |
| Integration | An application feature or a provider of data for one         | Routing, transit planning, weather, place photos |

The CLI renders the Docker Compose deployment from service manifests. Integrations
connect application features to those services and to external providers. Read
[How it works](./how-it-works.md) for the deployment model.

## Before you choose an instance

Saved places and other synchronized account data are readable by the instance's
server and operator. They are not end-to-end encrypted. External providers also
have their own data-use terms. The [user-data trust model](../developer/user-data-trust-model.md)
describes these boundaries; the instance's privacy page identifies its operator
and configured sources.

For a problem with the map or a documentation question, see
[Troubleshooting and help](./troubleshooting.md).
