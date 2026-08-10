import type { OsmContributionPublishRequest, OsmElementRef } from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadOsmConfig, type OsmConfig } from "../../../utils/osm-config.js";
import type { OsmAccountService, OsmAccountState } from "../account.js";
import { createOsmContributionService } from "../service.js";
import { createSubmissionGuard } from "../submission-guard.js";
import {
  isOsmContributionError,
  type OsmApiClient,
  type OsmContributionError,
  type OsmElement,
  OsmUpstreamError,
} from "../types.js";

const TOKEN = "osm-token-sentinel";
const COMMENT = "Corrected the name from the sign on the door";
const NOTE_TEXT = "The entrance is on the other side of the building.";
const REF: OsmElementRef = { type: "node", id: 12 };
const UUID = "3f4b2a5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const UUID_2 = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

const ENABLED = {
  OSM_CLIENT_ID: "id",
  OSM_CLIENT_SECRET: "secret",
  OSM_CONTRIBUTIONS_ENABLED: "true",
  OSM_DIRECT_EDITING_ENABLED: "true",
};

const linkedState: OsmAccountState = {
  status: "linked",
  accessToken: TOKEN,
  scopes: ["openid", "read_prefs", "write_api", "write_notes"],
  permissions: { allowWriteApi: true, allowWriteNotes: true },
  user: { id: 7, displayName: "mapper", contributorTermsAgreed: true, activeBlock: false },
};

function baseNode(overrides: Partial<Extract<OsmElement, { type: "node" }>> = {}): OsmElement {
  return {
    type: "node",
    id: 12,
    version: 4,
    lat: 52.5,
    lon: 13.4,
    visible: true,
    changeset: 800,
    tags: { amenity: "cafe", name: "Café Central", "openmapx:unknown": "keep" },
    ...overrides,
  };
}

const calls: string[] = [];

type LogCall = (details: Record<string, unknown>, message: string) => void;
interface TestLogger {
  info: ReturnType<typeof vi.fn<LogCall>>;
  warn: ReturnType<typeof vi.fn<LogCall>>;
  error: ReturnType<typeof vi.fn<LogCall>>;
}

function testLogger(): TestLogger {
  return { info: vi.fn<LogCall>(), warn: vi.fn<LogCall>(), error: vi.fn<LogCall>() };
}

/** A real spy that also records call order, so ordering and call assertions coexist. */
function trace<A extends unknown[], R>(name: string, impl: (...args: A) => R) {
  return vi.fn((...args: A): R => {
    calls.push(name);
    return impl(...args);
  });
}

function makeClient(overrides: Partial<OsmApiClient> = {}): OsmApiClient {
  const client: OsmApiClient = {
    getPermissions: vi.fn(async () => ({ allowWriteApi: true, allowWriteNotes: true })),
    getUserDetails: vi.fn(async () => linkedState.status === "linked" && linkedState.user),
    getElement: trace("getElement", async () => baseNode()),
    getFullElement: vi.fn(async () => ({ primary: baseNode(), nodes: [] })),
    createChangeset: trace("createChangeset", async () => 77),
    updateElement: trace("updateElement", async () => 5),
    closeChangeset: trace("closeChangeset", async () => undefined),
    getChangeset: vi.fn(async () => ({ id: 77, open: false })),
    createNote: vi.fn(async () => ({ id: 9, status: "open" as const })),
    ...overrides,
  } as unknown as OsmApiClient;
  return client;
}

function makeService(
  options: {
    client?: OsmApiClient;
    state?: OsmAccountState;
    config?: OsmConfig;
    logger?: TestLogger;
  } = {},
) {
  const client = options.client ?? makeClient();
  const account: OsmAccountService = { load: vi.fn(async () => options.state ?? linkedState) };
  const logger = options.logger ?? testLogger();
  const service = createOsmContributionService({
    config: options.config ?? loadOsmConfig(ENABLED),
    account,
    client,
    guard: createSubmissionGuard({ secret: "test-secret" }),
    now: () => new Date("2026-08-10T09:00:00.000Z"),
    logger,
  });
  return { service, client, account, logger };
}

const ctx = { headers: new Headers(), userId: "user-1", requestId: "req-1" };

