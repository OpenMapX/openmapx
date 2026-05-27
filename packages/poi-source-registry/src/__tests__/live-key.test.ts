import { describe, expect, it } from "vitest";
import { poiLiveHashKey } from "../index.js";

/**
 * Pins the cross-process key format between data-manager's `write-live`
 * stage and the integration-framework's POI reader. If either side stops
 * importing this helper and switches to a literal — or this helper changes
 * shape — both halves of the round-trip miss, exactly the bug we hit in
 * production where apps/api prefixed the key with `int:<integration>:`.
 *
 * The literal in the assertion is intentional: drift here MUST require a
 * deliberate code change with reviewer attention.
 */
describe("poiLiveHashKey", () => {
  it('formats keys as "poi:live:<sourceId>" with no host-level prefixing', () => {
    expect(poiLiveHashKey("bnetza")).toBe("poi:live:bnetza");
    expect(poiLiveHashKey("duesseldorf-de")).toBe("poi:live:duesseldorf-de");
  });

  it("returns distinct keys for distinct source ids", () => {
    expect(poiLiveHashKey("a")).not.toBe(poiLiveHashKey("b"));
  });
});
