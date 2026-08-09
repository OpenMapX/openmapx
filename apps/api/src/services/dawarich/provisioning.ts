import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { serviceConfig } from "../../db/schema.js";
import { dockerComposeContainerEnv, dockerComposePs } from "../../utils/docker-compose.js";
import { resolveEffectiveServiceConfig } from "../service-config-resolver.js";
import { mergeServiceConfig } from "../service-config-writer.js";
import { getServiceRegistry } from "../service-registry.js";
import { getServiceSecretStrict, setServiceSecret } from "../service-secrets.js";

export const MANAGED_REFERENCE_ID = "openmapx-managed-services";
export const DAWARICH_SOFTWARE_ID = "openmapx-managed-dawarich";
export const DAWARICH_APP_SERVICE_ID = "dawarich-app";
export const DAWARICH_WORKER_SERVICE_ID = "dawarich-sidekiq";
export const DAWARICH_POSTGIS_SERVICE_ID = "dawarich-postgis";
export const DAWARICH_REDIS_SERVICE_ID = "dawarich-redis";
export const DAWARICH_VERSION = "1.10.3";
export const DAWARICH_PROVISIONING_GENERATION_KEY = "OPENMAPX_PROVISIONING_GENERATION";

const LOCK_NAME = "openmapx:managed-dawarich:provision";
const CALLBACK_PATH = "/users/auth/openid_connect/callback";
const OIDC_SCOPES = "openid profile email";
const APP_SECRET_KEYS = {
  database: "DATABASE_PASSWORD",
  rails: "SECRET_KEY_BASE",
  oidc: "OIDC_CLIENT_SECRET",
} as const;
const POSTGIS_PASSWORD_KEY = "POSTGRES_PASSWORD";
const SERVICE_IDS = [
  DAWARICH_APP_SERVICE_ID,
  DAWARICH_WORKER_SERVICE_ID,
  DAWARICH_POSTGIS_SERVICE_ID,
  DAWARICH_REDIS_SERVICE_ID,
] as const;

export type ProvisioningSecretState = "missing" | "consistent" | "conflict";

export interface ManagedDawarichProvisioningStatus {
  installed: boolean;
  selected: boolean;
  running: boolean;
  healthy: boolean;
  publicOrigin: string | null;
  oauthClient: {
    present: boolean;
    clientId: string | null;
    redirectUriMatches: boolean;
    settingsMatch: boolean;
  };
  secrets: {
    databasePassword: ProvisioningSecretState;
    secretKeyBase: ProvisioningSecretState;
    oidcClientSecret: ProvisioningSecretState;
  };
  configReady: boolean;
  readyToStart: boolean;
  needsApply: boolean;
}

export interface ManagedOAuthClient {
  client_id: string;
  client_secret?: string;
  client_name?: string;
  client_uri?: string;
  software_id?: string;
  software_version?: string;
  reference_id?: string;
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  scope?: string;
  require_pkce?: boolean;
  skip_consent?: boolean;
  enable_end_session?: boolean;
  public?: boolean;
  disabled?: boolean;
  type?: string;
  client_secret_expires_at?: number | string;
}

export interface ManagedDawarichRuntimeState {
  installed: boolean;
  selected: boolean;
  running: boolean;
  healthy: boolean;
}

export interface ManagedDawarichProvisioningDependencies {
  listClients(headers: Headers): Promise<ManagedOAuthClient[]>;
  createClient(headers: Headers, body: Record<string, unknown>): Promise<ManagedOAuthClient>;
  updateClient(
    headers: Headers,
    clientId: string,
    update: Partial<ManagedOAuthClient>,
  ): Promise<ManagedOAuthClient>;
  rotateClientSecret(headers: Headers, clientId: string): Promise<ManagedOAuthClient>;
  getSecret(serviceId: string, key: string): Promise<string | null>;
  setSecret(
    serviceId: string,
    key: string,
    value: string,
    updatedBy?: string | null,
  ): Promise<void>;
  getConfig(serviceId: string): Promise<Record<string, unknown>>;
  getEffectiveConfig(serviceId: string): Promise<Record<string, unknown>>;
  mergeConfig(serviceId: string, updates: Record<string, unknown>): Promise<void>;
  withLock<T>(work: () => Promise<T>): Promise<T>;
  randomBytes(size: number): Buffer;
  getRuntimeState(): Promise<ManagedDawarichRuntimeState>;
  getAppliedGeneration(serviceId: string): Promise<string | null>;
}

