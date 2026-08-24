/**
 * app-server — drive the harness from another process (any language) over an
 * NDJSON JSON-RPC 2.0 stdio protocol, so non-JS hosts can `spawn` the binary
 * and talk to it.
 *
 *   // host side (TypeScript reference client)
 *   import { AppServerClient } from "operon-agents/app-server"
 *   const client = AppServerClient.spawn({ args: ["--workdir", "/repo", "--model", "anthropic/claude-opus-4-8"] })
 *   await client.initialize()
 *   const { sessionId } = await client.newSession()
 *   client.onEvent(render)
 *   client.setApprovalHandler(askUser)
 *   const result = await client.prompt(sessionId, "fix the bug")
 *
 * `./protocol` (wire types + constants) is the single source of truth for clients
 * in other languages.
 */
export * from "./protocol.ts";
export {
  type JsonRpcTransport,
  nodeStreamTransport,
  pairedTransports,
  RpcError,
  toWireSafe,
  classify,
} from "./codec.ts";
export { AppServer, type AppServerOptions } from "./server.ts";
export {
  AppServerClient,
  type ApprovalHandler,
  type EventListener,
  type QuestionHandler,
  type SpawnOptions,
} from "./client.ts";
