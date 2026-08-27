---
"@openmapx/core": patch
"@openmapx/integration-framework": patch
"@openmapx/extension-cli": patch
---

Package only the declared artifact contract and bound untrusted Git snapshots.
Integration archives are now built from an explicit allowlist in a staging step
that leaves the source tree unchanged and produces byte-identical output, with a
`--dry-run` file listing. Git URLs are canonicalized and rejected when they carry
credentials, a query, or a fragment, `gitShallowClone` validates internally and
enforces time, entry, size, path, and file-type budgets, and process errors and
forwarded stderr no longer reproduce a repository URL.
