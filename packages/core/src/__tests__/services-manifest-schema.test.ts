import { describe, expect, it } from "vitest";
import { validateServiceManifest } from "../services/manifest-schema";

const validMinimal = {
  id: "valhalla",
  name: "Valhalla",
  version: "1.0.0",
  quality: "built-in",
  container: {
    image: "ghcr.io/valhalla/valhalla-scripted",
    tag: "latest",
    expose: [8002],
  },
  provides: ["routing-engine"],
};

const validateFirstParty = (raw: unknown) => validateServiceManifest(raw, { firstParty: true });
const validateExternal = (raw: unknown) => validateServiceManifest(raw, { firstParty: false });
const validateWithProvenance = (raw: unknown, firstParty: boolean) =>
  validateServiceManifest(raw, { firstParty });

describe("validateServiceManifest", () => {
  it("validates unique companion selection dependencies and rejects duplicates or self-references", () => {
    const valid = validateFirstParty({
      ...validMinimal,
      selectionDependencies: ["timeline-worker", "timeline-scheduler"],
    });
    expect(valid.valid).toBe(true);

    const duplicate = validateFirstParty({
      ...validMinimal,
      selectionDependencies: ["timeline-worker", "timeline-worker"],
    });
    expect(duplicate.valid).toBe(false);

    const self = validateFirstParty({
      ...validMinimal,
      selectionDependencies: ["valhalla"],
    });
    expect(self.valid).toBe(false);
  });

  it("accepts a typed proxy hostname and rejects unsafe hostname syntax", () => {
    const validTemplate = validateFirstParty({
      ...validMinimal,
      configSchema: { properties: { APPLICATION_HOSTS: { type: "string" } } },
      exposure: {
        proxy: {
          enabled: true,
          host: { default: "timeline.{domain}", configKey: "APPLICATION_HOSTS" },
        },
      },
    });
    expect(validTemplate.valid).toBe(true);

    const exact = validateFirstParty({
      ...validMinimal,
      exposure: { proxy: { enabled: true, host: { default: "timeline.example.net" } } },
    });
    expect(exact.valid).toBe(true);

    for (const host of [
      "timeline example.net",
      "https://timeline.example.net",
      "timeline.example.net:443",
      "timeline.example.net,evil.example",
      "timeline.`evil`",
      "timeline.(evil)",
      "*.example.net",
      "{domain}.{domain}",
    ]) {
      expect(
        validateFirstParty({
          ...validMinimal,
          exposure: { proxy: { enabled: true, host: { default: host } } },
        }).valid,
      ).toBe(false);
    }
  });

  it("requires proxy host config keys to name declared non-secret string fields", () => {
    const missing = validateFirstParty({
      ...validMinimal,
      exposure: {
        proxy: { enabled: true, host: { default: "timeline.example.net", configKey: "MISSING" } },
      },
    });
    expect(missing.valid).toBe(false);

    const secret = validateFirstParty({
      ...validMinimal,
      configSchema: {
        properties: { APPLICATION_HOSTS: { type: "string", "x-openmapx-secret": true } },
      },
      exposure: {
        proxy: {
          enabled: true,
          host: { default: "timeline.example.net", configKey: "APPLICATION_HOSTS" },
        },
      },
    });
    expect(secret.valid).toBe(false);
  });

  it("requires an explicit path before stripping a custom hostname prefix", () => {
    const result = validateFirstParty({
      ...validMinimal,
      exposure: {
        proxy: { enabled: true, host: { default: "timeline.example.net" }, stripPrefix: true },
      },
    });
    expect(result.valid).toBe(false);
  });

  it("allows volume backup modes only for backup volumes and requires postgres credentials", () => {
    const tar = validateFirstParty({
      ...validMinimal,
      volumes: [
        { name: "openmapx-valhalla-data", mountAt: "/data", backup: true, backupMode: "tar" },
      ],
    });
    expect(tar.valid).toBe(true);

    const withoutBackup = validateFirstParty({
      ...validMinimal,
      volumes: [{ name: "openmapx-valhalla-data", mountAt: "/data", backupMode: "pg_dump" }],
    });
    expect(withoutBackup.valid).toBe(false);

    const unsupportedMode = validateFirstParty({
      ...validMinimal,
      volumes: [
        { name: "openmapx-valhalla-data", mountAt: "/data", backup: true, backupMode: "database" },
      ],
    });
    expect(unsupportedMode.valid).toBe(false);

    const missingPostgresEnv = validateFirstParty({
      ...validMinimal,
      volumes: [
        { name: "openmapx-valhalla-data", mountAt: "/data", backup: true, backupMode: "pg_dump" },
      ],
    });
    expect(missingPostgresEnv.valid).toBe(false);

    const pgDump = validateFirstParty({
      ...validMinimal,
      container: {
        ...validMinimal.container,
        environment: {
          POSTGRES_USER: "timeline_2026$archive",
          POSTGRES_DB: "timeline_2026$archive",
        },
      },
      volumes: [
        { name: "openmapx-valhalla-data", mountAt: "/data", backup: true, backupMode: "pg_dump" },
      ],
    });
    expect(pgDump.valid).toBe(true);

    const interpolation = validateFirstParty({
      ...validMinimal,
      container: {
        ...validMinimal.container,
        environment: {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: test data is literal Compose interpolation syntax
          POSTGRES_USER: "${POSTGRES_USER:-timeline}",
          POSTGRES_DB: "timeline",
        },
      },
      volumes: [
        { name: "openmapx-valhalla-data", mountAt: "/data", backup: true, backupMode: "pg_dump" },
      ],
    });
    expect(interpolation.valid).toBe(false);
    expect(interpolation.errors.join(" ")).toMatch(/POSTGRES_USER/);
  });

  it("accepts a minimal valid manifest", () => {
    const result = validateFirstParty(validMinimal);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects manifest missing id", () => {
    const result = validateFirstParty({ ...validMinimal, id: undefined });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/id/);
  });

  it("accepts a containerName (including a single-char Docker name)", () => {
    const multi = validateFirstParty({
      ...validMinimal,
      container: { ...validMinimal.container, containerName: "motis-staging" },
    });
    expect(multi.valid).toBe(true);
    const single = validateFirstParty({
      ...validMinimal,
      container: { ...validMinimal.container, containerName: "m" },
    });
    expect(single.valid).toBe(true);
  });

  it("rejects a containerName with illegal characters", () => {
    const result = validateFirstParty({
      ...validMinimal,
      container: { ...validMinimal.container, containerName: "bad/name" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/container/i);
  });

  it("rejects image containing a colon (tag must be separate)", () => {
    const result = validateFirstParty({
      ...validMinimal,
      container: { ...validMinimal.container, image: "valhalla:latest" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/image/);
  });

  it("rejects image with uppercase characters", () => {
    const result = validateFirstParty({
      ...validMinimal,
      container: { ...validMinimal.container, image: "Valhalla/Server" },
    });
    expect(result.valid).toBe(false);
  });

  it("rejects volume name without openmapx- prefix", () => {
    const result = validateFirstParty({
      ...validMinimal,
      volumes: [{ name: "valhalla-tiles", mountAt: "/data" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/volumes/);
  });

  it("accepts volume with openmapx- prefix", () => {
    const result = validateFirstParty({
      ...validMinimal,
      volumes: [{ name: "openmapx-valhalla-tiles", mountAt: "/data" }],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects mountAt with parent traversal", () => {
    const result = validateFirstParty({
      ...validMinimal,
      consumes: [{ type: "osm-pbf", mountAt: "/foo/../etc", required: true }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/mountAt/);
  });

  it("rejects mountAt that is not absolute", () => {
    const result = validateFirstParty({
      ...validMinimal,
      consumes: [{ type: "osm-pbf", mountAt: "data", required: true }],
    });
    expect(result.valid).toBe(false);
  });

  it("accepts a consumes targetFilename for fixed input-name contracts", () => {
    const result = validateFirstParty({
      ...validMinimal,
      consumes: [
        {
          type: "osm-pbf",
          mountAt: "/nominatim/data",
          targetFilename: "data.osm.pbf",
          required: true,
        },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects consumes targetFilename when it contains a path", () => {
    const result = validateFirstParty({
      ...validMinimal,
      consumes: [
        {
          type: "osm-pbf",
          mountAt: "/nominatim/data",
          targetFilename: "../data.osm.pbf",
          required: true,
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/targetFilename/);
  });

  it("rejects unknown capAdd entries (must be uppercase Linux capability)", () => {
    const result = validateFirstParty({
      ...validMinimal,
      container: { ...validMinimal.container, capAdd: ["random-thing"] },
    });
    expect(result.valid).toBe(false);
  });

  it("accepts well-known capAdd entries", () => {
    const result = validateFirstParty({
      ...validMinimal,
      container: { ...validMinimal.container, capAdd: ["NET_ADMIN", "SYS_PTRACE"] },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects networkMode: host for community service", () => {
    const result = validateExternal({
      ...validMinimal,
      quality: "community",
      container: { ...validMinimal.container, networkMode: "host" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/network/i);
  });

  it("accepts networkMode: host for built-in service", () => {
    const result = validateFirstParty({
      ...validMinimal,
      quality: "built-in",
      container: { ...validMinimal.container, networkMode: "host" },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects exposure.proxy.pathPrefix without leading slash", () => {
    const result = validateFirstParty({
      ...validMinimal,
      exposure: { proxy: { enabled: true, pathPrefix: "valhalla" } },
    });
    expect(result.valid).toBe(false);
  });

  it("accepts bindMounts with a relative source for built-in services", () => {
    const result = validateFirstParty({
      ...validMinimal,
      bindMounts: [{ source: "config/valhalla.json", target: "/etc/valhalla.json" }],
    });
    expect(result.valid).toBe(true);
  });

  it("accepts @docker-socket as a bindMount source for built-in services", () => {
    const result = validateFirstParty({
      ...validMinimal,
      bindMounts: [{ source: "@docker-socket", target: "/var/run/docker.sock" }],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects bindMounts with an absolute source path", () => {
    const result = validateFirstParty({
      ...validMinimal,
      bindMounts: [{ source: "/etc/passwd", target: "/mnt/passwd" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/source/);
  });

  it("rejects bindMounts with parent traversal in source", () => {
    const result = validateFirstParty({
      ...validMinimal,
      bindMounts: [{ source: "../etc/passwd", target: "/mnt/passwd" }],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects unknown @-prefixed special bindMount sources", () => {
    const result = validateFirstParty({
      ...validMinimal,
      bindMounts: [{ source: "@not-a-real-source", target: "/foo" }],
    });
    expect(result.valid).toBe(false);
  });

  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: strings are literal compose-substitution syntax, not JS template placeholders
  it("accepts a ${VAR}-reference bindMount source + target (host-path pass-through)", () => {
    const result = validateFirstParty({
      ...validMinimal,
      bindMounts: [
        {
          source: "${OPENMAPX_HOST_DIR:-/tmp/openmapx-host-not-configured}",
          target: "${OPENMAPX_HOST_DIR:-/tmp/openmapx-host-not-configured}",
          readOnly: false,
        },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a ${VAR}-reference bindMount source that contains a `..` path component", () => {
    const result = validateFirstParty({
      ...validMinimal,
      bindMounts: [
        { source: "${OPENMAPX_HOST_DIR:-/tmp/../escape}", target: "/var/run/docker.sock" },
      ],
    });
    expect(result.valid).toBe(false);
  });
  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: strings are literal compose-substitution syntax, not JS template placeholders

  it("accepts relative-path bindMounts for community services (ship own configs)", () => {
    const result = validateExternal({
      ...validMinimal,
      quality: "community",
      bindMounts: [{ source: "config/file.json", target: "/etc/file.json" }],
    });
    expect(result.valid).toBe(true);
  });

  it("accepts relative-path bindMounts for community-verified services", () => {
    const result = validateExternal({
      ...validMinimal,
      quality: "community-verified",
      bindMounts: [{ source: "config/settings.yml", target: "/app/settings.yml" }],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects @docker-socket bindMount source for community services", () => {
    const result = validateExternal({
      ...validMinimal,
      quality: "community",
      bindMounts: [{ source: "@docker-socket", target: "/var/run/docker.sock" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/built-in/);
  });

  it("rejects @docker-socket bindMount source for community-verified services", () => {
    const result = validateExternal({
      ...validMinimal,
      quality: "community-verified",
      bindMounts: [{ source: "@docker-socket", target: "/var/run/docker.sock" }],
    });
    expect(result.valid).toBe(false);
  });

  it("accepts @service:<slug>:<path> bindMount source for built-in services", () => {
    const result = validateFirstParty({
      ...validMinimal,
      bindMounts: [{ source: "@service:pelias:config/pelias.json", target: "/code/pelias.json" }],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects @service:<slug>:<path> with parent traversal in path", () => {
    const result = validateFirstParty({
      ...validMinimal,
      bindMounts: [{ source: "@service:pelias:../etc/passwd", target: "/etc/passwd" }],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects @service:<slug>:<path> with absolute path part", () => {
    const result = validateFirstParty({
      ...validMinimal,
      bindMounts: [{ source: "@service:pelias:/etc/passwd", target: "/etc/passwd" }],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects @service:<slug>:<path> for community services", () => {
    const result = validateExternal({
      ...validMinimal,
      quality: "community",
      bindMounts: [{ source: "@service:pelias:config/pelias.json", target: "/code/pelias.json" }],
    });
    expect(result.valid).toBe(false);
  });

  it("accepts bindMounts marked optional with an @infra: source", () => {
    const result = validateFirstParty({
      ...validMinimal,
      bindMounts: [
        {
          source: "@infra:secrets/transitous-feed-proxy.age",
          target: "/secrets/transitous-feed-proxy.age",
          readOnly: true,
          optional: true,
        },
      ],
    });
    expect(result.valid).toBe(true);
  });

  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: strings are literal compose-substitution syntax, not JS template placeholders
  it("rejects optional: true on a ${VAR}-prefixed bindMount source (host path unknown at render time)", () => {
    const result = validateFirstParty({
      ...validMinimal,
      bindMounts: [
        {
          source: "${OPENMAPX_HOST_DIR:-/tmp/openmapx-host-not-configured}",
          target: "${OPENMAPX_HOST_DIR:-/tmp/openmapx-host-not-configured}",
          optional: true,
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/optional/);
  });
  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: strings are literal compose-substitution syntax, not JS template placeholders

  it("accepts exposure.proxy.additionalRoutes with path or pathPrefix", () => {
    const r1 = validateFirstParty({
      ...validMinimal,
      exposure: {
        proxy: {
          enabled: true,
          pathPrefix: "/api",
          additionalRoutes: [{ path: "/health" }],
        },
      },
    });
    expect(r1.valid).toBe(true);

    const r2 = validateFirstParty({
      ...validMinimal,
      exposure: {
        proxy: {
          enabled: true,
          pathPrefix: "/api",
          additionalRoutes: [{ pathPrefix: "/v2" }],
        },
      },
    });
    expect(r2.valid).toBe(true);
  });

  it("rejects exposure.proxy.additionalRoutes with both path and pathPrefix", () => {
    const result = validateFirstParty({
      ...validMinimal,
      exposure: {
        proxy: {
          enabled: true,
          pathPrefix: "/api",
          additionalRoutes: [{ path: "/health", pathPrefix: "/v2" }],
        },
      },
    });
    expect(result.valid).toBe(false);
  });

  describe("community / community-verified capability and device gating", () => {
    it("rejects community service with SYS_ADMIN in capAdd", () => {
      const result = validateExternal({
        ...validMinimal,
        quality: "community",
        container: { ...validMinimal.container, capAdd: ["SYS_ADMIN"] },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/capAdd/);
      expect(result.errors.join(" ")).toMatch(/SYS_ADMIN/);
    });

    it("accepts community service with NET_BIND_SERVICE in capAdd", () => {
      const result = validateExternal({
        ...validMinimal,
        quality: "community",
        container: { ...validMinimal.container, capAdd: ["NET_BIND_SERVICE"] },
      });
      expect(result.valid).toBe(true);
    });

    it("rejects community service with devices declared", () => {
      const result = validateExternal({
        ...validMinimal,
        quality: "community",
        container: { ...validMinimal.container, devices: ["/dev/mem"] },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/devices/);
    });

    it("rejects community-verified service with privileged: true", () => {
      const result = validateExternal({
        ...validMinimal,
        quality: "community-verified",
        container: { ...validMinimal.container, privileged: true },
      });
      expect(result.valid).toBe(false);
    });

    it("rejects community-verified service with SYS_ADMIN in capAdd", () => {
      const result = validateExternal({
        ...validMinimal,
        quality: "community-verified",
        container: { ...validMinimal.container, capAdd: ["SYS_ADMIN"] },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/capAdd/);
    });

    it("rejects community-verified service with devices declared", () => {
      const result = validateExternal({
        ...validMinimal,
        quality: "community-verified",
        container: { ...validMinimal.container, devices: ["/dev/mem"] },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/devices/);
    });

    it("accepts community-verified service with NET_BIND_SERVICE in capAdd", () => {
      const result = validateExternal({
        ...validMinimal,
        quality: "community-verified",
        container: { ...validMinimal.container, capAdd: ["NET_BIND_SERVICE"] },
      });
      expect(result.valid).toBe(true);
    });

    it("accepts built-in service with privileged, SYS_ADMIN capAdd, and devices", () => {
      const result = validateFirstParty({
        ...validMinimal,
        quality: "built-in",
        container: {
          ...validMinimal.container,
          privileged: true,
          capAdd: ["SYS_ADMIN"],
          devices: ["/dev/mem"],
        },
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("produces / consumes instance ids", () => {
    it("accepts valid instance ids on produces and consumes", () => {
      const result = validateFirstParty({
        ...validMinimal,
        produces: [
          { type: "osm-pbf", instance: "europe", sourceDir: "data/osm/europe" },
          { type: "osm-pbf", instance: "north-america", sourceDir: "data/osm/north-america" },
        ],
        consumes: [
          { type: "osm-pbf", instance: "europe", mountAt: "/custom_files", required: true },
        ],
      });
      expect(result.valid).toBe(true);
    });

    it("rejects an instance id that doesn't match the slug regex", () => {
      const result = validateFirstParty({
        ...validMinimal,
        produces: [{ type: "osm-pbf", instance: "Europe!", sourceDir: "data/osm/europe" }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/lowercase/);
    });

    it("rejects duplicate (type, instance) on produces", () => {
      const result = validateFirstParty({
        ...validMinimal,
        produces: [
          { type: "osm-pbf", instance: "europe", sourceDir: "data/osm/eu1" },
          { type: "osm-pbf", instance: "europe", sourceDir: "data/osm/eu2" },
        ],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/duplicate.*europe/);
    });

    it("rejects two default-instance produces entries for the same type", () => {
      const result = validateFirstParty({
        ...validMinimal,
        produces: [
          { type: "osm-pbf", sourceDir: "data/osm/a" },
          { type: "osm-pbf", sourceDir: "data/osm/b" },
        ],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/default-instance/);
    });

    it("allows the same type with one default and one instanced entry on the same producer", () => {
      const result = validateFirstParty({
        ...validMinimal,
        produces: [
          { type: "osm-pbf", sourceDir: "data/osm/global" },
          { type: "osm-pbf", instance: "europe", sourceDir: "data/osm/europe" },
        ],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("privileged fields are authorized by provenance, not by tier labels", () => {
    const cases = [
      { name: "first-party built-in", firstParty: true, quality: "built-in", allowed: true },
      {
        name: "first-party community-verified",
        firstParty: true,
        quality: "community-verified",
        allowed: false,
      },
      { name: "first-party community", firstParty: true, quality: "community", allowed: false },
      {
        name: "external built-in",
        firstParty: false,
        quality: "built-in",
        allowed: false,
      },
      {
        name: "external community-verified",
        firstParty: false,
        quality: "community-verified",
        allowed: false,
      },
      { name: "external community", firstParty: false, quality: "community", allowed: false },
    ] as const;
    const privilegedFields = [
      {
        name: "privileged",
        container: { privileged: true },
        bindMounts: undefined,
        error: /privileged/,
      },
      {
        name: "host networking",
        container: { networkMode: "host" as const },
        bindMounts: undefined,
        error: /networkMode/,
      },
      {
        name: "SYS_ADMIN",
        container: { capAdd: ["SYS_ADMIN"] },
        bindMounts: undefined,
        error: /SYS_ADMIN/,
      },
      {
        name: "devices",
        container: { devices: ["/dev/mem"] },
        bindMounts: undefined,
        error: /devices/,
      },
      {
        name: "docker socket",
        container: {},
        bindMounts: [{ source: "@docker-socket", target: "/var/run/docker.sock" }],
        error: /@docker-socket/,
      },
    ] as const;

    for (const field of privilegedFields) {
      it(`${field.name}: allows only first-party built-in`, () => {
        for (const candidate of cases) {
          const result = validateWithProvenance(
            {
              ...validMinimal,
              quality: candidate.quality,
              container: { ...validMinimal.container, ...field.container },
              ...(field.bindMounts ? { bindMounts: field.bindMounts } : {}),
            },
            candidate.firstParty,
          );
          expect(result.valid, `${candidate.name} / ${field.name}`).toBe(candidate.allowed);
          if (
            !candidate.allowed &&
            candidate.firstParty === false &&
            candidate.quality !== "built-in"
          ) {
            expect(result.errors.join(" "), `${candidate.name} / ${field.name}`).toMatch(
              field.error,
            );
          }
        }

        const verified = validateExternal({
          ...validMinimal,
          quality: "community-verified",
          container: { ...validMinimal.container, ...field.container },
          ...(field.bindMounts ? { bindMounts: field.bindMounts } : {}),
        });
        const community = validateExternal({
          ...validMinimal,
          quality: "community",
          container: { ...validMinimal.container, ...field.container },
          ...(field.bindMounts ? { bindMounts: field.bindMounts } : {}),
        });
        expect(verified.errors).toEqual(community.errors);
      });
    }
  });

  describe("provenance gates the container sandbox", () => {
    it("rejects a non-first-party manifest that claims the built-in tier", () => {
      const result = validateExternal(validMinimal);
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/quality/);
      expect(result.errors.join(" ")).toMatch(/reserved for services shipped/);
    });

    it("rejects a self-declared built-in manifest asking for a privileged container", () => {
      const manifest = {
        ...validMinimal,
        container: { ...validMinimal.container, privileged: true },
      };
      const result = validateExternal(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/privileged/);
    });

    it("rejects a self-declared built-in manifest asking for host networking", () => {
      const manifest = {
        ...validMinimal,
        container: { ...validMinimal.container, networkMode: "host" },
      };
      const result = validateExternal(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/networkMode/);
    });

    it("rejects a self-declared built-in manifest asking for an escape capability", () => {
      const manifest = {
        ...validMinimal,
        container: { ...validMinimal.container, capAdd: ["SYS_ADMIN"] },
      };
      const result = validateExternal(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/SYS_ADMIN/);
    });

    it("rejects a self-declared built-in manifest asking for device passthrough", () => {
      const manifest = {
        ...validMinimal,
        container: { ...validMinimal.container, devices: ["/dev/mem"] },
      };
      const result = validateExternal(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/devices/);
    });

    it("rejects a self-declared built-in manifest mounting the docker socket", () => {
      const manifest = {
        ...validMinimal,
        bindMounts: [{ source: "@docker-socket", target: "/var/run/docker.sock" }],
      };
      const result = validateExternal(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/@docker-socket/);
    });

    it("still accepts an honest community manifest without elevated privileges", () => {
      const manifest = { ...validMinimal, quality: "community" };
      const result = validateExternal(manifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("rejects a first-party manifest that does not declare the built-in tier", () => {
      const manifest = {
        ...validMinimal,
        quality: "community",
        container: { ...validMinimal.container, privileged: true },
      };
      const result = validateFirstParty(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/quality/);
    });
  });
});
