import { type GroundMobileSession, routeFingerprint } from "@openmapx/core/navigation";
import { groundSessionFixture } from "../../storage/testing/sessionFixture";
import { applyGroundReferences, referenceRequestEffects } from "./groundReferences";

const PAGE_LANDMARKS = [{ stepIndex: 0, category: "pharmacy" as const }];

function session(extra: Record<string, unknown> = {}): GroundMobileSession {
  const base = groundSessionFixture({ status: "active" });
  return {
    ...base,
    payload: {
      ...base.payload,
      startPackage: { ...base.payload.startPackage, ...extra } as never,
    },
  };
}

const fingerprint = (s: GroundMobileSession) =>
  routeFingerprint(s.payload.startPackage.route.geometry);

describe("referenceRequestEffects", () => {
  it("asks when the package carries nothing", () => {
    const s = session();
    expect(referenceRequestEffects(s)).toEqual([
      { kind: "request-references", requestId: fingerprint(s) },
    ]);
  });

  it("asks for signals when the page handed over only landmarks", () => {
    const s = session({ landmarkReferences: PAGE_LANDMARKS });
    expect(referenceRequestEffects(s)).toHaveLength(1);
  });

  it("asks nothing when the page handed over signals", () => {
    expect(
      referenceRequestEffects(session({ signalsAlong: [], signalSpans: [{ from: 0, to: 1 }] })),
    ).toEqual([]);
  });
});

describe("applyGroundReferences", () => {
  it("fills only what the package lacks, keeping the page's landmarks", () => {
    const s = session({ landmarkReferences: PAGE_LANDMARKS });
    const mutation = applyGroundReferences(
      s,
      {
        ok: true,
        requestId: fingerprint(s),
        sessionId: s.sessionId,
        routeFingerprint: fingerprint(s),
        signalsAlong: [400],
        signalSpans: [{ from: 0, to: 1_200 }],
        landmarkReferences: [{ stepIndex: 0, category: "fuel" }],
      },
      2_000,
    );
    const next = mutation?.session;
    if (next?.kind !== "ground") throw new Error("no mutation");
    expect(next.payload.startPackage.signalsAlong).toEqual([400]);
    expect(next.payload.startPackage.landmarkReferences).toEqual(PAGE_LANDMARKS);
  });
});
