// Shapes shared across the CLI. The spec is OpenAPI JSON read at run time, so its nodes stay loosely typed:
// almost every field is optional and the code checks what it uses.
export type Json = any;
export type OpenApi = Record<string, Json>;
export type Schema = Record<string, Json>;

export interface Param {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: Schema;
  [key: string]: Json;
}

// One generated command: an OpenAPI operation plus the CLI behavior its x- extensions ask for.
export interface Command {
  operationId: string;
  method: string;
  path: string;
  group: string;
  tag: string;
  summary: string;
  description: string;
  params: Param[];
  body: { required: boolean; contentType: string | null; schema: Schema | undefined } | null;
  responseTypes: string[];
  sse: boolean;
  binary: boolean;
  websocket: Json | null;
  wait: Json | null;
  destructive: boolean;
  noAuth: boolean;
  name: string; // assigned once every command in the group is known
}

export interface Group {
  name: string;
  tag: string;
  description: string;
  commands: Map<string, Command>;
  aliases: string[];
}

export type Groups = Map<string, Group>;
export type Env = NodeJS.ProcessEnv;
