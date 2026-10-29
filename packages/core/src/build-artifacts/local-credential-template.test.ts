import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlRootOperationKey, executionFingerprint, opsOperationSchema } from "../ops";
import {
  closeControlInstallation,
  controlDigest,
  localFeedCredentialTemplateMac,
  openControlInstallation,
  provisionControlInstallation,
  retainAdmittedControlExecution,
} from "./control-authority";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const operation = {
  kind: "transit.credentials.template",
  catalogRevisionId: "a".repeat(64),
  outputPath: "services/motis/tools/transitous/api-keys.json",
  fileMac: "b".repeat(64),
};
async function fixture(role: "host-cli" | "ops-agent" | "data-manager") {
  const root = mkdtempSync(join(tmpdir(), "omx-local-credential-owner-"));
  roots.push(root);
  mkdirSync(join(root, "data"));
  await provisionControlInstallation(root);
  return openControlInstallation({ infraDir: root, role, serviceIds: ["motis", "valhalla"] });
}
function input(
  executor: "host-cli" | "ops-agent" | "data-manager",
  principal: "host-cli" | "api" | "data-manager" = "host-cli",
  serviceIds = ["motis"],
) {
  const admittedAt = Date.now(),
    deadlineAt = admittedAt + 300000,
    operationFingerprint = controlDigest(operation);
  return {
    kind: operation.kind,
    operation,
    admittedAt,
    requestedDeadlineAt: deadlineAt,
    serviceIds,
    execution: {
      executor,
      principal,
      executionId:
        executor === "ops-agent" ? `job1_${randomUUID().replaceAll("-", "")}` : randomUUID(),
      operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
      deadlineAt,
      operationFingerprint,
      fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
    },
  };
}
it("does not expose a credential template as an HTTP operation", () => {
  expect(opsOperationSchema.safeParse(operation).success).toBe(false);
});
it.each(["ops-agent", "data-manager"] as const)(
  "refuses the %s executor and its opaque file MAC oracle",
  async (role) => {
    const installation = await fixture(role);
    try {
      expect(() =>
        retainAdmittedControlExecution(
          installation,
          input(role, role === "ops-agent" ? "api" : "data-manager"),
        ),
      ).toThrow(/local/);
      expect(() => localFeedCredentialTemplateMac(installation, operation, "{}\n")).toThrow(
        /Local host/,
      );
    } finally {
      closeControlInstallation(installation);
    }
  },
);
it("requires local host intent and exactly the MOTIS closure", async () => {
  const installation = await fixture("host-cli");
  try {
    expect(() => retainAdmittedControlExecution(installation, input("host-cli", "api"))).toThrow(
      /local/,
    );
    expect(() =>
      retainAdmittedControlExecution(installation, input("host-cli", "host-cli", ["valhalla"])),
    ).toThrow(/local/);
  } finally {
    closeControlInstallation(installation);
  }
});
