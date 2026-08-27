import { describe, expect, it, vi } from "vitest";
import { createDbMock, type DbMock } from "../../test/db.js";

const dbMock: DbMock = createDbMock();
vi.mock("../../db/index.js", () => ({ db: dbMock.db }));
vi.mock("../../db", () => ({ db: dbMock.db }));

const { assertComponentOwnership } = await import("../extension-component-ownership.js");

describe("assertComponentOwnership", () => {
  it("allows a component that no other extension owns", async () => {
    dbMock.queueSelect([{ extensionId: "other", kind: "service", componentId: "unrelated" }]);
    await expect(
      assertComponentOwnership("bundle-x", [{ kind: "integration", id: "intg-one" }]),
    ).resolves.toBeUndefined();
  });

  it("allows an extension to re-claim the component it already owns", async () => {
    dbMock.queueSelect([{ extensionId: "bundle-x", kind: "integration", componentId: "intg-one" }]);
    await expect(
      assertComponentOwnership("bundle-x", [{ kind: "integration", id: "intg-one" }]),
    ).resolves.toBeUndefined();
  });

  it("refuses a component another extension already installed, naming every conflict", async () => {
    dbMock.queueSelect([
      { extensionId: "bundle-a", kind: "integration", componentId: "intg-one" },
      { extensionId: "bundle-b", kind: "service", componentId: "svc-one" },
    ]);
    await expect(
      assertComponentOwnership("bundle-x", [
        { kind: "integration", id: "intg-one" },
        { kind: "service", id: "svc-one" },
        { kind: "service", id: "svc-free" },
      ]),
    ).rejects.toThrow(/integration:intg-one, service:svc-one/);
  });

  it("treats kind as part of the identity", async () => {
    dbMock.queueSelect([{ extensionId: "bundle-a", kind: "service", componentId: "shared" }]);
    await expect(
      assertComponentOwnership("bundle-x", [{ kind: "integration", id: "shared" }]),
    ).resolves.toBeUndefined();
  });

  it("does not query when there is nothing to claim", async () => {
    const before = dbMock.db.select.mock.calls.length;
    await assertComponentOwnership("bundle-x", []);
    expect(dbMock.db.select.mock.calls.length).toBe(before);
  });
});
