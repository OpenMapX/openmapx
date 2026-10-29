export const productVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(alpha|beta|rc)\.(0|[1-9]\d*)$/;
export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
export function exactObject(value, keys, label) {
  assert(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => keys.includes(key)),
    `Invalid ${label}`,
  );
}
export function readProductReleaseConfig(bytes) {
  const config = JSON.parse(bytes);
  exactObject(
    config,
    ["schemaVersion", "version", "notesPath", "compatibility", "upgradeOrigins", "limitations"],
    "product release configuration",
  );
  assert(
    config.schemaVersion === 1 && productVersionPattern.test(config.version),
    "Expected a schema1 alpha/beta/rc product version",
  );
  assert(
    config.notesPath === `docs/docs/releases/${config.version}.md`,
    "Release notes path must match version",
  );
  exactObject(config.compatibility, ["extensionProtocol", "platforms"], "compatibility");
  assert(
    config.compatibility.extensionProtocol === "1.0" &&
      JSON.stringify(config.compatibility.platforms) === '["linux/amd64"]',
    "Unsupported compatibility declaration",
  );
  for (const field of ["upgradeOrigins", "limitations"])
    assert(
      Array.isArray(config[field]) &&
        config[field].length > 0 &&
        config[field].every(
          (item) => typeof item === "string" && item.trim().length > 0 && item.length <= 2000,
        ),
      `Invalid ${field}`,
    );
  return config;
}