export interface ManagedDawarichProvisioningInput {
  headers: Headers;
  actorId: string;
  controllerDomain: string;
  publicHost?: string;
}

export interface ManagedDawarichProvisioningAudit {
  hostname: string;
  created: boolean;
  reconciled: boolean;
  rotated: boolean;
  outcome: "success";
}

export interface ManagedDawarichProvisioningResult {
  status: ManagedDawarichProvisioningStatus;
  audit: ManagedDawarichProvisioningAudit;
}

export type ManagedDawarichProvisioningErrorCode =
  | "DAWARICH_INVALID_PUBLIC_HOST"
  | "DAWARICH_OAUTH_CLIENT_CONFLICT"
  | "DAWARICH_DATABASE_SECRET_CONFLICT"
  | "DAWARICH_RAILS_SECRET_CONFLICT"
  | "DAWARICH_OIDC_SECRET_RECOVERY_REQUIRED"
  | "DAWARICH_PROVISIONING_FAILED";

export class ManagedDawarichProvisioningError extends Error {
  constructor(readonly code: ManagedDawarichProvisioningErrorCode) {
    super(code);
    this.name = "ManagedDawarichProvisioningError";
  }
}

interface ProvisioningContext {
  hostname: string;
  publicOrigin: string;
  callback: string;
  issuer: string;
}

interface SecretSnapshot {
  database: [string | null, string | null, string | null];
  rails: [string | null, string | null];
  oidc: [string | null, string | null];
}

