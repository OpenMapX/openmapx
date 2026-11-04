import { allowsNavigationStart } from "./startContext";

it("never substitutes host presence for a permission grant or FGS authorization", () => {
  expect(allowsNavigationStart({ kind: "phone", activityVisible: false }, "background")).toBe(
    false,
  );
  expect(
    allowsNavigationStart(
      { kind: "car", hostAuthorized: true, locationServiceStartAllowed: false },
      "background",
    ),
  ).toBe(false);
  expect(
    allowsNavigationStart(
      { kind: "car", hostAuthorized: true, locationServiceStartAllowed: true },
      "foreground",
    ),
  ).toBe(false);
  expect(
    allowsNavigationStart(
      { kind: "car", hostAuthorized: true, locationServiceStartAllowed: true },
      "background",
    ),
  ).toBe(true);
  expect(allowsNavigationStart({ kind: "background" }, "background")).toBe(false);
});
