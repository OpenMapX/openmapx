import {
  coldStartUrl,
  type DeepLinkConfig,
  MAX_LINK_LENGTH,
  parseDeepLinkIntent,
} from "./deepLinkIntent";

const CONFIG: DeepLinkConfig = { webOrigin: "https://openmapx.com", scheme: "openmapx" };

const parse = (link: string) => parseDeepLinkIntent(link, CONFIG);

describe("parseDeepLinkIntent accepts", () => {
  it("the bare scheme link", () => {
    expect(parse("openmapx://")).toEqual({ kind: "map", query: "" });
  });

  it("a scheme link with a map query", () => {
    expect(parse("openmapx://?q=cafe&z=14")).toEqual({ kind: "map", query: "?q=cafe&z=14" });
  });

  it.each(["openmapx://navigation/active", "openmapx:///navigation/active"])(
    "the active-navigation intent spelled as %s",
    (link) => {
      // Both spellings occur in the wild depending on which OS built the URL.
      expect(parse(link)).toEqual({ kind: "active-navigation" });
    },
  );

  it("a verified HTTPS link on the compiled origin", () => {
    expect(parse("https://openmapx.com/?q=cafe")).toEqual({ kind: "map", query: "?q=cafe" });
  });

  it("the compiled origin with a trailing slash and no query", () => {
    expect(parse("https://openmapx.com/")).toEqual({ kind: "map", query: "" });
  });

  it("the HTTPS active-navigation path", () => {
    expect(parse("https://openmapx.com/navigation/active")).toEqual({ kind: "active-navigation" });
  });
});

describe("parseDeepLinkIntent refuses", () => {
  it.each([
    { label: "a different host", link: "https://evil.example/?q=cafe" },
    { label: "a different port on the right host", link: "https://openmapx.com:8443/?q=cafe" },
    { label: "plain HTTP on the right host", link: "http://openmapx.com/?q=cafe" },
    { label: "an unknown scheme", link: "openmapx-evil://?q=cafe" },
    { label: "a javascript URL", link: "javascript:alert(1)" },
    { label: "an iOS document URL", link: "file:///private/var/mobile/Documents/Inbox/route.gpx" },
    { label: "an Android content URI", link: "content://provider/route.gpx" },
    { label: "a data URL", link: "data:text/html,<script>x</script>" },
    { label: "not a URL at all", link: "just some text" },
    { label: "an empty string", link: "" },
  ])("$label", ({ link }) => {
    // A link that could point the app at a different backend is a link that
    // could point it at somebody else's.
    expect(parse(link)).toBeNull();
  });

  it.each([
    "https://user@openmapx.com/?q=cafe",
    "https://openmapx.com@evil.example/?q=cafe",
    "https://user:pass@openmapx.com/?q=cafe",
  ])("a link carrying userinfo: %s", (link) => {
    // The classic way to make one host look like another in a string a human
    // skims.
    expect(parse(link)).toBeNull();
  });

  it.each(["/api", "/api/integrations", "/mobile-auth", "/_next/static/x.js"])(
    "the reserved path %s",
    (path) => {
      expect(parse(`https://openmapx.com${path}`)).toBeNull();
    },
  );

  it("an unknown path on the right origin", () => {
    // Loading it would hand the WebView a screen nobody reviewed.
    expect(parse("https://openmapx.com/admin/secret")).toBeNull();
  });

  it("an unknown scheme path", () => {
    expect(parse("openmapx://navigation/somewhere-else")).toBeNull();
  });

  it("an oversize link", () => {
    expect(parse(`https://openmapx.com/?q=${"x".repeat(MAX_LINK_LENGTH)}`)).toBeNull();
  });

  it("an oversize query on an otherwise valid link", () => {
    expect(parse(`https://openmapx.com/?q=${"x".repeat(3_000)}`)).toBeNull();
  });

  it("a host that only matches after decoding", () => {
    expect(parse("https://openmapx%2ecom.evil.example/?q=cafe")).toBeNull();
  });
});

describe("deep link fragments", () => {
  it("drops a fragment rather than passing it on", () => {
    // It never reaches a server, and it is the part of a URL most likely to have
    // been appended by whoever passed the link along.
    expect(parse("https://openmapx.com/?q=cafe#/admin;run=1")).toEqual({
      kind: "map",
      query: "?q=cafe",
    });
  });

  it("treats a fragment-only link as a plain map link", () => {
    expect(parse("openmapx://#navigation/active")).toEqual({ kind: "map", query: "" });
  });
});

describe("coldStartUrl", () => {
  it("builds from the compiled origin, not the inbound link", () => {
    expect(coldStartUrl({ kind: "map", query: "?q=cafe" }, CONFIG)).toBe(
      "https://openmapx.com/?q=cafe",
    );
  });

  it("sends the active-navigation intent to the plain root", () => {
    // The screen is chosen by a bridge message once the page is up, not by a URL
    // the shell was handed.
    expect(coldStartUrl({ kind: "active-navigation" }, CONFIG)).toBe("https://openmapx.com/");
  });

  it("cannot be made to carry a host from the link", () => {
    const intent = parse("https://openmapx.com/?next=https://evil.example");

    expect(intent).not.toBeNull();
    expect(coldStartUrl(intent as never, CONFIG).startsWith("https://openmapx.com/")).toBe(true);
  });
});

describe("Android geo map intents", () => {
  const params = (raw: string) => {
    const intent = parse(raw);
    expect(intent?.kind).toBe("map");
    return new URLSearchParams(intent?.kind === "map" ? intent.query : "");
  };
  it("opens coordinates directly, preserving coordinate order and zoom", () => {
    const p = params("geo:48.137,11.575?z=13");
    expect(p.get("map")).toBe("48.137,11.575,13,0,0");
    expect(p.get("at")).toBe("48.137,11.575");
    expect(p.get("panel")).toBe("place");
  });
  it("uses coordinate queries rather than the 0,0 placeholder", () => {
    const p = params("geo:0,0?q=48.137,11.575(Marienplatz)");
    expect(p.get("at")).toBe("48.137,11.575");
    expect(p.get("name")).toBe("Marienplatz");
  });
  it("encodes address text as a single query without granting it URL authority", () => {
    const p = params("geo:0,0?q=Main+Street%26panel%3Dadmin%23fragment");
    expect(p.get("q")).toBe("Main Street&panel=admin#fragment");
    expect(p.has("panel")).toBe(false);
  });
  it("keeps numbered street addresses as text", () => {
    expect(params("geo:0,0?q=10,+Downing+Street").get("q")).toBe("10, Downing Street");
  });
  it("accepts WGS84 altitude/uncertainty without treating altitude as longitude", () => {
    expect(params("geo:48.137,11.575,10;crs=wgs84;u=5").get("at")).toBe("48.137,11.575");
  });
  it.each([
    "geo:",
    "geo:91,0",
    "geo:0,181",
    "geo:NaN,1",
    "geo:,1",
    "geo://evil/1,2",
    "geo:1,2;crs=other",
    "geo:0,0?q=91,0",
    `geo:0,0?q=${"a".repeat(3000)}`,
  ])("refuses malformed or unsupported input %s", (raw) => {
    expect(parse(raw)).toBeNull();
  });
});