function equalSecret(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function classifyCopies(values: Array<string | null>): ProvisioningSecretState {
  const present = values.filter((value): value is string => value !== null);
  if (present.length === 0) return "missing";
  if (present.length !== values.length) return "conflict";
  return present.every((value) => equalSecret(value, present[0] as string))
    ? "consistent"
    : "conflict";
}

export function validatePublicHostname(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    !/^[a-zA-Z0-9.-]+$/.test(value)
  ) {
    throw new ManagedDawarichProvisioningError("DAWARICH_INVALID_PUBLIC_HOST");
  }
  const withoutTrailingDot = value.endsWith(".") ? value.slice(0, -1) : value;
  const ascii = domainToASCII(withoutTrailingDot).toLowerCase();
  const labels = ascii.split(".");
  if (
    !ascii ||
    ascii.length > 253 ||
    labels.length < 2 ||
    isIP(ascii) !== 0 ||
    labels.some(
      (label) =>
        label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    throw new ManagedDawarichProvisioningError("DAWARICH_INVALID_PUBLIC_HOST");
  }
  return ascii;
}

function buildContext(input: ManagedDawarichProvisioningInput): ProvisioningContext {
  const controllerDomain = validatePublicHostname(input.controllerDomain);
  const hostname = validatePublicHostname(input.publicHost ?? `timeline.${controllerDomain}`);
  const publicOrigin = `https://${hostname}`;
  return {
    hostname,
    publicOrigin,
    callback: `${publicOrigin}${CALLBACK_PATH}`,
    issuer: `https://${controllerDomain}/api/auth`,
  };
}

async function resolveContext(
  input: ManagedDawarichProvisioningInput,
  dependencies: ManagedDawarichProvisioningDependencies,
): Promise<ProvisioningContext> {
  if (input.publicHost !== undefined) return buildContext(input);

  const app = await dependencies.getConfig(DAWARICH_APP_SERVICE_ID);
  const storedOrigin = app.APPLICATION_URL;
  if (typeof storedOrigin === "string") {
    try {
      const parsed = new URL(storedOrigin);
      if (
        parsed.protocol === "https:" &&
        !parsed.username &&
        !parsed.password &&
        !parsed.port &&
        parsed.pathname === "/" &&
        !parsed.search &&
        !parsed.hash &&
        parsed.origin === storedOrigin
      ) {
        return buildContext({ ...input, publicHost: parsed.hostname });
      }
    } catch {
      // Fall through to the deterministic timeline.<DOMAIN> default.
    }
  }
  return buildContext(input);
}

function desiredClient(context: ProvisioningContext): Record<string, unknown> {
  return {
    client_name: "OpenMapX Managed Dawarich",
    client_uri: context.publicOrigin,
    software_id: DAWARICH_SOFTWARE_ID,
    software_version: DAWARICH_VERSION,
    redirect_uris: [context.callback],
    token_endpoint_auth_method: "client_secret_basic",
    grant_types: ["authorization_code"],
    response_types: ["code"],
    scope: OIDC_SCOPES,
    require_pkce: true,
    skip_consent: true,
    enable_end_session: false,
    client_secret_expires_at: 0,
    type: "web",
  };
}

function sameArray(left: string[] | undefined, right: string[]): boolean {
  return (
    Array.isArray(left) && left.length === right.length && left.every((v, i) => v === right[i])
  );
}

function assertImmutableClientSecurity(client: ManagedOAuthClient): void {
  if (
    client.reference_id !== MANAGED_REFERENCE_ID ||
    client.token_endpoint_auth_method !== "client_secret_basic" ||
    client.require_pkce !== true ||
    client.public === true ||
    client.disabled === true
  ) {
    throw new ManagedDawarichProvisioningError("DAWARICH_OAUTH_CLIENT_CONFLICT");
  }
}

function mutableClientUpdates(
  client: ManagedOAuthClient,
  context: ProvisioningContext,
): Partial<ManagedOAuthClient> {
  const desired = desiredClient(context) as Partial<ManagedOAuthClient>;
  const updates: Partial<ManagedOAuthClient> = {};
  const scalarKeys = [
    "client_name",
    "client_uri",
    "software_id",
    "software_version",
    "scope",
    "skip_consent",
    "enable_end_session",
    "client_secret_expires_at",
    "type",
  ] as const;
  for (const key of scalarKeys) {
    if (
      key === "client_secret_expires_at" &&
      desired[key] === 0 &&
      (client[key] === undefined || client[key] === 0 || client[key] === "0")
    ) {
      // Better Auth persists its non-expiring `0` sentinel as no expiry and
      // therefore omits this field when the client is listed again.
      continue;
    }
    if (client[key] !== desired[key]) {
      (updates as Record<string, unknown>)[key] = desired[key];
    }
  }
  for (const key of ["redirect_uris", "grant_types", "response_types"] as const) {
    const expected = desired[key] as string[];
    if (!sameArray(client[key], expected)) {
      (updates as Record<string, unknown>)[key] = expected;
    }
  }
  return updates;
}

/**
 * Compare a redacted persisted client snapshot with the one managed client
 * contract. This intentionally accepts Better Auth's omitted non-expiring
 * sentinel, matching reconciliation, and never needs the client secret.
 */
export function managedOAuthClientMatchesExpected(
  client: ManagedOAuthClient,
  publicOrigin: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(publicOrigin);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== publicOrigin ||
    validatePublicHostname(parsed.hostname) !== parsed.hostname ||
    client.software_id !== DAWARICH_SOFTWARE_ID
  ) {
    return false;
  }
  try {
    assertImmutableClientSecurity(client);
  } catch {
    return false;
  }
  const context: ProvisioningContext = {
    hostname: parsed.hostname,
    publicOrigin,
    callback: `${publicOrigin}${CALLBACK_PATH}`,
    issuer: "",
  };
  return Object.keys(mutableClientUpdates(client, context)).length === 0;
}

