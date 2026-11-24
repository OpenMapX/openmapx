import { describe, expect, it, vi } from "vitest";
import { SUBJECT_DATA_CATALOGUE } from "./catalogue.js";
import { streamDrizzleRows, streamOpenMapxRegistrationRecords } from "./openmapx-collectors.js";

// A collector registration of the OpenMapX database that no projection reads.
vi.mock("./catalogue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./catalogue.js")>();
  return {
    ...actual,
    getSubjectDataRegistration: (id: string) =>
      id === "unprojected-records"
        ? { ...actual.getSubjectDataRegistration("saved-lists"), id }
        : actual.getSubjectDataRegistration(id),
  };
});

describe("OpenMapX subject collectors", () => {
  const projectionReached = new Error("projection reached the database");
  // Every property of this database stands for a projection's first query.
  const database = new Proxy(
    {},
    {
      get: () => {
        throw projectionReached;
      },
    },
  ) as never;

  it.each(
    SUBJECT_DATA_CATALOGUE.filter(
      (registration) =>
        registration.source === "openmapx-db" && registration.strategy === "collector",
    ).map((registration) => registration.id),
  )("has a projection for the catalogue registration %s", async (registrationId) => {
    const read = async () => {
      for await (const _record of streamOpenMapxRegistrationRecords(registrationId, {
        userId: "u1",
        cutoffAt: new Date("2024-01-01T00:00:00Z"),
        database,
        offlinePrincipalKey: Buffer.alloc(32, 1),
        requestId: "request-1",
      }));
    };
    await read().catch((error: unknown) => {
      if (error !== projectionReached) throw error;
    });
  });

  it("refuses a registration of its database that no projection reads", async () => {
    const read = async () => {
      for await (const _record of streamOpenMapxRegistrationRecords("unprojected-records", {
        userId: "u1",
        cutoffAt: new Date("2024-01-01T00:00:00Z"),
        database,
      }));
    };
    await expect(read()).rejects.toThrow(
      "No OpenMapX collector projection for registration unprojected-records",
    );
  });

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
    expect(records[0]?.data).toEqual(
      expect.objectContaining({ id: "u1", email: "ada@example.test" }),
    );
    expect(records[0]?.data).toHaveProperty("role", "admin");
  });
});
