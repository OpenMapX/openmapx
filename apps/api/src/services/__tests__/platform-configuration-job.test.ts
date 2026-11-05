import { expect, it } from "vitest";
import { platformJobMatchesPreview } from "../platform-configuration-job";

const release = { releaseId: "release-checked", manifestDigest: "a".repeat(64) };
const job = {
  type: "system.update",
  payload: {
    operation: "apply",
    workflow: "guarded-release",
    releaseId: release.releaseId,
    expectedDigest: release.manifestDigest,
  },
};
it("binds the queued update to its exact reviewed release", () => {
  expect(platformJobMatchesPreview(job, { release })).toBe(true);
  expect(platformJobMatchesPreview(job, {})).toBe(false);
  expect(
    platformJobMatchesPreview(job, { release: { ...release, manifestDigest: "b".repeat(64) } }),
  ).toBe(false);
  expect(platformJobMatchesPreview(job, { release: { ...release, releaseId: "another" } })).toBe(
    false,
  );
});
it("refuses legacy, extra-field and unrelated job selectors", () => {
  expect(
    platformJobMatchesPreview(
      { ...job, payload: { ...job.payload, workflow: undefined } },
      { release },
    ),
  ).toBe(false);
  expect(
    platformJobMatchesPreview(
      { ...job, payload: { ...job.payload, image: "untrusted" } },
      { release },
    ),
  ).toBe(false);
  expect(platformJobMatchesPreview({ ...job, type: "service.apply" }, { release })).toBe(false);
});
it("preserves the existing platform job path", () => {
  expect(platformJobMatchesPreview({ type: "platform.apply", payload: {} }, {})).toBe(true);
});
