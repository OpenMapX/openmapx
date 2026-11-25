---
impacts: [breaking, operator-action]
---

## What changes

The imprint, privacy policy and terms of service take every operator fact from
the API's `/api/legal-config`. When the API cannot be reached, these pages show
an error state instead of values read from the web container's environment. The
web service no longer receives any `LEGAL_*` variable.

## Who is affected

Deployments that set legal facts only for the web container. No released
installation exists.

## Required action

Configure the legal facts on the API, through its `LEGAL_*` variables or in
Settings → Legal in the administration. Remove `LEGAL_*` variables from the web
service's environment.
