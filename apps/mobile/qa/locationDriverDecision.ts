import { z } from "zod";

/**
 * The record that says which location driver this release uses, and on what
 * evidence.
 *
 * Its whole purpose is to stop simulator success from quietly becoming a
 * background-reliability claim. The schema is a closed discriminated union with
 * exactly two states:
 *
 *  - `expo-location-provisional`: selected from Expo's documented contract,
 *    deterministic tests, clean local Release builds and virtual-device smoke
 *    runs. Every hardware-only risk must still be listed, and public rollout is
 *    blocked.
 *  - `beta-qualified`: reachable only once volunteer TestFlight/Play reports
 *    exist for all three target device families and every enumerated risk is
 *    resolved.
 *
 * There is deliberately no way to express "provisional but unblocked", and no
 * way to shorten the risk list.
 */

const hardwareRisk = z.enum([
  "ios-suspension-delivery",
  "android-oem-background-killing",
  "real-permission-settings-transitions",
  "locked-screen-callback-gaps",
  "silent-mode-speech",
  "bluetooth-audio-focus",
  "battery-drain",
  "thermal-behavior",
]);

export type HardwareRisk = z.infer<typeof hardwareRisk>;

/** Every risk must appear exactly once; the list cannot be trimmed. */
const requiredHardwareRisks = new Set(hardwareRisk.options);

const completeRiskList = z
  .array(hardwareRisk)
  .length(requiredHardwareRisks.size)
  .refine((risks) => new Set(risks).size === requiredHardwareRisks.size, {
    message: "every hardware risk must be listed exactly once",
  });

const provisionalDecisionSchema = z
  .object({
    decision: z.literal("expo-location-provisional"),
    selectedDriver: z.literal("expo"),
    evidenceLevel: z.literal("automated-and-simulated"),
    decidedAt: z.iso.datetime(),
    decisionSource: z.literal("maintainer-approved-assumption"),
    runbookPath: z.literal("docs/docs/developer/mobile-feasibility.md"),
    automatedCommands: z.array(z.string().min(1)).min(3),
    virtualBuilds: z
      .object({
        iosSimulatorBuildId: z.string().min(1),
        androidEmulatorBuildId: z.string().min(1),
      })
      .strict(),
    unverifiedRisks: completeRiskList,
    publicRolloutBlockedUntil: z.literal("volunteer-beta-device-matrix"),
  })
  .strict();

/** Beta reports live at a version- and family-specific path, and nowhere else. */
const reportPath = (family: "ios" | "pixel" | "samsung") =>
  z
    .string()
    .regex(new RegExp(`^apps/mobile/qa/results/beta/[0-9]+\\.[0-9]+\\.[0-9]+-${family}\\.json$`));

const betaQualifiedDecisionSchema = z
  .object({
    decision: z.literal("beta-qualified"),
    selectedDriver: z.enum(["expo", "native"]),
    evidenceLevel: z.literal("physical-volunteer-beta"),
    decidedAt: z.iso.datetime(),
    qualifiedAt: z.iso.datetime(),
    runbookPath: z.literal("docs/docs/developer/mobile-feasibility.md"),
    evidenceReports: z
      .object({
        ios: reportPath("ios"),
        pixel: reportPath("pixel"),
        samsung: reportPath("samsung"),
      })
      .strict(),
    resolvedRisks: completeRiskList,
    unverifiedRisks: z.tuple([]),
    publicRolloutBlockedUntil: z.null(),
  })
  .strict();

export const locationDriverDecisionSchema = z.discriminatedUnion("decision", [
  provisionalDecisionSchema,
  betaQualifiedDecisionSchema,
]);

export type LocationDriverDecision = z.infer<typeof locationDriverDecisionSchema>;

export function parseLocationDriverDecision(value: unknown): LocationDriverDecision {
  return locationDriverDecisionSchema.parse(value);
}

/** True while public rollout must not proceed. */
export function blocksPublicRollout(decision: LocationDriverDecision): boolean {
  return decision.publicRolloutBlockedUntil !== null;
}

export const HARDWARE_RISKS = hardwareRisk.options;
