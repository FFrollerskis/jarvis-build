import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Remediation part 1 / JARVIS-007: backup tooling. No dependencies beyond Node and the
 * standard PostgreSQL client tools + `age`. Nothing here ever writes plaintext dump data to
 * disk: pg_dump output is piped straight into `age`.
 */
export function findBinary(name, env = process.env) {
  // D-370: a host without `age` (e.g. the NAS) points JARVIS_AGE_BIN at ops/backup/age-docker.sh.
  if (name === "age" && env.JARVIS_AGE_BIN && existsSync(env.JARVIS_AGE_BIN)) return env.JARVIS_AGE_BIN;
  const dirs = (env.PATH ?? "").split(":").filter(Boolean);
  try {
    for (const v of readdirSync("/usr/lib/postgresql").sort().reverse()) dirs.push(join("/usr/lib/postgresql", v, "bin"));
  } catch {
    // no system PostgreSQL install - PATH only
  }
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function requireBinary(name, env = process.env) {
  const found = findBinary(name, env);
  if (!found) throw new Error(`required tool not found: ${name} (install it, e.g. apt install age postgresql-client)`);
  return found;
}

export function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Public age recipient only (X25519). A private key / passphrase is never accepted here. */
export function assertAgeRecipient(recipient) {
  if (typeof recipient !== "string" || !/^age1[02-9ac-hj-np-z]{50,}$/.test(recipient)) {
    throw new Error("JARVIS_BACKUP_AGE_RECIPIENT must be an age public key (age1...). Refusing to write an unencrypted backup.");
  }
}

export function quoteIdent(id) {
  return `"${String(id).replace(/"/g, '""')}"`;
}
