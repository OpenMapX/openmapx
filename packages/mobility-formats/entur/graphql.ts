import type { DocumentTypeDecoration } from "@graphql-typed-document-node/core";

/** Pure serialization; generated documents remain the result/variable authority. */
export function encodeGraphQlRequest<TResult, TVariables>(
  document: DocumentTypeDecoration<TResult, TVariables> & { toString(): string },
  variables: NoInfer<TVariables>,
): string {
  return JSON.stringify({ query: document.toString(), variables });
}

export class GraphQlEnvelopeError extends Error {
  override readonly name = "GraphQlEnvelopeError";
  constructor() {
    // Provider diagnostics can contain request/configuration details. Never retain them.
    super("Entur returned an invalid GraphQL envelope");
  }
}

/** Checks the envelope and object data root, not the complete generated operation result. */
export function decodeGraphQlEnvelope<TResult>(text: string): TResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GraphQlEnvelopeError();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GraphQlEnvelopeError();
  const envelope = value as { data?: unknown; errors?: unknown };
  if (
    envelope.errors !== undefined &&
    (!Array.isArray(envelope.errors) || envelope.errors.length > 0)
  )
    throw new GraphQlEnvelopeError();
  if (envelope.data === null || typeof envelope.data !== "object" || Array.isArray(envelope.data))
    throw new GraphQlEnvelopeError();
  return envelope.data as TResult;
}
