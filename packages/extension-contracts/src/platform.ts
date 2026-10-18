import z from "zod/v4";
/** Extension protocol version, independent of product and package versions. */
export const PLATFORM_VERSION = "1.0";
const PLATFORM_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
export const platformVersionSchema = z
  .string()
  .regex(PLATFORM_VERSION_PATTERN, "must use major.minor protocol version syntax")
  .refine(
    (value) => value.split(".").map(Number).every(Number.isSafeInteger),
    "protocol components must be safe integers",
  );
export function satisfiesPlatformVersion(required: string, current = PLATFORM_VERSION): boolean {
  if (!PLATFORM_VERSION_PATTERN.test(required) || !PLATFORM_VERSION_PATTERN.test(current))
    return false;
  const [requiredMajor, requiredMinor] = required.split(".").map(Number);
  const [currentMajor, currentMinor] = current.split(".").map(Number);
  if (![requiredMajor, requiredMinor, currentMajor, currentMinor].every(Number.isSafeInteger))
    return false;
  return requiredMajor === currentMajor && currentMinor >= requiredMinor;
}
