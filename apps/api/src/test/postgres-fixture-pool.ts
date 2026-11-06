import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema";
import { createMigratedPostgresFixture } from "./postgres-fixture";

/** A server created here, never DATABASE_URL. Only current-schema tests use clones;
 * migration acceptance continues using createMigratedPostgresFixture directly. */
export async function createPostgresFixturePool() {
  const template = await createMigratedPostgresFixture();
  await template.sql.end({ timeout: 2 });
  const adminUri = new URL(template.connectionUri);
  adminUri.pathname = "/postgres";
  const admin = postgres(adminUri.toString(), { max: 1, onnotice: () => {} });
  const active = new Set<() => Promise<void>>();
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  let stopping: Promise<void> | undefined;

  async function create() {
    if (closing) throw new Error("PostgreSQL fixture pool is closed");
    const task = (async () => {
      const name = `openmapx_${randomUUID().replaceAll("-", "")}`;
      // The identifier is generated here, not derived from test/user input.
      await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "openmapx_test"`);
      const uri = new URL(template.connectionUri);
      uri.pathname = `/${name}`;
      const client = postgres(uri.toString(), { max: 4 });
      let stopped: Promise<void> | undefined;
      const stop = () => {
        stopped ??= (async () => {
          try {
            await client.end({ timeout: 2 });
          } finally {
            try {
              await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
            } finally {
              active.delete(stop);
            }
          }
        })();
        return stopped;
      };
      active.add(stop);
      return { sql: client, db: drizzle(client, { schema }), connectionUri: uri.toString(), stop };
    })();
    pending.add(task);
    try {
      return await task;
    } finally {
      pending.delete(task);
    }
  }
  function stop() {
    stopping ??= (async () => {
      closing = true;
      await Promise.allSettled([...pending]);
      const results = await Promise.allSettled([...active].map((close) => close()));
      try {
        await admin.end({ timeout: 2 });
      } finally {
        await template.stop();
      }
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    return stopping;
  }
  return { create, stop };
}
