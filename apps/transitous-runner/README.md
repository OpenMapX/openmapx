# Transitous runner shutdown

The private runner handles SIGTERM and SIGINT by closing run admission,
canceling its owned detached process groups, and awaiting their containment
before closing HTTP connections. Repeated signals share the same shutdown.
The runtime image uses tini as PID 1 to forward signals and reap adopted
descendants; the runner itself owns cancellation of its detached groups.

An interrupted run returns the existing contained failure result (`ok: false`,
`exitCode: 1`). A connected data-manager caller journals it and counts a feed failure.
A disconnected caller keeps the existing outcome-unknown behavior. Disconnecting
a request reader alone still does not cancel a run.

Failures during fixed argument or catalog-path preparation retain a terminal
failure with no output and zero process runtime, while the original POST keeps
its error status. A durable caller can inspect, journal and acknowledge that
definitive failure instead of polling an unfinished row and reporting an unknown
outcome. Acknowledgement does not permit replay of the consumed capability.

Unclassified exceptions during execution, including a throwing spawn
implementation, remain unresolved: they do not prove that no process exists.
Those rows cannot be acknowledged and occupy capacity until the runner restarts. Preparation-only failure handling does not claim containment
for them.

Run portable lifecycle tests with:

```sh
pnpm exec vitest run --project node apps/transitous-runner/src
```

The image tests are opt-in and create only uniquely named disposable local
containers. They exercise both a live parent and an exited parent with an
orphaned descendant, using a numeric user and dropped capabilities:

```sh
docker buildx build --load -f apps/transitous-runner/Dockerfile -t openmapx-runner-shutdown:test .
OPENMAPX_TEST_RUNNER_IMAGE=openmapx-runner-shutdown:test \
  pnpm exec vitest run --project node apps/transitous-runner/src/shutdown-image.test.ts
```

Each image case requires SIGTERM shutdown to finish within ten seconds with
exit code 0 and a contained HTTP response, rather than Docker's SIGKILL fallback.
