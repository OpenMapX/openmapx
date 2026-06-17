import { describe, expect, it } from "vitest";
import { parseXmlDocument } from "../xml.js";

const BILLION_LAUGHS = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<lolz>&lol3;</lolz>`;

describe("parseXmlDocument entity guard", () => {
  it("rejects documents that declare XML entities", () => {
    expect(() => parseXmlDocument(BILLION_LAUGHS)).toThrow(/entity declarations are not allowed/i);
  });

  it("rejects entity declarations even when validation is disabled", () => {
    expect(() => parseXmlDocument(BILLION_LAUGHS, { validate: false })).toThrow(
      /entity declarations are not allowed/i,
    );
  });

  it("leaves numeric character references unchanged (parser config does not decode them)", () => {
    const doc = parseXmlDocument("<root><name>Z&#252;rich</name></root>") as Record<string, any>;
    expect(doc.root.name).toBe("Z&#252;rich");
  });

  it("still decodes predefined entities", () => {
    const doc = parseXmlDocument("<root><x>a &amp; b</x></root>") as Record<string, any>;
    expect(doc.root.x).toBe("a & b");
  });

  it("parses a normal feed-shaped document without a DOCTYPE", () => {
    const doc = parseXmlDocument(
      `<Siri version="2.0">
        <ServiceDelivery>
          <ResponseTimestamp>2026-06-17T00:00:00Z</ResponseTimestamp>
        </ServiceDelivery>
      </Siri>`,
    ) as Record<string, any>;
    expect(doc.Siri.ServiceDelivery.ResponseTimestamp).toBe("2026-06-17T00:00:00Z");
    expect(doc.Siri["@_version"]).toBe("2.0");
  });
});
