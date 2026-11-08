/**
 * Parses Anthropic Messages API streaming events
 * (https://docs.claude.com — `content_block_delta` / `message_stop` etc.)
 * out of raw SSE text. Kept as a pure function, independent of `fetch`,
 * specifically so it can be unit-tested in a sandbox with no network
 * access: feed it a canned SSE payload string and assert on the parsed
 * deltas, with no real API call involved.
 */

export interface AnthropicSseEvent {
  type: string;
  data: any;
}

/** Split a raw SSE buffer into complete `event:`/`data:` frames. */
export function parseSseFrames(buffer: string): { events: AnthropicSseEvent[]; rest: string } {
  const events: AnthropicSseEvent[] = [];
  const frames = buffer.split("\n\n");
  const rest = frames.pop() ?? "";

  for (const frame of frames) {
    if (!frame.trim()) continue;
    let eventType = "message";
    let dataLine: string | null = null;
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
    }
    if (dataLine === null) continue;
    try {
      events.push({ type: eventType, data: JSON.parse(dataLine) });
    } catch {
      // Malformed frame — skip rather than crash the stream. A real
      // provider bug should surface as a thrown error upstream, not a
      // parser crash here.
    }
  }

  return { events, rest };
}

/**
 * Extract the text delta (if any) from a parsed Anthropic SSE event.
 * Returns null for events that carry no visible text (message_start,
 * ping, content_block_start for non-text blocks, etc.).
 */
export function extractTextDelta(event: AnthropicSseEvent): string | null {
  if (event.type !== "content_block_delta") return null;
  const delta = event.data?.delta;
  if (delta?.type === "text_delta" && typeof delta.text === "string") {
    return delta.text;
  }
  return null;
}

export function isStreamDone(event: AnthropicSseEvent): boolean {
  return event.type === "message_stop";
}

export function extractUsage(
  event: AnthropicSseEvent,
): { input_tokens: number; output_tokens: number } | null {
  if (event.type === "message_delta" && event.data?.usage) {
    const u = event.data.usage;
    return {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
    };
  }
  return null;
}
