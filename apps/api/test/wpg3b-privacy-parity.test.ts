import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ControlCenterRegistry, type ControlCenterReport } from "@jarvis/executive";
import { DocReader, RETENTION_JOBS, createPrivacyCenter } from "../src/control-center/privacy.ts";
import { ScriptedPool, type ScriptedRule } from "./support/scripted-pool.ts";

/**
 * WP-G3b (D-485), K2: Personvern-senteret med Syn-kortet AV er BYTE-IDENTISK med main.
 *
 * Beviset er et OPPTAK av hele rapporten (`fixtures/wpg3b-privacy-center-main-baseline.json`) tatt FØR noen G3b-endring i `privacy.ts`/`register.ts` (arbeidstreet var da identisk med `origin/main` 71a31d8b for disse filene;
 * `baseline_sha` i fixturen). Samme komposisjon som main (ScriptedPool + fast klokke + en liten syntetisk behandlingsoversikt, så opptaket ikke avhenger av innholdet i `docs/`) skal gi nøyaktig samme rapport etter
 * endringen når `vision` ikke er koblet inn - også når flagget `JARVIS_VISION_ENABLED` er AV selv om en kilde er gitt (se `wpg3b-privacy-vision-card.test.ts`).
 *
 * Regenerere opptaket (kun etter en bevisst endring av selve senteret, og si det i rapporten): `JARVIS_RECORD_BASELINES=1 pnpm exec vitest run apps/api/test/wpg3b-privacy-parity.test.ts` som `postgres`-bruker.
 */
const NOW = new Date("2026-11-14T10:00:00.000Z");
const H = 3_600_000;
const D = 24 * H;
const iso = (msAgo: number): string => new Date(NOW.getTime() - msAgo).toISOString();
const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/wpg3b-privacy-center-main-baseline.json", import.meta.url));
const BASELINE_SHA = "71a31d8bb5bc8c09359c491dd6b843cbc16a4140"; // origin/main ved opptaket (`git diff origin/main -- apps/api/src/control-center` var tom); kun en etikett, ikke brukt som sti

const owner: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };

const INVENTORY = [
  "# Behandlingsoversikt (testfiksur for G3b-opptaket)",
  "",
  "**Status: UTKAST** - IKKE juridisk gjennomgått og IKKE godkjent av eier.",
  "",
  "## 1. Datakategorier",
  "",
  "### Samtaler",
  "- **Tabeller:** `messages`, `tasks`",
  "",
  "### Revisjon",
  "- **Tabeller:** `audit_events`",
  "",
  "## 2. Behandlere",
  "",
  "### 2a. Modellleverandører",
  "",
  "| Leverandør | Region | Vilkår |",
  "|---|---|---|",
  "| Lokal | EU | VERIFISERT |",
  "| Sky | USA | IKKE VERIFISERT |",
  "",
  "### 2b. Connectorer",
  "",
  "| Connector | Vilkår |",
  "|---|---|",
  "| Kalender | IKKE VERIFISERT |",
  "",
  "## 3. DPIA-trigger-matrise",
  "",
  "| Trigger | Eksempel | Krever | Dokument | Status |",
  "|---|---|---|---|---|",
  "| Kamera og bilder | k | ja | `docs/UA9_VISION_DPIA.md` | UTKAST |",
  "| Helse | h | ja | `docs/finnes-ikke.md` | UTKAST |",
  "",
  "## 4. Slutt",
  ""
].join("\n");

function syntheticRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-g3b-parity-"));
  mkdirSync(join(root, "docs", "security"), { recursive: true });
  writeFileSync(join(root, "docs", "security", "PROCESSING_INVENTORY.md"), INVENTORY, "utf8");
  writeFileSync(join(root, "docs", "UA9_VISION_DPIA.md"), "# DPIA (testfiksur)\n", "utf8");
  return root;
}

