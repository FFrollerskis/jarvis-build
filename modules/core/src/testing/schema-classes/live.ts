import type { Queryable } from "./catalog.ts";

/**
 * WP-MC8a fiks-runde 1 (L8): KUN-LESING-økt mot en EKSISTERENDE database (eierens NAS-trinn: katalogsjekken mot en restore/live-database).
 *
 * Katalogutdraget (`extractCatalog`) består av rene SELECT-spørringer. Likevel kjøres de i en `BEGIN READ ONLY`-transaksjon med `statement_timeout`: selv en fremtidig feil i
 * biblioteket kan da aldri endre den virkelige databasen (Postgres avviser alle skrivende setninger i en read-only-transaksjon). Ingen migrering, ingen DDL, alltid ROLLBACK.
 */

export interface ReadOnlyClient extends Queryable {
  release(err?: boolean | Error): void;
}

/** Minimum av `pg.Pool` som trengs (strukturelt: ingen `pg`-avhengighet i selve biblioteket). */
export interface ReadOnlyPool {
  connect(): Promise<ReadOnlyClient>;
}

export const READ_ONLY_STATEMENT_TIMEOUT = "60s";

export async function withReadOnlyCatalogSession<T>(pool: ReadOnlyPool, fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
    await client.query(`SET LOCAL statement_timeout = '${READ_ONLY_STATEMENT_TIMEOUT}'`);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => {
      broken = true;
    });
    client.release(broken);
  }
}

/** `vert:port/database` uten brukernavn og passord (til utskrift). Ugyldig URL gir en nøytral tekst som ALDRI gjengir inndata (kan inneholde et passord). */
export function describeDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
    return `${u.hostname}:${u.port === "" ? "5432" : u.port}/${db}`;
  } catch {
    return "(ugyldig database-URL)";
  }
}
