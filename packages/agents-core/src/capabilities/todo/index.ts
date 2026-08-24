import { readSessionLog } from "../capability-state.ts";
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
    tools: [todoListTool(store)],
    service: store,
    injectors: [new TodoListInjector(store)],
    // Rebuild the list from the session log (the latest TodoList result), not a KV side
    // channel — so resume restores it and a fork reconstructs the list at the fork point.
    openSession: async (ctx) => {
      store.reconstruct(await readSessionLog(ctx));
    },
  };
}