async function readSecretSnapshot(
  dependencies: ManagedDawarichProvisioningDependencies,
): Promise<SecretSnapshot> {
  const values = await Promise.all([
    dependencies.getSecret(DAWARICH_POSTGIS_SERVICE_ID, POSTGIS_PASSWORD_KEY),
    dependencies.getSecret(DAWARICH_APP_SERVICE_ID, APP_SECRET_KEYS.database),
    dependencies.getSecret(DAWARICH_WORKER_SERVICE_ID, APP_SECRET_KEYS.database),
    dependencies.getSecret(DAWARICH_APP_SERVICE_ID, APP_SECRET_KEYS.rails),
    dependencies.getSecret(DAWARICH_WORKER_SERVICE_ID, APP_SECRET_KEYS.rails),
    dependencies.getSecret(DAWARICH_APP_SERVICE_ID, APP_SECRET_KEYS.oidc),
    dependencies.getSecret(DAWARICH_WORKER_SERVICE_ID, APP_SECRET_KEYS.oidc),
  ]);
  return {
    database: [values[0], values[1], values[2]],
    rails: [values[3], values[4]],
    oidc: [values[5], values[6]],
  };
}

async function writeSecretCopies(
  dependencies: ManagedDawarichProvisioningDependencies,
  copies: Array<[string, string, string]>,
  actorId: string,
): Promise<void> {
  for (const [serviceId, key, value] of copies) {
    await dependencies.setSecret(serviceId, key, value, actorId);
  }
}

function appConfig(
  context: ProvisioningContext,
  clientId: string,
  generation?: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    APPLICATION_HOSTS: context.hostname,
    APPLICATION_URL: context.publicOrigin,
    DOMAIN: context.hostname,
    APPLICATION_PROTOCOL: "https",
    TIME_ZONE: "UTC",
    REDIS_URL: "redis://dawarich-redis:6379",
    DATABASE_HOST: DAWARICH_POSTGIS_SERVICE_ID,
    DATABASE_PORT: "5432",
    DATABASE_USERNAME: "postgres",
    DATABASE_NAME: "dawarich_production",
    OIDC_ISSUER: context.issuer,
    OIDC_CLIENT_ID: clientId,
    OIDC_REDIRECT_URI: context.callback,
    OIDC_PROVIDER_NAME: "OpenMapX",
    OIDC_AUTO_REGISTER: "true",
    OIDC_PKCE_ENABLED: "true",
  };
  if (generation) config[DAWARICH_PROVISIONING_GENERATION_KEY] = generation;
  return config;
}

