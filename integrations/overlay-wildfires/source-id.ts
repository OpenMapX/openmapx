const SOURCE_ID = /^[A-Za-z0-9._:-]+$/;

/** Whether a value is the id of a data source, as the wildfire routes name them. */
export function isSourceId(value: unknown): value is string {
  return typeof value === "string" && SOURCE_ID.test(value);
}
