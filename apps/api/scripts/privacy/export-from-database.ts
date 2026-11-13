/**
 * Export one subject's data from a restored scratch database into a ZIP file.
 *
 * This is the manual backup step of the restore runbook in
 * docs/docs/administration/backup-and-restore.md. It runs the same streaming
 * export as the self-service download against the scratch database only, and
 * writes the archive to --out. It never contacts the ops-agent: the managed
 * Dawarich timeline is left out, and any source the scratch database cannot
 * answer is listed in the report for the operator.
 *
 * A scratch container started with `--network none` is reached through its
 * socket directory:
 *
 *   pnpm --filter @openmapx/api exec tsx scripts/privacy/export-from-database.ts \
 *     --socket-dir /srv/privacy-scratch/socket --database openmapx \
 *     --subject <user id> --case <privacy case id> --out ./subject-export.zip
 *
 * `--database-url <url>` connects over TCP instead.
 */
import { createWriteStream } from "node:fs";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const usage =
  "Usage: export-from-database.ts (--socket-dir <dir> [--database <name>] [--user <name>] | --database-url <url>) --subject <user id> --case <case id> --out <file.zip> [--kind access|portability|access_and_portability] [--locale en|de] [--received-at <ISO time>]";

const { values } = parseArgs({
  options: {
    "socket-dir": { type: "string" },
    database: { type: "string", default: "openmapx" },
    user: { type: "string", default: "postgres" },
    "database-url": { type: "string" },
    subject: { type: "string" },
    case: { type: "string" },
    out: { type: "string" },
    kind: { type: "string", default: "access_and_portability" },
    locale: { type: "string", default: "en" },
    "received-at": { type: "string" },
  },
  strict: true,
});

const { subject, out, kind } = values;
const caseId = values.case;
const socketDir = values["socket-dir"];
const databaseUrl = values["database-url"];
if (!subject || !caseId || !out || Boolean(socketDir) === Boolean(databaseUrl))
  throw new Error(usage);
if (!/^[0-9a-f-]{36}$/i.test(caseId)) throw new Error("--case must be the privacy case ID");
if (kind !== "access" && kind !== "portability" && kind !== "access_and_portability")
  throw new Error(usage);
const receivedAt = new Date(values["received-at"] ?? Date.now());
if (Number.isNaN(receivedAt.getTime())) throw new Error("--received-at must be an ISO time");

// The API modules also load a default database client from DATABASE_URL. Point
// it at an address that cannot resolve, so only the scratch connection below
// can ever be used.
process.env.DATABASE_URL = "postgresql://scratch-export-only.invalid/none";
const schema = await import("../../src/db/schema.js");
const { prepareSubjectExport } = await import("../../src/privacy/subject-export.js");

const sql = socketDir
  ? postgres({ host: socketDir, database: values.database, username: values.user, max: 2 })
  : postgres(databaseUrl as string, { max: 2 });
const database = drizzle(sql, { schema });
try {
  const prepared = await prepareSubjectExport({
    request: {
      id: caseId,
      kind,
      locale: values.locale ?? "en",
      receivedAt,
      registeredAt: receivedAt,
      preservationAt: null,
      snapshotAt: new Date(),
    },
    subjectUserId: subject,
    database: database as never,
    includeManagedTimeline: false,
    requireAllSources: false,
  });
  try {
    await prepared.write(createWriteStream(out, { flags: "wx", mode: 0o600 }));
  } finally {
    await prepared.dispose();
  }
  process.stdout.write(`Wrote ${out}\n`);
} finally {
  await sql.end({ timeout: 5 });
}
