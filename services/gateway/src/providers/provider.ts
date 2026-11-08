import type { ChatMessage, StreamChunk } from "../types.js";

/**
 * Every model provider AXORA supports — cloud, local, or future AXORA
 * Neural models — implements this interface. The router and gateway never
 * talk to a provider SDK directly; they only ever see this shape.
 *
 * NEVER let a provider implementation claim success without actually
 * having produced output — per master spec section 69 ("No Fake
 * Capabilities"), a provider that can't run must throw, not fabricate.
 */
export interface ModelProvider {
  /** Stable identifier, e.g. "mock", "anthropic", "local-llama". */
  readonly id: string;

  /** Human-readable name for logs/UI. */
  readonly name: string;

  /** Declares what this provider is good for, used by the router. */
  readonly capabilities: {
    modes: string[];
    maxContextTokens: number;
    streaming: boolean;
  };

  /**
   * Stream a completion. Implementations must yield real incremental
   * output — no simulated delays used to fake "thinking", no invented
   * content when the underlying call fails (throw instead).
   */
  stream(messages: ChatMessage[]): AsyncGenerator<StreamChunk>;
}
