import type { DocumentParser } from "./types.js";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
};

/** Decode the handful of HTML entities that actually show up in body text. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, code: string) => {
    if (code[0] === "#") {
      const codePoint = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return NAMED_ENTITIES[code] ?? match;
  });
}

/**
 * Strip tags to plain text. Deliberately simple (regex-based, not a real
 * DOM/HTML5 parser) — good enough for extracting readable body text from
 * well-formed HTML, not a substitute for a real parser if malformed or
 * adversarial HTML needs to be handled safely.
 */
export function stripHtmlTags(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

export const htmlParser: DocumentParser = {
  sourceTypes: ["html", "htm"],
  async parse(input: Buffer): Promise<string> {
    const raw = input.toString("utf8");
    const stripped = stripHtmlTags(raw);
    const decoded = decodeHtmlEntities(stripped);
    return decoded.replace(/[ \t]{2,}/g, " ").trim();
  },
};
