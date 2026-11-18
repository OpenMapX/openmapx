---
impacts: [operator-action]
---

## What changes

`compose up`, `data link` and `services build` apply hardlink plans that have
links to make or prune again. Data Manager applies the plan inside its container
as a data job named by the applied configuration generation; before, its `/link`
route refused such a plan. While a configuration change or another data job
runs, Data Manager answers busy: `compose up` warns and starts the stack anyway,
while `data link` and `services build` fail with a message saying to retry.

## Who is affected

Installations whose engines have built data, for example after a first data
download or a service build.

## Required action

After upgrading, run `pnpm openmapx data link` once to apply any plan an earlier
`compose up` left unapplied.