function publishRequest(
  overrides: Partial<OsmContributionPublishRequest> = {},
): OsmContributionPublishRequest {
  return {
    ref: REF,
    baseVersion: 4,
    changes: [{ field: "name", action: "set", value: "Café Zentral" }],
    locale: "en",
    idempotencyKey: UUID,
    evidence: { kind: "survey" },
    reviewRequested: false,
    comment: COMMENT,
    ...overrides,
  };
}

async function caught<T>(promise: Promise<T>): Promise<OsmContributionError> {
  const error = await promise.catch((e: unknown) => e);
  expect(isOsmContributionError(error)).toBe(true);
  return error as OsmContributionError;
}

beforeEach(() => {
  calls.length = 0;
});

describe("capabilities", () => {
  it("returns disabled without contacting OSM when the master flag is off", async () => {
    const { service, account } = makeService({ config: loadOsmConfig({}) });
    const capabilities = await service.getCapabilities(ctx);
    expect(capabilities.enabled).toBe(false);
    expect(account.load).not.toHaveBeenCalled();
  });

  it("returns disabled when OAuth is unconfigured even with the flag on", async () => {
    const { service, account } = makeService({
      config: loadOsmConfig({ OSM_CONTRIBUTIONS_ENABLED: "true" }),
    });
    expect((await service.getCapabilities(ctx)).enabled).toBe(false);
    expect(account.load).not.toHaveBeenCalled();
  });

  it("reports live account state when enabled", async () => {
    const { service } = makeService();
    const capabilities = await service.getCapabilities(ctx);
    expect(capabilities).toMatchObject({
      enabled: true,
      directEditingEnabled: true,
      linked: true,
      canWriteApi: true,
      contributorTermsAgreed: true,
    });
    expect(JSON.stringify(capabilities)).not.toContain(TOKEN);
  });
});

describe("context", () => {
  it("builds a browser-safe context from the live element", async () => {
    const { service } = makeService();
    const context = await service.getContext(ctx, REF, "en");
    expect(context).toMatchObject({
      ref: REF,
      version: 4,
      geometry: "point",
      center: { lat: 52.5, lon: 13.4 },
      displayName: "Café Central",
      changesetId: 800,
    });
    expect(context.elementUrl).toBe("https://www.openstreetmap.org/node/12");
    expect(context.advancedEditorUrl).toContain("editor=id&node=12");
    expect(context.fields.map((f) => f.field)).toContain("name");
    // The complete live tag map never crosses the boundary.
    expect(JSON.stringify(context)).not.toContain("openmapx:unknown");
  });

  it("infers way geometry conservatively and fetches a centre from /full", async () => {
    const closedWay: OsmElement = {
      type: "way",
      id: 42,
      version: 2,
      nodes: [1, 2, 3, 1],
      tags: { amenity: "cafe", name: "Café" },
    };
    const client = makeClient({
      getElement: vi.fn(async () => closedWay),
      getFullElement: vi.fn(async () => ({
        primary: closedWay,
        nodes: [
          { id: 1, lat: 52.0, lon: 13.0 },
          { id: 2, lat: 52.2, lon: 13.4 },
          { id: 3, lat: 52.4, lon: 13.2 },
        ],
      })),
    });
    const { service } = makeService({ client });
    const context = await service.getContext(ctx, { type: "way", id: 42 }, "en");
    expect(context.geometry).toBe("area");
    expect(context.center).toEqual({ lat: 52.2, lon: 13.2 });
  });

  it("reports unknown geometry for a closed way whose semantics are unprovable", async () => {
    const closedWay: OsmElement = {
      type: "way",
      id: 42,
      version: 2,
      nodes: [1, 2, 1],
      tags: { building: "yes" },
    };
    const client = makeClient({
      getElement: vi.fn(async () => closedWay),
      getFullElement: vi.fn(async () => ({ primary: closedWay, nodes: [] })),
    });
    const { service } = makeService({ client });
    const context = await service.getContext(ctx, { type: "way", id: 42 }, "en");
    expect(context.geometry).toBe("unknown");
    expect(context.center).toBeNull();
    expect(context.fields.find((f) => f.field === "category")?.enabled).toBe(false);
  });

  it("treats an open way as a line", async () => {
    const openWay: OsmElement = {
      type: "way",
      id: 42,
      version: 2,
      nodes: [1, 2, 3],
      tags: { highway: "residential" },
    };
    const client = makeClient({
      getElement: vi.fn(async () => openWay),
      getFullElement: vi.fn(async () => ({ primary: openWay, nodes: [] })),
    });
    const { service } = makeService({ client });
    expect((await service.getContext(ctx, { type: "way", id: 42 }, "en")).geometry).toBe("line");
  });

  it("maps upstream 404 and 410 to element errors", async () => {
    for (const [status, code] of [
      [404, "ELEMENT_NOT_FOUND"],
      [410, "ELEMENT_DELETED"],
    ] as const) {
      const client = makeClient({
        getElement: vi.fn(async () => {
          throw new OsmUpstreamError({ status, operation: "context", reason: "x" });
        }),
      });
      const { service } = makeService({ client });
      const error = await caught(service.getContext(ctx, REF, "en"));
      expect(error.code).toBe(code);
    }
  });

  it("refuses when the master flag is off", async () => {
    const { service } = makeService({ config: loadOsmConfig({}) });
    expect((await caught(service.getContext(ctx, REF, "en"))).code).toBe("FEATURE_DISABLED");
  });
});

