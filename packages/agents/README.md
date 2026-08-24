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
