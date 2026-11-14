# Crash-point suite catalogue

The suite pins the update and control plane at boundaries that survive a
rewrite of its internals. How it runs, and how to run it, is described in
`CONTRIBUTING.md` ("Crash-point suite"). Scenario files talk only to
`driver.ts`; when the update system changes, only the driver may change.

Each scenario lists the outcomes the system may show. When the operator exit
(`control status`, `clear`, `resolve`) does not exist yet, "held and visible"
means: the update does not succeed and a new update is refused while it is
held. An API job that stays `running` after a failed agent operation counts as
held and visible.

## Known failures

Some scenarios fail on today's code because of defects the update-system
replacement removes. They are committed with their full expectations and
listed in `known-failures.json`. Each entry gives a one-line `reason` and a
`fails` signature: a regular expression matched against the failure's message
and, for an assertion, the values it compared. Every scenario declares its test
through `scenario()` (`scenario.ts`). A listed scenario passes only when it
fails with its signature within its normal timeout. CI turns red when it
passes, when it fails any other way (the original error is reported) and when
it hangs. The rules:

- Entries may only be removed, when their scenario passes.
- Scenario files never change to make a scenario pass.
- A signature names the defect, not just "something failed": the observation
  a held job shows, the assertion that fails, or the role's own error.
- `scripts/crash-point-imports.test.ts` checks that every entry names an
  existing scenario with a reason and a valid signature, that scenarios declare
  their tests only through `scenario()`, and how `scenario()` treats a pass, a
  matching failure and any other failure.

## Environment

The roles run offline: inside their namespaces no name but `localhost`
resolves, and the database is reached by its address. The data-manager's
first notable-places build is switched off (`NOTABLE_PLACES_REFRESH_CRON=off`),
as it is in the native update smoke.

Today the agent reports a refused target lease (`Target lease busy`) as
`runtime`, and the API then holds the job with `recovery_required`. Scenarios
accept that as held and visible; the single admission path planned for a
later change replaces it.

One consequence is visible on every new installation. The first
notable-places build starts right after the installation, downloads for
minutes and holds the `data-manager` target as a data job. An update requested
meanwhile does not proceed, but instead of a "busy" refusal the operator sees a
generic runtime failure and a held job (C13 pins the same refusal for any data
job). The single admission path is to report it as busy.

The fake engine refuses two mounts at one container path with the daemon's
"Duplicate mount point" error. Before it did, every scenario that reached the
configuration helper passed while every real self-update failed to start the
helper.

## Known gaps

- **A failed helper launch never ends.** When the daemon refuses the helper's
  `docker run`, the agent swallows the error by design, finds no helper
  container and marks the handoff for recovery. Its operation route then
  reports `configurationHandoff.prepare` as `termination_pending` from two
  seconds after admission onwards, and the worker never settles. The API job
  stays `running`, and the CLI waits for its full hour. Seen on a real Docker
  host before the helper's duplicate mounts were fixed. No scenario pins it:
  the helper rewrite planned for a later change is to end such a launch as a
  terminal failure the API reports.
- **The helper checks a recreated service before it is healthy.** The helper
  runs `compose up -d --force-recreate --no-deps <service>` and checks the new
  container's readiness at once. A service with a healthcheck is still
  `starting` then, so the helper stops with `recovery_required`
  ("Original applied container not ready") after the first such service.
  Waiting for health (`--wait`) removes it on a real Docker host. The fake
  engine reports a recreated container healthy at once, so no scenario shows
  it.
- **Bind sources outside the checkout cannot be verified.** The helper's and
  the agent's mount checks resolve every bind source with `realpath` in their
  own container, where a host path outside the checkout does not exist. The
  agent's Docker configuration directory defaults to `/root/.docker`
  (`OPENMAPX_DOCKER_CONFIG_DIR`), which fails with `EACCES`. The roles of this
  suite run on the host's file system, so no scenario shows it.

On a real Docker host, once the helper waits for health and the configuration
directory lies inside the checkout, the native update smoke's self-update and
its registry, unhealthy, helper and agent cases pass. Its host-command case
fails as C18 does here.

## Scenarios

