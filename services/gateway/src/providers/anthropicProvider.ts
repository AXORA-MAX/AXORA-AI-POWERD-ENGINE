import type { ChatMessage, StreamChunk } from "../types.js";
import type { ModelProvider } from "./provider.js";
import { parseSseFrames, extractTextDelta, extractUsage, isStreamDone } from "./anthropicSse.js";

export interface AnthropicProviderConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

/**
 * Real Anthropic-compatible provider. Uses Node's built-in `fetch` — no
 * SDK dependency, consistent with the rest of the gateway being
 * dependency-free. NOT executable in the sandbox this was written in:
 * there is no network egress to api.anthropic.com here, so this has
 * never actually completed a live call. The SSE parsing it depends on
 * (anthropicSse.ts) IS unit-tested against a hand-written canned payload
 * — see anthropicSse.test.ts — which is the most that can be verified
 * offline. Test this against the real API before trusting it further.
 */
export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";
  readonly name = "Anthropic Claude";
  readonly capabilities = {
    modes: ["auto", "fast", "deep", "research", "creative", "coding", "study"],
    maxContextTokens: 200_000,
    streaming: true,
  };

  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: AnthropicProviderConfig) {
    if (!config.apiKey) {
      throw new Error("AnthropicProvider requires an apiKey (ANTHROPIC_API_KEY)");
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "claude-sonnet-4-6";
    this.baseUrl = config.baseUrl ?? "https://api.anthropic.com";
  }

  async *stream(messages: ChatMessage[]): AsyncGenerator<StreamChunk> {
    const system = messages.find((m) => m.role === "system")?.content;
    const conversational = messages.filter((m) => m.role === "user" || m.role === "assistant");

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        stream: true,
        ...(system ? { system } : {}),
        messages: conversational.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      // Per "no fake capabilities": a failed call throws, it never yields
      // a fabricated response.
      throw new Error(`Anthropic API error ${res.status}: ${errText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let outputTokens = 0;
    let inputTokens = 0;

    while (true) {
      const { value, done: readerDone } = await reader.read();
      if (readerDone) break;
      buffer += decoder.decode(value, { stream: true });

      const { events, rest } = parseSseFrames(buffer);
      buffer = rest;

      for (const event of events) {
        const delta = extractTextDelta(event);
        if (delta !== null) {
          outputTokens++;
          yield { delta, done: false };
        }

        const usage = extractUsage(event);
        if (usage) {
          inputTokens = usage.input_tokens;
          outputTokens = usage.output_tokens;
        }

        if (isStreamDone(event)) {
          yield { delta: "", done: true, usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
          return;
        }
      }
    }

    // Stream ended without an explicit message_stop — report what we
    // have rather than hanging silently.
    yield { delta: "", done: true, usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
  }
}
