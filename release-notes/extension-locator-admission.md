---
impacts: [security]
---

## What changes

Extension manifest, artifact, service-repository, and custom-catalog locators now require credential-free HTTPS URLs without a username, password, query, or fragment. Unsupported locators are rejected before fetching, queueing, caching, or durable host work. Extension install payloads and output paths retain only normalized locator provenance.

## Who is affected

Extension authors and operators configuring a custom catalog, direct manifest, integration artifact, or service repository URL.

## Required action

Publish extension resources at stable credential-free HTTPS URLs. Put authentication in a reviewed runtime credential flow rather than an acquisition URL.
