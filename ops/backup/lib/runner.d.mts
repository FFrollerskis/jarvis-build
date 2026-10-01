export interface PgCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}
export interface PgRunner {
  mode: "direct" | "docker" | "container";
  endpoint: string;
  command(tool: string, args: string[], opts?: { database?: string | undefined }): PgCommand;
}
export declare function makeRunner(opts: {
  mode?: "direct" | "docker" | "container";
  host?: string;
  port?: number;
  user?: string;
  password: string | undefined;
  composeFile?: string | undefined;
  service?: string;
  container?: string | undefined;
}): PgRunner;
