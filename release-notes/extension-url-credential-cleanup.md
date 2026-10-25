---
impacts: [security, migration, operator-action]
---

## What changes

Extension manifest, artifact, service-repository, and custom-catalog locators now require credential-free HTTPS URLs without a username, password, query, or fragment. Unsupported locators are rejected before fetching, queueing, caching, or durable host work. Extension install payloads and output paths retain only normalized locator provenance.

The upgrade scrubs legacy unsafe extension locators from PostgreSQL and Redis. Operations-agent recovery removes them from current and pending integration records, leaves installed files untouched, and marks affected installations as needing reinstall.

## Who is affected

Self-hosted installations that previously used credentials, signed queries, or fragments in extension acquisition URLs, including URLs stored in custom catalogs or extension manifests.

## Required action

Publish affected extension resources at stable credential-free HTTPS URLs and reinstall any integration reported as needing reinstall. Rotate credentials or signed tokens that appeared in old URLs. Review database, Redis, filesystem, log, diagnostic, and external backup retention separately because upgrading cannot remove historical values from backups.
