/** Shared by both agents' tools: JSON-schema shorthands for declarations, and argument checks. */

export const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
export const str = (description: string) => ({ type: 'string', description });

/** A tool called with arguments it can't use: reported back to the model, never thrown further. */
export class ToolInputError extends Error {}

export const asString = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new ToolInputError(`"${key}" must be a non-empty string.`);
  return v.trim();
};
