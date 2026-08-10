/**
 * Internal server types for the OSM contribution boundary.
 *
 * These never cross the browser boundary: `@openmapx/core`'s schemas own the
 * public contract. Everything here models the upstream OSM representation
 * exactly enough to rebuild a complete element without losing data.
 */
import type {
  OsmContributionContext,
  OsmContributionErrorCode,
  OsmElementRef,
  OsmElementType,
} from "@openmapx/core";

/** Closed operation enum shared by errors, logs and metrics. */
export type OsmOperation =
  | "capabilities"
  | "context"
  | "categories"
  | "preview"
  | "publish"
  | "note"
  | "reconcile"
  | "close_changeset";

export interface OsmPermissions {
  allowWriteApi: boolean;
  allowWriteNotes: boolean;
}

export interface OsmUserDetails {
  id: number;
  displayName: string;
  contributorTermsAgreed: boolean;
  activeBlock: boolean;
}

export interface OsmRelationMember {
  type: OsmElementType;
  ref: number;
  role: string;
}

/**
 * A live element as read from OSM. Node coordinates, way node references and
 * relation members are all retained because an update must send a complete
 * representation.
 */
export type OsmElement =
  | {
      type: "node";
      id: number;
      version: number;
      lat: number;
      lon: number;
      visible?: boolean;
      changeset?: number;
      tags: Record<string, string>;
    }
  | {
      type: "way";
      id: number;
      version: number;
      nodes: number[];
      visible?: boolean;
      changeset?: number;
      tags: Record<string, string>;
    }
  | {
      type: "relation";
      id: number;
      version: number;
      members: OsmRelationMember[];
      visible?: boolean;
      changeset?: number;
      tags: Record<string, string>;
    };

/**
 * The element as it will be written back. The geometry/member properties are
 * required at compile time, so a caller cannot serialize a partial way or
 * relation and silently drop its structure.
 */
export type OsmWritableElement =
  | {
      type: "node";
      id: number;
      version: number;
      changeset: number;
      lat: number;
      lon: number;
      visible?: boolean;
      tags: Record<string, string>;
    }
  | {
      type: "way";
      id: number;
      version: number;
      changeset: number;
      nodes: number[];
      visible?: boolean;
      tags: Record<string, string>;
    }
  | {
      type: "relation";
      id: number;
      version: number;
      changeset: number;
      members: OsmRelationMember[];
      visible?: boolean;
      tags: Record<string, string>;
    };

/** One element plus every element `/full` returned for it. */
export interface OsmFullResponse {
  primary: OsmElement;
  nodes: Array<{ id: number; lat: number; lon: number }>;
}

export interface OsmChangeset {
  id: number;
  open: boolean;
}

export interface OsmNote {
  id: number;
  status: "open" | "closed";
}

export interface OsmApiClient {
  getPermissions(token: string): Promise<OsmPermissions>;
  getUserDetails(token: string): Promise<OsmUserDetails>;
  getElement(ref: OsmElementRef): Promise<OsmElement>;
  getFullElement(ref: OsmElementRef): Promise<OsmFullResponse>;
  createChangeset(tags: Readonly<Record<string, string>>, token: string): Promise<number>;
  updateElement(element: OsmWritableElement, token: string): Promise<number>;
  closeChangeset(changesetId: number, token: string): Promise<void>;
  getChangeset(changesetId: number): Promise<OsmChangeset>;
  createNote(input: { lat: number; lon: number; text: string }, token: string): Promise<OsmNote>;
}

/**
 * A failure the route may translate into the shared safe error body. It never
 * carries an upstream body, URL, header or token.
 */
export class OsmContributionError extends Error {
  readonly code: OsmContributionErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;
  readonly context?: OsmContributionContext;
  readonly inspect?: { changesetUrl?: string; elementUrl?: string };

  constructor(
    code: OsmContributionErrorCode,
    status: number,
    message: string,
    extra: {
      retryAfterSeconds?: number;
      context?: OsmContributionContext;
      inspect?: { changesetUrl?: string; elementUrl?: string };
    } = {},
  ) {
    super(message);
    this.name = "OsmContributionError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = extra.retryAfterSeconds;
    this.context = extra.context;
    this.inspect = extra.inspect;
  }
}

export function isOsmContributionError(value: unknown): value is OsmContributionError {
  return value instanceof OsmContributionError;
}

/**
 * An upstream transport/protocol failure. `requestMayHaveBeenApplied` is the
 * only signal that decides whether reconciliation is required — it is true when
 * the request was transmitted but the outcome is unknown.
 */
export class OsmUpstreamError extends Error {
  readonly status: number | null;
  readonly operation: OsmOperation | "upstream";
  readonly retryAfterSeconds: number | null;
  readonly requestMayHaveBeenApplied: boolean;

  constructor(input: {
    status: number | null;
    operation: OsmOperation | "upstream";
    retryAfterSeconds?: number | null;
    requestMayHaveBeenApplied?: boolean;
    reason: string;
  }) {
    super(input.reason);
    this.name = "OsmUpstreamError";
    this.status = input.status;
    this.operation = input.operation;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
    this.requestMayHaveBeenApplied = input.requestMayHaveBeenApplied ?? false;
  }
}

export function isOsmUpstreamError(value: unknown): value is OsmUpstreamError {
  return value instanceof OsmUpstreamError;
}
