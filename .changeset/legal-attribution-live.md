---
"@openmapx/core": patch
---

`fetchIntegrations`/`fetchDisclosures` no longer cache the `/api/integrations` response (`cache: "no-store"`). They are consumed only by the force-dynamic `/privacy` and `/terms` pages, whose attribution and disclosure tables must reflect the integrations enabled at runtime; the previous 1-hour cache was seeded empty during `next build` and baked into the image, leaving those tables stale.
