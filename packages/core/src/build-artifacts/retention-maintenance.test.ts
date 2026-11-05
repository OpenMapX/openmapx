import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  closeControlInstallation,
  openControlInstallation,
  provisionControlInstallation,
} from "./control-authority";
import { startControlRetentionMaintenance } from "./retention-maintenance";

it("reports a repeatedly occupied collector guard without removing it", async () => {
  const root = mkdtempSync(join(tmpdir(), "omx-retention-busy-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await provisionControlInstallation(root);
  const installation = openControlInstallation({
    infraDir: root,
    role: "data-manager",
    serviceIds: ["data-manager"],
  });
  const guard = join(root, "control-private/data-manager/.retention-reconcile-writer");
  mkdirSync(guard, { mode: 0o700 });
  const warn = vi.fn();
  let stop: (() => Promise<void>) | undefined;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const maintenance = startControlRetentionMaintenance(installation, warn);
    stop = maintenance.stop;
    await maintenance.ready;
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await stop();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringMatching(/retention.*writer.*busy/i) }),
    );
    expect(existsSync(guard)).toBe(true);
  } finally {
    await stop?.();
    vi.useRealTimers();
    closeControlInstallation(installation);
    rmSync(root, { recursive: true, force: true });
  }
});
