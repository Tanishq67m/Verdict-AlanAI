/**
 * Gemini's `responseJsonSchema` accepts only a subset of JSON Schema (see the SDK docs for
 * GenerateContentConfig.responseJsonSchema). Unsupported keywords are stripped and `const`
 * (emitted by zod for literals) becomes a one-value `enum`. Anything dropped here is still
 * enforced by the caller's zod validation of the response.
 */
const SUPPORTED = new Set([
  "$id",
  "$defs",
  "$ref",
  "$anchor",
  "type",
  "format",
  "title",
  "description",
  "enum",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "anyOf",
  "oneOf",
  "properties",
  "additionalProperties",
  "required",
  "propertyOrdering",
]);

export function toGeminiJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiJsonSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "const") {
      out["enum"] = [value];
    } else if (key === "properties" && value !== null && typeof value === "object") {
      // Property names are user data, not keywords: keep every one, sanitize their schemas.
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value)) props[name] = toGeminiJsonSchema(sub);
      out[key] = props;
    } else if (SUPPORTED.has(key)) {
      out[key] = toGeminiJsonSchema(value);
    }
  }
  return out;
}
