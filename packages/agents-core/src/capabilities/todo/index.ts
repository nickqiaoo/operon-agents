import type { Capability } from "../capability.ts";
import { TodoListInjector } from "./injector.ts";
import { TodoStore } from "./todo-store.ts";
import { todoListTool } from "./tools.ts";

export { TodoStore, TODO_LIST_TOOL_NAME } from "./todo-store.ts";
export type { TodoItem, TodoStatus, TodoDetails } from "./todo-store.ts";
export { todoListTool, renderTodoList } from "./tools.ts";
export { TodoListInjector } from "./injector.ts";

export function todoCapability(store: TodoStore = new TodoStore()): Capability {
  return {
    name: "todo",
    contract: "detachable",
    tools: [todoListTool(store)],
    injectors: [new TodoListInjector(store)],
    service: store,
    // FRAME state: each address stores and restores its own agent's list. A lost write only
    // leaves the list one change behind, which the agent's next TodoList call rewrites — so
    // nothing waits for it.
    durableState: {
      snapshot: (address) => store.snapshot(address),
      restore: (address, value) => store.restore(address, value),
    },
    openSession: (ctx) => {
      store.attachPersistence((address) => void ctx.persistState(address));
    },
  };
}
