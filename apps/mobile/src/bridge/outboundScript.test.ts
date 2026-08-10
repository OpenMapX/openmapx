import { encodeBase64, encodeBase64Url, utf8Bytes } from "./base64";
import { BASE64_LITERAL, buildChannelBootstrapScript, buildOutboundScript } from "./outboundScript";

/** Extracts the one substituted value from the generated program. */
function base64Literal(script: string): string {
  const match = script.match(/atob\("([^"]*)"\)/);
  if (!match) throw new Error("generated script has no base64 literal");
  return match[1];
}

describe("base64", () => {
  it("round-trips ASCII against the platform decoder", () => {
    const encoded = encodeBase64(utf8Bytes("hello world"));

    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe("hello world");
  });

  it("round-trips multi-byte text", () => {
    const text = "Höchstädter Straße · 東京駅 · 🚉";
    const encoded = encodeBase64(utf8Bytes(text));

    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(text);
  });

  it("pads to a multiple of four", () => {
    for (const text of ["a", "ab", "abc", "abcd"]) {
      expect(encodeBase64(utf8Bytes(text)).length % 4).toBe(0);
    }
  });

  it("emits url-safe output without padding", () => {
    const bytes = new Uint8Array([251, 255, 190, 0, 16]);

    const encoded = encodeBase64Url(bytes);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeBase64(bytes)).toMatch(/[+/]/);
  });
});

describe("buildOutboundScript", () => {
  const hostile = {
    type: "snapshot.update" as const,
    payload: {
      quote: '"; alert(1); //',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the point of the fixture is that a template substitution survives as data
      backtick: "`${process}`",
      closer: "</script><script>alert(2)</script>",
      separators: "line\u2028paragraph\u2029",
      newline: "a\nb\r\nc",
      backslash: "c:\\path\\to",
      unicode: "Straße 東京 🚉",
    },
  };

  it("puts the payload only inside a base64 literal", () => {
    const script = buildOutboundScript(hostile);

    expect(base64Literal(script)).toMatch(BASE64_LITERAL);
  });

  it("never reproduces a hostile substring in the generated program", () => {
    const script = buildOutboundScript(hostile);
    const literal = base64Literal(script);
    const program = script.replace(literal, "");

    for (const value of Object.values(hostile.payload)) {
      expect(program).not.toContain(value);
    }
    expect(program).not.toContain("alert(");
    expect(program).not.toContain("</script>");
  });

  it("keeps the surrounding program byte-identical across payloads", () => {
    const first = buildOutboundScript({ a: 1 });
    const second = buildOutboundScript(hostile);

    expect(first.replace(base64Literal(first), "")).toBe(second.replace(base64Literal(second), ""));
  });

  it("encodes a payload the page can decode back", () => {
    const script = buildOutboundScript(hostile);

    const decoded = JSON.parse(Buffer.from(base64Literal(script), "base64").toString("utf8"));

    expect(decoded).toEqual(hostile);
  });

  it("dispatches an event rather than assigning a global", () => {
    const script = buildOutboundScript({ a: 1 });

    expect(script).toContain('new CustomEvent("openmapx:native"');
    expect(script).toContain("window.dispatchEvent");
    // No generic capability is handed to the page along the way.
    expect(script).not.toContain("eval");
    expect(script).not.toContain("Function(");
  });

  it("refuses a value that cannot be serialised", () => {
    expect(() => buildOutboundScript(() => undefined)).toThrow(/serialisable/);
  });
});

describe("buildChannelBootstrapScript", () => {
  it("publishes a frozen, non-writable nonce and nothing else", () => {
    const script = buildChannelBootstrapScript("abcDEF-_123");

    expect(script).toContain("configurable:false");
    expect(script).toContain("writable:false");
    expect(script).toContain("Object.freeze({nonce:");
    expect(script).toContain('"abcDEF-_123"');
  });

  it("exposes no capability, origin override or token", () => {
    const script = buildChannelBootstrapScript("abcDEF");

    for (const forbidden of ["fetch", "eval", "token", "origin", "invoke", "postMessage("]) {
      expect(script).not.toContain(forbidden);
    }
  });

  it("refuses a nonce that is not base64url", () => {
    for (const nonce of ['a";alert(1);//', "a b", "a=", "a+b", "", "a/b"]) {
      expect(() => buildChannelBootstrapScript(nonce)).toThrow(/base64url/);
    }
  });
});
