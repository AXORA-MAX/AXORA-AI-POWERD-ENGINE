import type { DocumentParser } from "./types.js";

/** Flatten nested JSON into "path: value" lines — much more retrieval-friendly than raw JSON syntax. */
export function flattenJson(value: unknown, path: string = ""): string[] {
  if (value === null || value === undefined) {
    return path ? [`${path}: null`] : [];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return path ? [`${path}: []`] : [];
    return value.flatMap((v, i) => flattenJson(v, path ? `${path}[${i}]` : `[${i}]`));
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return path ? [`${path}: {}`] : [];
    return entries.flatMap(([k, v]) => flattenJson(v, path ? `${path}.${k}` : k));
  }

  return [`${path}: ${String(value)}`];
}

export const jsonParser: DocumentParser = {
  sourceTypes: ["json"],
  async parse(input: Buffer): Promise<string> {
    const parsed = JSON.parse(input.toString("utf8"));
    return flattenJson(parsed).join("\n");
  },
};
