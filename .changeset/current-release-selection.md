---
"@openmapx/core": patch
"@openmapx/cli": patch
"@openmapx/ops-agent": patch
---

Keep application release lockfiles limited to seven images, with documentation
published independently. Add `compose release --clear` to remove local selection
safely without deleting runtime evidence or changing running containers.

Include transitous-runner in administrative release updates and report all five
running application services. Require a host-side update when ops-agent or its
backup helper does not match the selected release; administrative recreation
leaves dependencies running and checks the same condition during recovery.
