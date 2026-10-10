import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BusinessService } from "@jarvis/business";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { parseUsageCliArgs, runProductUsageCli, UsageCliUsageError, type UsageCliIo } from "../src/product-usage-cli.ts";

/**
 * WP-D2 (UA-3 «churn/product usage»): eierens CLI (`product-usage-main.ts`) mot ekte Postgres som app-rolle. Dry-run som standard, ingen filstier (stdin), ukjente flagg
 * avvises, kun pseudonyme referanser, og utdata ekkoer aldri hendelsesinnhold.
 */
const BIZ = "tenant-wpd2-cli";
const PERSON = "tenant-wpd2-cli-person";
const OWNER = "person-wpd2-cli-owner";
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let business: BusinessService;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd2-cli-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_wpd2_cli LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_wpd2_cli");
  await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${BIZ}', 'Cli', 'business'), ('${PERSON}', 'Person', 'person')`);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd2_cli", password: "pw2" });
  business = new BusinessService(app);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

function makeIo(stdin: string | Error = ""): UsageCliIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines, errors,
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    readStdin: async () => { if (stdin instanceof Error) throw stdin; return stdin; }
  };
}
const run = async (argv: string[], stdin: string | Error = "") => {
  const io = makeIo(stdin);
  const code = await runProductUsageCli(argv, { owner_person_id: OWNER }, app, io);
  return { code, out: io.lines.join("\n"), err: io.errors.join("\n"), all: [...io.lines, ...io.errors].join("\n") };
};
const count = async (sql: string, params: unknown[] = []) => ((await admin.query(sql, params)).rows[0] as { n: number }).n;
const ago = (days: number) => new Date(Date.now() - days * 86_400_000 - 60_000).toISOString();
const csv = (rows: Array<Record<string, string>>, header = "event_id,account_ref,feature,occurred_at,quantity") =>
  `${header}\n${rows.map((r) => header.split(",").map((h) => r[h] ?? "").join(",")).join("\n")}\n`;

describe("A: argumentparsing (fail closed)", () => {
  it("gjenkjenner kommandoer og flagg; avviser ukjent kommando, ukjente flagg, manglende/doble verdier og løse argumenter", () => {
    expect(parseUsageCliArgs(["import", "--tenant", BIZ, "--format", "csv", "--label", "x", "--confirm"])).toEqual({
      command: "import", flags: { tenant: BIZ, format: "csv", label: "x" }, confirm: true
    });
    expect(parseUsageCliArgs(["accounts", "--tenant", BIZ, "--unlinked"])).toMatchObject({ command: "accounts", confirm: false, linked: false });
    expect(parseUsageCliArgs(["accounts", "--tenant", BIZ, "--linked"])).toMatchObject({ linked: true });
    for (const argv of [
      [], ["delete-all"], ["import", "--nope", "x"], ["import", "--tenant"], ["import", "--tenant", "--format"], ["import", "--tenant", BIZ, "--tenant", BIZ],
      ["import", "stray"], ["import", "--confirm", "--confirm"], ["accounts", "--linked", "--unlinked"], ["accounts", "--linked", "--linked"], ["import", "--file", "/etc/passwd"]
    ]) {
      expect(() => parseUsageCliArgs(argv), JSON.stringify(argv)).toThrowError(UsageCliUsageError);
    }
  });

  it("det finnes ingen flagg for filsti (ingen path traversal): filen leses kun fra stdin", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/product-usage-cli.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/readFile|createReadStream|from "node:fs/);
    expect(src).not.toMatch(/"file"|"path"|--file|--path/);
  });

  it("prosess-inngangen kjører som RUNTIME-rollen og stopper hvis den omgår RLS - aldri admin", () => {
    const main = readFileSync(fileURLToPath(new URL("../src/product-usage-main.ts", import.meta.url)), "utf8");
    expect(main).toContain("assertRuntimeCredentialsConfigured()");
    expect(main).toContain("assertRuntimeRoleSafe(pool)");
    expect(main).toContain("createPool(configFromEnv())");
    expect(main).not.toMatch(/adminConfigFromEnv/);
  });
});

