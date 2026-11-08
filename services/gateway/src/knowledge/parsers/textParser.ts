import type { DocumentParser } from "./types.js";

/** Plain text and Markdown need no real parsing — just a UTF-8 decode. */
export const textParser: DocumentParser = {
  sourceTypes: ["text", "txt", "md", "markdown"],
  async parse(input: Buffer): Promise<string> {
    return input.toString("utf8");
  },
};
