/**
 * The exact bytes TracePay hashes and signs: JSON with object keys sorted and undefined values left
 * out (dates as ISO strings). Shared by the API, which signs receipts, and the browser, which checks
 * them — one definition, so the two can never drift apart.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .filter((k) => o[k] !== undefined)
        .map((k) => [k, sortKeys(o[k])]),
    );
  }
  return value;
}
