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

| ID  | Fault and boundary                                               | Scenario file                                                                | Status on this branch                                                                           |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| —   | Fresh installation finds release N+1                             | `install.test.ts`                                                            | pinned                                                                                          |
| —   | Self-update to N+1, agent recreated last                         | `self-update.test.ts`                                                        | pinned                                                                                          |
| C1  | Two simultaneous update requests                                 | `concurrent-admission.test.ts`                                               | pinned                                                                                          |
| C1  | Host `services start` while an update holds maintenance          | `maintenance-holds-admission.test.ts`                                        | pinned                                                                                          |
| C2  | API killed during the image download                             | —                                                                            | fails today: the reclaimed job is held with `recovery_required` although the download succeeded |
| C3  | Lost prepare reply, then API killed                              | —                                                                            | fails today: the job fails with `conflict`, nothing committed                                   |
| C4  | API killed between saving and applying                           | —                                                                            | fails today: the reclaimed job is held with `transport`                                         |
| C5  | Same operation key, other body, at the agent                     | `same-key-conflict.test.ts`                                                  | pinned                                                                                          |
| C5  | Same key, other body, at the data-manager                        | —                                                                            | not expressible from outside: DM executions need an agent-signed delegation                     |
| C6  | Agent killed during a service start's Compose effect             | —                                                                            | fails today: the restarted agent refuses to start, its configuration writer is left held        |
| C6  | Cancel and deadline variants                                     | —                                                                            | not pinned (C6 itself fails today; deadlines are not reachable from outside)                    |
| C7  | Agent killed after accepting, before the effect                  | `agent-killed-before-effect.test.ts`                                         | pinned                                                                                          |
| C8  | Lost fence prepare reply                                         | `lost-fence-prepare-reply.test.ts`                                           | pinned                                                                                          |
| C9  | Lost fence settle reply                                          | `lost-fence-settle-reply.test.ts`                                            | pinned                                                                                          |
| C9  | Cancelled during the fence settle                                | `update-cancelled-during-settle.test.ts`                                     | pinned                                                                                          |
| C9  | Deadline variant                                                 | —                                                                            | not expressible: the roles' deadlines are minutes to hours of real time                         |
| C10 | Data-manager restarted while the fence is held                   | `maintenance-holds-admission.test.ts`, `fence-released-after-update.test.ts` | pinned                                                                                          |
| C11 | Data-manager killed in a legacy data job while the agent is down | —                                                                            | not pinned: needs a traffic data job, which needs Valhalla and OpenConditions in the fixture    |
| C12 | Agent restarted with a surviving data-manager child              | —                                                                            | not pinned: needs MOTIS and a transit job in the fixture                                        |
| C13 | Update requested while a data job runs                           | `data-job-blocks-update.test.ts`                                             | pinned                                                                                          |
| C14 | Registry outage after the check                                  | `registry-outage.test.ts`                                                    | pinned                                                                                          |
| C15 | New API image unhealthy                                          | `unhealthy-api-image.test.ts`                                                | pinned                                                                                          |
| C16 | Helper killed mid-recreate                                       | `helper-killed.test.ts`                                                      | pinned                                                                                          |
| C16 | Cancelled mid-recreate                                           | —                                                                            | fails today: the helper continues and the update succeeds after the cancel                      |
| C16 | Deadline variant                                                 | —                                                                            | not expressible: deadlines are not reachable from outside                                       |
| C17 | Agent restarted while the helper runs                            | `agent-restart-during-helper.test.ts`                                        | pinned                                                                                          |
| C18 | Host lifecycle commands while the helper runs                    | —                                                                            | fails today: `services restart` runs `compose restart` while the helper recreates               |
| C19 | Agent state filesystem full after an effect                      | `state-filesystem-full.test.ts`                                              | pinned (needs `OPENMAPX_RUN_CRASH_DISK_TESTS=1`)                                                |
| C20 | Restore of the pre-update backup                                 | —                                                                            | not pinned: backups need `docker exec` into PostgreSQL, which the fake engine does not model    |
