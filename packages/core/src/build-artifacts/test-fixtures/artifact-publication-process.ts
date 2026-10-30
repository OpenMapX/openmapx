/** Owned native crash fixture. Only its test supplies paths and synthetic bytes. */
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  createControlRootOperationKey,
  executionFingerprint,
  opsOperationFingerprint,
} from "../../ops/index";
import { DEFAULT_ARTIFACT_ARCHIVE_LIMITS, validateBuildBundle, writeBuildBundle } from "../archive";
import * as control from "../control-authority";
import { acquireArtifactTargetLease } from "../target-lease";

const root = process.argv[2]!,
  point = process.argv[3]!;
if (!root || !["old-directory", "build-record"].includes(point))
  throw Error("Native fixture input required");
const dataRoot = join(root, "data"),
  source = join(root, "source");
fs.mkdirSync(join(dataRoot, "osrm-graph"), { recursive: true });
fs.writeFileSync(join(dataRoot, "osrm-graph/old"), "old graph");
fs.mkdirSync(join(dataRoot, ".openmapx-builds"));
const oldRecord = JSON.stringify({
  schemaVersion: 1,
  service: "osrm",
  builtAt: "2026-01-01T00:00:00.000Z",
  runtimeImages: { osrm: "example/osrm:1" },
  toolImages: {},
});
fs.writeFileSync(join(dataRoot, ".openmapx-builds/osrm.json"), oldRecord, { mode: 0o600 });
const oldDirectoryInode = fs.statSync(join(dataRoot, "osrm-graph")).ino;
fs.mkdirSync(join(source, "osrm-graph"), { recursive: true });
for (const name of [
  "region.osrm",
  "region.osrm.partition",
  "region.osrm.cells",
  "region.osrm.mldgr",
])
  fs.writeFileSync(join(source, "osrm-graph", name), `new ${name}`);
const chunks: Buffer[] = [];
await writeBuildBundle({
  dataRoot: source,
  serviceId: "osrm",
  record: {
    schemaVersion: 1,
    service: "osrm",
    builtAt: "2026-10-30T00:00:00.000Z",
    runtimeImages: { osrm: "example/osrm:1" },
    toolImages: {},
  },
  target: new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  }),
  limits: DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
  signal: new AbortController().signal,
});
const stageId = randomUUID(),
  stagingRoot = join(dataRoot, `.openmapx-import-${stageId}`);
fs.mkdirSync(stagingRoot, { mode: 0o700 });
const bundle = await validateBuildBundle({
  source: Readable.from([Buffer.concat(chunks)]),
  stagingRoot,
  limits: DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
  signal: new AbortController().signal,
});
await control.provisionControlInstallation(root);
const installation = control.openControlInstallation({
  infraDir: root,
  role: "host-cli",
  serviceIds: ["osrm"],
});
const admittedAt = Date.now(),
  deadlineAt = admittedAt + 300000,
  operationKey = createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
  operation = {
    kind: "artifactTransfer.import" as const,
    stageId,
    ownerId: "host-cli",
    expectedSha256: bundle.archiveSha256,
    previewFingerprint: "a".repeat(64),
    expectedCurrentRevisionId: null,
  },
  operationFingerprint = opsOperationFingerprint(operation),
  execution = {
    executor: "host-cli" as const,
    principal: "host-cli" as const,
    executionId: randomUUID(),
    operationKey,
    operationFingerprint,
    deadlineAt,
    fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
  };
const authority = control.retainAdmittedControlExecution(installation, {
    execution,
    kind: operation.kind,
    operation,
    admittedAt,
    requestedDeadlineAt: deadlineAt,
    serviceIds: ["osrm"],
  }),
  lease = await acquireArtifactTargetLease({ dataRoot, serviceIds: ["osrm"], owner: authority });
const nativeRename = fs.renameSync;
let stopped = false;
fs.renameSync = (from, to) => {
  const isOldDirectory =
    point === "old-directory" &&
    fs.statSync(from).isDirectory() &&
    fs.statSync(from).ino === oldDirectoryInode;
  const isRecord =
    point === "build-record" &&
    String(to).endsWith("/osrm.json") &&
    String(from).includes(".write-");
  nativeRename(from, to);
  if (!stopped && (isOldDirectory || isRecord)) {
    stopped = true;
    fs.writeFileSync(
      join(root, "fault.json"),
      JSON.stringify({
        execution,
        stageId,
        stagingRoot,
        bundle,
        expectedFingerprint,
        oldRecord,
        oldDirectoryInode,
        leaseId: lease.leaseId,
        admissionDigest: control.executionAuthorityState(authority).receiptDigest,
      }),
      { mode: 0o600 },
    );
    process.kill(process.pid, "SIGSTOP");
    throw Error("Native fixture must be killed at the actual publication boundary");
  }
};
syncBuiltinESMExports();
const { artifactPublicationFingerprint, publishValidatedBuild } = await import("../publication");
const expectedFingerprint = await artifactPublicationFingerprint(dataRoot, "osrm");
await publishValidatedBuild({
  dataRoot,
  stagingRoot,
  stageId,
  bundle,
  authority,
  lease,
  expectedFingerprint,
});
throw Error("Named native crash boundary was not reached");
