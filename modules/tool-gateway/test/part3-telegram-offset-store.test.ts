import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { PgTelegramOffsetStore } from "../src/live-transports.ts";

/** Del 3 (JARVIS-024): holdbar offset mot ekte Postgres (migrasjon 065), som jarvis_app - ikke superbruker. */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-tgoffset-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_tgoff LOGIN PASSWORD 'pw2'; GRANT jarvis_app TO jarvis_tgoff;");
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_tgoff", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

describe("PgTelegramOffsetStore", () => {
  it("ingen rad => 0; lagret offset leses av en HELT NY instans (restart)", async () => {
    expect(await new PgTelegramOffsetStore(appPool, "tok-a").load()).toBe(0);
    await new PgTelegramOffsetStore(appPool, "tok-a").save(42);
    expect(await new PgTelegramOffsetStore(appPool, "tok-a").load()).toBe(42);
  });
  it("offset går aldri bakover (GREATEST) - en forsinket lagring kan ikke spille av meldinger", async () => {
    const store = new PgTelegramOffsetStore(appPool, "tok-b");
    await store.save(100);
    await store.save(60);
    expect(await store.load()).toBe(100);
  });
  it("hver bot har sin egen nøkkel, og tokenet lagres aldri i klartekst", async () => {
    await new PgTelegramOffsetStore(appPool, "tok-c").save(7);
    expect(await new PgTelegramOffsetStore(appPool, "tok-d").load()).toBe(0);
    const rows = await adminPool.query("SELECT bot_key FROM telegram_poll_state");
    for (const r of rows.rows as Array<{ bot_key: string }>) expect(r.bot_key).not.toContain("tok-");
  });
});
