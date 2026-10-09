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

function planetSetting(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}
export function planetPlaceLimit(): number {
  return planetSetting("AMBIENT_PLANET_MAX_PLACES", 250_000_000);
}
export function assertPlanetDiskCapacity(available: number, remainingRows: number): void {
  const reserve = planetSetting("AMBIENT_PLANET_RESERVE_BYTES", 20 * 1024 ** 3);
  const required = reserve + Math.max(1024 ** 3, remainingRows * 2048);
  if (
    !Number.isSafeInteger(available) ||
    available < 0 ||
    !Number.isSafeInteger(remainingRows) ||
    remainingRows < 0 ||
    !Number.isSafeInteger(required)
  )
    throw new Error("Invalid planet disk capacity or source row count");
  if (available < required)
    throw new Error(
      `Insufficient disk for planet ambient publication: ${available} bytes free, ${required} required including remaining build work and reserve`,
    );
}