const JOB_ROWS = (names: string[]): Array<Record<string, unknown>> => names.map((job_name) => ({ job_name, last_completed_at: iso(5 * H), last_open: false, last_had_error: false, last_attempts: 1 }));
function rules(): ScriptedRule[] {
  return [
    { match: /FROM pg_tables/, rows: [{ tablename: "audit_events" }, { tablename: "tasks" }, { tablename: "messages" }, { tablename: "ny_tabell_uten_rad" }] },
    { match: /FROM scheduler_state/, rows: JOB_ROWS(RETENTION_JOBS.map((j) => j.job)) },
    { match: /FROM tool_executions/, rows: [{ tool_executions: 3, session_grants: 0 }] },
    { match: /min\(at\)/, rows: [{ audit_oldest: iso(200 * D), cost_oldest: iso(150 * D) }] },
    { match: /GROUP BY status, scope_type/, rows: [{ status: "completed", scope_type: "person", n: 2, last_started_at: iso(10 * D), last_completed_at: iso(10 * D) }] },
    { match: /FILTER \(WHERE status = 'failed'\)/, rows: [{ failed: 1, pending_stale: 0 }] },
    { match: /FROM erasure_fingerprints/, rows: [{ n: 5 }] }
  ];
}

/** Rapportene under tre skjebner for dokumentet: syntetisk oversikt, dokument som ikke finnes, og en kilde som er nede. Samme env for alle (`JARVIS_MEMORY_RETENTION_DAYS` er satt: den vises). */
async function scenarios(buildCenter: (opts: { pool: ScriptedPool; repoRoot: string; docReader: DocReader }) => ReturnType<typeof createPrivacyCenter>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const root = syntheticRoot();
  const cases: Array<[string, ScriptedPool, string]> = [
    ["synthetic_doc", new ScriptedPool(rules()), root],
    ["missing_doc", new ScriptedPool(rules()), join(root, "finnes-ikke")],
    ["everything_down", new ScriptedPool([{ match: /./, rows: new Error("connect ECONNREFUSED 10.9.9.9:5432 password=hemmelig") }]), root]
  ];
  for (const [name, pool, repoRoot] of cases) {
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registry.register(buildCenter({ pool, repoRoot, docReader: new DocReader() }));
    out[name] = JSON.parse(JSON.stringify((await registry.report("privacy", owner)) as ControlCenterReport));
  }
  return out;
}

const plainCenter = (opts: { pool: ScriptedPool; repoRoot: string; docReader: DocReader }): ReturnType<typeof createPrivacyCenter> =>
  createPrivacyCenter({ pool: opts.pool.asPool(), env: { JARVIS_MEMORY_RETENTION_DAYS: "90" }, repoRoot: opts.repoRoot, docReader: opts.docReader });

describe("Personvern-senteret uten Syn-kort er byte-identisk med opptaket fra ren main", () => {
  it("opptaket (tatt FØR G3b) og dagens senter uten `vision` gir nøyaktig samme rapport i alle tre scenarier", async () => {
    const actual = await scenarios(plainCenter);
    if (process.env["JARVIS_RECORD_BASELINES"] === "1") {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify({ baseline_sha: BASELINE_SHA, scenarios: actual }, null, 1)}\n`, "utf8");
    }
    const recorded = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { baseline_sha: string; scenarios: Record<string, unknown> };
    expect(recorded.baseline_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(recorded.scenarios)).toEqual(["synthetic_doc", "missing_doc", "everything_down"]);
    expect(actual).toEqual(recorded.scenarios);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(recorded.scenarios)); // også rekkefølgen av felt og elementer (byte-identisk), ikke bare dyp likhet
  });

  it("opptaket er ikke tomt: de fem seksjonene finnes og det finnes ingen `vision`-seksjon", async () => {
    const recorded = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { scenarios: Record<string, { sections: Array<{ id: string }> }> };
    expect(recorded.scenarios["synthetic_doc"]?.sections.map((s) => s.id)).toEqual(["inventory", "processors", "dpia", "retention", "deletion_evidence"]);
    for (const scenario of Object.values(recorded.scenarios)) expect(scenario.sections.some((s) => s.id === "vision")).toBe(false);
  });
});
