import { spawn } from "node:child_process";

const SENTINEL = "__JARVIS_BACKUP_END__";

/** One persistent psql session - needed to hold an exported snapshot open while pg_dump runs. */
export class PsqlSession {
  constructor(runner, database) {
    const cmd = runner.command("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"], { database });
    this.child = spawn(cmd.file, cmd.args, { env: cmd.env, stdio: ["pipe", "pipe", "pipe"] });
    this.buffer = "";
    this.stderr = "";
    this.pending = undefined;
    this.exited = new Promise((resolve) => this.child.on("close", (code) => resolve(code)));
    this.child.stdout.on("data", (d) => {
      this.buffer += d;
      this.#drain();
    });
    this.child.stderr.on("data", (d) => {
      this.stderr += d;
    });
    this.child.on("close", () => {
      if (this.pending) this.pending.reject(new Error(`psql ended unexpectedly: ${this.stderr.trim().slice(0, 300)}`));
      this.pending = undefined;
    });
  }

  #drain() {
    if (!this.pending) return;
    const idx = this.buffer.indexOf(`${SENTINEL}\n`);
    if (idx === -1) return;
    const out = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + SENTINEL.length + 1);
    const { resolve } = this.pending;
    this.pending = undefined;
    resolve(out.replace(/\n$/, ""));
  }

  query(sql) {
    if (this.pending) throw new Error("psql session is busy");
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.child.stdin.write(`${sql.replace(/;\s*$/, "")};\n\\echo ${SENTINEL}\n`);
    });
  }

  async close() {
    this.child.stdin.end();
    await this.exited;
  }
}

/** One-shot psql (no persistent session). Returns stdout; rejects on non-zero exit. */
export function psqlOnce(runner, database, sql, { input } = {}) {
  const cmd = runner.command("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", ...(sql ? ["-c", sql] : [])], { database });
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.file, cmd.args, { env: cmd.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`psql failed (${code}): ${err.trim().slice(0, 300)}`))));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export const INVENTORY_SQL = `SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
  ORDER BY 1`;
