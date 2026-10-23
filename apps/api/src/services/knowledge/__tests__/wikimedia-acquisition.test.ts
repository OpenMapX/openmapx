import { createOsmImagePhotoProvider, searchHeroPhotos } from "@integrations/photos/orchestrator";
import { wikimediaProvider } from "@integrations/photos-wikimedia/provider.js";
import {
  createRequestJsonScope,
  type KnowledgeProvider,
  type KnowledgeResult,
  type Place,
} from "@openmapx/core";
import { withKnowledgeContributors } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, streamedJsonResponse } from "../../../test/streamed-response.js";

// Real wikidata/wikipedia/photos-wikimedia providers, the real Commons parser
// and the real getPlaceKnowledge/searchHeroPhotos orchestrators run here. Only
// the network boundary (global fetch) and the host registry/policy are
// synthetic, so request counts reflect what an enrichment would send upstream.

const hosts = vi.hoisted(() => ({
  integrations: [] as Array<{ id: string; providers: Map<string, unknown[]> }>,
  gated: new Set<string>(),
}));

vi.mock("../../../integration-host.js", () => ({
  getIntegrationsByDomain: (domain: string) => (domain === "knowledge" ? hosts.integrations : []),
}));
vi.mock("../../data-use-policy.js", () => ({
  getGatedIntegrationIds: async () => hosts.gated,
}));

const FILE = "Synthetic place.jpg";
const ENTITY_URL_PART = "www.wikidata.org/w/api.php";
const SUMMARY_URL_PART = "en.wikipedia.org/api/rest_v1/page/summary/";
const COMMONS_URL_PART = "commons.wikimedia.org/w/api.php";

function commonsPage(title = `File:${FILE}`) {
  return {
    title,
    imageinfo: [
      {
        url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Synthetic_place.jpg",
        thumburl:
          "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Synthetic_place.jpg/800px-Synthetic_place.jpg",
        size: 2_000_000,
        width: 4000,
        height: 3000,
        mime: "image/jpeg",
        mediatype: "BITMAP",
        descriptionurl: "https://commons.wikimedia.org/wiki/File:Synthetic_place.jpg",
        extmetadata: {
          Artist: { value: '<a href="/wiki/User:Synth">Synthetic Author</a>' },
          LicenseShortName: { value: "CC BY-SA 4.0" },
          LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" },
          Attribution: { value: "Credit: Synthetic Author" },
          DateTimeOriginal: { value: "2022-07-01 12:00:00" },
        },
      },
    ],
  };
}

function commonsBody(title?: string) {
  return { query: { pages: { "1": commonsPage(title) } } };
}

function entityBody(qid = "Q123") {
  return {
    entities: {
      [qid]: {
        descriptions: { en: { value: "synthetic landmark" } },
        claims: {
          P18: [
            {
              rank: "normal",
              mainsnak: { snaktype: "value", datavalue: { type: "string", value: FILE } },
            },
          ],
        },
        sitelinks: { enwiki: { title: "Synthetic place" } },
      },
    },
  };
}

