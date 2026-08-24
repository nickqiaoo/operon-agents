import type { Message } from "../protocol/index.ts";
import type { PromptOrigin } from "../store/origin.ts";

export interface InjectionContext {
  readonly history: readonly Message[];
  readonly sessionId: string;
  readonly address: string;
  readonly originOf: (message: Message) => PromptOrigin | undefined;
}

export interface InjectionResult {
  readonly text: string;
  readonly variant?: string;
}

export interface Injector {
  readonly id: string;
  inject(ctx: InjectionContext): InjectionResult | null;
  onContextCleared?(): void;
  onContextCompacted?(compactedCount: number): void;
  onContextMessageRemoved?(index: number): void;
}

export abstract class BoundaryInjector implements Injector {
  abstract readonly id: string;
  protected injectedAt: number | null = null;
  private scope: string | null = null;

  inject(ctx: InjectionContext): InjectionResult | null {
    const scope = `${ctx.sessionId}\u0000${ctx.address}`;
    if (scope !== this.scope) {
      this.onContextCleared();
      this.scope = scope;
    }
    const result = this.getInjection(ctx);
    if (result === null) return null;
    this.injectedAt = ctx.history.length;
    return result;
  }

  onContextCleared(): void {
    this.injectedAt = null;
  }

  onContextCompacted(compactedCount: number): void {
    if (this.injectedAt === null) return;
    if (this.injectedAt < compactedCount) {
      this.injectedAt = null;
      return;
    }
    // N old messages → 1 summary: surviving tail positions shift down by N - 1.
    this.injectedAt = this.injectedAt - compactedCount + 1;
  }

  onContextMessageRemoved(index: number): void {
    if (this.injectedAt === null) return;
    if (index < this.injectedAt) this.injectedAt -= 1;
    else if (index === this.injectedAt) this.injectedAt = null;
  }

  /** Restore the last append-only injection position from replayed message provenance. */
  protected restoreInjectedAt(ctx: InjectionContext, legacyVariants: readonly string[] = []): boolean {
    if (this.injectedAt !== null) return true;
    for (let i = ctx.history.length - 1; i >= 0; i--) {
      const origin = ctx.originOf(ctx.history[i]!);
      if (origin?.kind !== "injection") continue;
      if (origin.injectorId === this.id || (origin.injectorId === undefined && legacyVariants.includes(origin.variant))) {
        this.injectedAt = i;
        return true;
      }
    }
    return false;
  }

  protected abstract getInjection(ctx: InjectionContext): InjectionResult | null;
}

export type InjectionAppender = (result: InjectionResult, injectorId: string) => void;

export class InjectionManager {
  private readonly injectors: Injector[] = [];

  register(injector: Injector): void {
    this.injectors.push(injector);
  }

  registerAll(injectors: readonly Injector[]): void {
    for (const injector of injectors) this.register(injector);
  }

  get size(): number {
    return this.injectors.length;
  }

  runAtTurnBoundary(ctx: InjectionContext, append: InjectionAppender): void {
    for (const injector of this.injectors) {
      let result: InjectionResult | null;
      try {
        result = injector.inject(ctx);
      } catch {
        continue; // a broken injector must not break the boundary (fault isolation)
      }
      if (result) append(result, injector.id);
    }
  }

  onContextCleared(): void {
    for (const injector of this.injectors) {
      try {
        injector.onContextCleared?.();
      } catch {
        continue;
      }
    }
  }

  onContextCompacted(compactedCount: number): void {
    for (const injector of this.injectors) {
      try {
        injector.onContextCompacted?.(compactedCount);
      } catch {
        continue;
      }
    }
  }

  onContextMessageRemoved(index: number): void {
    for (const injector of this.injectors) {
      try {
        injector.onContextMessageRemoved?.(index);
      } catch {
        continue;
      }
    }
  }
}

export function systemReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}
