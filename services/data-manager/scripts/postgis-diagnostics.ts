/** Operator-only, fixed read-only queries. The URI is read from the environment, never argv or output. */
import postgres from "postgres";
import { collectDiagnostics } from "../src/postgis/diagnostics.js";

const target = process.env.POSTGIS_DIAGNOSTICS_URL;
if (!target) {
  process.stderr.write("Set POSTGIS_DIAGNOSTICS_URL to the database connection URI.\n");
  process.exitCode = 1;
} else {
  let sql: ReturnType<typeof postgres> | undefined;
  try {
    sql = postgres(target, {
      max: 1,
      connect_timeout: 5,
      connection: {
        statement_timeout: 5000,
        default_transaction_read_only: true,
        application_name: "openmapx-diagnostics",
      },
      onnotice: () => {},
    });
    process.stdout.write(`${JSON.stringify(await collectDiagnostics(sql), null, 2)}\n`);
  } catch {
    process.stderr.write(
      "PostgreSQL diagnostics unavailable: enable diagnostics and verify PostgreSQL 18 extension access.\n",
    );
    process.exitCode = 1;
  } finally {
    await sql?.end({ timeout: 2 }).catch(() => {
      process.exitCode = 1;
    });
  }
}
