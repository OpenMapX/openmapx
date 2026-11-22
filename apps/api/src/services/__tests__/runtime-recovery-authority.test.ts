import { services } from "@openmapx/core/server";
import { describe, expect, it, vi } from "vitest";
import { callArg } from "../../test/mock-calls";
import { openRuntimeRecoveryAuthority } from "../runtime-recovery-authority";

describe("runtime recovery startup authority", () => {
  it("fails before journal consumption when the fixed release inventory is invalid", async () => {
    const openJournal = vi.fn();
    await expect(
      openRuntimeRecoveryAuthority("/trusted/release", {
        validateAuthority: vi.fn().mockRejectedValue(new Error("damaged release")),
        openJournal,
      }),
    ).rejects.toThrow("damaged release");
    expect(openJournal).not.toHaveBeenCalled();
  });

  it("passes the complete fixed inventory and unconditional NEVER IDs to the journal", async () => {
    const journal = { record: () => null, replace: vi.fn(), clear: vi.fn() };
    const openJournal = vi.fn().mockResolvedValue(journal);
    await expect(
      openRuntimeRecoveryAuthority("/trusted/release", {
        validateAuthority: vi
          .fn()
          .mockResolvedValue(new Set(services.RELEASE_BUILT_IN_SERVICE_IDS)),
        openJournal,
      }),
    ).resolves.toBe(journal);
    expect(openJournal).toHaveBeenCalledWith(expect.stringMatching(/runtime-recovery-v1\.json$/), {
      forbiddenServiceIds: expect.arrayContaining([...services.RELEASE_BUILT_IN_SERVICE_IDS]),
    });
  });

  it.each(services.CONTROL_PLANE_SERVICE_IDS)(
    "forbids recovering control-plane %s even if the release inventory omitted it",
    async (serviceId) => {
      const openJournal = vi.fn().mockResolvedValue({});
      await openRuntimeRecoveryAuthority("/trusted/release", {
        validateAuthority: vi.fn().mockResolvedValue(new Set()),
        openJournal,
      });
      const options = callArg(openJournal, 0, 1) as { forbiddenServiceIds: string[] };
      expect(options.forbiddenServiceIds).toContain(serviceId);
    },
  );
});