function validGeneration(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

function sharedGeneration(
  app: Record<string, unknown>,
  worker: Record<string, unknown>,
): string | null {
  const appGeneration = app[DAWARICH_PROVISIONING_GENERATION_KEY];
  const workerGeneration = worker[DAWARICH_PROVISIONING_GENERATION_KEY];
  return validGeneration(appGeneration) && workerGeneration === appGeneration
    ? appGeneration
    : null;
}

function hasExpectedConfig(
  current: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  return Object.entries(expected).every(([key, value]) => current[key] === value);
}

async function reconcileConfig(
  dependencies: ManagedDawarichProvisioningDependencies,
  context: ProvisioningContext,
  clientId: string,
  pendingGeneration: string | null = null,
): Promise<boolean> {
  const app = appConfig(context, clientId);
  const postgis = { POSTGRES_USER: "postgres", POSTGRES_DB: "dawarich_production" };
  const [currentApp, currentWorker, currentPostgis] = await Promise.all([
    dependencies.getConfig(DAWARICH_APP_SERVICE_ID),
    dependencies.getConfig(DAWARICH_WORKER_SERVICE_ID),
    dependencies.getConfig(DAWARICH_POSTGIS_SERVICE_ID),
  ]);
  const baseChanged =
    !hasExpectedConfig(currentApp, app) ||
    !hasExpectedConfig(currentWorker, app) ||
    !hasExpectedConfig(currentPostgis, postgis);
  const existingGeneration = sharedGeneration(currentApp, currentWorker);
  const generation =
    pendingGeneration ??
    (baseChanged || !existingGeneration
      ? dependencies.randomBytes(16).toString("hex")
      : existingGeneration);
  let changed = false;
  for (const [serviceId, current, expected] of [
    [DAWARICH_APP_SERVICE_ID, currentApp, appConfig(context, clientId, generation)],
    [DAWARICH_WORKER_SERVICE_ID, currentWorker, appConfig(context, clientId, generation)],
    [DAWARICH_POSTGIS_SERVICE_ID, currentPostgis, postgis],
  ] as const) {
    if (!hasExpectedConfig(current, expected)) {
      await dependencies.mergeConfig(serviceId, expected);
      changed = true;
    }
  }
  return changed;
}

/**
 * Establish the fail-closed apply boundary before mutating Better Auth or the
 * secret vault. Writes are deliberately ordered: if the worker write fails,
 * the raw generations disagree and every readiness path remains closed. The
 * previous generation is never restored after a partial write.
 */
async function stagePendingGeneration(
  dependencies: ManagedDawarichProvisioningDependencies,
): Promise<string> {
  const generation = dependencies.randomBytes(16).toString("hex");
  for (const serviceId of [DAWARICH_APP_SERVICE_ID, DAWARICH_WORKER_SERVICE_ID]) {
    await dependencies.mergeConfig(serviceId, {
      [DAWARICH_PROVISIONING_GENERATION_KEY]: generation,
    });
  }
  return generation;
}

async function matchingClients(
  dependencies: ManagedDawarichProvisioningDependencies,
  headers: Headers,
): Promise<ManagedOAuthClient[]> {
  const listed = await dependencies.listClients(headers);
  return listed.filter((client) => client.software_id === DAWARICH_SOFTWARE_ID);
}

async function buildStatus(
  dependencies: ManagedDawarichProvisioningDependencies,
  context: ProvisioningContext,
  clients: ManagedOAuthClient[],
): Promise<ManagedDawarichProvisioningStatus> {
  const runtime = await dependencies.getRuntimeState();
  const client = clients.length === 1 ? clients[0] : undefined;
  const [secrets, rawApp, rawWorker, app, worker, postgis, appliedApp, appliedWorker] =
    await Promise.all([
      readSecretSnapshot(dependencies),
      dependencies.getConfig(DAWARICH_APP_SERVICE_ID),
      dependencies.getConfig(DAWARICH_WORKER_SERVICE_ID),
      dependencies.getEffectiveConfig(DAWARICH_APP_SERVICE_ID),
      dependencies.getEffectiveConfig(DAWARICH_WORKER_SERVICE_ID),
      dependencies.getEffectiveConfig(DAWARICH_POSTGIS_SERVICE_ID),
      dependencies.getAppliedGeneration(DAWARICH_APP_SERVICE_ID),
      dependencies.getAppliedGeneration(DAWARICH_WORKER_SERVICE_ID),
    ]);
  const secretStates = {
    databasePassword: classifyCopies(secrets.database),
    secretKeyBase: classifyCopies(secrets.rails),
    oidcClientSecret: classifyCopies(secrets.oidc),
  };
  const redirectUriMatches = Boolean(client && sameArray(client.redirect_uris, [context.callback]));
  const settingsMatch = Boolean(
    client && Object.keys(mutableClientUpdates(client, context)).length === 0,
  );
  const desiredGeneration = sharedGeneration(rawApp, rawWorker);
  const configReady = Boolean(
    client &&
      desiredGeneration &&
      hasExpectedConfig(app, appConfig(context, client.client_id, desiredGeneration)) &&
      hasExpectedConfig(worker, appConfig(context, client.client_id, desiredGeneration)) &&
      hasExpectedConfig(postgis, {
        POSTGRES_USER: "postgres",
        POSTGRES_DB: "dawarich_production",
      }),
  );
  const readyToStart =
    runtime.installed &&
    Boolean(client) &&
    settingsMatch &&
    configReady &&
    Object.values(secretStates).every((state) => state === "consistent");
  const applied = Boolean(
    desiredGeneration && appliedApp === desiredGeneration && appliedWorker === desiredGeneration,
  );
  const hasGenerationState =
    validGeneration(rawApp[DAWARICH_PROVISIONING_GENERATION_KEY]) ||
    validGeneration(rawWorker[DAWARICH_PROVISIONING_GENERATION_KEY]);
  return {
    ...runtime,
    publicOrigin: client ? context.publicOrigin : null,
    oauthClient: {
      present: Boolean(client),
      clientId: client?.client_id ?? null,
      redirectUriMatches,
      settingsMatch,
    },
    secrets: secretStates,
    configReady,
    readyToStart,
    needsApply:
      hasGenerationState &&
      (!runtime.selected || !runtime.running || !desiredGeneration || !applied),
  };
}

async function storeOidcSecret(
  dependencies: ManagedDawarichProvisioningDependencies,
  secret: string | undefined,
  actorId: string,
): Promise<void> {
  if (!secret) {
    throw new ManagedDawarichProvisioningError("DAWARICH_OIDC_SECRET_RECOVERY_REQUIRED");
  }
  try {
    await writeSecretCopies(
      dependencies,
      [
        [DAWARICH_APP_SERVICE_ID, APP_SECRET_KEYS.oidc, secret],
        [DAWARICH_WORKER_SERVICE_ID, APP_SECRET_KEYS.oidc, secret],
      ],
      actorId,
    );
  } catch {
    throw new ManagedDawarichProvisioningError("DAWARICH_OIDC_SECRET_RECOVERY_REQUIRED");
  }
}

async function executeProvision(
  input: ManagedDawarichProvisioningInput,
  dependencies: ManagedDawarichProvisioningDependencies,
): Promise<ManagedDawarichProvisioningResult> {
  const context = await resolveContext(input, dependencies);
  let clients = await matchingClients(dependencies, input.headers);
  if (clients.length > 1) {
    throw new ManagedDawarichProvisioningError("DAWARICH_OAUTH_CLIENT_CONFLICT");
  }

  const initialSecrets = await readSecretSnapshot(dependencies);
  const databaseState = classifyCopies(initialSecrets.database);
  if (databaseState === "conflict") {
    throw new ManagedDawarichProvisioningError("DAWARICH_DATABASE_SECRET_CONFLICT");
  }
  const railsState = classifyCopies(initialSecrets.rails);
  const [initialAppRails, initialWorkerRails] = initialSecrets.rails;
  if (
    initialAppRails !== null &&
    initialWorkerRails !== null &&
    !equalSecret(initialAppRails, initialWorkerRails)
  ) {
    throw new ManagedDawarichProvisioningError("DAWARICH_RAILS_SECRET_CONFLICT");
  }

  let created = false;
  let reconciled = false;
  let rotated = false;
  let client = clients[0];
  let updates: Partial<ManagedOAuthClient> = {};
  if (client) {
    assertImmutableClientSecurity(client);
    updates = mutableClientUpdates(client, context);
  }
  const oidcRecoveryRequired = Boolean(
    client && classifyCopies(initialSecrets.oidc) !== "consistent",
  );
  const runtimeMutationRequired =
    !client ||
    Object.keys(updates).length > 0 ||
    databaseState === "missing" ||
    railsState !== "consistent" ||
    oidcRecoveryRequired;
  const pendingGeneration = runtimeMutationRequired
    ? await stagePendingGeneration(dependencies)
    : null;

  if (!client) {
    client = await dependencies.createClient(input.headers, desiredClient(context));
    created = true;
    await storeOidcSecret(dependencies, client.client_secret, input.actorId);
    clients = [{ ...client, client_secret: undefined }];
  } else if (Object.keys(updates).length > 0) {
    client = await dependencies.updateClient(input.headers, client.client_id, updates);
    reconciled = true;
    clients = [client];
  }

  if (databaseState === "missing") {
    const password = dependencies.randomBytes(32).toString("base64url");
    await writeSecretCopies(
      dependencies,
      [
        [DAWARICH_POSTGIS_SERVICE_ID, POSTGIS_PASSWORD_KEY, password],
        [DAWARICH_APP_SERVICE_ID, APP_SECRET_KEYS.database, password],
        [DAWARICH_WORKER_SERVICE_ID, APP_SECRET_KEYS.database, password],
      ],
      input.actorId,
    );
  }

  if (railsState === "missing") {
    const secret = dependencies.randomBytes(64).toString("hex");
    await writeSecretCopies(
      dependencies,
      [
        [DAWARICH_APP_SERVICE_ID, APP_SECRET_KEYS.rails, secret],
        [DAWARICH_WORKER_SERVICE_ID, APP_SECRET_KEYS.rails, secret],
      ],
      input.actorId,
    );
  } else {
    const [appRails, workerRails] = initialSecrets.rails;
    if (appRails && !workerRails) {
      await dependencies.setSecret(
        DAWARICH_WORKER_SERVICE_ID,
        APP_SECRET_KEYS.rails,
        appRails,
        input.actorId,
      );
    } else if (workerRails && !appRails) {
      await dependencies.setSecret(
        DAWARICH_APP_SERVICE_ID,
        APP_SECRET_KEYS.rails,
        workerRails,
        input.actorId,
      );
    }
  }

  if (!created && oidcRecoveryRequired) {
    const rotatedClient = await dependencies.rotateClientSecret(input.headers, client.client_id);
    rotated = true;
    await storeOidcSecret(dependencies, rotatedClient.client_secret, input.actorId);
  }

  await reconcileConfig(dependencies, context, client.client_id, pendingGeneration);
  const status = await buildStatus(dependencies, context, clients);
  return {
    status,
    audit: { hostname: context.hostname, created, reconciled, rotated, outcome: "success" },
  };
}

export async function provisionManagedDawarich(
  input: ManagedDawarichProvisioningInput,
  dependencies: ManagedDawarichProvisioningDependencies = defaultDependencies,
): Promise<ManagedDawarichProvisioningResult> {
  return dependencies.withLock(() => executeProvision(input, dependencies));
}

export async function inspectManagedDawarichProvisioning(
  input: ManagedDawarichProvisioningInput,
  dependencies: ManagedDawarichProvisioningDependencies = defaultDependencies,
): Promise<ManagedDawarichProvisioningStatus> {
  const context = await resolveContext(input, dependencies);
  const clients = await matchingClients(dependencies, input.headers);
  if (clients.length > 1) {
    throw new ManagedDawarichProvisioningError("DAWARICH_OAUTH_CLIENT_CONFLICT");
  }
  if (clients[0]) assertImmutableClientSecurity(clients[0]);
  return buildStatus(dependencies, context, clients);
}

export async function rotateManagedDawarichOidcSecret(
  input: ManagedDawarichProvisioningInput,
  dependencies: ManagedDawarichProvisioningDependencies = defaultDependencies,
): Promise<ManagedDawarichProvisioningResult> {
  return dependencies.withLock(async () => {
    const context = await resolveContext(input, dependencies);
    const clients = await matchingClients(dependencies, input.headers);
    if (clients.length !== 1) {
      throw new ManagedDawarichProvisioningError("DAWARICH_OAUTH_CLIENT_CONFLICT");
    }
    const client = clients[0] as ManagedOAuthClient;
    assertImmutableClientSecurity(client);
    const pendingGeneration = await stagePendingGeneration(dependencies);
    await reconcileConfig(dependencies, context, client.client_id, pendingGeneration);
    const rotated = await dependencies.rotateClientSecret(input.headers, client.client_id);
    await storeOidcSecret(dependencies, rotated.client_secret, input.actorId);
    const status = await buildStatus(dependencies, context, clients);
    return {
      status,
      audit: {
        hostname: context.hostname,
        created: false,
        reconciled: false,
        rotated: true,
        outcome: "success",
      },
    };
  });
}

async function readServiceConfig(serviceId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ config: serviceConfig.config })
    .from(serviceConfig)
    .where(eq(serviceConfig.serviceId, serviceId))
    .limit(1);
  return row?.config ?? {};
}

