import type { InjectionContext, InjectionResult, Injector } from "../capabilities/injection.ts";

/** One pending environment update per session, delivered once to each frame. */
export class EnvironmentNoticeInjector implements Injector {
  readonly id = "environments";
  private text?: string;
  private readonly delivered = new Set<string>();

  publish(text: string): void {
    this.text = text;
    this.delivered.clear();
  }

  take(address: string): string | undefined {
    if (this.text === undefined || this.delivered.has(address)) return undefined;
    this.delivered.add(address);
    return this.text;
  }

  inject(ctx: InjectionContext): InjectionResult | null {
    if (ctx.trigger === "compaction") return null;
    const text = this.take(ctx.address);
    return text === undefined ? null : { text, variant: "status" };
  }
}
