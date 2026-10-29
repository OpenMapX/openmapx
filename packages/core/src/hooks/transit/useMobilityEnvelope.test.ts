import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { expect, it } from "vitest";
import { wrapMobilityEnvelope } from "./useMobilityEnvelope";

const a = { sourceId: "a", name: "A" };
it("captures legacy uniform responses once while keeping retained records referentially stable", () => {
  const envelope = { data: [{ id: "a:stop" }], attributions: [a] } as MobilityEnvelope<
    TransitStop[]
  >;
  const query = { data: envelope } as never;
  const first = wrapMobilityEnvelope<TransitStop[]>(query);
  expect(first.data?.[0].contributors).toEqual([a]);
  expect(wrapMobilityEnvelope<TransitStop[]>(query).data).toBe(first.data);
  expect(envelope.data[0].contributors).toBeUndefined();
});
it("does not give an untagged legacy stop every source of a mixed envelope", () => {
  const b = { sourceId: "b", name: "B" };
  const query = { data: { data: [{ id: "unknown" }], attributions: [a, b] } } as never;
  expect(wrapMobilityEnvelope<TransitStop[]>(query).data?.[0].contributors).toEqual([]);
});
