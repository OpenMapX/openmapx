import { parseSurfaceAction } from "./surfaceAction";

const config = { scheme: "openmapx", webOrigin: "https://openmapx.com" };
it("accepts only a bounded compiled-scheme End confirmation request", () => {
  expect(parseSurfaceAction("openmapx:///navigation/end?sessionId=trip-1", config)).toBe("trip-1");
  for (const link of [
    "evil:///navigation/end?sessionId=x",
    "openmapx:///navigation/end",
    "openmapx://evil/navigation/end?sessionId=x",
    "openmapx:///navigation/end?sessionId=a&sessionId=b",
    "openmapx:///navigation/end?sessionId=x#run",
    `openmapx:///navigation/end?sessionId=${"x".repeat(129)}`,
  ])
    expect(parseSurfaceAction(link, config)).toBeNull();
});
