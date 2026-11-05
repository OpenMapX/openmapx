import { expect, it } from "vitest";
import {
  configurationHandoffHelperBodySchema,
  configurationHandoffProgressSchema,
  configurationHandoffReleaseProgressSchema,
} from "./configuration-handoff-records";

const image = `sha256:${"a".repeat(64)}`;
const progress = () => ({
  version: 1,
  intentDigest: "b".repeat(64),
  sequence: 0,
  phase: "prepared",
  launch: { state: "not_attempted", containerId: null },
  targets: [
    {
      serviceId: "app-api",
      phase: "pending",
      oldContainerId: "c".repeat(64),
      newContainerId: null,
      expectedImageId: image,
    },
  ],
  updatedAt: 1,
  completedAt: null,
});
it("retains a reference-only helper body and truthful bounded launch/target progress", () => {
  expect(
    configurationHandoffHelperBodySchema.parse({
      kind: "configuration-helper",
      handoffId: "11111111-1111-4111-8111-111111111111",
      intentDigest: "a".repeat(64),
    }).kind,
  ).toBe("configuration-helper");
  expect(
    configurationHandoffHelperBodySchema.safeParse({
      kind: "configuration-helper",
      handoffId: "11111111-1111-4111-8111-111111111111",
      intentDigest: "a".repeat(64),
      path: "/tmp/selected",
    }).success,
  ).toBe(false);
  expect(configurationHandoffProgressSchema.parse(progress()).phase).toBe("prepared");
  expect(
    configurationHandoffProgressSchema.safeParse({
      ...progress(),
      phase: "applied",
      completedAt: 2,
    }).success,
  ).toBe(false);
  expect(
    configurationHandoffProgressSchema.parse({
      ...progress(),
      phase: "applied",
      completedAt: 2,
      updatedAt: 2,
      launch: { state: "confirmed", containerId: "d".repeat(64) },
      targets: [{ ...progress().targets[0]!, phase: "verified", newContainerId: "e".repeat(64) }],
    }).phase,
  ).toBe("applied");
  expect(
    configurationHandoffProgressSchema.safeParse({
      ...progress(),
      targets: [...progress().targets, ...progress().targets],
    }).success,
  ).toBe(false);
});

it("does not confuse an attempted release pull/publication with verified local images and overlay", () => {
  const image = {
    image: "api",
    reference: `ghcr.io/openmapx/api@sha256:${"a".repeat(64)}`,
    phase: "pending",
    imageId: null,
  };
  const initial = {
    images: [image],
    publication: "not_attempted",
    overlay: null,
    statePublication: "not_attempted",
    state: null,
  };
  expect(configurationHandoffReleaseProgressSchema.parse(initial)).toEqual(initial);
  expect(
    configurationHandoffReleaseProgressSchema.safeParse({
      ...initial,
      images: [{ ...image, phase: "verified" }],
    }).success,
  ).toBe(false);
  expect(
    configurationHandoffReleaseProgressSchema.safeParse({
      ...initial,
      images: [{ ...image, imageId: `sha256:${"b".repeat(64)}` }],
    }).success,
  ).toBe(false);
  expect(
    configurationHandoffReleaseProgressSchema.safeParse({ ...initial, publication: "published" })
      .success,
  ).toBe(false);
  expect(
    configurationHandoffReleaseProgressSchema.safeParse({ ...initial, images: [image, image] })
      .success,
  ).toBe(false);
});
