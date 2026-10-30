import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { build } = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "esbuild",
);

const ts = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "typescript",
);

import { generateArtifacts, writeOrCheckArtifacts } from "./codegen.mjs";
import { adminOperationBindings, createCodegenConfig, selectTaggedDocument } from "./config.mjs";
import { validatedResponseTypes } from "./validated-response-types.mjs";

function generatedConsumerDiagnostics(files: { filename: string; content: string }[]) {
  const base = new URL("../../packages/core", import.meta.url).pathname;
  const configuration = ts.readConfigFile(resolve(base, "tsconfig.json"), ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(configuration.config, ts.sys, base);
  options.typeRoots = [
    dirname(
      dirname(
        createRequire(new URL("../../packages/core/package.json", import.meta.url)).resolve(
          "@types/node/package.json",
        ),
      ),
    ),
  ];
  const filename = resolve(base, "src/api/generated/admin/activity-target.typecheck.ts");
  const virtual = new Map(
    files.map((file) => [resolve(base, "src/api/generated", file.filename), file.content]),
  );
  virtual.set(
    filename,
    `
    import { streamAdminActivityJobEvents } from "./activity-admin.generated";
    import type { AdminEventStreamTargetOptions } from "../../admin-sdk-transport";
    declare const options: AdminEventStreamTargetOptions;
    const target: Promise<{url: string; withCredentials: boolean}> = streamAdminActivityJobEvents("id", undefined, options);
    streamAdminActivityJobEvents("id", undefined, {signal: new AbortController().signal, method: "GET", headers: {}});
    // @ts-expect-error EventSource targets have no finite HTTP deadline.
    streamAdminActivityJobEvents("id", undefined, {timeoutMs: 100});
    // @ts-expect-error EventSource targets cannot send request bodies.
    streamAdminActivityJobEvents("id", undefined, {body: "payload"});
    // @ts-expect-error EventSource targets cannot apply fetch cache policy.
    streamAdminActivityJobEvents("id", undefined, {cache: "no-store"});
    // @ts-expect-error EventSource targets cannot apply fetch request modes.
    streamAdminActivityJobEvents("id", undefined, {mode: "same-origin"});
    // @ts-expect-error Target construction cannot consume a text stream.
    streamAdminActivityJobEvents("id", undefined, {onTextChunk: () => {}});
    // @ts-expect-error Native EventSource owns Last-Event-ID rather than explicit header arguments.
    streamAdminActivityJobEvents("id", undefined, {"last-event-id": 1});
    // @ts-expect-error Target options permit only an empty generated header container.
    streamAdminActivityJobEvents("id", undefined, {headers: {Authorization: "token"}});
    // @ts-expect-error Generated EventSource operations use GET only.
    streamAdminActivityJobEvents("id", undefined, {method: "POST"});
  `,
  );
  if (virtual.has(resolve(base, "src/api/generated/admin/integration-admin.generated.ts"))) {
    virtual.set(
      filename,
      `${virtual.get(filename)}
      import { getAdminIntegration, setAdminIntegrationCredential, getAdminIntegrationHealthHistory, getAdminOverview, getAdminIntegrationCredentials } from "./integration-admin.generated";
      import type { AdminSdkRequestOptions } from "../../admin-sdk-transport";
      declare const finiteOptions: AdminSdkRequestOptions;
      getAdminIntegration("sample", finiteOptions).then(response => {
        if (response.status === 200) {
          const id: string = response.data.manifest.id;
          const domains: string[] = response.data.manifest.domains;
          const source: "default" | "database" | "vault" | "config.json" | "env" = response.data.resolvedConfig.field.source;
        }
      });
      setAdminIntegrationCredential("sample", "apiKey", {value: "synthetic",expectedRevision:"cfg1_synthetic"}, {"idempotency-key":"synthetic-intent-0001"}, finiteOptions);
      // @ts-expect-error Credential bodies reject unknown fields.
      setAdminIntegrationCredential("sample", "apiKey", {value: "synthetic", unexpected: true}, {"idempotency-key":"synthetic-intent-0001"});
      // @ts-expect-error Credentials are strings, not numbers.
      setAdminIntegrationCredential("sample", "apiKey", {value: 1}, {"idempotency-key":"synthetic-intent-0001"});
      getAdminIntegrationHealthHistory("sample", {hours: 24}, finiteOptions);
      // @ts-expect-error Generated query output exposes bounded integer input, not string coercion.
      getAdminIntegrationHealthHistory("sample", {hours: "24"});
      getAdminOverview(finiteOptions).then(response => {
        if (response.status === 200) {
          const email: string | undefined = response.data.activeJobs[0].actor?.email;
          const createdAt: string = response.data.recentActivity[0].createdAt;
        }
      });
      getAdminIntegrationCredentials("sample", finiteOptions).then(response => {
        if (response.status === 200) {
          const source: "default" | "database" | "vault" | "config.json" | "env" | "missing" = response.data.credentials[0].source;
        }
      });
    `,
    );
  }
  if (virtual.has(resolve(base, "src/api/generated/admin/service-admin.generated.ts"))) {
    virtual.set(
      filename,
      `${virtual.get(filename)}
      import { uploadAdminArtifactTransferContent,downloadAdminArtifactTransferContent,getDownloadAdminArtifactTransferContentTarget, streamAdminServiceLogs, getAdminService, getAdminComposePreview, stopAdminCompose, setAdminServiceSelection, runAdminServicesBulkAction, restoreAdminServiceBackup } from "./service-admin.generated";
      getAdminService("sample").then(response => {
        if (response.status === 200) {
          const image: string = response.data.manifest.container.image;
          const count: number | "all" | undefined = response.data.manifest.container.gpu?.count;
          response.data.manifest.provides?.forEach(entry => { const capability: string = typeof entry === "string" ? entry : entry.capability; });
        }
      });
      uploadAdminArtifactTransferContent("stage",new Blob([new Uint8Array([0,255])]),{client:undefined});
      // @ts-expect-error Uploads accept opaque Blob bodies, not JSON.
      uploadAdminArtifactTransferContent("stage",{body:"invalid"});
      downloadAdminArtifactTransferContent("stage",{onByteChunk:async(chunk,signal)=>{const byte:number=chunk[0];signal.throwIfAborted();}}).then(response=>{if(response.status===200){const data:undefined=response.data;}});
      // @ts-expect-error Byte downloads require an explicit owned consumer.
      downloadAdminArtifactTransferContent("stage");
      // @ts-expect-error Signal alone cannot consume a byte response.
      downloadAdminArtifactTransferContent("stage",{signal:new AbortController().signal});
      const native:Promise<{url:string;ownership:"browser"}>=getDownloadAdminArtifactTransferContentTarget("stage",{headers:{}});
      // @ts-expect-error Native navigation cannot send custom headers.
      getDownloadAdminArtifactTransferContentTarget("stage",{headers:{Authorization:"x"}});
      const logHeaders = {"idempotency-key": "synthetic-intent-0001"};
      streamAdminServiceLogs("id", logHeaders, undefined, {onTextChunk: async (chunk) => { const text: string = chunk; }, timeoutMs: 100}).then(response => {
        if (response.status === 200) { const data: undefined = response.data; }
        if (response.status === 404) { const error: string = response.data.error; }
      });
      // @ts-expect-error Streams require an explicit callback-bearing options argument.
      streamAdminServiceLogs("id", logHeaders);
      // @ts-expect-error Signal alone cannot consume a stream.
      streamAdminServiceLogs("id", logHeaders, undefined, {signal: new AbortController().signal});
      // @ts-expect-error Streams never buffer a successful string.
      streamAdminServiceLogs("id", logHeaders, undefined, {onTextChunk: () => {}}).then(response => {if (response.status === 200) {const data: string = response.data;}});
      getAdminComposePreview().then(response => {if (response.status === 200) {const yaml: string = response.data;}});
      stopAdminCompose().then(response => {
        // @ts-expect-error Compose down deliberately has no successful response.
        if (response.status === 200) {}
        if (response.status === 503) { const guidance: string = response.data.error; const ok: false = response.data.ok; }
      });
      setAdminServiceSelection({selectedRoots: []}, {"idempotency-key":"synthetic-intent-0001"});
      // @ts-expect-error An absent selection cannot mean intentional deselection.
      setAdminServiceSelection({}, {"idempotency-key":"synthetic-intent-0001"});
      // @ts-expect-error Build-only fields cannot enter lifecycle actions.
      runAdminServicesBulkAction({action: "start", serviceIds: ["sample"], all: true});
      restoreAdminServiceBackup("sample", {serviceIds: [], stopRunning: true});
    `,
    );
  }
  if (virtual.has(resolve(base, "src/api/generated/admin/extension-admin.generated.ts"))) {
    virtual.set(
      filename,
      `${virtual.get(filename)}
      import { listAdminExtensionCatalog, getAdminExtensionCatalogEntry, listAdminInstalledExtensions, previewAdminExtensionInstall, installAdminExtension, updateAdminExtension, removeAdminExtension, listAdminExtensionSources, addAdminExtensionSource, removeAdminExtensionSource, refreshAdminExtensionCatalog } from "./extension-admin.generated";
      import type { AdminExtensionInstallPreview, AdminInstalledExtension, AdminExtensionSource } from "../../contracts/extension-admin";
      listAdminExtensionCatalog({q: "a & b", type: "fallback", sort: "fallback"}).then(response => {
        if (response.status === 200) {
          const version: string | undefined = response.data.entries[0].version;
          const state: "verified" | "community" | "revoked" | "stale-revocation-data" = response.data.entries[0].status;
          const retained: unknown = response.data.entries[0].unfamiliar;
        }
      });
      getAdminExtensionCatalogEntry("a/b?#").then(response => {
        if (response.status === 200) { const kind: "service" | "integration" = response.data.componentList[0].kind; }
        if (response.status === 404) { const error: string = response.data.error; }
      });
      listAdminInstalledExtensions().then(response => {
        if (response.status === 200) { const item: AdminInstalledExtension = response.data.extensions[0]; }
      });
      previewAdminExtensionInstall({id: "a", manifestUrl: "https://example.test"}).then(response => {
        if (response.status === 200) { const preview: AdminExtensionInstallPreview = response.data; }
      });
      installAdminExtension({id: "a", hostPortConfirmation: "opaque"}).then(response => {
        if (response.status === 202) {
          const job: string = response.data.jobId;
          // @ts-expect-error Accepted jobs have no synchronous success flag.
          response.data.ok;
        }
        // @ts-expect-error Install acceptance is 202, never 200.
        if (response.status === 200) { throw Error(); }
      });
      updateAdminExtension("id", undefined); updateAdminExtension("id", {hostPortConfirmation: "opaque"});
      removeAdminExtension("id", undefined); removeAdminExtension("id", {});
      refreshAdminExtensionCatalog(undefined); refreshAdminExtensionCatalog({});
      listAdminExtensionSources().then(response => { if (response.status === 200) { const source: AdminExtensionSource = response.data.sources[0]; } });
      addAdminExtensionSource({url: "https://example.test", label: "Synthetic"});
      removeAdminExtensionSource({url: "https://example.test"});
      // @ts-expect-error Selector fields are strings.
      installAdminExtension({id: 1});
      // @ts-expect-error Unknown install fields are rejected.
      installAdminExtension({id: "a", unexpected: true});
      // @ts-expect-error Update null differs from absent body.
      updateAdminExtension("id", null);
      // @ts-expect-error Source label is required.
      addAdminExtensionSource({url: "https://example.test"});
    `,
    );
  }
  if (virtual.has(resolve(base, "src/api/generated/saved/saved-places.generated.ts"))) {
    virtual.set(
      resolve(base, "src/api/generated/saved/saved-consumer.typecheck.ts"),
      `
      import { createSavedList, updateSavedList, exportSavedList, createSavedPlace } from "./saved-places.generated";
      async function savedConsumer() {
        const result = await createSavedList({name: "Trip"});
        if (result.status === 200) {
          const id: string = result.data.id;
          // @ts-expect-error A creation receipt is not a full saved-list read record.
          result.data.createdAt;
        }
        await updateSavedList("list", {icon: null});
        const exported = await exportSavedList("list", {format: "gpx"});
        if (exported.status === 200) { const blob: Blob = exported.data; }
        await createSavedPlace("list", {name: "Place", lat: 52, lng: 13, fieldContributors: {name: [{sourceId: "x", name: "X"}] as const}});
        // @ts-expect-error The export selector is closed.
        exportSavedList("list", {format: "csv"});
      }
    `,
    );
  }
  if (virtual.has(resolve(base, "src/api/generated/garage/garage.generated.ts"))) {
    virtual.set(
      resolve(base, "src/api/generated/garage/garage-consumer.typecheck.ts"),
      `
      import { createGarageVehicle, listGarageVehicles, updateGarageVehicle, updateGarageParking, saveGarageParking } from "./garage.generated";
      async function garageConsumer() {
        const created = await createGarageVehicle({ name: "Car", kind: "car", powertrain: "petrol" });
        if (created.status === 200) {
          const id: string = created.data.id;
          // @ts-expect-error A creation receipt has no persisted timestamp.
          created.data.createdAt;
          // @ts-expect-error Owning account IDs are not public records.
          created.data.userId;
        }
        const read = await listGarageVehicles();
        if (read.status === 200) { const at: string = read.data.vehicles[0].createdAt; }
        await updateGarageVehicle("car / café", { isDefault: false });
        await saveGarageParking({ lat: 52, lng: 13, source: "manual" });
        await updateGarageParking("parked", { expiresAt: null });
        // @ts-expect-error Coordinates are numeric JSON fields.
        saveGarageParking({ lat: "52", lng: 13, source: "manual" });
        // @ts-expect-error PATCH cannot silently reassign a parked position.
        updateGarageParking("parked", { vehicleId: "other" });
      }
    `,
    );
  }
  if (virtual.has(resolve(base, "src/api/generated/sharing/sharing.generated.ts"))) {
    virtual.set(
      resolve(base, "src/api/generated/sharing/sharing-consumer.typecheck.ts"),
      `
      import { createShare, resolvePublicShare, rotateShareToken, revokeShare, listOwnerShares } from "./sharing.generated";
      async function sharingConsumer() {
        const created = await createShare({ targetType: "list", targetId: "list", mode: "live" });
        if (created.status === 201) { const token: string = created.data.token;
          // @ts-expect-error Token hashes are never wire fields.
          created.data.share.tokenHash;
        }
        const resolved = await resolvePublicShare("A".repeat(43));
        if (resolved.status === 200 && resolved.data.type === "list") { const lat: number = resolved.data.places[0].lat; }
        await listOwnerShares(); await rotateShareToken("share / café"); await revokeShare("share");
        // @ts-expect-error List creation requires a mode.
        createShare({ targetType: "list", targetId: "list" });
        // @ts-expect-error Coordinates are numeric.
        createShare({ targetType: "route", route: {mode: "walking", waypoints: [{lat: "52", lng: 13}, {lat: 53, lng: 14}]} });
      }
    `,
    );
  }
  const host = ts.createCompilerHost(options);
  const fileExists = host.fileExists.bind(host),
    read = host.readFile.bind(host),
    source = host.getSourceFile.bind(host);
  const directoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (path: string) =>
    Array.from(virtual.keys()).some((file) => file.startsWith(`${path}/`)) ||
    directoryExists?.(path) === true;
  host.fileExists = (path: string) => virtual.has(path) || fileExists(path);
  host.readFile = (path: string) => virtual.get(path) ?? read(path);
  host.getSourceFile = (path: string, language: unknown, ...rest: unknown[]) =>
    virtual.has(path)
      ? ts.createSourceFile(path, virtual.get(path), language, true)
      : source(path, language, ...rest);
  return ts
    .getPreEmitDiagnostics(
      ts.createProgram(
        [
          filename,
          ...Array.from(virtual.keys()).filter(
            (file) =>
              file.endsWith("/saved-consumer.typecheck.ts") ||
              file.endsWith("/garage-consumer.typecheck.ts") ||
              file.endsWith("/sharing-consumer.typecheck.ts"),
          ),
        ],
        options,
        host,
      ),
    )
    .map((diagnostic: { messageText: unknown }) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
}

const directories: string[] = [];
async function directory() {
  const result = await mkdtemp(join(tmpdir(), "api-sdk-test-"));
  directories.push(result);
  return result;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("SDK artifact gate", () => {
  it("keeps privacy generation dormant until actual privacy-admin routes adopt the family", () => {
    const document = {
      paths: {
        "/fixture": {
          get: { operationId: "fixture", tags: ["data-manager-admin"], responses: {} },
        },
      },
    };
    expect(
      createCodegenConfig({ inputDocument: document, outputDirectory: "/tmp/sdk-config" }),
    ).not.toHaveProperty("privacyAdmin");
    const adopted = {
      paths: {
        ...document.paths,
        "/api/admin/privacy/requests": {
          get: {
            operationId: "listAdminPrivacyRequests",
            tags: ["privacy-admin"],
            responses: {
              200: {
                description: "Cases",
                content: { "application/json": { schema: { type: "object" } } },
              },
            },
          },
        },
      },
    };
    const config = createCodegenConfig({
      inputDocument: adopted,
      outputDirectory: "/tmp/sdk-config",
    });
    expect(config).toHaveProperty("privacyAdmin");
    expect(config.privacyAdmin.output).toMatchObject({
      target: "/tmp/sdk-config/generated/admin/privacy-admin.generated.ts",
      schemas: "/tmp/sdk-config/generated/admin/privacy-models",
    });
    expect(typeof config.privacyAdmin.output.client).toBe("function");
    expect(selectTaggedDocument(adopted, "privacy-admin").paths).toHaveProperty(
      "/api/admin/privacy/requests",
    );
    expect(selectTaggedDocument(adopted, "service-admin").paths).toEqual({});
  });

  it("keeps extension generation dormant until a real document adopts the tag", () => {
    const document = {
      paths: {
        "/fixture": {
          post: { operationId: "fixture", tags: ["data-manager-admin"], responses: {} },
        },
      },
    };
    expect(
      createCodegenConfig({ inputDocument: document, outputDirectory: "/tmp/sdk-config" }),
    ).not.toHaveProperty("extensionAdmin");
    // Disposable config fixture only; no production OpenAPI or SDK artifact is written.
    const adopted = {
      paths: {
        ...document.paths,
        "/api/admin/extensions/install": {
          post: {
            operationId: "installAdminExtension",
            tags: ["extension-admin"],
            responses: {
              202: {
                description: "Accepted",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { jobId: { type: "string" } },
                      required: ["jobId"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const config = createCodegenConfig({
      inputDocument: adopted,
      outputDirectory: "/tmp/sdk-config",
    });
    expect(config).toHaveProperty("extensionAdmin");
    expect(config.extensionAdmin.output).toMatchObject({
      client: "fetch",
      target: "/tmp/sdk-config/generated/admin/extension-admin.generated.ts",
      schemas: "/tmp/sdk-config/generated/admin/extension-models",
    });
    expect(adminOperationBindings(adopted)).toContain(
      'bindAdminOperation("installAdminExtension")',
    );
    expect(selectTaggedDocument(adopted, "service-admin").paths).toEqual({});
  });
  it("isolates family schemas while preserving recursive refs and security definitions", () => {
    const document = {
      paths: {
        "/metadata": {
          get: {
            operationId: "metadata",
            tags: ["runtime-metadata"],
            responses: {
              200: {
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Metadata" } },
                },
              },
            },
          },
        },
        "/admin": {
          post: {
            operationId: "admin",
            tags: ["data-manager-admin"],
            responses: {
              200: {
                content: { "application/json": { schema: { $ref: "#/components/schemas/Admin" } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Metadata: { type: "string" },
          Admin: { type: "object", properties: { next: { $ref: "#/components/schemas/Admin" } } },
        },
        securitySchemes: { session: { type: "apiKey", in: "cookie", name: "session" } },
      },
    };
    const metadata = selectTaggedDocument(document, "runtime-metadata");
    expect(Object.keys(metadata.paths)).toEqual(["/metadata"]);
    expect(Object.keys(metadata.components.schemas)).toEqual(["Metadata"]);
    expect(metadata.components.securitySchemes).toEqual(document.components.securitySchemes);
    expect(
      Object.keys(selectTaggedDocument(document, "data-manager-admin").components.schemas),
    ).toEqual(["Admin"]);
    expect(document.components.schemas).toHaveProperty("Admin");
  });
  it("rejects unsupported response shapes instead of inventing validator bindings", () => {
    expect(() =>
      validatedResponseTypes({
        operationId: "unsupported",
        response: {
          definition: { success: "string" },
          types: { success: [{ value: "string", isRef: false, key: "200" }], errors: [] },
        },
      }),
    ).toThrow(/named JSON success schema/);
  });
  it("detects stale, missing and extra files without changing them", async () => {
    const outputDirectory = await directory();
    const files = [{ filename: "sdk.generated.ts", content: "generated\n" }];
    await writeOrCheckArtifacts(files, { outputDirectory });
    await expect(
      writeOrCheckArtifacts(files, { outputDirectory, check: true }),
    ).resolves.toBeUndefined();
    await writeFile(join(outputDirectory, "sdk.generated.ts"), "stale\n");
    await writeFile(join(outputDirectory, "old.generated.ts"), "old\n");
    await expect(writeOrCheckArtifacts(files, { outputDirectory, check: true })).rejects.toThrow(
      /stale|extra/,
    );
    expect(await readFile(join(outputDirectory, "sdk.generated.ts"), "utf8")).toBe("stale\n");
    expect(await readFile(join(outputDirectory, "old.generated.ts"), "utf8")).toBe("old\n");
    await writeFile(join(outputDirectory, "sdk.generated.ts"), "generated\n");
    await expect(writeOrCheckArtifacts(files, { outputDirectory, check: true })).rejects.toThrow(
      "old.generated.ts (extra)",
    );
    await rm(join(outputDirectory, "old.generated.ts"));
    await rm(join(outputDirectory, "sdk.generated.ts"));
    await expect(writeOrCheckArtifacts(files, { outputDirectory, check: true })).rejects.toThrow(
      /missing/,
    );
  });

  it("generates deterministic adopted families while preserving runtime metadata", async () => {
    const first = await generateArtifacts();
    expect(await generateArtifacts()).toEqual(first);
    const sdk = first.find(
      (file: { filename: string }) => file.filename === "runtime-metadata.generated.ts",
    )?.content;
    expect(sdk).toContain("getApiCapabilities");
    expect(sdk).toContain("getApiIntegrations");
    expect(sdk).toContain("data: IntegrationsResponseOutput");
    expect(sdk).toContain("status: 304");
    expect(sdk).toContain("schema: IntegrationsResponse");
    expect(sdk).not.toContain("getApiAdmin");
    const admin = first.find(
      (file: { filename: string }) => file.filename === "admin/data-manager-admin.generated.ts",
    )?.content;
    expect(admin).toContain("postApiDataManagerTransitSync");
    expect(admin).toContain("status: 202");
    expect(admin).toContain("status: 409");
    expect(admin).toContain("status: 422");
    expect(admin).toContain("encodeURIComponent");
    const { serviceAdminOperations } = await import(
      "../../packages/core/src/api/contracts/service-admin"
    );
    const service = first.find(
      (file: { filename: string }) => file.filename === "admin/service-admin.generated.ts",
    )?.content;
    expect(service).toBeDefined();
    for (const [id, operation] of Object.entries(serviceAdminOperations)) {
      expect(service).toContain(`export const ${id}`);
      const declared = [
        ...(service ?? "").matchAll(new RegExp(`export type ${id}Response(\\d+) =`, "g")),
      ]
        .map((match) => match[1])
        .sort();
      expect(declared, id).toEqual(Object.keys(operation.responses).sort());
    }
    const extension = first.find(
      (file: { filename: string }) => file.filename === "admin/extension-admin.generated.ts",
    );
    expect(extension).toBeDefined();
    const { extensionAdminOperations } = await import(
      "../../packages/core/src/api/contracts/extension-admin"
    );
    for (const [id, operation] of Object.entries(extensionAdminOperations)) {
      expect(extension.content).toContain(`export const ${id}`);
      const statuses = [
        ...extension.content.matchAll(new RegExp(`export type ${id}Response(\\d+) =`, "g")),
      ]
        .map((match) => match[1])
        .sort();
      expect(statuses, id).toEqual(Object.keys(operation.responses).sort());
    }
    // Real committed document, removing only the adopted family for the isolation baseline.
    const previousDocument = JSON.parse(
      await readFile(new URL("../../apps/api/openapi.json", import.meta.url), "utf8"),
    );
    for (const methods of Object.values(previousDocument.paths)) {
      for (const [method, operation] of Object.entries(methods as object))
        if (operation.tags?.includes("extension-admin")) delete methods[method];
    }
    const previousFiles = await generateArtifacts({ document: previousDocument });
    for (const file of previousFiles.filter(
      (file: { filename: string }) => file.filename !== "admin/operation-bindings.generated.ts",
    ))
      expect(
        first.find((candidate: { filename: string }) => candidate.filename === file.filename)
          ?.content,
        file.filename,
      ).toBe(file.content);
    expect(generatedConsumerDiagnostics(first)).toEqual([]);
    const bindings = first.find(
      (file: { filename: string }) => file.filename === "admin/operation-bindings.generated.ts",
    )?.content;
    expect(bindings).toContain('bindAdminOperation("getApiDataManagerTransitState")');
    expect(bindings).not.toContain("/api/");
    const metadata = first.filter(
      (file: { filename: string }) =>
        !file.filename.startsWith("admin/") &&
        !file.filename.startsWith("saved/") &&
        !file.filename.startsWith("garage/") &&
        !file.filename.startsWith("sharing/"),
    );
    expect(metadata).toHaveLength(6);
    for (const file of metadata)
      expect(file.content).toBe(
        await readFile(
          new URL(`../../packages/core/src/api/generated/${file.filename}`, import.meta.url),
          "utf8",
        ),
      );
    expect(
      first
        .filter((file: { filename: string }) => file.filename.startsWith("admin/"))
        .map((file: { content: string }) => file.content)
        .join("\n"),
    ).not.toContain('from "zod');
    const content = first.map((file: { content: string }) => file.content).join("\n");
    expect(content).toContain("zod.lazy");
    expect(content).not.toContain("zod.unknown()");
  }, 90_000);
});

describe("activity generation", () => {
  it("generates all five operations and an honest EventSource target using the generated URL", async () => {
    const input = JSON.parse(
      await readFile(new URL("../../apps/api/openapi.json", import.meta.url), "utf8"),
    );
    const ids = [
      ["listAdminActivityJobs", "get", "/api/admin/jobs"],
      ["getAdminActivityJob", "get", "/api/admin/jobs/{id}"],
      ["cancelAdminActivityJob", "post", "/api/admin/jobs/{id}/cancel"],
      ["getAdminActivityJobStreamMetrics", "get", "/api/admin/jobs/stream-metrics"],
      ["streamAdminActivityJobEvents", "get", "/api/admin/jobs/{id}/events"],
    ];
    const previousInput = structuredClone(input);
    // Once Activity is adopted, the committed spec also contains its full schemas.
    // Compare the other families against a baseline without this fixture family.
    for (const [, method, path] of ids) delete previousInput.paths[path]?.[method];
    for (const [id, method, path] of ids) {
      const stream = id === "streamAdminActivityJobEvents";
      input.paths[path] ??= {};
      input.paths[path][method] = {
        operationId: id,
        tags: ["activity-admin"],
        parameters: [
          ...(path.includes("{id}")
            ? [{ in: "path", name: "id", required: true, schema: { type: "string" } }]
            : []),
          ...(id === "listAdminActivityJobs"
            ? [
                {
                  in: "query",
                  name: "limit",
                  schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
                },
                {
                  in: "query",
                  name: "offset",
                  schema: {
                    type: "integer",
                    minimum: 0,
                    maximum: Number.MAX_SAFE_INTEGER,
                    default: 0,
                  },
                },
              ]
            : []),
          ...(stream
            ? [
                {
                  in: "header",
                  name: "last-event-id",
                  schema: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
                },
                { in: "query", name: "source", schema: { type: "string", enum: ["application"] } },
                {
                  in: "query",
                  name: "cursor",
                  schema: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
                },
              ]
            : []),
        ],
        responses: {
          200: {
            description: "ok",
            content: {
              [stream ? "text/event-stream" : "application/json"]: { schema: { type: "string" } },
            },
          },
        },
      };
    }
    vi.stubGlobal("fetch", () => {
      throw new Error("Unexpected network");
    });
    try {
      const files = await generateArtifacts({ document: input });
      // Every other committed family/model stays byte-stable when adding Activity.
      const previous = await generateArtifacts({ document: previousInput });
      for (const file of previous.filter(
        (f: { filename: string }) => f.filename !== "admin/operation-bindings.generated.ts",
      ))
        expect(files.find((f: { filename: string }) => f.filename === file.filename)?.content).toBe(
          file.content,
        );
      const activity = files.find(
        (f: { filename: string }) => f.filename === "admin/activity-admin.generated.ts",
      );
      expect(activity).toBeDefined();
      for (const [id] of ids) expect(activity.content).toContain(`export const ${id} =`);
      expect(activity.content).toContain("Promise<AdminEventStreamTarget>");
      expect(activity.content).not.toContain("Promise<string>");
      const bindings = files.find(
        (f: { filename: string }) => f.filename === "admin/operation-bindings.generated.ts",
      ).content;
      expect(generatedConsumerDiagnostics(files)).toEqual([]);
      const result = await build({
        stdin: {
          contents: activity.content,
          loader: "ts",
          resolveDir: new URL("../../packages/core/src/api/generated/admin", import.meta.url)
            .pathname,
        },
        bundle: true,
        platform: "node",
        format: "esm",
        write: false,
        plugins: [
          {
            name: "generated-bindings",
            setup(builder) {
              builder.onResolve({ filter: /operation-bindings.generated/ }, () => ({
                path: "bindings",
                namespace: "fixture",
              }));
              builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
                contents: bindings,
                loader: "ts",
                resolveDir: new URL("../../packages/core/src/api/generated/admin", import.meta.url)
                  .pathname,
              }));
            },
          },
        ],
      });
      const sdk = await import(
        `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
      );
      expect(
        Object.keys(sdk)
          .filter((name) => !name.startsWith("get") || ids.some(([id]) => name === id))
          .sort(),
      ).toEqual(ids.map(([id]) => id).sort());
      const { createApiClient } = await import("../../packages/core/src/api/client");
      const client = createApiClient({ baseUrl: "https://app.example", credentials: "include" });
      expect(
        sdk.getStreamAdminActivityJobEventsUrl("a/b?#", { source: "application", cursor: 2 }),
      ).toBe("/api/admin/jobs/a%2Fb%3F%23/events?source=application&cursor=2");
      await expect(
        sdk.streamAdminActivityJobEvents(
          "a/b?#",
          { source: "application", cursor: 2 },
          {
            client,
          },
        ),
      ).resolves.toEqual({
        url: "https://app.example/api/admin/jobs/a%2Fb%3F%23/events?source=application&cursor=2",
        withCredentials: true,
      });
      for (const unsupported of [
        { timeoutMs: 100 },
        { body: "secret payload" },
        { cache: "no-store" },
      ]) {
        const error = await sdk
          .streamAdminActivityJobEvents("id", undefined, { client, ...unsupported })
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toMatch(/unsupported/i);
        expect(String(error)).not.toContain("secret");
      }
      vi.stubGlobal("fetch", async (url: string) => {
        if (url !== "https://app.example/api/admin/jobs") throw new Error("Unexpected network");
        return Response.json({ jobs: [], total: 0 });
      });
      await expect(sdk.listAdminActivityJobs(undefined, { client })).resolves.toMatchObject({
        status: 200,
        data: { jobs: [], total: 0 },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  }, 90_000);
});

describe("integration administration generation", () => {
  it("generates all22operations, isolated models and aggregate bindings without changing prior families", async () => {
    const { integrationAdminOperations } = await import(
      "../../packages/core/src/api/contracts/integration-admin"
    );
    const { routeJsonSchema } = await import("../../packages/core/src/api/schema");
    const previousInput = JSON.parse(
      await readFile(new URL("../../apps/api/openapi.json", import.meta.url), "utf8"),
    );
    const input = structuredClone(previousInput);
    // Keep the synthetic emitter probe; compare old families to a document without
    // this family now that actual producers are adopted and separately qualified.
    for (const operation of Object.values(integrationAdminOperations)) {
      const path = operation.path.replace(/:([^/]+)/g, "{$1}");
      delete previousInput.paths[path]?.[operation.method.toLowerCase()];
    }
    input.components ??= {};
    input.components.schemas ??= {};
    const definitions = input.components.schemas;
    const schemaIds = new Map<Parameters<typeof routeJsonSchema>[0], string>();
    function schema(value: Parameters<typeof routeJsonSchema>[0], identity: string) {
      const previous = schemaIds.get(value);
      if (previous) return { $ref: `#/components/schemas/${previous}` };
      schemaIds.set(value, identity);
      const result = routeJsonSchema(value, {
        identity,
        io: "output",
        registerDefinition: ({ $id, ...definition }) => {
          definitions[$id] = definition;
        },
      });
      definitions[identity] = result;
      return { $ref: `#/components/schemas/${identity}` };
    }
    for (const [id, operation] of Object.entries(integrationAdminOperations)) {
      const path = operation.path.replace(/:([^/]+)/g, "{$1}");
      const request = "request" in operation ? operation.request : undefined;
      const parameters: unknown[] = [];
      for (const name of [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]))
        parameters.push({ in: "path", name, required: true, schema: { type: "string" } });
      if (request && "query" in request)
        parameters.push({
          in: "query",
          name: "hours",
          schema: { type: "integer", minimum: 1, maximum: 168, default: 24 },
        });
      if (request && "headers" in request) {
        const emitted = routeJsonSchema(request.headers, {
          identity: `${id}Headers`,
          io: "output",
        });
        const required = emitted.required as string[] | undefined;
        for (const [name, field] of Object.entries(emitted.properties as Record<string, unknown>))
          parameters.push({
            in: "header",
            name,
            required: required?.includes(name) ?? false,
            schema: field,
          });
      }
      input.paths[path] ??= {};
      input.paths[path][operation.method.toLowerCase()] = {
        operationId: id,
        tags: ["integration-admin"],
        parameters,
        ...(request && "body" in request
          ? {
              requestBody: {
                required: !request.body.isOptional(),
                content: { "application/json": { schema: schema(request.body, `${id}Body`) } },
              },
            }
          : {}),
        responses: Object.fromEntries(
          Object.entries(operation.responses).map(([status, response]) => [
            status,
            {
              description: "Synthetic contract fixture",
              content: {
                "application/json": { schema: schema(response.schema, `${id}Response${status}`) },
              },
            },
          ]),
        ),
      };
    }
    function references(value: unknown): void {
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (typeof node.$ref === "string" && node.$ref.endsWith("#"))
        node.$ref = `#/components/schemas/${node.$ref.slice(0, -1)}`;
      for (const child of Object.values(value)) references(child);
    }
    references(definitions);
    vi.stubGlobal("fetch", () => {
      throw new Error("Unexpected network");
    });
    try {
      const files = await generateArtifacts({ document: input });
      const integration = files.find(
        (file: { filename: string }) => file.filename === "admin/integration-admin.generated.ts",
      );
      expect(integration).toBeDefined();
      const previous = await generateArtifacts({ document: previousInput });
      for (const file of previous.filter(
        (file: { filename: string }) => file.filename !== "admin/operation-bindings.generated.ts",
      ))
        expect(
          files.find((candidate: { filename: string }) => candidate.filename === file.filename)
            ?.content,
        ).toBe(file.content);
      expect(await generateArtifacts({ document: input })).toEqual(files);
      expect(
        files.some((file: { filename: string }) =>
          file.filename.startsWith("admin/integration-models/"),
        ),
      ).toBe(true);
      expect(integration.content).toContain("./integration-models");
      for (const id of Object.keys(integrationAdminOperations))
        expect(integration.content).toContain(`export const ${id} =`);
      const bindings = files.find(
        (file: { filename: string }) => file.filename === "admin/operation-bindings.generated.ts",
      ).content;
      expect(bindings).toContain('bindAdminOperation("getAdminOverview")');
      expect(bindings).toContain('bindAdminStreamOperation("streamAdminActivityJobEvents")');
      expect(generatedConsumerDiagnostics(files)).toEqual([]);
      const bundled = await build({
        stdin: {
          contents: integration.content,
          loader: "ts",
          resolveDir: new URL("../../packages/core/src/api/generated/admin", import.meta.url)
            .pathname,
        },
        bundle: true,
        platform: "node",
        format: "esm",
        write: false,
        plugins: [
          {
            name: "pending-integration-bindings",
            setup(builder) {
              builder.onResolve({ filter: /operation-bindings.generated/ }, () => ({
                path: "bindings",
                namespace: "fixture",
              }));
              builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
                contents: bindings,
                loader: "ts",
                resolveDir: new URL("../../packages/core/src/api/generated/admin", import.meta.url)
                  .pathname,
              }));
            },
          },
        ],
      });
      const sdk = await import(
        `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
      );
      expect(sdk.getGetAdminIntegrationUrl("sample /街?")).toBe(
        "/api/admin/integrations/sample%20%2F%E8%A1%97%3F",
      );
      const { createApiClient } = await import("../../packages/core/src/api/client");
      const client = createApiClient({ baseUrl: "https://app.example", credentials: "include" });
      vi.stubGlobal("fetch", async (url: string) => {
        if (url !== "https://app.example/api/admin/integrations/sample%20%2F%E8%A1%97%3F")
          throw new Error("Unexpected network");
        return Response.json({ error: "Absent" }, { status: 404 });
      });
      await expect(sdk.getAdminIntegration("sample /街?", { client })).resolves.toMatchObject({
        status: 404,
        data: { error: "Absent" },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  }, 180_000);
});

describe("service administration custom-client generation", () => {
  it("generates all30operations with callback-required logs, finite YAML and all-error down, preserving prior bytes", async () => {
    const { serviceAdminOperations } = await import(
      "../../packages/core/src/api/contracts/service-admin"
    );
    const { routeJsonSchema } = await import("../../packages/core/src/api/schema");
    const previousInput = JSON.parse(
      await readFile(new URL("../../apps/api/openapi.json", import.meta.url), "utf8"),
    );
    const input = structuredClone(previousInput);
    const definitions = input.components.schemas;
    const schemaIds = new Map<Parameters<typeof routeJsonSchema>[0], string>();
    function schema(value: Parameters<typeof routeJsonSchema>[0], identity: string) {
      const previous = schemaIds.get(value);
      if (previous) return { $ref: `#/components/schemas/${previous}` };
      schemaIds.set(value, identity);
      const result = routeJsonSchema(value, {
        identity,
        io: "output",
        registerDefinition: ({ $id, ...definition }) => {
          definitions[$id] = definition;
        },
      });
      definitions[identity] = result;
      return { $ref: `#/components/schemas/${identity}` };
    }
    // Disposable producer-independent document. Actual producer adoption belongs to Task2.
    for (const [id, entry] of Object.entries(serviceAdminOperations)) {
      const operation: import("../../packages/core/src/api/contracts/admin").AdminOperation = entry;
      const path = operation.path.replace(/:([^/]+)/g, "{$1}");
      const request = operation.request;
      const parameters: unknown[] = [];
      for (const [location, shape] of [
        ["path", request?.params],
        ["query", request?.query],
        ["header", request?.headers],
      ] as const) {
        if (!shape) continue;
        const emitted = routeJsonSchema(shape, { identity: `${id}${location}`, io: "output" });
        const required = emitted.required as string[] | undefined;
        for (const [name, field] of Object.entries(emitted.properties as Record<string, unknown>))
          parameters.push({
            in: location,
            name,
            required: required?.includes(name) ?? false,
            schema: field,
          });
      }
      input.paths[path] ??= {};
      input.paths[path][operation.method.toLowerCase()] = {
        operationId: id,
        tags: ["service-admin"],
        parameters,
        ...(Object.values(operation.responses).some((c) => c.kind === "bytes" && c.nativeDownload)
          ? { "x-openmapx-native-download": true }
          : {}),
        ...(operation.requestBody
          ? {
              requestBody: {
                required: true,
                content: {
                  [operation.requestBody.mediaType]: {
                    schema: { type: "string", format: "binary" },
                  },
                },
              },
            }
          : {}),
        ...(request?.body
          ? {
              requestBody: {
                required: !request.body.isOptional(),
                content: { "application/json": { schema: schema(request.body, `${id}Body`) } },
              },
            }
          : {}),
        responses: Object.fromEntries(
          Object.entries(operation.responses).map(([status, response]) => [
            status,
            {
              description: "Synthetic service contract fixture",
              content: {
                [response.kind === "json"
                  ? "application/json"
                  : "mediaType" in response
                    ? response.mediaType
                    : "text/plain"]: {
                  schema:
                    "schema" in response
                      ? schema(response.schema, `${id}Response${status}`)
                      : response.kind === "bytes"
                        ? { type: "string", format: "binary" }
                        : { type: "string" },
                },
              },
            },
          ]),
        ),
      };
    }
    function references(value: unknown): void {
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (typeof node.$ref === "string" && node.$ref.endsWith("#"))
        node.$ref = `#/components/schemas/${node.$ref.slice(0, -1)}`;
      for (const child of Object.values(value)) references(child);
    }
    references(definitions);
    vi.stubGlobal("fetch", () => {
      throw new Error("Unexpected network");
    });
    try {
      const files = await generateArtifacts({ document: input });
      const service = files.find(
        (file: { filename: string }) => file.filename === "admin/service-admin.generated.ts",
      );
      expect(service, "The service-admin tag needs its own supported custom client").toBeDefined();
      if (!service) throw new Error("Missing service family");
      for (const id of Object.keys(serviceAdminOperations))
        expect(service.content).toContain(`export const ${id}`);
      expect(
        files.some((file: { filename: string }) =>
          file.filename.startsWith("admin/service-models/"),
        ),
      ).toBe(true);
      expect(generatedConsumerDiagnostics(files)).toEqual([]);
      const previous = await generateArtifacts({ document: previousInput });
      for (const file of previous.filter(
        (file: { filename: string }) =>
          file.filename !== "admin/operation-bindings.generated.ts" &&
          file.filename !== "admin/service-admin.generated.ts" &&
          !file.filename.startsWith("admin/service-models/"),
      ))
        expect(
          files.find((candidate: { filename: string }) => candidate.filename === file.filename)
            ?.content,
        ).toBe(file.content);
      expect(await generateArtifacts({ document: input })).toEqual(files);
      const bindings = files.find(
        (file: { filename: string }) => file.filename === "admin/operation-bindings.generated.ts",
      ).content;
      const bundled = await build({
        stdin: {
          contents: service.content,
          loader: "ts",
          resolveDir: new URL("../../packages/core/src/api/generated/admin", import.meta.url)
            .pathname,
        },
        bundle: true,
        platform: "node",
        format: "esm",
        write: false,
        plugins: [
          {
            name: "service-fixture-bindings",
            setup(builder) {
              builder.onResolve({ filter: /operation-bindings.generated/ }, () => ({
                path: "bindings",
                namespace: "fixture",
              }));
              builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
                contents: bindings,
                loader: "ts",
                resolveDir: new URL("../../packages/core/src/api/generated/admin", import.meta.url)
                  .pathname,
              }));
            },
          },
        ],
      });
      const sdk = await import(
        `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
      );
      const { createApiClient } = await import("../../packages/core/src/api/client");
      const client = createApiClient({ baseUrl: "https://app.example", credentials: "include" });
      const headers = { "idempotency-key": "synthetic-intent-0001" };
      expect(sdk.getStreamAdminServiceLogsUrl("a/b?#", { lines: "20 &" })).toBe(
        "/api/admin/services/a%2Fb%3F%23/logs?lines=20+%26",
      );
      expect(sdk.getRestoreAdminServiceBackupUrl("a/b?#")).toBe(
        "/api/admin/services/backups/a%2Fb%3F%23/restore",
      );
      let acquire: () => Response = () =>
        new Response("services:\n  synthetic: {}\n", {
          headers: {
            "content-type": "text/yaml; charset=utf-8",
            "x-openmapx-current-configuration": "none",
          },
        });
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        expect(url).toMatch(/^https:\/\/app\.example\/api\/admin\//);
        expect(init.credentials).toBe("include");
        if (url.includes("/logs")) {
          expect(url).toBe("https://app.example/api/admin/services/a%2Fb%3F%23/logs?lines=20");
          expect(new Headers(init.headers).get("idempotency-key")).toBe("synthetic-intent-0001");
        }
        return acquire();
      });
      await expect(sdk.getAdminComposePreview({ client })).resolves.toMatchObject({
        status: 200,
        data: "services:\n  synthetic: {}\n",
      });
      await expect(sdk.getAdminComposePreview({ client, maxTextBytes: 1 })).rejects.toThrow(
        /contract/i,
      );
      acquire = () => Response.json({ error: "Registry unavailable" }, { status: 503 });
      await expect(sdk.getAdminComposePreview({ client })).resolves.toMatchObject({
        status: 503,
        data: { error: "Registry unavailable" },
      });
      acquire = () => Response.json({ ok: false, error: "Host guidance" }, { status: 503 });
      await expect(sdk.stopAdminCompose(undefined, { client })).resolves.toMatchObject({
        status: 503,
        data: { ok: false, error: "Host guidance" },
      });
      acquire = () => Response.json({ ok: true });
      await expect(sdk.stopAdminCompose(undefined, { client })).rejects.toThrow(/contract/i);
      for (const status of [404, 409]) {
        acquire = () => Response.json({ error: "Synthetic log rejection" }, { status });
        await expect(
          sdk.streamAdminServiceLogs(
            "a/b?#",
            headers,
            { lines: "20" },
            {
              client,
              onTextChunk: () => {
                throw new Error("Must not consume JSON as log text");
              },
            },
          ),
        ).resolves.toMatchObject({ status, data: { error: "Synthetic log rejection" } });
      }
      acquire = () => Response.json({ error: "x".repeat(100) }, { status: 404 });
      await expect(
        sdk.streamAdminServiceLogs(
          "a/b?#",
          headers,
          { lines: "20" },
          { client, maxErrorBytes: 10, onTextChunk: () => {} },
        ),
      ).rejects.toThrow(/contract/i);
      const log = (options: Record<string, unknown>) =>
        sdk.streamAdminServiceLogs("a/b?#", headers, { lines: "20" }, { client, ...options });
      const utf8 = new TextEncoder().encode("first €\nlast");
      let body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(utf8.slice(0, 7));
          controller.enqueue(utf8.slice(7));
          controller.enqueue(new Uint8Array([0xe2]));
          controller.close();
        },
      });
      acquire = () =>
        new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
      const chunks: string[] = [];
      await expect(
        log({
          onTextChunk: async (chunk: string) => {
            chunks.push(chunk);
          },
        }),
      ).resolves.toMatchObject({ status: 200, data: undefined });
      expect(chunks.join("")).toBe("first €\nlast�");
      expect(body.locked).toBe(false);
      acquire = () => new Response("synthetic", { headers: { "content-type": "text/plain" } });
      await expect(log({})).rejects.toThrow(/contract/i);
      await expect(
        sdk.streamAdminServiceLogs(
          "a/b?#",
          { "idempotency-key": "short" },
          { lines: "20" },
          { client, onTextChunk: () => {} },
        ),
      ).rejects.toThrow(/contract/i);
      // A callback owns backpressure: the generated call cannot complete first.
      let deliver!: () => void;
      let deliveryStarted!: () => void;
      const delivering = new Promise<void>((resolve) => {
        deliveryStarted = resolve;
      });
      let completed = false;
      const delivered = log({
        onTextChunk: () => {
          deliveryStarted();
          return new Promise<void>((resolve) => {
            deliver = resolve;
          });
        },
      }).then((response: unknown) => {
        completed = true;
        return response;
      });
      await delivering;
      expect(completed).toBe(false);
      deliver();
      await expect(delivered).resolves.toMatchObject({ status: 200, data: undefined });
      acquire = () =>
        new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
      // Actual generated stream: errors, stalled reads/callbacks, owner abort and deadline.
      vi.useFakeTimers();
      for (const schedule of [
        "callback failure",
        "abort read",
        "deadline read",
        "abort callback",
        "deadline callback",
      ] as const) {
        const canceled = vi.fn();
        let reading!: () => void;
        const readEntered = new Promise<void>((resolve) => {
          reading = resolve;
        });
        body = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              if (schedule.includes("callback"))
                controller.enqueue(new TextEncoder().encode("chunk"));
            },
            pull() {
              reading();
            },
            cancel: canceled,
          },
          { highWaterMark: 0 },
        );
        const abort = new AbortController();
        const removedListener = vi.spyOn(abort.signal, "removeEventListener");
        let entered!: () => void;
        const callbackEntered = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const callback = () => {
          entered();
          if (schedule === "callback failure") throw new Error("Synthetic callback failure");
          return new Promise<void>(() => {});
        };
        const result = log({
          signal: abort.signal,
          ...(schedule.startsWith("deadline") ? { timeoutMs: 20 } : {}),
          onTextChunk: callback,
        });
        const rejected = expect(result).rejects.toThrow();
        if (schedule.includes("callback")) await callbackEntered;
        else await readEntered;
        if (schedule.startsWith("abort")) abort.abort();
        if (schedule.startsWith("deadline")) await vi.advanceTimersByTimeAsync(20);
        await rejected;
        expect(canceled).toHaveBeenCalledTimes(1);
        expect(body.locked).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(removedListener).toHaveBeenCalledWith("abort", expect.any(Function));
      }
      vi.useRealTimers();
      acquire = () => new Response("not JSON", { headers: { "content-type": "application/json" } });
      await expect(log({ onTextChunk: () => {} })).rejects.toThrow(/contract/i);
      acquire = () => new Response(null, { headers: { "content-type": "text/plain" } });
      await expect(log({ onTextChunk: () => {} })).rejects.toThrow(/contract/i);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  }, 180_000);
});
