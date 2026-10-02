import { requireBinary } from "./tools.mjs";

/**
 * How to reach PostgreSQL's client tools.
 *  - direct: local binaries against host:port (tests, or a host with postgresql-client).
 *  - docker: `docker compose exec -T postgres <tool>` - the production NAS path; no client
 *    tools and no published port needed on the host. The password is passed by NAME
 *    (`-e PGPASSWORD`), so it never appears in argv.
 *  - container: `docker exec -i <name> <tool>` - a throwaway scratch container for restore
 *    verification (see nas-restore-verify.sh).
 */
export function makeRunner(opts) {
  const { mode = "direct", host = "127.0.0.1", port = 5432, user = "postgres", password, composeFile, service = "postgres", container } = opts;
  if (password === undefined || password === "") throw new Error("database admin password is required (JARVIS_DB_ADMIN_PASSWORD)");
  const env = { ...process.env, PGPASSWORD: password };
  const endpoint = mode === "docker" ? `docker-compose:${service}` : mode === "container" ? `docker-container:${container}` : `${host}:${port}`;
  return {
    mode,
    endpoint,
    command(tool, args, { database } = {}) {
      const dbArgs = database ? ["-d", database] : [];
      if (mode === "container") {
        if (!container) throw new Error("container name is required in container mode");
        return { file: "docker", args: ["exec", "-i", "-e", "PGPASSWORD", container, tool, "-U", user, ...dbArgs, ...args], env };
      }
      if (mode === "docker") {
        if (!composeFile) throw new Error("composeFile is required in docker mode");
        return {
          file: "docker",
          args: ["compose", "-f", composeFile, "exec", "-T", "-e", "PGPASSWORD", service, tool, "-U", user, ...dbArgs, ...args],
          env
        };
      }
      return { file: requireBinary(tool), args: ["-h", host, "-p", String(port), "-U", user, ...dbArgs, ...args], env };
    }
  };
}
