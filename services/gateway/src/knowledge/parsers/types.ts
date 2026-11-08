/**
 * Document parsing — the "Parsing" pipeline stage that comes before
 * cleaning/chunking (master spec section 14). Each parser turns raw
 * bytes of a specific format into plain text; chunking.ts takes it from
 * there unchanged.
 */
export interface DocumentParser {
  /** Source-type identifiers this parser handles (matched case-insensitively). */
  sourceTypes: string[];
  parse(input: Buffer): Promise<string>;
}
