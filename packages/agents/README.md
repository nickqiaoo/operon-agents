# operon-agents

Public SDK entrypoint for building agents.

```ts
import { Agent, Runner, Session, ChatModel, tool } from "operon-agents";
```

Use `operon-agents` from applications. `operon-agents-core` is the lower-level
engine package.

Focused subpaths are available for larger capability areas:

```ts
import { TransportMCPServer } from "operon-agents/mcp";
import { bashTool, readTool } from "operon-agents/tools";
import { OTelTracingProcessor } from "operon-agents/tracing";
```

## Tracing

Every session drives a `TracingProcessor` registered on the harness scope as `T.Tracing`: one
trace per run (a prompt and everything it triggers), spans for agents, turns, model generations,
tool calls and sub-agents, the session id on every span as `gen_ai.conversation.id`. By default
spans are metadata only. Pass `content: "delta"` to also record the system prompt, the messages
the model was asked to answer, its output, tool arguments and results — enough to replay a
conversation in a trace viewer. Local Jaeger:

```sh
docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:2.9.0
```

```ts
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTelTracingProcessor } from "operon-agents/tracing";
import { T } from "operon-agents/core";

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ "service.name": "my-agent" }),
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: "http://localhost:4318/v1/traces" }))],
});
const tracing = new OTelTracingProcessor({ tracer: provider.getTracer("my-agent"), tracerProvider: provider, content: "delta", shutdownProvider: true });

const harness = await createLocalHarness({
  model,
  harness: (scope) => scope.register(T.Tracing, tracing),
});
```

`content: "full"` repeats the entire context on every generation (trace size grows with steps ×
context); `contentMaxChars` caps each attribute; `redact: true` masks tokens, emails and keys
before export when the collector is not on the same machine.

