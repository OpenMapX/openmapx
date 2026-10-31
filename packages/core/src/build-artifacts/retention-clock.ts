import type { KeyObject } from "node:crypto";
import { fsyncSync, mkdirSync } from "node:fs";
import { z } from "zod";
import type { ControlExecutionOrigin } from "../ops/control-root-key";
import { controlDigest, signControl, verifyControl } from "./control-records";
import { type AnchoredDirectory, identity } from "./filesystem";

interface ClockHost {
  installation: { installationId: string; role: "ops-agent" | "data-manager" | "host-cli" };
  privateRoot: AnchoredDirectory;
  privateKey: KeyObject;
  publicKeys: Record<"ops-agent" | "data-manager" | "host-cli", string>;
}
const schema = z.strictObject({
  version: z.literal(1),
  installationId: z.uuid(),
  role: z.enum(["ops-agent", "data-manager", "host-cli"]),
  sequence: z.number().int().nonnegative().safe(),
  lastRetirementWallTime: z.number().int().nonnegative().safe(),
  rejectNotAfterThrough: z.number().int().nonnegative().safe(),
});
type Clock = z.infer<typeof schema>;
function writer<T>(s: ClockHost, run: () => T): T {
  const root = s.privateRoot;
  mkdirSync(root.name(".retention-clock-writer"), { mode: 0o700 });
  fsyncSync(root.fd);
  const guard = root.directory(".retention-clock-writer"),
    held = identity(guard.stat);
  try {
    return run();
  } finally {
    guard.close();
    root.removeDirectory(".retention-clock-writer", held);
  }
}
function read(s: ClockHost): Clock {
  const parse = (name: string) =>
    verifyControl(
      s.publicKeys[s.installation.role],
      "openmapx-retention-clock-v1",
      JSON.parse(s.privateRoot.read(name, 2048).toString("utf8")),
      schema,
    );
  let current: Clock, prior: Clock;
  try {
    current = parse("retention-clock.json");
    prior = parse("retention-clock-highwater.json");
  } catch {
    throw Error("Control retention clock missing/corrupt; supervised clock recovery required");
  }
  if (
    current.installationId !== s.installation.installationId ||
    current.role !== s.installation.role ||
    current.sequence < prior.sequence ||
    current.rejectNotAfterThrough < prior.rejectNotAfterThrough ||
    current.lastRetirementWallTime < prior.lastRetirementWallTime ||
    (current.sequence === prior.sequence && controlDigest(current) !== controlDigest(prior))
  )
    throw Error("Control retention clock rollback; supervised clock recovery required");
  return current;
}
export function bootstrapRetentionClock(s: ClockHost): void {
  // Only verified empty-store provisioning can establish the zero barrier.
  if (s.privateRoot.hasEntries()) return;
  writer(s, () => {
    const payload: Clock = {
      version: 1,
      installationId: s.installation.installationId,
      role: s.installation.role,
      sequence: 0,
      lastRetirementWallTime: 0,
      rejectNotAfterThrough: 0,
    };
    const bytes = JSON.stringify(signControl(s.privateKey, "openmapx-retention-clock-v1", payload));
    s.privateRoot.write("retention-clock.json", bytes.padEnd(2048), true);
    s.privateRoot.write("retention-clock-highwater.json", bytes.padEnd(2048), true);
    s.privateRoot.write("retention-cursor.json", "0".padEnd(64), true);
    s.privateRoot.write("retention-slot-transaction.json", "null".padEnd(4096), true);
  });
}
export function assertOriginClockForward(s: ClockHost, origin: ControlExecutionOrigin): void {
  writer(s, () => {
    const clock = read(s),
      now = Date.now();
    if (now < clock.lastRetirementWallTime)
      throw Error("Wall clock moved backward; control clock recovery prerequisite");
    if (origin.notAfter <= clock.rejectNotAfterThrough || now >= origin.notAfter)
      throw Error("Expired control origin; observation/settlement only");
  });
}
export function advanceRetentionClock(s: ClockHost, notAfter: number): Clock {
  return writer(s, () => {
    const prior = read(s),
      now = Date.now();
    if (now < prior.lastRetirementWallTime || now < notAfter)
      throw Error("Control retirement clock recovery prerequisite");
    const current: Clock = {
      ...prior,
      sequence: prior.sequence + 1,
      lastRetirementWallTime: Math.max(now, prior.lastRetirementWallTime),
      rejectNotAfterThrough: Math.max(notAfter, prior.rejectNotAfterThrough),
    };
    schema.parse(current);
    const bytes = JSON.stringify(signControl(s.privateKey, "openmapx-retention-clock-v1", current));
    // High-water first: partial publication is a safe clock prerequisite.
    s.privateRoot.write("retention-clock-highwater.json", bytes.padEnd(2048));
    s.privateRoot.write("retention-clock.json", bytes.padEnd(2048));
    return current;
  });
}
export function readRetentionClock(s: ClockHost): Clock {
  return writer(s, () => read(s));
}
