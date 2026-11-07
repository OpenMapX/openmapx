import { describe, expect, it } from "vitest";
import { streamDrizzleRows, streamOpenMapxRegistrationRecords } from "./openmapx-collectors.js";

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
    let selectedFields: string[] = [];

    const records = [];
    for await (const record of streamOpenMapxRegistrationRecords("account-profile", {
      userId: "u1",
      cutoffAt: new Date("2024-01-01T00:00:00Z"),
      database: {
        select: (fields: Record<string, unknown>) => {
          selectedFields = Object.keys(fields).sort();
          return {
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
          };
        },
      } as never,
    }))
      records.push(record);
    expect(selectedFields).toEqual([
      "banExpires",
      "banReason",
      "banned",
      "createdAt",
      "email",
      "emailVerified",
      "id",
      "image",
      "name",
      "normalizedEmail",
      "role",
      "twoFactorEnabled",
      "updatedAt",
    ]);
    expect(records[0].data).toEqual(
      expect.objectContaining({ id: "u1", email: "ada@example.test" }),
    );
    expect(records[0].data).toHaveProperty("role", "admin");
  });
});
