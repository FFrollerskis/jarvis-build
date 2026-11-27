import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REQUEST_DIGEST_MAX_DEPTH, REQUEST_DIGEST_TEST_VECTORS, REQUEST_DIGEST_VERSION } from "@jarvis/contracts";
import {
  DIGEST_EXCLUDED_PARAMETERS, IDEMPOTENCY_RULE_REASONS, LEDGER_RESERVED_FLOOR_MINUTES, LEDGER_RESERVED_TTL_DEFAULT_MINUTES, LEDGER_RESERVED_TTL_MAX_MINUTES, LEDGER_RESERVED_TTL_MIN_MINUTES,
  LEDGER_SWEEP_BATCH, LEDGER_SWEEP_MAX_BATCHES, LEDGER_UNVERIFIED_TTL_DEFAULT_HOURS, LEDGER_UNVERIFIED_TTL_MAX_HOURS, LEDGER_UNVERIFIED_TTL_MIN_HOURS
} from "../src/index.ts";

/**
 * WP-T1 K7: dokumentvakt for `docs/runbooks/WPT1_REQUEST_DIGEST.md`. Runbooken er spesifikasjonen andre implementasjoner (en signerende enhet, en fremtidig Approval v2) leser, og driftsveiledningen eieren følger: tallene, vektorene, flaggene og revisjonstypene i den skal
 * ikke kunne råtne bort fra koden. Hver påstand under er avledet fra koden/fixturen (aldri hardkodet i testen), slik at en endring av koden feller testen til dokumentet er oppdatert.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string): string => readFileSync(`${ROOT}${rel}`, "utf8");
const DOC = read("docs/runbooks/WPT1_REQUEST_DIGEST.md");
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Tegn som overlever alle redigeringsverktøy i en kodeblokk: utskrivbar ASCII og Latin-1 (uten kontrolltegn, kombinerende tegn og astrale tegn). */
const printableLatin1 = (text: string): boolean => [...text].every((ch) => { const c = ch.codePointAt(0)!; return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff); });