describe("categories", () => {
  it("delegates to the bounded preset search and clamps input", async () => {
    const { service } = makeService();
    const results = await service.suggestCategories(ctx, {
      type: "node",
      id: 12,
      geometry: "point",
      locale: "en",
      q: "restaurant",
      limit: 500,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(20);
    expect(results.map((r) => r.presetId)).toContain("amenity/restaurant");
    expect(JSON.stringify(results)).not.toContain('amenity":');
  });
});

describe("preview", () => {
  it("returns semantic and exact diffs without writing anything", async () => {
    const { service, client } = makeService();
    const preview = await service.preview(ctx, publishRequest());
    expect(preview.tagDiff.replace).toEqual([
      { key: "name", from: "Café Central", to: "Café Zentral" },
    ]);
    expect(client.createChangeset).not.toHaveBeenCalled();
    expect(client.updateElement).not.toHaveBeenCalled();
  });

  it("rejects a stale base version", async () => {
    const { service } = makeService();
    const error = await caught(service.preview(ctx, publishRequest({ baseVersion: 3 })));
    expect(error.code).toBe("VERSION_CONFLICT");
    expect(error.context?.version).toBe(4);
  });
});

describe("publish ordering and success", () => {
  it("validates and version-checks before creating a changeset", async () => {
    const { service } = makeService();
    await service.publish(ctx, publishRequest());
    expect(calls).toEqual(["getElement", "createChangeset", "updateElement", "closeChangeset"]);
  });

  it("returns public result links", async () => {
    const { service } = makeService();
    await expect(service.publish(ctx, publishRequest())).resolves.toEqual({
      ref: REF,
      version: 5,
      changesetId: 77,
      changesetUrl: "https://www.openstreetmap.org/changeset/77",
      elementUrl: "https://www.openstreetmap.org/node/12",
      publishedAt: "2026-08-10T09:00:00.000Z",
    });
  });

  it("builds changeset tags from the person's own input and no bot markers", async () => {
    const { service, client } = makeService();
    await service.publish(
      ctx,
      publishRequest({ reviewRequested: true, evidence: { kind: "officialWebsite" } }),
    );
    expect(client.createChangeset).toHaveBeenCalledWith(
      {
        comment: COMMENT,
        created_by: "OpenMapX 1.0",
        locale: "en",
        source: "official website",
        review_requested: "yes",
      },
      TOKEN,
    );
  });

  it("maps every evidence kind to a public source value", async () => {
    for (const [evidence, source] of [
      [{ kind: "survey" }, "survey"],
      [{ kind: "signage" }, "survey"],
      [{ kind: "officialWebsite" }, "official website"],
      [{ kind: "otherCompatible", detail: "City open data" }, "City open data"],
    ] as const) {
      const { service, client } = makeService();
      await service.publish(ctx, publishRequest({ evidence, idempotencyKey: UUID }));
      expect((client.createChangeset as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject(
        { source },
      );
    }
  });

  it("sends exactly one element update", async () => {
    const { service, client } = makeService();
    await service.publish(ctx, publishRequest());
    expect(client.updateElement).toHaveBeenCalledTimes(1);
  });
});

describe("publish gating", () => {
  it("honors the direct-editing kill switch without converting to a note", async () => {
    const { service, client } = makeService({
      config: loadOsmConfig({ ...ENABLED, OSM_DIRECT_EDITING_ENABLED: "false" }),
    });
    const error = await caught(service.publish(ctx, publishRequest()));
    expect(error.code).toBe("DIRECT_EDITING_DISABLED");
    expect(client.createNote).not.toHaveBeenCalled();
    expect(client.createChangeset).not.toHaveBeenCalled();
  });

  it("refuses without a linked account, scope, terms or with an active block", async () => {
    const states: Array<[OsmAccountState, string]> = [
      [{ status: "not_linked" }, "OSM_ACCOUNT_NOT_LINKED"],
      [{ status: "reauthorization_required" }, "OSM_REAUTHORIZATION_REQUIRED"],
      [
        { ...linkedState, permissions: { allowWriteApi: false, allowWriteNotes: true } },
        "OSM_REAUTHORIZATION_REQUIRED",
      ],
      [
        { ...linkedState, user: { ...linkedState.user, contributorTermsAgreed: false } },
        "CONTRIBUTOR_TERMS_REQUIRED",
      ],
      [{ ...linkedState, user: { ...linkedState.user, activeBlock: true } }, "OSM_ACCOUNT_BLOCKED"],
    ];
    for (const [state, code] of states) {
      const { service, client } = makeService({ state });
      expect((await caught(service.publish(ctx, publishRequest()))).code).toBe(code);
      expect(client.createChangeset).not.toHaveBeenCalled();
    }
  });

  it("returns a fresh context on a live version conflict", async () => {
    const client = makeClient({ getElement: vi.fn(async () => baseNode({ version: 6 })) });
    const { service } = makeService({ client });
    const error = await caught(service.publish(ctx, publishRequest()));
    expect(error.code).toBe("VERSION_CONFLICT");
    expect(error.context?.version).toBe(6);
    expect(client.createChangeset).not.toHaveBeenCalled();
  });
});

describe("idempotency and concurrency", () => {
  it("replays the original success for a repeated idempotency key", async () => {
    const { service, client } = makeService();
    const first = await service.publish(ctx, publishRequest());
    const second = await service.publish(ctx, publishRequest());
    expect(second).toEqual(first);
    expect(client.updateElement).toHaveBeenCalledTimes(1);
  });

  it("reports a concurrent submission for a second key on the same element", async () => {
    let release: (() => void) | undefined;
    const client = makeClient({
      createChangeset: vi.fn(
        () =>
          new Promise<number>((resolve) => {
            release = () => resolve(77);
          }),
      ),
    });
    const { service } = makeService({ client });
    const pending = service.publish(ctx, publishRequest());
    await vi.waitFor(() => expect(release).toBeDefined());
    const error = await caught(service.publish(ctx, publishRequest({ idempotencyKey: UUID_2 })));
    expect(error.code).toBe("SUBMISSION_IN_PROGRESS");
    release?.();
    await pending;
  });
});

describe("changeset lifecycle", () => {
  it("never updates or closes when creation definitively fails", async () => {
    const client = makeClient({
      createChangeset: trace("createChangeset", async (): Promise<number> => {
        throw new OsmUpstreamError({ status: 403, operation: "publish", reason: "x" });
      }),
    });
    const { service } = makeService({ client });
    await caught(service.publish(ctx, publishRequest()));
    expect(calls).toEqual(["getElement", "createChangeset"]);
  });

  it("returns an ambiguous result and no retry when creation may have reached OSM", async () => {
    const client = makeClient({
      createChangeset: vi.fn(async () => {
        throw new OsmUpstreamError({
          status: null,
          operation: "publish",
          requestMayHaveBeenApplied: true,
          reason: "x",
        });
      }),
    });
    const { service } = makeService({ client });
    const error = await caught(service.publish(ctx, publishRequest()));
    expect(error.code).toBe("AMBIGUOUS_RESULT");
    expect(error.inspect).toBeUndefined();
    expect(client.createChangeset).toHaveBeenCalledTimes(1);
    expect(client.updateElement).not.toHaveBeenCalled();
    // The terminal outcome replays instead of retrying.
    expect((await caught(service.publish(ctx, publishRequest()))).code).toBe("AMBIGUOUS_RESULT");
    expect(client.createChangeset).toHaveBeenCalledTimes(1);
  });

  it("closes the changeset even when the update fails", async () => {
    const client = makeClient({
      updateElement: trace("updateElement", async (): Promise<number> => {
        throw new OsmUpstreamError({ status: 400, operation: "publish", reason: "x" });
      }),
    });
    const { service } = makeService({ client });
    await caught(service.publish(ctx, publishRequest()));
    expect(calls).toEqual(["getElement", "createChangeset", "updateElement", "closeChangeset"]);
  });

  it("treats an already-closed changeset as closed and retries only a confirmed-open one", async () => {
    let closeAttempts = 0;
    const client = makeClient({
      closeChangeset: vi.fn(async () => {
        closeAttempts += 1;
        if (closeAttempts === 1) {
          throw new OsmUpstreamError({
            status: null,
            operation: "close_changeset",
            requestMayHaveBeenApplied: true,
            reason: "x",
          });
        }
      }),
      getChangeset: vi.fn(async () => ({ id: 77, open: true })),
    });
    const { service } = makeService({ client });
    await expect(service.publish(ctx, publishRequest())).resolves.toMatchObject({
      changesetId: 77,
    });
    expect(closeAttempts).toBe(2);
  });

  it("does not turn a confirmed update into a failure when close cannot be confirmed", async () => {
    const client = makeClient({
      closeChangeset: vi.fn(async () => {
        throw new OsmUpstreamError({ status: 500, operation: "close_changeset", reason: "x" });
      }),
      getChangeset: vi.fn(async () => {
        throw new OsmUpstreamError({ status: 500, operation: "reconcile", reason: "x" });
      }),
    });
    const { service } = makeService({ client });
    await expect(service.publish(ctx, publishRequest())).resolves.toMatchObject({ version: 5 });
  });
});

describe("post-send reconciliation", () => {
  function lostUpdate(after: OsmElement, changesetOpen = false) {
    let reads = 0;
    return makeClient({
      getElement: vi.fn(async () => {
        reads += 1;
        return reads === 1 ? baseNode() : after;
      }),
      updateElement: vi.fn(async () => {
        throw new OsmUpstreamError({
          status: null,
          operation: "publish",
          requestMayHaveBeenApplied: true,
          reason: "x",
        });
      }),
      getChangeset: vi.fn(async () => ({ id: 77, open: changesetOpen })),
    });
  }

  it("confirms success when the element carries the expected result", async () => {
    const applied = baseNode({
      version: 5,
      changeset: 77,
      tags: { amenity: "cafe", name: "Café Zentral", "openmapx:unknown": "keep" },
    });
    const { service } = makeService({ client: lostUpdate(applied) });
    await expect(service.publish(ctx, publishRequest())).resolves.toMatchObject({
      version: 5,
      changesetId: 77,
    });
  });

  it("reports a safe failure when the element is unchanged", async () => {
    const { service } = makeService({ client: lostUpdate(baseNode()) });
    const error = await caught(service.publish(ctx, publishRequest()));
    expect(error.code).toBe("OSM_UNAVAILABLE");
  });

  it("reports an ambiguous result with trusted links for any other state", async () => {
    const other = baseNode({ version: 6, changeset: 999, tags: { amenity: "bar" } });
    const client = lostUpdate(other);
    const { service } = makeService({ client });
    const error = await caught(service.publish(ctx, publishRequest()));
    expect(error.code).toBe("AMBIGUOUS_RESULT");
    expect(error.inspect).toEqual({
      changesetUrl: "https://www.openstreetmap.org/changeset/77",
      elementUrl: "https://www.openstreetmap.org/node/12",
    });
    expect(client.updateElement).toHaveBeenCalledTimes(1);
  });
});

describe("upstream error mapping", () => {
  it.each([
    [409, "VERSION_CONFLICT"],
    [412, "VERSION_CONFLICT"],
    [404, "ELEMENT_NOT_FOUND"],
    [410, "ELEMENT_DELETED"],
    [429, "RATE_LIMITED"],
    [500, "OSM_UNAVAILABLE"],
    [400, "UPSTREAM_INVALID"],
  ])("maps an update %i to %s", async (status, code) => {
    const client = makeClient({
      updateElement: vi.fn(async () => {
        throw new OsmUpstreamError({
          status,
          operation: "publish",
          retryAfterSeconds: status === 429 ? 30 : null,
          reason: "x",
        });
      }),
    });
    const { service } = makeService({ client });
    const error = await caught(service.publish(ctx, publishRequest()));
    expect(error.code).toBe(code);
    if (status === 429) expect(error.retryAfterSeconds).toBe(30);
  });

  it("maps malformed upstream data to UPSTREAM_INVALID", async () => {
    const client = makeClient({
      getElement: vi.fn(async () => {
        throw new OsmUpstreamError({
          status: null,
          operation: "context",
          reason: "upstream element failed validation",
        });
      }),
    });
    const { service } = makeService({ client });
    expect((await caught(service.getContext(ctx, REF, "en"))).code).toBe("UPSTREAM_INVALID");
  });
});

describe("notes", () => {
  it("re-reads the element and uses a server-computed centre", async () => {
    const { service, client } = makeService();
    await expect(
      service.createNote(ctx, { ref: REF, text: NOTE_TEXT, idempotencyKey: UUID }),
    ).resolves.toEqual({
      noteId: 9,
      noteUrl: "https://www.openstreetmap.org/note/9",
      status: "open",
    });
    expect(client.getElement).toHaveBeenCalledWith(REF);
    expect(client.createNote).toHaveBeenCalledWith(
      { lat: 52.5, lon: 13.4, text: NOTE_TEXT },
      TOKEN,
    );
  });

  it("refuses without the write_notes permission", async () => {
    const { service, client } = makeService({
      state: { ...linkedState, permissions: { allowWriteApi: true, allowWriteNotes: false } },
    });
    expect(
      (await caught(service.createNote(ctx, { ref: REF, text: NOTE_TEXT, idempotencyKey: UUID })))
        .code,
    ).toBe("OSM_REAUTHORIZATION_REQUIRED");
    expect(client.createNote).not.toHaveBeenCalled();
  });

  it("refuses when no reliable centre can be computed", async () => {
    const way: OsmElement = { type: "way", id: 42, version: 1, nodes: [1, 2], tags: {} };
    const client = makeClient({
      getElement: vi.fn(async () => way),
      getFullElement: vi.fn(async () => ({ primary: way, nodes: [] })),
    });
    const { service } = makeService({ client });
    const error = await caught(
      service.createNote(ctx, {
        ref: { type: "way", id: 42 },
        text: NOTE_TEXT,
        idempotencyKey: UUID,
      }),
    );
    expect(error.code).toBe("ELEMENT_NOT_ELIGIBLE");
    expect(client.createNote).not.toHaveBeenCalled();
  });

  it("is still allowed when direct editing is switched off", async () => {
    const { service, client } = makeService({
      config: loadOsmConfig({ ...ENABLED, OSM_DIRECT_EDITING_ENABLED: "false" }),
    });
    await service.createNote(ctx, { ref: REF, text: NOTE_TEXT, idempotencyKey: UUID });
    expect(client.createNote).toHaveBeenCalledTimes(1);
  });

  it("replays a duplicate submission rather than creating a second note", async () => {
    const { service, client } = makeService();
    const first = await service.createNote(ctx, {
      ref: REF,
      text: NOTE_TEXT,
      idempotencyKey: UUID,
    });
    const second = await service.createNote(ctx, {
      ref: REF,
      text: NOTE_TEXT,
      idempotencyKey: UUID,
    });
    expect(second).toEqual(first);
    expect(client.createNote).toHaveBeenCalledTimes(1);
  });

  it("never creates a note as a fallback from a failed publish", async () => {
    const client = makeClient({
      updateElement: vi.fn(async () => {
        throw new OsmUpstreamError({ status: 500, operation: "publish", reason: "x" });
      }),
    });
    const { service } = makeService({ client });
    await caught(service.publish(ctx, publishRequest()));
    expect(client.createNote).not.toHaveBeenCalled();
  });
});

describe("log hygiene", () => {
  it("logs only closed operation, status and duration", async () => {
    const logger = testLogger();
    const { service } = makeService({ logger });
    await service.publish(ctx, publishRequest());
    const serialized = JSON.stringify([
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls,
    ]);
    for (const sentinel of [
      TOKEN,
      COMMENT,
      "Café Central",
      "Café Zentral",
      "openmapx:unknown",
      "52.5",
      "13.4",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(serialized).toContain("publish");
  });

  it("keeps upstream detail out of every returned error", async () => {
    const client = makeClient({
      updateElement: vi.fn(async () => {
        throw new OsmUpstreamError({
          status: 403,
          operation: "publish",
          reason: `blocked because ${TOKEN}`,
        });
      }),
    });
    const { service } = makeService({ client });
    const error = await caught(service.publish(ctx, publishRequest()));
    expect(error.message).not.toContain(TOKEN);
    expect(JSON.stringify(error.inspect ?? {})).not.toContain(TOKEN);
  });
});
