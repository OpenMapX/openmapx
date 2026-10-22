---
impacts: [security]
---

## What changes

The web application upgrades Next.js from 16.4.0 to 16.4.1. This addresses
[GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw), a critical
image-optimization vulnerability, and
[GHSA-p3m5-59mp-jv5r](https://github.com/advisories/GHSA-p3m5-59mp-jv5r), a high-severity
Server Actions denial-of-service vulnerability.

## Who is affected

Installations running the web application with the previous Next.js dependency.
The upstream advisories describe the specific affected features and platforms.

## Required action

Deploy the updated web application as part of the next OpenMapX upgrade. No
configuration change, data migration or manual cache invalidation is required.
