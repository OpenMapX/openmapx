const GIB = 1024 ** 3;
/** Admission allowance, not measured country sizing. During a build only the reserve is checked. */
export function assertAmbientDiskCapacity(freeBytes: number, inputCount?: number): void {
  if (
    !Number.isSafeInteger(freeBytes) ||
    freeBytes < 0 ||
    (inputCount !== undefined && (!Number.isSafeInteger(inputCount) || inputCount < 0))
  )
    throw new Error("Invalid Germany publication disk capacity");
  const working = inputCount === undefined ? 0 : Math.max(GIB, inputCount * 2048);
  const required = 5 * GIB + working;
  if (freeBytes < required)
    throw new Error(
      `Insufficient disk for Germany ambient publication: ${freeBytes} bytes free, ${required} required including the 5 GiB reserve`,
    );
}
