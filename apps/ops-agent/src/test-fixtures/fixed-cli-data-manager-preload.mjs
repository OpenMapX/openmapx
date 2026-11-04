/** Named native HTTP boundary for the fixed CLI's owned Data Manager fixture. */
const target = new URL(process.env.OPENMAPX_TEST_FIXED_DM_TARGET);
if (
  target.protocol !== "http:" ||
  target.hostname !== "127.0.0.1" ||
  !target.port ||
  target.username ||
  target.password ||
  target.pathname !== "/" ||
  target.search ||
  target.hash
)
  throw Error("Expected the owned loopback Data Manager fixture");
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const source = new URL(input instanceof Request ? input.url : input);
  if (source.origin !== "http://data-manager:4000") return nativeFetch(input, init);
  const destination = new URL(target);
  destination.pathname = source.pathname;
  destination.search = source.search;
  return nativeFetch(
    input instanceof Request ? new Request(destination, input) : destination,
    init,
  );
};
