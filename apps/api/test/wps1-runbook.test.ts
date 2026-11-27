import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEVICE_KINDS,
  ENROLLABLE_DEVICE_KINDS,
  STEPUP_BINDING_NOT_ENFORCED,
  STEPUP_BOUND_FLAG_GROUPS,
  STEPUP_CHANNEL_BINDING_ENV,
  allowedChannelsForDeviceKind,
  deviceKindHoldsStepUpChannel
} from "@jarvis/contracts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-S1 K6: runbooken er et KRAV på hva eieren skal gjøre på NAS, så den må ikke råtne uten at noe feiler. Låst her:
 *  A. mappingstabellen (§2) er NØYAKTIG `DEVICE_KIND_CHANNELS` + `legacy_unknown`-regelen, inkludert hvilke typer som kan gi step-up;
 *  B. flaggtabellen (§3) er NØYAKTIG registeret over de fail-closed koblede flaggene;
 *  C. HVER SQL-snippet i utrullingen (§7) kjøres mot en ekte, migrert database med realistiske rader (kolonnenavn, uttrykk og resultat), inkludert admin-retting av en type;
 *  D. billett-kommandoen lister NØYAKTIG de lukkede billettypene, og revisjonstypene/årsakene runbooken nevner finnes i koden;
 *  E. statusord og personvern (ingen «VERIFIED» uten NOT_, ingen e-postadresser/personnavn i en offentlig repo).
 */
const RUNBOOK = readFileSync(fileURLToPath(new URL("../../../docs/runbooks/WPS1_STEPUP_CHANNEL_BINDING.md", import.meta.url)), "utf8");
const source = (path: string): string => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8");

function section(from: RegExp, to: RegExp): string {
  const start = RUNBOOK.search(from);
  expect(start, `fant ikke seksjonen ${String(from)}`).toBeGreaterThanOrEqual(0);
  const rest = RUNBOOK.slice(RUNBOOK.indexOf("\n", start) + 1);
  const end = rest.search(to);
  return end < 0 ? rest : rest.slice(0, end);
}
const ticks = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);

describe("A: mappingstabellen i runbooken er tabellen i koden", () => {
  const sec = section(/^## 2\. /m, /^## 3\. /m);
  const rows = sec.split("\n").filter((l) => l.startsWith("| `")).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));

  it("radene dekker NØYAKTIG de lukkede typene, og hver rad har samme kanaler og step-up-evne som koden", () => {
    const seen: string[] = [];
    for (const cells of rows) {
      const kinds = ticks(cells[0] ?? "");
      const channelCell = cells[1] ?? "";
      const stepUpCell = cells[2] ?? "";
      for (const kind of kinds) {
        seen.push(kind);
        expect(DEVICE_KINDS as readonly string[], kind).toContain(kind);
        const docChannels = kind === "legacy_unknown" ? ticks(channelCell.slice(channelCell.indexOf("altså"))) : ticks(channelCell);
        expect(new Set(docChannels), `kanaler for ${kind}`).toEqual(new Set(allowedChannelsForDeviceKind(kind as (typeof DEVICE_KINDS)[number])));
        expect(docChannels.length, `ingen duplikater for ${kind}`).toBe(new Set(docChannels).size);
        expect(stepUpCell.startsWith("ja"), `step-up-evne for ${kind}`).toBe(deviceKindHoldsStepUpChannel(kind));
      }
    }
    expect([...seen].sort()).toEqual([...DEVICE_KINDS].sort());
  });

  it("legacy_unknown-raden sier at den ALDRI kan gi step-up, og invarianten er nevnt", () => {
    const legacy = rows.find((c) => ticks(c[0] ?? "").includes("legacy_unknown"));
    expect(legacy?.[2]).toContain("aldri");
    expect(sec).toContain("Invariant");
    expect(sec).toContain("device-kind.test.ts");
  });
});