describe("B: import - dry-run som standard, idempotent, aldri PII", () => {
  const rows = [
    { event_id: "cli-evt-000001", account_ref: "acct-cli-0001", feature: "chat.send", occurred_at: ago(3), quantity: "4" },
    { event_id: "cli-evt-000002", account_ref: "acct-cli-0001", feature: "export", occurred_at: ago(2), quantity: "1" },
    { event_id: "cli-evt-000003", account_ref: "acct-cli-0002", feature: "chat.send", occurred_at: ago(1), quantity: "2" }
  ];
  const importArgs = (extra: string[] = []) => ["import", "--tenant", BIZ, "--format", "csv", "--label", "cli-test", ...extra];

  it("uten --confirm: validerer og viser, men skriver ingenting (verken hendelser eller revisjon)", async () => {
    const r = await run(importArgs(), csv(rows));
    expect(r.code, r.all).toBe(0);
    expect(r.out).toContain("gyldige hendelser: 3 (kontoer: 2)");
    expect(r.out).toContain("DRY-RUN: ingenting er skrevet");
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE tenant_id = $1", [BIZ])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND type LIKE 'business.product_usage%'", [BIZ])).toBe(0);
  });

  it("med --confirm: lagrer; samme fil på nytt gir duplikater (idempotent); revisjonen bærer aktør og tellere", async () => {
    const first = await run(importArgs(["--confirm"]), csv(rows));
    expect(first.code, first.all).toBe(0);
    expect(first.out).toMatch(/lagret nå:\s+3\b/);
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE tenant_id = $1", [BIZ])).toBe(3);
    const again = await run(importArgs(["--confirm"]), csv(rows));
    expect(again.code, again.all).toBe(0);
    expect(again.out).toMatch(/lagret nå:\s+0\b/);
    expect(again.out).toMatch(/allerede lagret \(duplikater\):\s+3\b/);
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE tenant_id = $1", [BIZ])).toBe(3);
    const audit = (await admin.query("SELECT person_id, payload FROM audit_events WHERE tenant_id = $1 AND type = 'business.product_usage_ingested' ORDER BY audit_id LIMIT 1", [BIZ])).rows[0] as { person_id: string; payload: { via: string; source_id: string } };
    expect(audit.person_id).toBe(OWNER);
    expect(audit.payload).toMatchObject({ via: "import", source_id: "import:cli-test" });
  });

  it("samme hendelses-id med ANNET innhold gir konflikt: ikke anvendt og exit 3", async () => {
    const r = await run(importArgs(["--confirm"]), csv([{ ...rows[0] as Record<string, string>, quantity: "99" }]));
    expect(r.code).toBe(3);
    expect(r.err).toContain("ANNET innhold");
    expect((await admin.query("SELECT quantity FROM product_usage_events WHERE external_event_id = 'cli-evt-000001'")).rows[0]).toEqual({ quantity: 4 });
  });

  it("ugyldige linjer listes med linjenummer og kode (aldri innhold); resten lagres", async () => {
    const mixed = csv([
      { event_id: "cli-evt-000010", account_ref: "acct-cli-0003", feature: "chat.send", occurred_at: ago(1), quantity: "1" },
      { event_id: "cli-evt-000011", account_ref: "ola.nordmann@example.com", feature: "chat.send", occurred_at: ago(1), quantity: "1" },
      { event_id: "x", account_ref: "acct-cli-0003", feature: "chat.send", occurred_at: ago(1), quantity: "1" }
    ]);
    const r = await run(importArgs(["--confirm"]), mixed);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toContain("avvist #3: account_ref_invalid_or_not_pseudonymous");
    expect(r.out).toContain("avvist #4: event_id_invalid");
    expect(r.all).not.toMatch(/ola\.nordmann|example\.com/);
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE external_event_id = 'cli-evt-000010'")).toBe(1);
  });

  it("personopplysninger via ekstra kolonne avviser HELE filen (exit 2) uten å skrive, og navnet på kolonnen - ikke verdiene - vises", async () => {
    const header = "event_id,account_ref,feature,occurred_at,email";
    const r = await run(importArgs(["--confirm"]), `${header}\ncli-evt-000020,acct-cli-0004,chat.send,${ago(1)},ola@example.com\n`);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown_column: email");
    expect(r.all).not.toContain("ola@example.com");
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE external_event_id = 'cli-evt-000020'")).toBe(0);
  });

  it("tom inndata, for stor fil, ugyldig format/etikett/tenant og person-tenant avvises", async () => {
    expect((await run(importArgs(["--confirm"]), "")).code).toBe(2);
    expect((await run(importArgs(["--confirm"]), "   \n")).code).toBe(2);
    const big = await run(importArgs(["--confirm"]), new Error("file_too_large"));
    expect(big.code).toBe(2);
    expect(big.err).toContain("for stor");
    expect((await run(["import", "--tenant", BIZ, "--format", "xlsx", "--label", "x"], csv(rows))).code).toBe(2);
    expect((await run(["import", "--tenant", BIZ, "--format", "csv", "--label", "Upper Case"], csv(rows))).code).toBe(2);
    expect((await run(["import", "--tenant", "BAD TENANT", "--format", "csv", "--label", "x"], csv(rows))).code).toBe(2);
    expect((await run(["import", "--format", "csv", "--label", "x"], csv(rows))).code).toBe(2);
    const person = await run(["import", "--tenant", PERSON, "--format", "csv", "--label", "x", "--confirm"], csv(rows));
    expect(person.code).toBe(3);
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE tenant_id = $1", [PERSON])).toBe(0);
  });

  it("JSONL fungerer likt", async () => {
    const lines = [{ event_id: "cli-jsonl-00001", account_ref: "acct-cli-0005", feature: "chat.send", occurred_at: ago(1) }].map((e) => JSON.stringify(e)).join("\n");
    const r = await run(["import", "--tenant", BIZ, "--format", "jsonl", "--label", "j1", "--confirm"], lines);
    expect(r.code, r.all).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE external_event_id = 'cli-jsonl-00001'")).toBe(1);
  });
});

