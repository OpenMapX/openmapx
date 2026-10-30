import { expect, it, vi } from "vitest";

const native = vi.hoisted(() => vi.fn());
vi.mock("execa", () => ({ execa: native }));

import { runningComposeServicesStrict } from "../src/lib/docker";

it("refuses artifact movement when Docker container state cannot be acquired", async () => {
  native.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "private diagnostic" });
  await expect(runningComposeServicesStrict(["osrm"])).rejects.toThrow(
    "Container state is unavailable",
  );
});