describe("B: flaggtabellen (§3) er registeret over de fail-closed koblede flaggene", () => {
  const sec = section(/^## 3\. /m, /^## 4\. /m);
  const flagRows = sec.split("\n").filter((l) => /^\| `(personal|growth_write|comms_outbound|situation_signals)` \|/.test(l));

  it("hver gruppe har en rad med NØYAKTIG flaggene i koden, og alle fire gruppene finnes", () => {
    expect(flagRows.map((l) => ticks(l.split("|")[1] ?? "")[0]).sort()).toEqual(STEPUP_BOUND_FLAG_GROUPS.map((g) => g.id).sort());
    for (const group of STEPUP_BOUND_FLAG_GROUPS) {
      const row = flagRows.find((l) => ticks(l.split("|")[1] ?? "")[0] === group.id) as string;
      const docFlags = ticks(row.split("|")[2] ?? "").filter((t) => t.startsWith("JARVIS_"));
      expect(docFlags.sort(), group.id).toEqual(group.flags.map((f) => f.name).sort());
    }
  });

  it("modusnavn, årsakskode og miljøvariabelen er nevnt, og den rå modusverdien `enforce`/`observe` forklares", () => {
    expect(sec).toContain(STEPUP_CHANNEL_BINDING_ENV);
    expect(sec).toContain(STEPUP_BINDING_NOT_ENFORCED);
    expect(sec).toContain("`observe`");
    expect(sec).toContain("`enforce`");
    expect(sec).toContain("invalid_value");
  });
});

describe("C: SQL-snippene i utrullingen kjører mot en ekte, migrert database", () => {
  let db: H0Db;
  const T = "tenant-s1r";
  const P = "person-s1r";
  beforeAll(async () => {
    db = await startH0Db("wps1runbook");
    await seedTenants(db.adminPool, [{ tenant_id: T, person_id: P }]);
    await db.adminPool.query(
      `INSERT INTO devices (device_id, tenant_id, person_id, kind, device_kind, device_kind_source, public_key_pem) VALUES
        ('dev-r-1', $1, $2, 'web', 'web_browser', 'legacy_label', 'k1'),
        ('dev-r-2', $1, $2, 'phone', 'legacy_unknown', 'unclassified', 'k2'),
        ('dev-r-3', $1, $2, 'x', 'iphone', 'enrollment_ticket', 'k3')`, [T, P]
    );
    for (const [device, channel, kind] of [["dev-r-2", "web", "legacy_unknown"], ["dev-r-2", "web", "legacy_unknown"], ["dev-r-2", "mobile", "legacy_unknown"], ["dev-r-1", "mobile", "web_browser"]] as const) {
      await db.adminPool.query(
        `INSERT INTO audit_events (tenant_id, person_id, device_id, type, decision, reason, payload, actor_kind) VALUES ($1, $2, $3, 'identity.channel_binding_would_deny', 'ALLOW', 'channel_not_allowed_for_device_kind', $4::jsonb, 'system')`,
        [T, P, device, JSON.stringify({ mode: "observe", device_kind: kind, channel })]
      );
    }
  }, 240_000);
  afterAll(async () => { await db?.stop(); }, 120_000);

  const sec = (): string => section(/^## 7\. /m, /^## 8\. /m);
  const snippets = (): string[] => [...sec().matchAll(/psql -U postgres -d jarvis -c \\\n\s+"([^"]+)"/g)].map((m) => m[1] as string);

  it("det finnes to leseforespørsler (enhetsliste og would-deny-oppsummering), og de bruker kun lesing", () => {
    const found = snippets();
    expect(found).toHaveLength(2);
    for (const q of found) expect(q.trimStart().toUpperCase().startsWith("SELECT")).toBe(true);
  });

  it("enhetslisten gir (tenant, person, enhet, gammel etikett, type, kilde, tilbakekalt, opprettet) for ALLE rader", async () => {
    const q = (snippets()[0] as string).replace(/;\s*$/, "");
    const result = await db.adminPool.query(q);
    expect(result.fields.map((f) => f.name)).toEqual(["tenant_id", "person_id", "device_id", "gammel_etikett", "device_kind", "device_kind_source", "tilbakekalt", "created_at"]);
    const byId = Object.fromEntries(result.rows.map((r) => [r.device_id as string, r]));
    expect(byId["dev-r-1"]).toMatchObject({ gammel_etikett: "web", device_kind: "web_browser", device_kind_source: "legacy_label", tilbakekalt: false });
    expect(byId["dev-r-2"]).toMatchObject({ gammel_etikett: "phone", device_kind: "legacy_unknown", device_kind_source: "unclassified", tilbakekalt: false });
    expect(byId["dev-r-3"]).toMatchObject({ device_kind: "iphone", device_kind_source: "enrollment_ticket" });
  });

  it("would-deny-oppsummeringen teller per (enhet, type, kanal) og viser siste tidspunkt", async () => {
    const q = (snippets()[1] as string).replace(/;\s*$/, "");
    const result = await db.adminPool.query(q);
    expect(result.fields.map((f) => f.name)).toEqual(["device_id", "type", "kanal", "antall", "sist"]);
    const flat = result.rows.map((r) => `${r.device_id}|${r.type}|${r.kanal}|${r.antall}`).sort();
    expect(flat).toEqual(["dev-r-1|web_browser|mobile|1", "dev-r-2|legacy_unknown|mobile|1", "dev-r-2|legacy_unknown|web|2"]);
  });

  it("admin-rettingen av en type (transaksjons-lokal tillatelse) virker som beskrevet, og endringen revideres av databasevakten", async () => {
    const block = [...RUNBOOK.matchAll(/```\n(BEGIN;[\s\S]*?COMMIT;)\n```/g)].map((m) => m[1] as string).find((b) => b.includes("jarvis.device_kind_change"));
    expect(block, "fant admin-SQL-blokken i runbooken").toBeDefined();
    const sql = (block as string).replace("<tenant>", T).replace("<device_id>", "dev-r-2");
    const client = await db.adminPool.connect();
    try { await client.query(sql); } finally { await client.query("ROLLBACK").catch(() => undefined); client.release(); }
    const row = (await db.adminPool.query("SELECT device_kind, device_kind_source FROM devices WHERE device_id = 'dev-r-2'")).rows[0];
    expect(row).toEqual({ device_kind: "iphone", device_kind_source: "trusted_provisioning" });
    const audit = (await db.adminPool.query("SELECT payload FROM audit_events WHERE device_id = 'dev-r-2' AND type = 'device.kind_changed'")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({ from: "legacy_unknown", to: "iphone", from_source: "unclassified", to_source: "trusted_provisioning" });
  });

  it("uten den transaksjons-lokale tillatelsen avvises endringen (det er hele poenget med vakten)", async () => {
    await expect(db.adminPool.query("UPDATE devices SET device_kind = 'mac', device_kind_source = 'trusted_provisioning' WHERE device_id = 'dev-r-1'")).rejects.toThrow(/device_kind_change_not_authorized/);
  });
});

describe("D: billett-kommandoen og revisjonstypene i runbooken er de i koden", () => {
  it("--kind-listen i billett-kommandoen er NØYAKTIG de lukkede billettypene (aldri legacy_unknown)", () => {
    const m = RUNBOOK.match(/--kind <([a-z_|]+)>/);
    expect(m, "fant --kind <...> i runbooken").not.toBeNull();
    const listed = (m as RegExpMatchArray)[1]?.split("|") ?? [];
    expect([...listed].sort()).toEqual([...ENROLLABLE_DEVICE_KINDS].sort());
    expect(listed).not.toContain("legacy_unknown");
  });

  it("hver revisjonstype og årsak i §8 skrives faktisk av koden", () => {
    const sec = section(/^## 8\. /m, /^## 9\. /m);
    const code = [
      source("modules/core/src/services/device-authority.ts"), source("modules/core/src/services/device-enrollment-service.ts"), source("modules/core/src/services/session-grant-service.ts"),
      source("modules/core/src/db/migrations/149_device_kind_channel_binding.sql"), source("modules/core/src/services/identity-service.ts"), source("modules/core/src/services/device-service.ts")
    ].join("\n");
    const types = sec.split("\n").filter((l) => l.startsWith("| `")).map((l) => ticks(l.split("|")[1] ?? "")[0] as string);
    expect(types.sort()).toEqual(["device.enrolled", "device.enrollment_denied", "device.enrollment_would_deny", "device.kind_changed", "device.kind_classified", "identity.channel_binding_would_deny", "identity.denied", "session_grant.denied"]);
    for (const type of types) expect(code, type).toContain(type);
    for (const reason of ["channel_not_allowed_for_device_kind", "authorizing_device_kind_not_allowed"]) {
      expect(sec, reason).toContain(reason);
      expect(code + source("packages/contracts/src/session-grant.ts"), reason).toContain(reason);
    }
  });

  it("modusvariabelen finnes i api-containerens miljø, og kun der", () => {
    const env = source("infra/local/service-env.mjs");
    expect(env).toContain(`"${STEPUP_CHANNEL_BINDING_ENV}"`);
    const compose = source("infra/local/docker-compose.yml");
    expect(compose).toContain(`${STEPUP_CHANNEL_BINDING_ENV}: "\${${STEPUP_CHANNEL_BINDING_ENV}:-}"`);
    expect([...compose.matchAll(new RegExp(`^\\s+${STEPUP_CHANNEL_BINDING_ENV}:`, "gm"))], "kun api-tjenesten leser modusen").toHaveLength(1);
  });
});

describe("E: statusord og personvern", () => {
  it("ingen forekomst av VERIFIED uten NOT_ foran (bortsett fra setningen som forbyr ordet)", () => {
    const stripped = RUNBOOK.replace(/NOT_VERIFIED/g, "").replace(/Ingenting her er `VERIFIED`/g, "");
    expect(stripped).not.toMatch(/\bVERIFIED\b/);
    expect(RUNBOOK).toContain("`NOT_VERIFIED`");
    expect(RUNBOOK).toContain("`DORMANT`");
    expect(RUNBOOK).toContain("`DEFERRED`");
  });

  it("ingen e-postadresser, personnavn eller kontoer (repoet er offentlig)", () => {
    expect(RUNBOOK).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    for (const forbidden of [/tobias/i, /tsworkflow/i, /ffrollerskis/i]) expect(RUNBOOK).not.toMatch(forbidden);
    expect(RUNBOOK).not.toMatch(/\bhttps?:\/\/(?!<)[^\s`)]*\.ts\.net/);
  });
});
