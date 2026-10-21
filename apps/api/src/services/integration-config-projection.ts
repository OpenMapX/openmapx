/** The shared non-secret integration projection used by trusted apply and its inverse. */
export function projectIntegrationConfig(
  schema: Record<string, unknown> | undefined,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const properties = ((schema?.properties ?? schema) || {}) as Record<
    string,
    { "x-openmapx-secret"?: unknown }
  >;
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key]) =>
        key !== "type" &&
        key !== "properties" &&
        Object.hasOwn(properties, key) &&
        properties[key] &&
        properties[key]?.["x-openmapx-secret"] !== true,
    ),
  );
}
