---
impacts: [security]
---

## What changes

The data-manager strengthens file-serving boundaries and limits failed authentication attempts. Its generated SDK now validates the complete internal service protocol, including framework request errors and bodyless responses.

## Who is affected

Installations running the data-manager and API services.

## Required action

Deploy the API and data-manager from the same product release. No data migration or configuration change is required.