describe("K1: digest-spesifikasjonen og vektorene i runbooken er de samme som i koden", () => {
  it("versjon og maks dybde i teksten er kodens", () => {
    expect(DOC).toContain(`v: ${REQUEST_DIGEST_VERSION}`);
    expect(DOC).toContain(`dybde over ${REQUEST_DIGEST_MAX_DEPTH}`);
    expect(DOC).toContain("(versjon 1)");
  });

  it("HVER feilkode modulen kan gi (`RequestDigestErrorCode`) er omtalt i avvisningsavsnittet", () => {
    const source = read("packages/contracts/src/request-digest.ts");
    const union = source.match(/export type RequestDigestErrorCode =([\s\S]*?);/);
    expect(union).not.toBeNull();
    const codes = [...union![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThanOrEqual(8);
    const section = DOC.slice(DOC.indexOf("### 3.2 Avvisning"), DOC.indexOf("### 3.3"));
    for (const code of codes) expect(section, code).toContain(`\`${code}\``);
  });

  it("HVER publiserte vektor har en tabellrad med navn og SHA-256 som i modulen", () => {
    expect(REQUEST_DIGEST_TEST_VECTORS.length).toBe(14);
    for (const v of REQUEST_DIGEST_TEST_VECTORS) expect(DOC, v.name).toMatch(new RegExp(`\\| \`${escapeRe(v.name)}\` \\|[^\\n]*\\| \`${v.digest}\` \\|`));
  });

  it("HVER vektor som kan skrives lesbart har sin kanoniske streng i kodeblokken, og SHA-256 av nøyaktig den teksten er tabellens digest", () => {
    let shown = 0;
    for (const v of REQUEST_DIGEST_TEST_VECTORS) {
      if (!printableLatin1(v.canonical)) continue;
      const line = DOC.match(new RegExp(`^${escapeRe(v.name)}\\s+(\\{.*\\})$`, "m"));
      expect(line, `kanonisk streng for ${v.name} mangler i runbooken`).not.toBeNull();
      expect(line![1]).toBe(v.canonical);
      expect(createHash("sha256").update(line![1]!, "utf8").digest("hex")).toBe(v.digest);
      shown += 1;
    }
    expect(shown).toBeGreaterThanOrEqual(10);
    // De tre som ikke gjengis er nettopp de med kombinerende tegn, kontrolltegn og astrale tegn.
    expect(REQUEST_DIGEST_TEST_VECTORS.filter((v) => !printableLatin1(v.canonical)).map((v) => v.name).sort()).toEqual(["key_sort_utf16", "unicode_escaping", "unicode_nfd"]);
  });
});

describe("K2/K5: flagg, grenser og migrasjoner", () => {
  it("alle fem flaggene er omtalt med standard og grenser fra koden", () => {
    for (const flag of ["JARVIS_TOOL_REQUEST_DIGEST", "JARVIS_TOOL_LEDGER_RECONCILE", "JARVIS_TOOL_LEDGER_RESERVED_TTL_MINUTES", "JARVIS_TOOL_LEDGER_UNVERIFIED_TTL_HOURS", "JARVIS_TOOL_LEDGER_RECONCILE_HOUR"]) expect(DOC, flag).toContain(`\`${flag}\``);
    expect(DOC).toContain(`| \`JARVIS_TOOL_LEDGER_RESERVED_TTL_MINUTES\` | api | ${LEDGER_RESERVED_TTL_DEFAULT_MINUTES} | heltall ${LEDGER_RESERVED_TTL_MIN_MINUTES}-${LEDGER_RESERVED_TTL_MAX_MINUTES} |`);
    expect(DOC).toContain(`| \`JARVIS_TOOL_LEDGER_UNVERIFIED_TTL_HOURS\` | api | ${LEDGER_UNVERIFIED_TTL_DEFAULT_HOURS} | heltall ${LEDGER_UNVERIFIED_TTL_MIN_HOURS}-${LEDGER_UNVERIFIED_TTL_MAX_HOURS} |`);
    expect(DOC).toContain(`batcher à ${LEDGER_SWEEP_BATCH} (opptil ${LEDGER_SWEEP_MAX_BATCHES} batcher`);
    // Norsk tusenskille (mellomrom): 10 000.
    expect(DOC).toContain(`${String(LEDGER_SWEEP_BATCH * LEDGER_SWEEP_MAX_BATCHES).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} rader`);
  });

  it("databasegulvene i triggeren er de som runbooken oppgir (10 minutter for reserved, 1 time for unverified)", () => {
    const sql = read("modules/core/src/db/migrations/154_tool_executions_reconcile.sql");
    expect(LEDGER_RESERVED_FLOOR_MINUTES).toBe(10);
    expect(sql).toContain(`interval '${LEDGER_RESERVED_FLOOR_MINUTES} minutes'`);
    expect(sql).toContain("interval '1 hour'");
    expect(DOC).toContain("10 minutter gammel");
    expect(DOC).toContain("ikke før 1 time");
  });

  it("migrasjonene 153 og 154 finnes og er omtalt med filnavn", () => {
    for (const file of ["153_tool_executions_request_digest.sql", "154_tool_executions_reconcile.sql"]) {
      expect(existsSync(`${ROOT}modules/core/src/db/migrations/${file}`), file).toBe(true);
      expect(DOC, file).toContain(file);
    }
  });

  it("alle revisjonstyper koden skriver for WP-T1 er omtalt (ingen skjult revisjonstype)", () => {
    const sources = [read("modules/tool-gateway/src/gateway.ts"), read("modules/tool-gateway/src/ledger-reconcile.ts")].join("\n");
    const types = new Set([...sources.matchAll(/"(tool\.(?:idempotency_[a-z_]+|ledger_[a-z_]+|request_digest_[a-z_]+))"/g)].map((m) => m[1]!));
    expect([...types].sort()).toEqual([
      "tool.idempotency_key_missing_observed", "tool.idempotency_key_reuse_mismatch", "tool.idempotency_key_reuse_observed", "tool.idempotency_legacy_row", "tool.ledger_reconciled", "tool.ledger_resolved", "tool.request_digest_invalid_observed"
    ]);
    for (const type of types) expect(DOC, type).toContain(`\`${type}\``);
  });
});

describe("K4: regeltallene i runbooken er fixturens", () => {
  const rows = JSON.parse(read("apps/api/test/fixtures/wpt1-idempotency-decisions.json")) as Array<{ key: string; mode: string; rule: string }>;

  it("hver regel (unntatt lesing) har en tabellrad med nøkkelkrav og antall som i fixturen", () => {
    const rules = Object.keys(IDEMPOTENCY_RULE_REASONS).filter((r) => r !== "R1_read");
    expect(rules).toHaveLength(8);
    for (const rule of rules) {
      const own = rows.filter((r) => r.rule === rule);
      expect(own.length, rule).toBeGreaterThan(0);
      const modes = new Set(own.map((r) => r.mode));
      expect(modes.size, `${rule}: én modus per regel`).toBe(1);
      expect(DOC, rule).toContain(`| \`${rule}\` | \`${[...modes][0]}\` | ${own.length} |`);
    }
  });

  it("totalene stemmer: antall skrivehandlinger, `required` og `optional`", () => {
    const required = rows.filter((r) => r.mode === "required").length;
    const optional = rows.filter((r) => r.mode === "optional").length;
    expect(required + optional).toBe(rows.length);
    expect(DOC).toContain(`(${rows.length} av ca.`);
    expect(DOC).toContain(`Totalt ${required} handlinger er \`required\` og ${optional} \`optional\``);
  });

  it("de utelatte hemmelighetsfeltene og handlingene de gjelder er omtalt", () => {
    for (const [action, fields] of Object.entries(DIGEST_EXCLUDED_PARAMETERS)) {
      expect(DOC, action).toContain(`\`${action}\``);
      for (const field of fields) expect(DOC, `${action}.${field}`).toContain(`\`${field}\``);
    }
  });
});

describe("hygiene (offentlig repo)", () => {
  it("runbooken har ingen e-postadresser, telefonnumre eller eksterne URL-er (kun relative lenker)", () => {
    expect(DOC).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(DOC).not.toMatch(/https?:\/\//);
    expect(DOC).not.toMatch(/(?<![A-Za-z0-9])\+\d{2}[ -]?\d{6,}/); // telefonnummer (ikke `U+0301` eller `1e+21`)
  });

  it("runbooken har statusbanneret, NOT VERIFIED og rollback", () => {
    expect(DOC).toMatch(/IKKE KJØRT MOT NAS-en, IKKE DEPLOYET, INGENTING ER `VERIFIED`/);
    expect(DOC).toContain("`NOT VERIFIED`");
    expect(DOC).toContain("Rollback");
  });
});
