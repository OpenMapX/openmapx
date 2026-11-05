import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { JobContext } from "./job-runner";

const database = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("../db", () => ({ db: database }));

import { extensionStep, openExtensionWorkflow } from "./extension-workflow";

let directory: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function context() {
  directory = await mkdtemp(join(tmpdir(), "extension-cursor-"));
  const file = join(directory, "token");
  await writeFile(file, "a".repeat(43), { mode: 0o600 });
  vi.stubEnv("OPS_AGENT_TOKEN_FILE", file);
  const ctx: JobContext = {
    jobId: randomUUID(),
    jobType: "extension.install",
    execution: { owner: randomUUID(), version: 1 },
    payload: { original: true },
    signal: new AbortController().signal,
    log: async () => {},
    setProgress: async () => {},
    checkpoint: async (value) => {
      ctx.checkpointResult = value;
    },
  };
  return ctx;
}
it("resumes the original completed publication without redispatch and rejects changed intent or forged cursor", async () => {
  const ctx = await context(),
    publish = vi.fn(async () => ({ transactionId: "original" }));
  const first = await openExtensionWorkflow(ctx, { id: "original" });
  expect(await extensionStep(first, "publish.integration", { id: "one" }, publish)).toEqual({
    transactionId: "original",
  });
  const replacement = { ...ctx, execution: { owner: randomUUID(), version: 2 } };
  replacement.checkpoint = async (value) => {
    replacement.checkpointResult = value;
  };
  const second = await openExtensionWorkflow(replacement, { id: "original" });
  expect(await extensionStep(second, "publish.integration", { id: "one" }, publish)).toEqual({
    transactionId: "original",
  });
  expect(publish).toHaveBeenCalledTimes(1);
  await expect(openExtensionWorkflow(replacement, { id: "changed" })).rejects.toThrow();
  const saved = replacement.checkpointResult!._extensionWorkflow as { body: string; mac: string };
  replacement.checkpointResult = {
    ...replacement.checkpointResult,
    _extensionWorkflow: { ...saved, body: saved.body.replace("original", "forged") },
  };
  await expect(openExtensionWorkflow(replacement, { id: "original" })).rejects.toThrow();
});
