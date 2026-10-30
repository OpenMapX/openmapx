/** Run with the bundled actual store module; native Linux kill/restart proof. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(process.argv[2]).href;
const { ArtifactTransferStore } = await import(moduleUrl);
const root = mkdtempSync(join(tmpdir(), "omx-native-byte-"));
const options = {
  dataRoot: join(root, "stages"),
  privateRoot: join(root, "private"),
  token: "synthetic-native-byte-token",
};
let store;
let child;
try {
  mkdirSync(options.dataRoot, { mode: 0o700 });
  mkdirSync(options.privateRoot, { mode: 0o700 });
  const source = `
    import { ArtifactTransferStore } from ${JSON.stringify(moduleUrl)};
    import { statSync } from 'node:fs';
    const store = new ArtifactTransferStore(${JSON.stringify(options)});
    const stage = await store.createStage({ ownerId: 'native-admin', purpose: 'prepared-artifact', direction: 'upload', declaredBytes: 2, operationKey: ${JSON.stringify(`opk1_${randomUUID().replaceAll("-", "")}`)} });
    void store.upload({ stageId: stage.stageId, ownerId: 'native-admin', purpose: stage.purpose, attemptId: ${JSON.stringify(randomUUID())}, deadlineAt: Date.now()+60000, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([7])); } }) }).catch(()=>{});
    const timer = setInterval(() => { try { if(statSync(${JSON.stringify(options.dataRoot)}+'/'+stage.stageId+'/content').size===1) {clearInterval(timer);process.stdout.write(JSON.stringify(stage)+'\\n');} } catch {} }, 10);
    process.stdin.resume();
  `;
  child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const stage = await new Promise((resolve, reject) => {
    let data = "";
    const timer = setTimeout(
      () => reject(Error("Partial upload did not reach its actual FD")),
      20000,
    );
    child.stdout.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\n")) {
        clearTimeout(timer);
        resolve(JSON.parse(data.trim()));
      }
    });
    child.once("exit", (code) => reject(Error(`Upload process exited before hold: ${code}`)));
  });
  store = new ArtifactTransferStore(options);
  await store.reconcileTransferStages({ signal: new AbortController().signal });
  assert.equal(
    (
      await store.getStage({
        stageId: stage.stageId,
        ownerId: "native-admin",
        purpose: stage.purpose,
      })
    ).state,
    "uploading",
  );
  await assert.rejects(store.deleteStage({ stageId: stage.stageId, ownerId: "native-admin" }), {
    statusCode: 409,
  });
  const closed = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await closed;
  store.close();
  store = new ArtifactTransferStore(options);
  await store.reconcileTransferStages({ signal: new AbortController().signal });
  assert.equal(
    (
      await store.getStage({
        stageId: stage.stageId,
        ownerId: "native-admin",
        purpose: stage.purpose,
      })
    ).state,
    "failed",
  );
  assert.throws(() => readFileSync(join(options.dataRoot, stage.stageId, "content")), {
    code: "ENOENT",
  });
  assert.equal(await store.reservedBytes(), 0);
  await store.deleteStage({ stageId: stage.stageId, ownerId: "native-admin" });
  assert.equal(await store.reservedBytes(), 0);
  assert.equal(statSync(join(options.dataRoot, stage.stageId)).isDirectory(), true);
  console.log(
    JSON.stringify({
      passed: true,
      actualPartialBytes: 1,
      kill: "SIGKILL",
      liveOwnerPreserved: true,
      restartedState: "failed",
      reservedBytes: 0,
    }),
  );
} finally {
  child?.kill("SIGKILL");
  store?.close();
  rmSync(root, { recursive: true, force: true });
}
