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
