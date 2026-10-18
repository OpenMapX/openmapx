import { getSchemaOutputTypeRef, rewriteImportsForResponseValidation } from "orval";

/**
 * A validating custom mutator returns the schema's output, not its input.
 * Orval's supported output transformer selects that same type used by its
 * built-in validating client. Keep schema identity for runtime forwarding.
 */
export function validatedResponseTypes(verb) {
  const name = verb.response.definition.success;
  const success = verb.response.types.success;
  const declaredStatuses = [...success, ...verb.response.types.errors].map((entry) =>
    Number(entry.key),
  );
  if (
    !success.length ||
    declaredStatuses.some((status) => !Number.isInteger(status)) ||
    success.some(
      (entry) => !entry.isRef || entry.value !== name || entry.contentType !== "application/json",
    )
  ) {
    throw new Error(
      `${verb.operationId}: expected a named JSON success schema for SDK validation.`,
    );
  }
  return {
    ...verb,
    override: {
      ...verb.override,
      requestOptions: {
        ...(typeof verb.override?.requestOptions === "object" ? verb.override.requestOptions : {}),
        declaredStatuses,
      },
    },
    response: {
      ...verb.response,
      imports: rewriteImportsForResponseValidation(verb.response.imports, name),
      types: {
        ...verb.response.types,
        success: success.map((entry) => ({ ...entry, value: getSchemaOutputTypeRef(name) })),
      },
    },
  };
}