| ID  | Fault and boundary                                               | Scenario file                                                                | Status on this branch                                                                             |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| —   | Fresh installation finds release N+1                             | `install.test.ts`                                                            | pinned                                                                                            |
| —   | Self-update to N+1, agent recreated last                         | `self-update.test.ts`                                                        | pinned                                                                                            |
| C1  | Two simultaneous update requests                                 | `concurrent-admission.test.ts`                                               | pinned                                                                                            |
| C1  | Host `services start` while an update holds maintenance          | `maintenance-holds-admission.test.ts`                                        | pinned                                                                                            |
| C2  | API killed during the image download                             | `api-killed-during-download.test.ts`                                         | known failure: the reclaimed job is held with `recovery_required` although the download succeeded |
| C3  | Lost prepare reply, then API killed                              | `lost-prepare-reply.test.ts`                                                 | known failure: the job fails with `conflict`, nothing committed                                   |
| C4  | API killed between saving and applying                           | `api-killed-before-apply.test.ts`                                            | known failure: the reclaimed job is held with `transport`                                         |
| C5  | Same operation key, other body, at the agent                     | `same-key-conflict.test.ts`                                                  | pinned                                                                                            |
| C5  | Same key, other body, at the data-manager                        | —                                                                            | not expressible from outside: DM executions need an agent-signed delegation                       |
| C6  | Agent killed during a service start's Compose effect             | `agent-killed-during-start.test.ts`                                          | known failure: the restarted agent refuses to start, its configuration writer is left held        |
| C6  | Cancel and deadline variants                                     | —                                                                            | not pinned (C6 itself fails today; deadlines are not reachable from outside)                      |
| C7  | Agent killed after accepting, before the effect                  | `agent-killed-before-effect.test.ts`                                         | pinned                                                                                            |
| C8  | Lost fence prepare reply                                         | `lost-fence-prepare-reply.test.ts`                                           | pinned                                                                                            |
| C9  | Lost fence settle reply                                          | `lost-fence-settle-reply.test.ts`                                            | pinned                                                                                            |
| C9  | Cancelled during the fence settle                                | `update-cancelled-during-settle.test.ts`                                     | pinned                                                                                            |
| C9  | Deadline variant                                                 | —                                                                            | not expressible: the roles' deadlines are minutes to hours of real time                           |
| C10 | Data-manager restarted while the fence is held                   | `maintenance-holds-admission.test.ts`, `fence-released-after-update.test.ts` | pinned                                                                                            |
| C11 | Data-manager killed in a legacy data job while the agent is down | —                                                                            | not pinned: needs a traffic data job, which needs Valhalla and OpenConditions in the fixture      |
| C12 | Agent restarted with a surviving data-manager child              | —                                                                            | not pinned: needs MOTIS and a transit job in the fixture                                          |
| C13 | Update requested while a data job runs                           | `data-job-blocks-update.test.ts`                                             | pinned                                                                                            |
| —   | Data-manager routes called with another caller's token           | `per-caller-tokens.test.ts`                                                  | pinned                                                                                            |
| —   | Traffic maintenance with OpenConditions and no Valhalla          | `traffic-without-valhalla.test.ts`                                           | pinned                                                                                            |
| C14 | Registry outage after the check                                  | `registry-outage.test.ts`                                                    | pinned                                                                                            |
| C15 | New API image unhealthy                                          | `unhealthy-api-image.test.ts`                                                | pinned                                                                                            |
| C16 | Helper killed mid-recreate                                       | `helper-killed.test.ts`                                                      | pinned                                                                                            |
| C16 | Cancelled mid-recreate                                           | `update-cancelled-mid-recreate.test.ts`                                      | known failure: the helper continues and the update succeeds after the cancel                      |
| C16 | Deadline variant                                                 | —                                                                            | not expressible: deadlines are not reachable from outside                                         |
| C17 | Agent restarted while the helper runs                            | `agent-restart-during-helper.test.ts`                                        | pinned                                                                                            |
| C18 | Host lifecycle commands while the helper runs                    | `cli-during-helper.test.ts`                                                  | known failure: `services restart` runs `compose restart` while the helper recreates               |
| C19 | Agent state filesystem full after an effect                      | `state-filesystem-full.test.ts`                                              | pinned (needs `OPENMAPX_RUN_CRASH_DISK_TESTS=1`)                                                  |
| C20 | Restore of the pre-update backup                                 | —                                                                            | not pinned: backups need `docker exec` into PostgreSQL, which the fake engine does not model      |
