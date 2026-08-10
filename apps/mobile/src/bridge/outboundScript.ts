import { encodeBase64, utf8Bytes } from "./base64";

/**
 * Native-to-web delivery.
 *
 * `injectJavaScript` runs a *string* in the page, so any payload interpolated
 * into it is executable. Escaping is the wrong tool — a single missed case in a
 * stop name or an operator-supplied label becomes script injection into the
 * product origin. Instead the payload is base64-encoded into a literal that
 * cannot contain a quote, a backtick, `</script>`, `${`, or a line terminator,
 * and the surrounding program is fixed text this module never varies.
 */

/**
 * The decoder. Constant by construction: the only substitution is the base64
 * literal, and base64 has no character that can leave the string.
 *
 * Decoding goes through UTF-8 bytes rather than `atob` alone, because `atob`
 * yields one code unit per byte and would mangle every non-ASCII name.
 */
function decoderProgram(encoded: string): string {
  return `(function(){try{
var b=atob("${encoded}");
var u=new Uint8Array(b.length);
for(var i=0;i<b.length;i++){u[i]=b.charCodeAt(i);}
var d=JSON.parse(new TextDecoder("utf-8").decode(u));
window.dispatchEvent(new CustomEvent("openmapx:native",{detail:d}));
}catch(e){}})();true;`;
}

/** Matches exactly the alphabet the encoder can produce. */
export const BASE64_LITERAL = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Builds the script that hands one already-validated message to the page.
 *
 * The caller validates against the protocol schema first; this function assumes
 * the value is serialisable and makes no attempt to sanitise its contents.
 */
export function buildOutboundScript(message: unknown): string {
  const json = JSON.stringify(message);
  if (typeof json !== "string") {
    throw new Error("outbound bridge message must be JSON-serialisable");
  }
  const encoded = encodeBase64(utf8Bytes(json));
  return decoderProgram(encoded);
}

/**
 * The script injected before the document runs.
 *
 * It publishes the nonce and nothing else. Not a capability, not an origin
 * override, not a token, and not a callable native API: a page that has this
 * value can address the channel, but every command it sends is still validated,
 * versioned and state-checked on the native side.
 */
export function buildChannelBootstrapScript(nonce: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(nonce)) {
    throw new Error("channel nonce must be base64url");
  }
  return `(function(){try{
Object.defineProperty(window,"__OPENMAPX_MOBILE_CHANNEL__",{
configurable:false,enumerable:false,writable:false,
value:Object.freeze({nonce:"${nonce}"})});
}catch(e){}})();true;`;
}
