import { describe, expect, it } from "vitest";
import { probeOpsPrivacyBackupCapability } from "./ops-backup-health.js";

const image = `ghcr.io/openmapx/privacy-backup@sha256:${"a".repeat(64)}`;
const env = {
  OPS_AGENT_URL: "https://ops.example.test",
  OPS_PRIVACY_BACKUP_COLLECTOR_IMAGE: image,
};

describe("ops privacy backup health", () => {
  it("accepts only live evidence for the exact pinned image and readable inventory", async () => {
    const probe = (payload: unknown) =>
      probeOpsPrivacyBackupCapability(
        env,
        async () => new Response(JSON.stringify(payload), { status: 200 }),
      );

    await expect(
      probe({
        ok: true,
        privacyBackup: { ready: true, inventoryReadable: true, collectorImage: image },
      }),
    ).resolves.toBe(true);
    await expect(
      probe({
        ok: true,
        privacyBackup: {
          ready: true,
          inventoryReadable: true,
          collectorImage: image.replace(/a/g, "b"),
        },
      }),
    ).resolves.toBe(false);
    await expect(probe({ ok: true })).resolves.toBe(false);
  });

  it("fails closed for configuration, transport, and bounded-response failures", async () => {
    await expect(probeOpsPrivacyBackupCapability({})).resolves.toBe(false);
    await expect(
      probeOpsPrivacyBackupCapability(env, async () => {
        throw new Error("offline");
      }),
    ).resolves.toBe(false);
    await expect(
      probeOpsPrivacyBackupCapability(
        env,
        async () => new Response("x".repeat(4_097), { status: 200 }),
      ),
    ).resolves.toBe(false);
  });
});
