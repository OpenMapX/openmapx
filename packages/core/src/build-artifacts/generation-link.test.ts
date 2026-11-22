import { randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createControlRootOperationKey } from "../ops/control-root-key";
import { createDataManagerTransport } from "../services/data-manager/transport";
import { GenerationLinkNotApplied, GenerationLinkUnknown, linkGeneration } from "./generation-link";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const lost = () => Promise.reject(new TypeError("fetch failed"));
const busy = () =>
  json({ statusCode: 409, error: "Conflict", message: "configuration_maintenance_busy" }, 409);
const conflict = () =>
  json({ statusCode: 409, error: "Conflict", message: "Data execution identity conflict" }, 409);
const applied = () => json({ ok: true, linked: 1, skipped: 0, pruned: 0 }, 200);

/** Sends a plan to a data-manager that gives these answers, one per request. */
function send(answers: (() => Response | Promise<Response>)[], lifetimeMs = 60_000) {
  const fetch = vi.fn(async () => {
    const answer = answers.shift();
    if (!answer) throw Error("No answer left");
    return answer();
  });
  const deadlineAt = Date.now() + lifetimeMs;
  const result = linkGeneration({
    transport: createDataManagerTransport({ baseUrl: "http://openmapx-data-manager", fetch }),
    operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
    deadlineAt,
    revisionId: `cfg1_${"a".repeat(43)}`,
    plan: [],
    prune: true,
    leaseId: null,
  });
  return { fetch, result };
}

it("reads a busy refusal of a first request as nothing linked", async () => {
  const { result } = send([busy]);
  await expect(result).rejects.toMatchObject({
    name: GenerationLinkNotApplied.name,
    reason: "busy",
  });
});

it("asks again when a busy refusal follows an unanswered request", async () => {
  // The unanswered copy may still be inside its admission and about to link.
  const { fetch, result } = send([lost, busy, applied]);
  await expect(result).resolves.toMatchObject({ applied: true, linked: 1 });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("reports an unknown outcome when an unanswered request is only ever answered busy", async () => {
  const { result } = send([lost, busy, busy, busy, busy, busy], 1_500);
  await expect(result).rejects.toBeInstanceOf(GenerationLinkUnknown);
});

it("keeps another refusal after an unanswered request an answer", async () => {
  const { fetch, result } = send([lost, conflict]);
  await expect(result).rejects.toBeInstanceOf(GenerationLinkNotApplied);
  expect(fetch).toHaveBeenCalledTimes(2);
});
