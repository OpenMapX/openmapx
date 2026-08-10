import {
  MOBILE_PROTOCOL_MAX,
  MOBILE_PROTOCOL_MIN,
  messageAllowedAtVersion,
  negotiateMobileProtocol,
} from "@openmapx/core/navigation";
import { describe, expect, it } from "vitest";
import { browserEngineAllowed } from "./nativeSnapshotReducer";

/**
 * The compatibility matrix, as fixtures rather than a table in a document.
 *
 * The web app deploys continuously; the store binary does not. So at any moment
 * there are older shells running against a newer web app and — after a store
 * release the user has not yet received alongside a rollback — newer shells
 * running against an older one. Both have to work, and neither may quietly fall
 * back to a second navigation engine.
 *
 * A document describing that would drift. These do not.
 */

interface Side {
  min: number;
  max: number;
}

const V1: Side = { min: 1, max: 1 };
const V2: Side = { min: 1, max: 2 };
const CURRENT: Side = { min: MOBILE_PROTOCOL_MIN, max: MOBILE_PROTOCOL_MAX };
/** A future shell whose range no longer overlaps this web app's. */
const FUTURE_ONLY: Side = { min: MOBILE_PROTOCOL_MAX + 1, max: MOBILE_PROTOCOL_MAX + 2 };

const V1_ONLY_MESSAGES = ["session.prepare", "session.start", "snapshot.request", "event.ack"];
const V2_MESSAGES = ["location.request", "settings.open", "auth.open"];

describe("v1 native", () => {
  it("negotiates v1 with the current web app", () => {
    expect(negotiateMobileProtocol(CURRENT, V1)).toBe(1);
  });

  it("still runs navigation", () => {
    for (const type of V1_ONLY_MESSAGES) {
      expect(messageAllowedAtVersion(type, 1)).toBe(true);
    }
  });

  it("hides every v2 feature", () => {
    for (const type of V2_MESSAGES) {
      expect(messageAllowedAtVersion(type, 1)).toBe(false);
    }
  });

  it("keeps the browser engine off", () => {
    // A v1 shell is still an installed app. "Older" is not "browser".
    expect(browserEngineAllowed("native")).toBe(false);
  });
});

describe("v2 native", () => {
  it("negotiates v2 with a v2 web app", () => {
    expect(negotiateMobileProtocol(V2, V2)).toBe(2);
  });

  it("negotiates v1 with a web app that only knows v1", () => {
    // The reverse direction: a newer binary against an older deployed page.
    expect(negotiateMobileProtocol(V1, V2)).toBe(1);
  });

  it("runs full behaviour at v2", () => {
    for (const type of [...V1_ONLY_MESSAGES, ...V2_MESSAGES]) {
      expect(messageAllowedAtVersion(type, 2)).toBe(true);
    }
  });
});

describe("no overlap", () => {
  it("produces no negotiated version at all", () => {
    expect(negotiateMobileProtocol(CURRENT, FUTURE_ONLY)).toBeNull();
  });

  it("is an incompatibility, never a licence to fall back", () => {
    // The whole point: an installed app that cannot negotiate must ask for an
    // update, not start a second engine beside a native session it cannot see.
    expect(browserEngineAllowed("error")).toBe(false);
    expect(browserEngineAllowed("negotiating")).toBe(false);
  });
});

describe("staged deployment", () => {
  it("never requires a lockstep store review and web deploy", () => {
    // Step 1: web supports old and new. Old shells keep working.
    expect(negotiateMobileProtocol(V2, V1)).toBe(1);
    // Step 2: the new native release ships. Both are now on v2.
    expect(negotiateMobileProtocol(V2, V2)).toBe(2);
    // Step 3: a web deploy that uses the new capability. Users who have not yet
    // updated are still on step 1's answer, which still works.
    expect(negotiateMobileProtocol(V2, V1)).toBe(1);
  });

  it("survives a web rollback under a new shell", () => {
    // The reverse sequence, which is what a bad deploy actually looks like.
    expect(negotiateMobileProtocol(V1, V2)).toBe(1);
  });

  it("picks the highest version both sides have", () => {
    // Not the newest either side knows: negotiating up to something the other
    // cannot parse is how a working pair becomes a broken one.
    expect(negotiateMobileProtocol({ min: 1, max: 4 }, { min: 1, max: 2 })).toBe(2);
  });
});

describe("browser authority", () => {
  it("is the only state that permits a browser engine", () => {
    expect(browserEngineAllowed("browser")).toBe(true);
  });
});
