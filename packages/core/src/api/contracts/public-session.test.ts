import { expect, it } from "vitest";
import { publicSessionSchema } from "./public-session";

it("accepts the deliberately reduced session and rejects private upstream fields", () => {
  const value = {
    user: {
      id: "a",
      name: "Admin",
      email: "admin@example.test",
      emailVerified: true,
      image: null,
      role: "admin",
    },
    session: { expiresAt: "2026-11-07T00:00:00.000Z" },
  };
  expect(publicSessionSchema.parse(value)).toEqual(value);
  expect(
    publicSessionSchema.safeParse({ ...value, session: { ...value.session, token: "private" } })
      .success,
  ).toBe(false);
});