describe("C: kontoer, kobling, frakobling og «glem bruker»", () => {
  it("accounts lister ukoblede/koblede; link er dry-run uten --confirm; ukjent selskap gir exit 3; ugyldig referanse gir exit 2", async () => {
    const company = await business.createCompany(BIZ, "business", { name: "Cli Kunde AS" });
    const unlinked = await run(["accounts", "--tenant", BIZ, "--unlinked"]);
    expect(unlinked.code).toBe(0);
    expect(unlinked.out).toContain("acct-cli-0001");
    const dry = await run(["link", "--tenant", BIZ, "--account", "acct-cli-0001", "--company", company.company_id]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("DRY-RUN");
    expect((await admin.query("SELECT company_id FROM product_usage_accounts WHERE tenant_id = $1 AND account_ref = 'acct-cli-0001'", [BIZ])).rows[0]).toEqual({ company_id: null });
    expect((await run(["link", "--tenant", BIZ, "--account", "acct-cli-0001", "--company", "biz-co-finnes-ikke", "--confirm"])).code).toBe(3);
    expect((await run(["link", "--tenant", BIZ, "--account", "ola@example.com", "--company", company.company_id, "--confirm"])).code).toBe(2);
    const ok = await run(["link", "--tenant", BIZ, "--account", "acct-cli-0001", "--company", company.company_id, "--confirm"]);
    expect(ok.code, ok.all).toBe(0);
    expect(ok.out).toContain("Koblet acct-cli-0001");
    const again = await run(["link", "--tenant", BIZ, "--account", "acct-cli-0001", "--company", company.company_id, "--confirm"]);
    expect(again.out).toContain("Allerede koblet");
    const linked = await run(["accounts", "--tenant", BIZ, "--linked"]);
    expect(linked.out).toContain(`acct-cli-0001  selskap=${company.company_id}`);
    expect(linked.out).not.toContain("acct-cli-0002");
    const un = await run(["unlink", "--tenant", BIZ, "--account", "acct-cli-0001", "--confirm"]);
    expect(un.out).toContain("fjernet");
    expect((await run(["unlink", "--tenant", BIZ, "--account", "acct-cli-0001", "--confirm"])).out).toContain("ikke koblet");
  });

  it("forget-user: dry-run uten --confirm; med --confirm nulles user_ref og volum beholdes", async () => {
    await run(["import", "--tenant", BIZ, "--format", "jsonl", "--label", "usr", "--confirm"], JSON.stringify({ event_id: "cli-usr-000001", account_ref: "acct-cli-0006", user_ref: "usr_cliforget01", feature: "chat.send", quantity: 5, occurred_at: ago(1) }));
    const dry = await run(["forget-user", "--tenant", BIZ, "--user", "usr_cliforget01"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("DRY-RUN");
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE user_ref = 'usr_cliforget01'")).toBe(1);
    const done = await run(["forget-user", "--tenant", BIZ, "--user", "usr_cliforget01", "--confirm"]);
    expect(done.code, done.all).toBe(0);
    expect(done.out).toContain("1 hendelser");
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE user_ref = 'usr_cliforget01'")).toBe(0);
    expect((await admin.query("SELECT quantity FROM product_usage_events WHERE external_event_id = 'cli-usr-000001'")).rows[0]).toEqual({ quantity: 5 });
    expect((await run(["forget-user", "--tenant", BIZ, "--user", "ola@example.com", "--confirm"])).code).toBe(2);
  });
});
