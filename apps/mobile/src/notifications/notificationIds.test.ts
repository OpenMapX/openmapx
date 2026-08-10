import {
  isOpenMapXNotificationId,
  MAX_NOTIFICATION_ID_LENGTH,
  NOTIFICATION_ID_PATTERN,
  type NotificationCategory,
  notificationIdFor,
} from "./notificationIds";

const CATEGORIES: NotificationCategory[] = ["alight", "transfer", "departure", "critical"];

describe("notificationIdFor", () => {
  it("is stable for the same session, category and event", () => {
    const first = notificationIdFor("session-1", "alight", "leg-3");
    const second = notificationIdFor("session-1", "alight", "leg-3");

    expect(first).toBe(second);
  });

  it("differs between sessions", () => {
    expect(notificationIdFor("session-1", "alight", "leg-3")).not.toBe(
      notificationIdFor("session-2", "alight", "leg-3"),
    );
  });

  it("differs between events in one session", () => {
    expect(notificationIdFor("session-1", "alight", "leg-3")).not.toBe(
      notificationIdFor("session-1", "alight", "leg-4"),
    );
  });

  it("differs between categories for one event", () => {
    const ids = CATEGORIES.map((category) => notificationIdFor("session-1", category, "leg-3"));

    expect(new Set(ids).size).toBe(CATEGORIES.length);
  });

  it("never embeds the inputs it was derived from", () => {
    const id = notificationIdFor("session-abc123", "alight", "Hauptbahnhof, Gleis 7");

    expect(id).not.toContain("session-abc123");
    expect(id).not.toContain("Hauptbahnhof");
    expect(id).not.toContain("Gleis");
    expect(id).not.toContain("7");
  });

  it("survives a name that would otherwise break an identifier", () => {
    const id = notificationIdFor("session-1", "alight", "Ünïcodé / slash: colon 🚉");

    expect(id).toMatch(NOTIFICATION_ID_PATTERN);
  });

  it("stays within the platform-safe length and character set", () => {
    for (const category of CATEGORIES) {
      const id = notificationIdFor("s".repeat(200), category, "e".repeat(200));

      expect(id.length).toBeLessThanOrEqual(MAX_NOTIFICATION_ID_LENGTH);
      expect(id).toMatch(NOTIFICATION_ID_PATTERN);
    }
  });

  it("refuses to derive an identifier from nothing", () => {
    expect(() => notificationIdFor("", "alight", "leg-1")).toThrow(/session/);
    expect(() => notificationIdFor("session-1", "alight", "")).toThrow(/event key/);
  });

  it("spreads many events across distinct identifiers", () => {
    const ids = new Set<string>();
    for (let leg = 0; leg < 2_000; leg += 1) {
      ids.add(notificationIdFor("session-1", "alight", `leg-${leg}`));
    }

    expect(ids.size).toBe(2_000);
  });

  it("recognises only its own identifiers", () => {
    expect(isOpenMapXNotificationId(notificationIdFor("s", "alight", "e"))).toBe(true);
    for (const foreign of ["", "omx-alight-", "some-other-app-id", "omx-unknown-abcdefghijklmn"]) {
      expect(isOpenMapXNotificationId(foreign)).toBe(false);
    }
  });
});
