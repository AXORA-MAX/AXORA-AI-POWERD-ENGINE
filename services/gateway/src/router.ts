import type { RouteMode } from "./types.js";
import type { ModelProvider } from "./providers/provider.js";

/**
 * AXORA Model Router (master spec section 4 / 61).
 *
 * Today this only has the mock provider registered, so routing is
 * trivial — but the selection logic is written for N providers so adding
 * a real one is a registration, not a rewrite.
 */
export class ModelRouter {
  private providers = new Map<string, ModelProvider>();
  private defaultProviderId: string;

  constructor(providers: ModelProvider[], defaultProviderId: string) {
    for (const p of providers) this.providers.set(p.id, p);
    if (!this.providers.has(defaultProviderId)) {
      throw new Error(
        `ModelRouter: default provider "${defaultProviderId}" was not registered`,
      );
    }
    this.defaultProviderId = defaultProviderId;
  }

  list(): ModelProvider[] {
    return [...this.providers.values()];
  }

  /**
   * Resolve which provider should serve this request.
   * - Explicit provider id always wins (manual override, spec section 4).
   * - Otherwise pick the first registered provider that declares support
   *   for the requested mode.
   * - Falls back to the configured default.
   */
  resolve(opts: { mode?: RouteMode; providerId?: string }): ModelProvider {
    if (opts.providerId) {
      const p = this.providers.get(opts.providerId);
      if (!p) {
        throw new Error(`ModelRouter: unknown provider "${opts.providerId}"`);
      }
      return p;
    }

    const mode = opts.mode ?? "auto";
    for (const p of this.providers.values()) {
      if (p.capabilities.modes.includes(mode)) return p;
    }

    return this.providers.get(this.defaultProviderId)!;
  }
}
