/** Actual Linux validation FD, SIGSTOP/SIGKILL, store restart and original receipt proof. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(process.argv[2]).href;
const { ArtifactTransferStore, control, ops, retainArtifactValidationObservation } = await import(
  moduleUrl
);
const root = mkdtempSync(join(tmpdir(), "omx-native-validation-")),
  infra = join(root, "infra"),
  options = {
    dataRoot: join(infra, "data/.openmapx-transfers"),
    privateRoot: join(infra, "control-private/ops-agent/artifact-transfers"),
    token: "synthetic-native-validation-token",
  };
let child, store, installation;
try {
  mkdirSync(join(infra, "data"), { recursive: true, mode: 0o700 });
  const source = `
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import {Writable} from 'node:stream'; import {randomBytes,randomUUID} from 'node:crypto';
    import {ArtifactTransferStore,control,ops} from ${JSON.stringify(moduleUrl)};
    const infra=${JSON.stringify(infra)},root=${JSON.stringify(root)},options=${JSON.stringify(options)};
    await control.provisionControlInstallation(infra);
    const installation=control.openControlInstallation({infraDir:infra,role:'ops-agent',serviceIds:['osrm']}), store=new ArtifactTransferStore(options);
    fs.mkdirSync(root+'/source/osrm-graph',{recursive:true,mode:0o755});
    for(const name of ['region.osrm','region.osrm.partition','region.osrm.cells','region.osrm.mldgr'])fs.writeFileSync(root+'/source/osrm-graph/'+name,'synthetic '+name,{mode:0o644});
    const chunks=[];await control.writeBuildBundle({dataRoot:root+'/source',serviceId:'osrm',record:{schemaVersion:1,service:'osrm',builtAt:new Date().toISOString(),runtimeImages:{osrm:'example/osrm:1'},toolImages:{}},target:new Writable({write(chunk,e,done){chunks.push(Buffer.from(chunk));done();}}),limits:control.DEFAULT_ARTIFACT_ARCHIVE_LIMITS,signal:new AbortController().signal});
    const bytes=Buffer.concat(chunks),stage=await store.createStage({ownerId:'native-admin',purpose:'prepared-artifact',direction:'upload',declaredBytes:bytes.length,operationKey:'opk1_'+randomUUID().replaceAll('-','')});
    await store.upload({stageId:stage.stageId,ownerId:'native-admin',purpose:stage.purpose,attemptId:randomUUID(),deadlineAt:Date.now()+60000,body:new ReadableStream({start(c){c.enqueue(bytes);c.close();}})});
    const operation={kind:'artifactTransfer.validate',stageId:stage.stageId,ownerId:'native-admin',purpose:'prepared-artifact'},operationFingerprint=ops.opsOperationFingerprint(operation),admittedAt=Date.now(),requestedDeadlineAt=admittedAt+600000,operationKey=ops.createControlRootOperationKey({notAfter:requestedDeadlineAt,nonce:randomBytes(16)}),admission=ops.normalizeExecutionAdmission({operationFingerprint,operationKey,kind:operation.kind,admittedAt,requestedDeadlineAt}),execution={executor:'ops-agent',principal:'api',executionId:'job1_'+randomUUID().replaceAll('-',''),operationKey,operationFingerprint,deadlineAt:admission.deadlineAt,fingerprint:admission.fingerprint},authority=control.retainAdmittedControlExecution(installation,{execution,kind:operation.kind,operation,admittedAt,requestedDeadlineAt,serviceIds:['osrm']});
    control.requireControlJournalRetention(authority);control.beginControlEffect(authority);
    const native=fs.writeSync;let stopped=false;
    fs.writeSync=function(fd,...args){const value=native.call(fs,fd,...args);if(!stopped && fs.readlinkSync('/proc/self/fd/'+fd).includes('/prepared-')){stopped=true;native.call(fs,1,Buffer.from(JSON.stringify({stage,execution,operation,admittedAt})+'\\n'));process.kill(process.pid,'SIGSTOP');}return value;};syncBuiltinESMExports();
    await store.validatePreparedArtifact({execution,controlAuthority:authority,signal:new AbortController().signal,emitLog(){},claim:{source:'registry',operation,fingerprint:operationFingerprint,capability:{revisionId:'fixture',values:{}}}});
  `;
  child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const original = await new Promise((resolve, reject) => {
    let data = "";
    const timer = setTimeout(
      () => reject(Error("Validation did not reach actual extraction write")),
      60000,
    );
    child.stdout.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\n")) {
        clearTimeout(timer);
        resolve(JSON.parse(data.trim()));
      }
    });
    child.once("exit", (code) =>
      reject(Error("Validation exited before extraction hold: " + code)),
    );
  });
  store = new ArtifactTransferStore(options);
  await store.reconcileTransferStages({ signal: new AbortController().signal });
  assert.equal(
    (
      await store.getStage({
        stageId: original.stage.stageId,
        ownerId: "native-admin",
        purpose: "prepared-artifact",
      })
    ).state,
    "validating",
  );
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  store.close();
  store = new ArtifactTransferStore(options);
  await store.reconcileTransferStages({ signal: new AbortController().signal });
  const stage = await store.getStage({
    stageId: original.stage.stageId,
    ownerId: "native-admin",
    purpose: "prepared-artifact",
  });
  assert.equal(stage.state, "failed");
  assert.equal(stage.cleanup, "complete");
  assert.equal(await store.reservedBytes(), 0);
  installation = control.openControlInstallation({
    infraDir: infra,
    role: "ops-agent",
    serviceIds: ["osrm"],
  });
  const authority = control.restoreAdmittedControlExecution(installation, original.execution),
    at = Date.now(),
    status = {
      version: 2,
      admittedAt: original.admittedAt,
      deadlineAt: original.execution.deadlineAt,
      fingerprint: original.execution.fingerprint,
      operationId: original.execution.executionId,
      operationKey: original.execution.operationKey,
      kind: "artifactTransfer.validate",
      resourceId: ops.opsResourceId(original.operation),
      state: "failed",
      errorClass: "recovery_required",
      submittedAt: new Date(original.admittedAt).toISOString(),
      updatedAt: new Date(at).toISOString(),
    };
  control.retainControlEffectReceipt(authority, {
    outcome: "unknown",
    publication: "unknown",
    receipt: { kind: "unresolved" },
  });
  control.retainControlTerminalCommitment(authority, status, at);
  control.retainControlTerminalStatus(installation, original.execution, status, at);
  const owner = control.executionAuthorityState(authority),
    before = control.controlDigest(
      control.readPrivateRecord(
        owner.installation,
        "observations",
        "terminal-" + original.execution.operationKey + ".json",
      ),
    );
  const contained = await store.recoverPreparedValidation(authority);
  control.cancelControlExecution(authority);
  control.retainControlEffectReceipt(authority, {
    outcome: "committed",
    publication: "committed",
    receipt: { kind: "ops-result", result: contained },
  });
  retainArtifactValidationObservation(authority, status, at, contained);
  control.completeControlJournalExecution(authority);
  assert.equal(
    control.controlDigest(
      control.readPrivateRecord(
        owner.installation,
        "observations",
        "terminal-" + original.execution.operationKey + ".json",
      ),
    ),
    before,
  );
  assert.equal(existsSync(join(infra, "data/osrm-graph")), false);
  console.log(
    JSON.stringify({
      passed: true,
      kill: "SIGKILL",
      actualExtractionWrite: true,
      liveOwnerPreserved: true,
      recoveredPrivateFailure: true,
      originalCanonicalUnchanged: true,
      managedFilesPublished: false,
      reservedBytes: 0,
    }),
  );
} finally {
  child?.kill("SIGKILL");
  store?.close();
  if (installation) control.closeControlInstallation(installation);
  rmSync(root, { recursive: true, force: true });
}
