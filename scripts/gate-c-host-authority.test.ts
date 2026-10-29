import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCompose } from "../packages/core/src/services/compose-renderer";
import { renderConfiguration } from "../packages/core/src/services/configuration-generation";
import { findServiceManifestDirs } from "../packages/core/src/services/manifest-discovery";
import { serviceManifestSchema } from "../packages/core/src/services/manifest-schema";
import type { LoadedService, ServiceManifest } from "../packages/core/src/services/types";
import { findAuthorityViolations } from "./check-ops-authority";

/**
 * Gate C — host authority.
 *
 * Track 4 is complete only when a policy test AND a rendered stack jointly show
 * that the Docker socket, host repository write access, and Docker credentials
 * exist only in the operations agent. Searching source is not sufficient, so
 * this renders the full built-in stack and inspects the produced Compose
 * mounts, networks, and users rather than the manifests alone.
 */

const ROOT = join(import.meta.dirname, "..");
const AUTHORITY_SERVICE = "ops-agent";

interface RenderedService {
  volumes?: string[];
  networks?: string[] | Record<string, unknown>;
  user?: string;
  privileged?: boolean;
  cap_add?: string[];
  labels?: Record<string, string>;
}

function renderFullStack(): Record<string, RenderedService> {
  const loaded: LoadedService[] = findServiceManifestDirs(join(ROOT, "services")).map(
    (directory) => ({
      manifest: serviceManifestSchema.parse(
        JSON.parse(readFileSync(join(directory, "service.json"), "utf8")),
      ) as unknown as ServiceManifest,
      directory,
      isBuiltIn: true,
      enabled: true,
    }),
  );
  // Every optional source present, so each mount is rendered and inspected.
  const compose = renderCompose(loaded, { domain: "maps.example.test", existsSync: () => true });
  return renderedVolumes(compose.composeYaml);
}

function renderedVolumes(composeYaml: string): Record<string, RenderedService> {
  // Parsed without a YAML dependency: the renderer emits two-space-indented
  // service keys under a single top-level `services:` block, and this gate only
  // needs each service's volume lines.
  const lines = composeYaml.split("\n");
  const start = lines.indexOf("services:");
  const out: Record<string, RenderedService> = {};
  let current: string | undefined;
  let inVolumes = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // left the services block
    const service = /^ {2}([A-Za-z0-9][A-Za-z0-9._-]*):\s*$/.exec(line);
    if (service) {
      current = service[1] as string;
      out[current] = { volumes: [] };
      inVolumes = false;
      continue;
    }
    if (!current) continue;
    if (/^ {4}volumes:\s*$/.test(line)) {
      inVolumes = true;
      continue;
    }
    if (/^ {4}\S/.test(line)) {
      inVolumes = false;
      continue;
    }
    const item = /^ {6}- (.+)$/.exec(line);
    if (inVolumes && item) (out[current] as RenderedService).volumes?.push(item[1] as string);
  }
  return out;
}

