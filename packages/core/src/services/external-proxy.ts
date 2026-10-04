// Deployments that already run a reverse proxy on the host (a shared Traefik
// with its own entrypoints, certificate resolvers and Docker network) route to
// OpenMapX through that proxy instead of the bundled `traefik` service.
//
// `OPENMAPX_PROXY_NETWORK` names the external proxy's Docker network. When it
// is set, the bundled `traefik` is never selected, every proxied first-party
// service also joins that network, and its Traefik labels name it as the
// network to route over. The labels' entrypoint and certificate resolver are
// rendered as Compose interpolations of `OPENMAPX_PROXY_ENTRYPOINT` and
// `OPENMAPX_PROXY_CERT_RESOLVER`, so every render path (CLI, admin panel,
// ops-agent) produces the same file and Compose resolves the values from
// `infra/docker/.env`. The bundled Traefik reads its routes from a generated
// file instead of labels, so the label values change nothing for it.

export const EXTERNAL_PROXY_NETWORK_ENV = "OPENMAPX_PROXY_NETWORK";

/** Compose network key the proxied services use for the external network. */
export const EXTERNAL_PROXY_NETWORK_KEY = "openmapx-proxy";

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: literal Docker Compose interpolation
export const PROXY_ENTRYPOINT_LABEL_VALUE = "${OPENMAPX_PROXY_ENTRYPOINT:-websecure}";
export const PROXY_CERT_RESOLVER_LABEL_VALUE = "${OPENMAPX_PROXY_CERT_RESOLVER:-letsencrypt}";
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: literal Docker Compose interpolation

const DOCKER_NETWORK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * The external proxy network from the environment, or undefined when the
 * bundled Traefik routes. Throws on a value Docker would reject, so a typo
 * fails the render instead of the later `docker compose up`.
 */
export function readExternalProxyNetwork(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): string | undefined {
  const value = env[EXTERNAL_PROXY_NETWORK_ENV]?.trim();
  if (!value) return undefined;
  if (!DOCKER_NETWORK_NAME.test(value)) {
    throw new Error(`${EXTERNAL_PROXY_NETWORK_ENV} is not a valid Docker network name`);
  }
  return value;
}
