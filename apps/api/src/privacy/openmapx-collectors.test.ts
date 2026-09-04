import { describe, expect, it } from "vitest";
import { collectOpenMapxRegistration, streamDrizzleRows } from "./openmapx-collectors.js";

describe("OpenMapX subject collectors", () => {
  it("reads database projections through bounded cursor pages and closes on cancellation", async () => {
    let closed = false;
    const cursor = (async function* () {
      try {
        yield [{ id: "a" }];
        yield [{ id: "b" }];
      } finally {
        closed = true;
      }
    })();
    const rows = streamDrizzleRows(
      {
        toSQL: () => ({ sql: "select id from test", params: [] }),
        _prepare: () => ({
          client: {
            unsafe: () => ({
              values: () => ({
                cursor: () =>
                  (async function* () {
                    try {
                      yield [["a"]];
                      yield [["b"]];
                    } finally {
                      closed = true;
                    }
                  })(),
              }),
            }),
          },
          queryString: "select id from test",
          params: [],
          fields: [
            {
              path: ["id"],
              field: { sql: { decoder: { mapFromDriverValue: (value: unknown) => value } } },
            },
          ],
        }),
      } as never,
      {
        session: { client: { unsafe: () => ({ cursor: () => cursor }) } },
      } as never,
    );
    for await (const row of rows) {
      expect(row).toEqual({ id: "a" });
      break;
    }
    expect(closed).toBe(true);
  });

  it("projects profile and account-state fields without credential material", async () => {
    const part = await collectOpenMapxRegistration("account-profile", {
      userId: "u1",
      cutoffAt: new Date("2024-01-01T00:00:00Z"),
      database: {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: async () => [
                {
                  id: "u1",
                  name: "Ada",
                  email: "ada@example.test",
                  emailVerified: true,
                  image: null,
                  createdAt: new Date("2020-01-01"),
                  updatedAt: new Date("2023-01-01"),
                  role: "admin",
                },
              ],
            }),
          }),
        }),
      } as never,
    });
    expect(part.records[0].data).toEqual(
      expect.objectContaining({ id: "u1", email: "ada@example.test" }),
    );
    expect(part.records[0].data).toHaveProperty("role", "admin");
  });

  it("bounds the projection materialization helper used by focused tests", async () => {
    const row = {
      id: "u1",
      name: "Ada",
      email: "ada@example.test",
      emailVerified: true,
      image: null,
      createdAt: new Date("2020-01-01"),
      updatedAt: new Date("2023-01-01"),
      role: "user",
    };
    await expect(
      collectOpenMapxRegistration("account-profile", {
        userId: "u1",
        cutoffAt: new Date("2024-01-01T00:00:00Z"),
        database: {
          select: () => ({
            from: () => ({
              where: () => ({ orderBy: async () => Array.from({ length: 10_001 }, () => row) }),
            }),
          }),
        } as never,
      }),
    ).rejects.toThrow("materialization limit");
  });
});
