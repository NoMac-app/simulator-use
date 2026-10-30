/** A tool as both the MCP server and the CLI see it. One list (registry.ts) feeds both. */

export type Property =
  | { type: "string" | "boolean" | "number"; description: string; enum?: string[] }
  | { type: "array"; items: { type: "string" }; description: string; minItems?: number };

export type JsonSchema = {
  type: "object";
  properties: Record<string, Property>;
  required?: string[];
  additionalProperties: false;
};

export type ToolResult = {
  text: string;
  /** A picture for the agent (MCP) or a file path to print (CLI). */
  image?: { data: Buffer; mimeType: "image/jpeg" | "image/png" };
  isError?: boolean;
};

/** How the call came: the CLI waits for long work to finish; MCP answers within 40 s, with a job if needed. */
export type CallContext = { waitForJobs: boolean };

export type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  /** The four MCP hints; `title` above is the fifth. */
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  /** The CLI command: `simulator-use look` for ui_look. An array argument takes the command's positional words. */
  command: string;
  /** Arguments the CLI also takes as bare words, in order: `simulator-use app launch dev.example.app`. */
  positional?: string[];
  /** The argument that takes the words after the positional ones, each quoted as a shell would: app launch's arguments. */
  restWords?: (args: Record<string, unknown>) => string | undefined;
  run: (args: Record<string, unknown>, context: CallContext) => Promise<ToolResult>;
};
