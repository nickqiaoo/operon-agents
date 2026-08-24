import { z } from "zod";
import { defineTool } from "../../tool/define.ts";
import { ToolAccesses } from "../../tool/access.ts";
import type { Tool, ToolResult } from "../../tool/types.ts";
import type { TodoItem, TodoStatus, TodoStore } from "./todo-store.ts";
import { TODO_LIST_TOOL_NAME } from "./todo-store.ts";

export { TODO_LIST_TOOL_NAME } from "./todo-store.ts";

const TODO_LIST_WRITE_REMINDER =
  "Ensure that you continue to use the todo list to track progress. Mark tasks done immediately after finishing them, and keep exactly one task in_progress when work is underway.";

const TodoItemSchema = z.object({
  title: z.string().min(1).describe("Short, actionable title for the todo."),
  status: z.enum(["pending", "in_progress", "done"]).describe("Current status of the todo."),
});

const TodoListInput = z.object({
  todos: z
    .array(TodoItemSchema)
    .optional()
    .describe(
      "The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.",
    ),
});

type TodoListInput = z.infer<typeof TodoListInput>;

const TODO_LIST_DESCRIPTION = [
  "Use this tool to maintain a structured TODO list as you work through a multi-step task.",
  "Call with `todos: [...]` to replace the full list, with no arguments to read it, and with `todos: []` to clear it.",
  "Statuses are pending, in_progress, and done. Keep exactly one task in_progress when work is underway.",
].join("\n");

export function todoListTool(store: TodoStore): Tool {
  return defineTool({
    name: TODO_LIST_TOOL_NAME,
    description: TODO_LIST_DESCRIPTION,
    params: TodoListInput,
    resolve: (args) => {
      const title =
        args.todos === undefined
          ? "Read todo list"
          : args.todos.length === 0
            ? "Clear todo list"
            : "Update todo list";
      return {
        approvalRule: TODO_LIST_TOOL_NAME,
        accesses: ToolAccesses.none(),
        display: { title },
        run: async (): Promise<ToolResult> => {
          // Read mode carries the current list too, so a resumed/forked session reconstructs
          // from the latest TodoList result even when the last write was on a parent node.
          if (args.todos === undefined) return todoResult(renderTodoList(store.get()), store.get());

          const stored = store.set(args.todos);
          if (stored.length === 0) return todoResult("Todo list cleared.", stored);
          return todoResult(`Todo list updated.\n${renderTodoList(stored)}\n\n${TODO_LIST_WRITE_REMINDER}`, stored);
        },
      };
    },
  });
}

export function renderTodoList(todos: readonly TodoItem[], title = "Current todo list:"): string {
  if (todos.length === 0) return "Todo list is empty.";
  return [title, ...todos.map((todo) => `  ${statusMarker(todo.status)} ${todo.title}`)].join("\n");
}

function statusMarker(status: TodoStatus): string {
  switch (status) {
    case "pending":
      return "[pending]";
    case "in_progress":
      return "[in_progress]";
    case "done":
      return "[done]";
  }
}

function todoResult(text: string, todos: readonly TodoItem[]): ToolResult {
  // The list snapshot rides in `details` so the log is the single source of truth.
  return { content: [{ type: "text", text }], details: { todos } };
}