describe("Gate C — host authority", () => {
  const services = renderFullStack();

  it("renders every built-in service so the inspection is meaningful", () => {
    expect(Object.keys(services).length).toBeGreaterThan(5);
    expect(services[AUTHORITY_SERVICE]).toBeDefined();
  });

  it("grants the Docker socket to the operations agent alone in the rendered stack", () => {
    const holders = Object.entries(services)
      .filter(([, service]) =>
        (service.volumes ?? []).some((volume) => volume.includes("docker.sock")),
      )
      .map(([id]) => id);
    expect(holders).toEqual([AUTHORITY_SERVICE]);
  });

  it("grants Docker credentials to the operations agent alone in the rendered stack", () => {
    const holders = Object.entries(services)
      .filter(([, service]) =>
        (service.volumes ?? []).some((volume) => volume.includes("/.docker")),
      )
      .map(([id]) => id);
    expect(holders).toEqual([AUTHORITY_SERVICE]);
  });

  it("grants the host repository root to no service at all in the rendered stack", () => {
    // Host repository WRITE access was the third leg of Gate C. Every caller now
    // reaches `infra/docker/` through typed agent operations instead.
    const holders = Object.entries(services)
      .filter(([, service]) =>
        (service.volumes ?? []).some((volume) => {
          const [source = "", target = ""] = volume.split(":");
          // The repository root mounted at itself; a narrower subdirectory
          // (extension artifacts) is application data, not the checkout.
          return source !== "" && source === target && /openmapx/i.test(source);
        }),
      )
      .map(([id]) => id);
    expect(holders).toEqual([]);
  });

  it("keeps the operations agent's state out of every other service's reach in the rendered stack", () => {
    // The journal, handoff record, trusted-config queue and privacy scratch
    // live in infra/docker/state/ops-agent. data-manager, which mounts the
    // data directory read-write as the same uid, must not reach any of it.
    const state = "./state/ops-agent";
    const reaching = Object.entries(services).flatMap(([id, service]) =>
      (service.volumes ?? [])
        .map((volume) => volume.split(":")[0] ?? "")
        .filter(
          (source) =>
            source === "." ||
            source === "./" ||
            source === "./state" ||
            source === state ||
            source.startsWith(`${state}/`),
        )
        .map((source) => `${id} ${source}`),
    );
    expect(reaching.filter((entry) => !entry.startsWith(`${AUTHORITY_SERVICE} `))).toEqual([
      "app-api ./state/ops-agent/trusted-config",
      "app-api ./state/ops-agent/custom-integrations",
      "traefik ./state/ops-agent/configuration/current/traefik/traefik.yml",
      "traefik ./state/ops-agent/traefik/dynamic",
    ]);
    // Traefik reads its files; it never writes them.
    for (const volume of services.traefik?.volumes ?? []) {
      if (volume.startsWith("./state/")) expect(volume).toMatch(/:ro$/);
    }
    // app-api reads the integrations the agent installed; it never writes them.
    const store = (services["app-api"]?.volumes ?? []).filter((volume) =>
      volume.startsWith("./state/ops-agent/custom-integrations:"),
    );
    expect(store).toHaveLength(1);
    expect(store[0]).toMatch(/\/app\/custom_integrations\}:ro$/);
    expect(services["data-manager"]?.volumes).toContain("./data:/data");
  });

  it("mounts each service's release files from its own store tree, read-only, in a generation", () => {
    const loaded: LoadedService[] = findServiceManifestDirs(join(ROOT, "services")).map(
      (directory) => ({
        manifest: serviceManifestSchema.parse(
          JSON.parse(readFileSync(join(directory, "service.json"), "utf8")),
        ) as unknown as ServiceManifest,
        directory,
        isBuiltIn: true,
        enabled: true,
      }),
    );
    const {
      rendered: { composeYaml },
    } = renderConfiguration({
      infraDir: join(ROOT, "infra", "docker"),
      services: loaded,
      input: {
        domain: "maps.example.test",
        selectedRoots: loaded.map((service) => service.manifest.id),
        serviceConfigs: [],
        integrationConfigs: [],
        serviceSecrets: [],
      },
    });
    const rendered = renderedVolumes(composeYaml);
    const store = "../../service-files/";
    const fromStore = Object.entries(rendered).flatMap(([id, service]) =>
      (service.volumes ?? [])
        .filter((volume) => volume.startsWith(store))
        .map((volume) => ({ id, volume })),
    );
    expect(fromStore.length).toBeGreaterThan(10);
    for (const { id, volume } of fromStore) {
      expect(volume).toMatch(/:ro$/);
      const owner = volume.slice(store.length).split("/")[0];
      // pelias-pip and pelias-placeholder read pelias's file, through @service:.
      expect(owner === id || (owner === "pelias" && id.startsWith("pelias-"))).toBe(true);
    }
    // Nothing of a service's directory is mounted from the checkout any more.
    for (const service of Object.values(rendered)) {
      for (const volume of service.volumes ?? []) {
        expect(volume.startsWith("../../../../../services/")).toBe(false);
      }
    }
    // valhalla.json, which Valhalla rewrites, from its writable copy.
    expect(
      rendered.valhalla?.volumes?.filter((volume) => volume.includes("valhalla.json")),
    ).toEqual(["../../../../data/valhalla/config/valhalla.json:/custom_files/valhalla.json"]);
  });

  it("lets Traefik mount its own files from the agent's state read-only, and no one else", () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-authority-"));
    try {
      const manifest = (id: string, mounts: Array<{ source: string; readOnly?: boolean }>) => {
        mkdirSync(join(root, "services", id), { recursive: true });
        writeFileSync(
          join(root, "services", id, "service.json"),
          JSON.stringify({
            id,
            bindMounts: mounts.map((mount) => ({ ...mount, target: `/mnt/${id}` })),
          }),
        );
      };
      const dynamic = "@infra:state/ops-agent/traefik/dynamic";
      const staticFile = "@infra:state/ops-agent/configuration/current/traefik/traefik.yml";
      const generation = "@infra:state/ops-agent/configuration/current";
      manifest("traefik", [{ source: dynamic }, { source: staticFile }, { source: generation }]);
      manifest("app-web", [{ source: dynamic }]);
      expect(findAuthorityViolations(root).map((violation) => violation.detail)).toEqual([
        `service "app-web" mounts the operations agent's state (${dynamic})`,
        `service "traefik" mounts the operations agent's state (${generation})`,
      ]);
      manifest("traefik", [{ source: dynamic, readOnly: false }]);
      expect(findAuthorityViolations(root).map((violation) => violation.detail)).toContain(
        `service "traefik" mounts the operations agent's state (${dynamic})`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets app-api mount the agent's integration store read-only, and no one else", () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-authority-"));
    try {
      const manifest = (id: string, mounts: Array<{ source: string; readOnly?: boolean }>) => {
        mkdirSync(join(root, "services", id), { recursive: true });
        writeFileSync(
          join(root, "services", id, "service.json"),
          JSON.stringify({
            id,
            bindMounts: mounts.map((mount) => ({ ...mount, target: `/mnt/${id}` })),
          }),
        );
      };
      const store = "@infra:state/ops-agent/custom-integrations";
      manifest("app-api", [{ source: store, readOnly: true }, { source: store }]);
      manifest("app-web", [{ source: store, readOnly: true }]);
      manifest("data-manager", [{ source: store, readOnly: false }]);
      expect(findAuthorityViolations(root).map((violation) => violation.detail)).toEqual([
        `service "app-web" mounts the operations agent's state (${store})`,
        `service "data-manager" mounts the operations agent's state (${store})`,
      ]);
      manifest("app-api", [{ source: store, readOnly: false }]);
      expect(findAuthorityViolations(root).map((violation) => violation.detail)).toContain(
        `service "app-api" mounts the operations agent's state (${store})`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a manifest that mounts the operations agent's state", () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-authority-"));
    try {
      const manifest = (id: string, sources: string[]) => {
        mkdirSync(join(root, "services", id), { recursive: true });
        writeFileSync(
          join(root, "services", id, "service.json"),
          JSON.stringify({
            id,
            bindMounts: sources.map((source) => ({ source, target: `/mnt/${id}` })),
          }),
        );
      };
      manifest("app-api", ["@infra:state/ops-agent/trusted-config", "@infra:state/ops-agent"]);
      manifest("data-manager", ["@infra:data", "@infra:state", "@infra:."]);
      manifest("ops-agent", ["@infra:state/ops-agent/trusted-config"]);
      expect(findAuthorityViolations(root).map((violation) => violation.detail)).toEqual([
        `service "app-api" mounts the operations agent's state (@infra:state/ops-agent)`,
        `service "data-manager" mounts the operations agent's state (@infra:state)`,
        `service "data-manager" mounts the operations agent's state (@infra:.)`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: literal Compose variable sources under test
  it("rejects the agent's state reached through any other form of source", () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-authority-"));
    try {
      const manifest = (id: string, sources: string[]) => {
        mkdirSync(join(root, "services", id), { recursive: true });
        writeFileSync(
          join(root, "services", id, "service.json"),
          JSON.stringify({
            id,
            bindMounts: sources.map((source) => ({ source, target: `/mnt/${id}` })),
          }),
        );
      };
      manifest("app-api", [
        "${OPENMAPX_HOST_DIR:?OPENMAPX_HOST_DIR must be set}/custom_integrations",
        "${OPENMAPX_HOST_DIR}/infra/docker/state/ops-agent/trusted-config",
        "@infra:data/../state/ops-agent/trusted-config/",
      ]);
      manifest("data-manager", [
        "${OPENMAPX_HOST_DIR}/infra/docker/state/ops-agent",
        "$OPENMAPX_HOST_DIR/infra/docker/state",
        "${OPENMAPX_HOST_DIR:-/srv/openmapx}/infra/docker",
        "${OPENMAPX_HOST_DIR}/infra/",
        "${OPENMAPX_HOST_DIR}/infra/docker/data/../.trusted-config-current",
        "${OPENMAPX_HOST_DIR}/infra/docker/data",
        "@infra:data/../state/ops-agent",
        "@infra:../..",
        "@service:pelias:../../infra/docker/state",
        "../../infra/docker/state/ops-agent/jobs-v1.json",
        "config/data-manager.json",
      ]);
      manifest("photon", [
        "${OPENMAPX_STATE_DIR}/ops-agent",
        "${OPENMAPX_HOST_DIR}/${OPENMAPX_STATE_SUBDIR}",
        "@infra:data/${OPENMAPX_STATE_SUBDIR}",
        "/srv/openmapx/infra/docker/state",
      ]);
      manifest("ops-agent", ["${OPENMAPX_HOST_DIR}/infra/docker/state"]);
      expect(findAuthorityViolations(root).map((violation) => violation.detail)).toEqual([
        ...[
          "${OPENMAPX_HOST_DIR}/infra/docker/state/ops-agent",
          "$OPENMAPX_HOST_DIR/infra/docker/state",
          "${OPENMAPX_HOST_DIR:-/srv/openmapx}/infra/docker",
          "${OPENMAPX_HOST_DIR}/infra/",
          "${OPENMAPX_HOST_DIR}/infra/docker/data/../.trusted-config-current",
          "@infra:data/../state/ops-agent",
          "@infra:../..",
          "@service:pelias:../../infra/docker/state",
          "../../infra/docker/state/ops-agent/jobs-v1.json",
        ].map((source) => `service "data-manager" mounts the operations agent's state (${source})`),
        ...[
          "${OPENMAPX_STATE_DIR}/ops-agent",
          "${OPENMAPX_HOST_DIR}/${OPENMAPX_STATE_SUBDIR}",
          "@infra:data/${OPENMAPX_STATE_SUBDIR}",
          "/srv/openmapx/infra/docker/state",
        ].map(
          (source) =>
            `service "photon" mounts a host path this gate cannot place in the checkout (${source})`,
        ),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: literal Compose variable sources under test

  it("declares no Docker provider anywhere in production service configuration", () => {
    // Traefik's socket provider was host authority by another name.
    const traefik = readFileSync(
      join(ROOT, "services", "traefik", "config", "traefik.yml"),
      "utf8",
    );
    expect(traefik).not.toContain("docker.sock");
    expect(traefik).not.toMatch(/^\s*docker:\s*$/m);
  });

  it("passes the standalone policy gate with no violations", () => {
    expect(findAuthorityViolations(ROOT)).toEqual([]);
  });

  it("ships no Docker CLI in the API image", () => {
    const dockerfile = readFileSync(join(ROOT, "apps", "api", "Dockerfile"), "utf8");
    expect(dockerfile).not.toMatch(/\bdocker-cli\b/);
    expect(dockerfile).not.toMatch(/\bdocker-cli-compose\b/);
    // And it must not run as root.
    expect(dockerfile).toMatch(/^USER node$/m);
  });

  it("keeps every production image off the root user", () => {
    const dockerfiles = readdirSync(join(ROOT, "apps"))
      .map((name) => join(ROOT, "apps", name, "Dockerfile"))
      .filter((path) => {
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      });
    expect(dockerfiles.length).toBeGreaterThan(0);
    for (const path of dockerfiles) {
      // `USER node`, `USER nextjs`, and `USER node:node` are all non-root.
      expect(readFileSync(path, "utf8"), path).toMatch(/^USER (?!root\b)[\w:-]+$/m);
    }
  });
});
