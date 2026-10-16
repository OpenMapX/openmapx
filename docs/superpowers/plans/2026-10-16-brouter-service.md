# BRouter service implementation plan

Spec: docs/superpowers/specs/2026-10-16-brouter-design.md

## Global constraints

Work on main as explicitly requested. Preserve unrelated host changes. No new
Docker authority outside ops-agent. Service is opt-in; no user routing changes
until stage two. Use upstream release 1.7.10 with published SHA256 and a pinned
Temurin 17 JDK image, because the currently published BRouter image is older.

### Task 1: Coverage and download transaction

Files: create services/brouter/scripts/coverage.sh and services/brouter/tests/coverage.test.ts.

Interfaces: coverage.sh exports normalize_region, region_bounds, select_segments,
and prepare_generation; the supervisor passes a data root, region and segment
base URL, and receives a complete staged directory with segments and lookups.

- Write failing tests for Germany alias, valid nested extract and planet; reject
  traversal and malformed names. Verify rectangle selection includes all nine
  Germany bounding tiles and excludes unrelated tiles. Reject empty indexes,
  truncated files and preserve an existing current generation after failure.
- Implement bounded curl downloads, index parsing and staging/publication helpers.
- Run pnpm exec vitest run services/brouter/tests/coverage.test.ts. Expected: pass.

### Task 2: Runtime, manifest and operator documentation

Files: create services/brouter/service.json, scripts/run.sh, tests/service.test.ts;
modify infra/docker/.env.example, docs/docs/install/managing-services.md,
packages/core/src/services/release-authority-inventory.ts and the Renovate
inventory assertion in scripts/supply-chain-policy.test.ts.

Interfaces: supervisor uses Task 1 helpers; config REGION, UPDATE_INTERVAL_HOURS,
JAVA_HEAP_MB, MAXTHREADS and REQUEST_TIMEOUT_SECONDS resolves using standard
SERVICE_BROUTER_<KEY> precedence. Service supplies routing-engine on port 17777.

- Write failing assertions for manifest validity, selection optionality, rendered
  config, named persistence, health and private exposure.
- Implement checksum-verified distribution extraction; bootstrap or reuse matching
  coverage, weekly refresh, atomic generation publication and Java restart, signal
  handling and health. Do not log full route request URLs.
- Document enable/configure/start and update behavior. Run focused tests, policy
  checks, lint/types and real Docker startup with German tiles. Expected: prepared
  dataset, responsive engine and successful bike route.

### Task 3: Review and first deployment

- Self-review diff for paths, data publication, failed updates, signals and no
  implicit public service use. Fix defects with regression tests.
- Run required project gates, commit feat(brouter): add optional managed routing
  service, and push main. Preserve complete test results in the execution ledger.
- On DEORS-SRV-1 fast-forward code preserving runtime Valhalla config; enable
  brouter through existing selection, set Germany coverage, render and start only
  brouter. Verify container health, real routes, memory/disk and public health.
- Record deployed revision and data generation before beginning feature work.

## Review focus

Coverage shrink on config change; partially downloaded generations; Java caches
across publication; downloads surviving shutdown; region index names as paths.

## Plan self-review

Every service acceptance requirement maps to Tasks 1-3. Runtime consumes the same
coverage functions tested in Task 1. Tests run before implementation. The Germany
service is deployed before feature code starts. Stage-two plan is written against
the verified engine response and current routing call sites after this gate.