async function readEffectiveServiceConfig(serviceId: string): Promise<Record<string, unknown>> {
  const service = getServiceRegistry().get(serviceId);
  if (!service) return {};
  return resolveEffectiveServiceConfig({
    id: service.manifest.id,
    configSchema: service.manifest.configSchema,
    containerEnv: service.manifest.container.environment,
  });
}

export async function withDawarichProvisioningLock<T>(work: () => Promise<T>): Promise<T> {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${LOCK_NAME}))`);
    return work();
  });
}

async function getDefaultRuntimeState(): Promise<ManagedDawarichRuntimeState> {
  let registry: ReturnType<typeof getServiceRegistry>;
  try {
    registry = getServiceRegistry();
  } catch {
    return { installed: false, selected: false, running: false, healthy: false };
  }
  const installed = SERVICE_IDS.every((serviceId) => Boolean(registry.get(serviceId)));
  const selected = installed && SERVICE_IDS.every((serviceId) => registry.get(serviceId)?.enabled);
  const ps = await dockerComposePs();
  const running =
    selected &&
    SERVICE_IDS.every((serviceId) =>
      ps.some((entry) => entry.service === serviceId && entry.state === "running"),
    );
  let healthy = false;
  if (running) {
    const { managedDawarichResolver } = await import("./managed-resolver.js");
    healthy = (await managedDawarichResolver.resolve())?.healthy ?? false;
  }
  return { installed, selected, running, healthy };
}

const defaultDependencies: ManagedDawarichProvisioningDependencies = {
  async listClients(headers) {
    const { auth } = await import("../../auth.js");
    return ((await auth.api.getOAuthClients({ headers })) ?? []) as ManagedOAuthClient[];
  },
  async createClient(headers, body) {
    const { auth } = await import("../../auth.js");
    return auth.api.adminCreateOAuthClient({
      headers,
      body: body as never,
    }) as Promise<ManagedOAuthClient>;
  },
  async updateClient(headers, clientId, update) {
    const { auth } = await import("../../auth.js");
    return auth.api.adminUpdateOAuthClient({
      headers,
      body: { client_id: clientId, update: update as never },
    }) as Promise<ManagedOAuthClient>;
  },
  async rotateClientSecret(headers, clientId) {
    const { auth } = await import("../../auth.js");
    return auth.api.rotateClientSecret({
      headers,
      body: { client_id: clientId },
    }) as Promise<ManagedOAuthClient>;
  },
  getSecret: getServiceSecretStrict,
  setSecret: setServiceSecret,
  getConfig: readServiceConfig,
  getEffectiveConfig: readEffectiveServiceConfig,
  mergeConfig: mergeServiceConfig,
  withLock: withDawarichProvisioningLock,
  randomBytes: nodeRandomBytes,
  getRuntimeState: getDefaultRuntimeState,
  getAppliedGeneration: (serviceId) =>
    dockerComposeContainerEnv(serviceId, DAWARICH_PROVISIONING_GENERATION_KEY),
};
