---
impacts: [breaking, operator-action]
---

## What changes

Integration manifest validation now refuses a `dataSources[]` entry that carries a key the manifest schema does not name. Earlier releases dropped such keys silently, which hid mistakes such as credit text placed under `attributionText` instead of `attribution`; that credit was never shown. Sources an integration supplies at runtime through `ctx.setDataSources()` are unchanged: unknown keys there are still dropped.

## Who is affected

Operators running a community integration whose manifest has an unknown key in one of its data sources, and the authors of such integrations. Built-in integrations are not affected; every in-tree manifest validates.

After the upgrade, the API skips that integration at startup. It logs a warning `Skipping integration <id>: manifest validation failed` whose errors name the entry and key, for example `dataSources.0: Unrecognized key: "attributionText"`. The integration's routes, providers and credits are absent until it is fixed. Installing or updating it is refused with the same error, as is `openmapx-ext validate` or packaging it with the extension CLI.

## Required action

Operators: after upgrading, check the API log for `manifest validation failed` warnings. Update each affected community integration to a release that fixes its manifest, or remove it.

Extension authors: in every static `dataSources` entry, rename credit text to `attribution` and remove any other key the schema does not list (see the data source fields in the integration system documentation, or the authoring schema `schemas/integration.json` in `@openmapx/extension-contracts`). Validate with `openmapx-ext validate`, then publish the fixed release.
