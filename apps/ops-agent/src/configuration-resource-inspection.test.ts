import { describe, expect, it } from "vitest";
import { verifyConfigurationRuntimeResources } from "./configuration-resource-inspection";

describe("actual Docker runtime limits", () => {
  const expected = { deploy: { resources: { limits: { memory: "268435456", cpus: 0.5 } } } };
  it("compares normalized Compose limits with actual cgroup settings for unchanged images", () => {
    expect(
      verifyConfigurationRuntimeResources(expected, {
        HostConfig: { Memory: 268435456, NanoCpus: 500000000 },
      }),
    ).toEqual({ memoryBytes: 268435456, nanoCpus: 500000000 });
    expect(
      verifyConfigurationRuntimeResources(expected, {
        HostConfig: { Memory: 268435456, NanoCpus: 0, CpuQuota: 50000, CpuPeriod: 100000 },
      }),
    ).toEqual({ memoryBytes: 268435456, nanoCpus: 500000000 });
  });
  it.each([
    { HostConfig: { Memory: 536870912, NanoCpus: 500000000 } },
    { HostConfig: { Memory: 268435456, NanoCpus: 1000000000 } },
    { HostConfig: { Memory: 268435456, NanoCpus: 0 } },
    { HostConfig: { Memory: 268435456, NanoCpus: 500000000, CpuQuota: 100000, CpuPeriod: 100000 } },
    {},
  ])("rejects missing or mismatched runtime memory/CPU %#", (actual) => {
    expect(() => verifyConfigurationRuntimeResources(expected, actual)).toThrow();
  });
  it("verifies explicit reset to no limit rather than keeping previous resource values", () => {
    expect(
      verifyConfigurationRuntimeResources({}, { HostConfig: { Memory: 0, NanoCpus: 0 } }),
    ).toEqual({ memoryBytes: 0, nanoCpus: 0 });
    expect(() =>
      verifyConfigurationRuntimeResources(
        {},
        { HostConfig: { Memory: 268435456, NanoCpus: 500000000 } },
      ),
    ).toThrow();
  });
});
