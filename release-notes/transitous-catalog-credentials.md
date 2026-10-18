---
impacts: [security]
---

## What changes

Transitous catalog overlays restrict files to owner-only access before writing
API keys or preserving credentialed feed URLs, including when a write fails.
Catalog writes reject symbolic links, hard links and non-regular files.

## Who is affected

Self-hosted installations using Transitous API-key or feed overlays.

## Required action

No configuration change is required for regular catalog files. File ownership
and the catalog JSON format are preserved. Custom setups using linked catalog
files must replace those links with regular catalog files before rerunning the job.