function summaryBody(file = "Synthetic_place.jpg") {
  return {
    description: "Synthetic summary description",
    extract: "A synthetic extract.",
    originalimage: {
      source: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${file}`,
      width: 100,
      height: 100,
    },
    content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Synthetic_place" } },
  };
}

type Responder = (url: string) => Response | Promise<Response>;

let requests: string[];
let responder: Responder;

const defaultResponder: Responder = (url) => {
  if (url.includes(ENTITY_URL_PART)) return streamedJsonResponse(entityBody());
  if (url.includes(SUMMARY_URL_PART)) return streamedJsonResponse(summaryBody());
  if (url.includes(COMMONS_URL_PART)) return streamedJsonResponse(commonsBody());
  return emptyResponse(404);
};

function count(part: string): number {
  return requests.filter((url) => url.includes(part)).length;
}

function counts() {
  return {
    entity: count(ENTITY_URL_PART),
    summary: count(SUMMARY_URL_PART),
    commons: count(COMMONS_URL_PART),
  };
}

function registerKnowledge(): void {
  // Distinct synthetic receipts so parity covers obligations, not only URLs.
  const { wikidataSource } = wikidata;
  const { wikipediaSource } = wikipedia;
  hosts.integrations = [
    {
      id: "knowledge-wikidata",
      providers: new Map([
        [
          "knowledge",
          [
            withKnowledgeContributors(wikidataSource as KnowledgeProvider, () => ({
              uniform: [{ sourceId: "wikidata", name: "Synthetic Wikidata receipt" }],
              overrides: {
                wikipediaExtract: [
                  { sourceId: "wikidata", name: "Synthetic Wikidata receipt" },
                  { sourceId: "wikipedia", name: "Synthetic Wikipedia receipt" },
                ],
              },
            })),
          ],
        ],
      ]),
    },
    {
      id: "knowledge-wikipedia",
      providers: new Map([
        [
          "knowledge",
          [
            withKnowledgeContributors(wikipediaSource as KnowledgeProvider, () => ({
              uniform: [{ sourceId: "wikipedia", name: "Synthetic Wikipedia receipt" }],
            })),
          ],
        ],
      ]),
    },
  ];
}

let wikidata: typeof import("@integrations/knowledge-wikidata/provider.js");
let wikipedia: typeof import("@integrations/knowledge-wikipedia/provider.js");
let knowledgeModule: typeof import("../index.js");

function place(overrides: Record<string, string> = {}): Place {
  return {
    id: "osm:node/1",
    primaryScheme: "osm",
    ids: { osm: "node/1" },
    name: "Synthetic place",
    address: "",
    coordinates: [13.4, 52.5],
    osmTags: {
      wikidata: "Q123",
      wikipedia: "en:Synthetic place",
      wikimedia_commons: `File:${FILE}`,
      ...overrides,
    },
  } as Place;
}

type Enrichment = {
  knowledge: KnowledgeResult;
  hero: Awaited<ReturnType<typeof searchHeroPhotos>>;
};

/** The two lookups enrichPlace starts together, optionally sharing one scope. */
async function enrichmentLookups(
  target: Place,
  scope?: ReturnType<typeof createRequestJsonScope>,
): Promise<Enrichment> {
  const [knowledge, hero] = await Promise.all([
    knowledgeModule.getPlaceKnowledge(target, "en", scope ? { jsonScope: scope } : undefined),
    searchHeroPhotos(
      target.osmTags as Record<string, string>,
      [wikimediaProvider],
      scope ? { getJson: scope.getJson } : undefined,
    ),
  ]);
  return { knowledge, hero };
}

beforeEach(async () => {
  requests = [];
  responder = defaultResponder;
  hosts.gated = new Set();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      requests.push(url);
      return responder(url);
    }),
  );
  wikidata = await import("@integrations/knowledge-wikidata/provider.js");
  wikipedia = await import("@integrations/knowledge-wikipedia/provider.js");
  knowledgeModule = await import("../index.js");
  registerKnowledge();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Wikimedia acquisition sharing within one enrichment", () => {
  it("characterises the unscoped fan-out: six requests for three distinct URLs", async () => {
    await enrichmentLookups(place());
    expect(counts()).toEqual({ entity: 1, summary: 2, commons: 3 });
    expect(new Set(requests).size).toBe(3);
  });

  it("shares identical summary and Commons JSON with identical outputs and receipts", async () => {
    const baseline = await enrichmentLookups(place());
    requests = [];

    const shared = await enrichmentLookups(place(), createRequestJsonScope());

    expect(counts()).toEqual({ entity: 1, summary: 1, commons: 1 });
    expect(shared).toEqual(baseline);
    // The assertions above would be vacuous on empty output.
    expect(shared.hero).toHaveLength(1);
    expect(shared.hero[0]?.author).toBe("Synthetic Author");
    expect(shared.knowledge.photos).toHaveLength(2);
    expect(shared.knowledge.photos?.[0]?.licensing).toBeDefined();
    expect(shared.hero[0]?.licensing).toEqual(shared.knowledge.photos?.[0]?.licensing);
    expect(shared.knowledge.photos?.[0]?.attributionText).toBe("Credit: Synthetic Author");
    expect(shared.knowledge.photos?.[0]?.pageUrl).toBe(
      "https://commons.wikimedia.org/wiki/File:Synthetic_place.jpg",
    );
    expect(shared.knowledge.wikipediaExtractSource).toEqual([
      "knowledge-wikidata",
      "knowledge-wikipedia",
    ]);
    expect(shared.knowledge.fieldContributors?.wikipediaExtract?.map((r) => r.sourceId)).toEqual([
      "wikidata",
      "wikipedia",
    ]);
  });

  it("reuses a response that settled before a later branch asked for it", async () => {
    const scope = createRequestJsonScope();
    const baseline = await enrichmentLookups(place());
    requests = [];

    const knowledge = await knowledgeModule.getPlaceKnowledge(place(), "en", { jsonScope: scope });
    expect(counts()).toEqual({ entity: 1, summary: 1, commons: 1 });
    const hero = await searchHeroPhotos(
      place().osmTags as Record<string, string>,
      [wikimediaProvider],
      { getJson: scope.getJson },
    );

    expect(counts()).toEqual({ entity: 1, summary: 1, commons: 1 });
    expect({ knowledge, hero }).toEqual(baseline);
  });

  it("does not share across separate enrichment-style calls", async () => {
    await enrichmentLookups(place(), createRequestJsonScope());
    await enrichmentLookups(place(), createRequestJsonScope());
    expect(counts()).toEqual({ entity: 2, summary: 2, commons: 2 });
  });

  it("keeps distinct title and file inputs separate", async () => {
    responder = (url) => {
      if (url.includes("page/summary/Other_page"))
        return streamedJsonResponse(summaryBody("Other_file.jpg"));
      if (url.includes("Other_file.jpg"))
        return streamedJsonResponse(commonsBody("File:Other file.jpg"));
      return defaultResponder(url);
    };
    await enrichmentLookups(
      place({ wikipedia: "en:Other page", wikimedia_commons: `File:${FILE}` }),
      createRequestJsonScope(),
    );
    const urls = requests.filter((url) => !url.includes(ENTITY_URL_PART));
    expect(new Set(urls).size).toBe(urls.length);
    expect(count("page/summary/Other_page")).toBe(1);
    expect(count("page/summary/Synthetic_place")).toBe(1);
    expect(count("Other_file.jpg")).toBe(1);
    expect(count("Synthetic_place.jpg")).toBe(1);
  });

  it("shares one raw failure among concurrent joiners and retries once it is no longer pending", async () => {
    const release = Promise.withResolvers<void>();
    let commonsCalls = 0;
    responder = async (url) => {
      if (url.includes(COMMONS_URL_PART)) {
        commonsCalls += 1;
        if (commonsCalls === 1) {
          await release.promise;
          return emptyResponse(503);
        }
      }
      return defaultResponder(url);
    };
    const scope = createRequestJsonScope();
    const getJson = vi.spyOn(scope, "getJson");
    const commonsInvocations = () =>
      getJson.mock.calls.filter(([url]) => url.includes(COMMONS_URL_PART)).length;
    const first = enrichmentLookups(place(), scope);
    // Hold the failure until every Commons consumer has asked the scope while one request is pending.
    await vi.waitFor(() => {
      expect(counts()).toEqual({ entity: 1, summary: 1, commons: 1 });
      expect(commonsInvocations()).toBe(3);
    });
    release.resolve();
    const failed = await first;

    // Non-strict consumers each keep their own empty fallback for the failure.
    expect(count(COMMONS_URL_PART)).toBe(1);
    expect(failed.hero).toEqual([]);
    expect(failed.knowledge.photos).toBeUndefined();

    const retried = await enrichmentLookups(place(), scope);
    expect(count(COMMONS_URL_PART)).toBe(2);
    expect(retried.hero).toHaveLength(1);
    expect(retried.knowledge.photos).toHaveLength(2);
  });

  describe("with a scope already holding the data", () => {
    let scope: ReturnType<typeof createRequestJsonScope>;

    beforeEach(async () => {
      scope = createRequestJsonScope();
      await knowledgeModule.getPlaceKnowledge(place(), "en", { jsonScope: scope });
      expect(counts()).toEqual({ entity: 1, summary: 1, commons: 1 });
      requests = [];
    });

    it("makes strict card-photo lookups bypass it", async () => {
      await knowledgeModule.getPlaceKnowledge(place(), "en", {
        cardPhoto: true,
        jsonScope: scope,
      });
      // card mode: wikidata entity + P18 Commons, wikipedia summary + Commons.
      expect(counts()).toEqual({ entity: 1, summary: 1, commons: 2 });
    });

    it("makes signalled lookups bypass it", async () => {
      await knowledgeModule.getPlaceKnowledge(place(), "en", {
        signal: new AbortController().signal,
        jsonScope: scope,
      });
      expect(counts()).toEqual({ entity: 1, summary: 2, commons: 2 });
    });

    it("lets an unsignalled lookup reuse it", async () => {
      await knowledgeModule.getPlaceKnowledge(place(), "en", { jsonScope: scope });
      expect(counts()).toEqual({ entity: 1, summary: 0, commons: 0 });
    });
  });

  it("still skips a policy-gated integration when the scope already holds its data", async () => {
    const wikipediaLookup = vi.spyOn(wikipedia.wikipediaSource, "lookup");
    registerKnowledge();
    const scope = createRequestJsonScope();
    await knowledgeModule.getPlaceKnowledge(place(), "en", { jsonScope: scope });
    expect(wikipediaLookup).toHaveBeenCalledTimes(1);
    requests = [];
    hosts.gated = new Set(["knowledge-wikipedia"]);

    const gated = await knowledgeModule.getPlaceKnowledge(place(), "en", { jsonScope: scope });

    // The allowed integration reuses the scope; the gated one never runs even
    // though the data it would need is already sitting in the scope.
    expect(wikipediaLookup).toHaveBeenCalledTimes(1);
    expect(counts()).toEqual({ entity: 1, summary: 0, commons: 0 });
    expect(gated.photos).toHaveLength(1); // wikidata only; wikipedia is gated
  });

  it("returns independent outputs to each consumer", async () => {
    const scope = createRequestJsonScope();
    const { knowledge, hero } = await enrichmentLookups(place(), scope);
    const knowledgePhoto = knowledge.photos?.[0];
    expect(knowledgePhoto).toBeDefined();
    expect(knowledgePhoto).not.toBe(hero[0]);
    if (knowledgePhoto) knowledgePhoto.author = "Mutated";
    expect(hero[0]?.author).toBe("Synthetic Author");
  });
});

describe("host-bound OSM image transport", () => {
  function osmProvider(disallowed: string[] = []) {
    const get = vi.fn(async () => commonsBody());
    const provider = createOsmImagePhotoProvider({
      http: { get } as never,
      getDisallowedSourceIds: async () => new Set(disallowed),
    });
    return { get, provider };
  }

  it("keeps using ctx.http even when a top-level scope getJson is supplied", async () => {
    const scope = createRequestJsonScope();
    const { get, provider } = osmProvider();
    const photos = await searchHeroPhotos({ image: `File:${FILE}` }, [provider], {
      getJson: scope.getJson,
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([]);
    expect(photos).toHaveLength(1);
  });

  it("makes no Commons request when the source is denied", async () => {
    const scope = createRequestJsonScope();
    const { get, provider } = osmProvider(["wikimedia-commons"]);
    const photos = await searchHeroPhotos({ image: `File:${FILE}` }, [provider], {
      getJson: scope.getJson,
    });
    expect(get).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(photos).toEqual([]);
  });
});
