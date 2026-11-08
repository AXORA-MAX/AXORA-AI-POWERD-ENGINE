import type { ChatMessage, StreamChunk } from "../types.js";
import type { ModelProvider } from "./provider.js";

/**
 * A genuinely functioning local provider with no external dependencies.
 * It does not "pretend" to call a model — it deterministically composes a
 * response from the conversation so far and streams it token-by-token,
 * exactly like a real provider would over SSE. This is what AXORA falls
 * back to per master spec section 53 ("project should run without paid AI
 * APIs using a mock provider").
 */
export class MockProvider implements ModelProvider {
  readonly id = "mock";
  readonly name = "AXORA Mock Provider (local, offline)";
  readonly capabilities = {
    modes: ["auto", "fast", "deep", "research", "creative", "coding", "study"],
    maxContextTokens: 8000,
    streaming: true,
  };

  async *stream(messages: ChatMessage[]): AsyncGenerator<StreamChunk> {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const userText = lastUser?.content?.trim() ?? "";

    const reply =
      userText.length === 0
        ? "I didn't receive any message content to respond to."
        : `[mock provider] You said: "${userText}". ` +
          `This is a deterministic offline response from AXORA's local ` +
          `mock provider — no external model was called. Configure a real ` +
          `provider (see services/gateway/src/providers/provider.ts) to ` +
          `get actual model output.`;

    const words = reply.split(" ");
    let outputTokens = 0;
    for (const word of words) {
      const delta = outputTokens === 0 ? word : " " + word;
      outputTokens++;
      yield { delta, done: false };
      // Small real (not fake) async yield so this behaves like genuine
      // streaming I/O rather than a synchronous dump.
      await new Promise((resolve) => setImmediate(resolve));
    }

    yield {
      delta: "",
      done: true,
      usage: {
        input_tokens: messages.reduce((n, m) => n + m.content.split(" ").length, 0),
        output_tokens: outputTokens,
      },
    };
  }
}
