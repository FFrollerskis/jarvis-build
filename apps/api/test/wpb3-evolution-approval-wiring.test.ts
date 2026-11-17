import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WP-B3 (D-475, EV-23) - KILDEVAKTER for eierens avgjørelse om endringsforslag (`main.ts` kan ikke importeres - den starter en server - så strukturen leses som tekst):
 *  - kobling: skriveren og verktøyet finnes KUN med eget flagg OG et koblet Evolusjon-senter; workeren og `main.ts` kjenner ikke flaggnavnet som streng;
 *  - SKRIVEREN er smal: kun lesing av endringsregisteret, kun ÉN revisjonsrad (writeAudit), ingen leverandør-SDK, ingen nettverk/fil/prosess, ingen import av endringsregisterets skriver;
 *  - INGEN LESER AVGJØRELSEN SOM TILLATELSE: kun skriveren, kontrakten og Evolusjon-senteret (visning) refererer revisjonstypen - ingen annen kode kan lese en registrert avgjørelse og handle på den;
 *  - `activation_decision` settes aldri til true, og ingenting i denne flaten skriver til endringsregisteret eller aktiverer en sovende del.
 */
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), "utf8");
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const MAIN = strip(read("apps/api/src/main.ts"));
const WORKER = strip(read("apps/api/src/worker-main.ts"));
const RECORDER_RAW = read("apps/api/src/evolution-decisions.ts");
const RECORDER = strip(RECORDER_RAW);
const CONTRACT_RAW = read("modules/executive/src/evolution/decision.ts");
const CONTRACT = strip(CONTRACT_RAW);
const REGISTER = strip(read("apps/api/src/control-center/register.ts"));
const CENTER = strip(read("apps/api/src/control-center/evolution.ts"));
const SERVER = strip(read("apps/api/src/server.ts"));
const TRANSPORT = strip(read("modules/executive/src/transport.ts"));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|mjs|js|html)$/.test(name)) out.push(full);
  }
  return out;
}
const SOURCE_FILES = [
  ...walk(resolve(REPO_ROOT, "apps")).filter((f) => !/[\\/](test|tests)[\\/]/.test(f)),
  ...walk(resolve(REPO_ROOT, "modules")).filter((f) => !/[\\/](test|tests)[\\/]/.test(f))
];

describe("kildevakt: main.ts kobler avgjørelsen kun med eget flagg + koblet senter", () => {
  it("`evolutionApprovalOn` er flagget OG at senteret er koblet inn - definert ÉN gang og brukt til både skriveren og verktøyvalget", () => {
    expect(MAIN.match(/const evolutionApprovalOn = /g)).toHaveLength(1);
    expect(MAIN).toMatch(/const evolutionApprovalOn = flagOn\(process\.env, CONTROL_FEATURE_FLAGS\.evolutionApproval\) && controlCenters\.has\("evolution"\);/);
    expect(MAIN).toMatch(/\.\.\.\(evolutionApprovalOn \? \{ evolutionDecisions: createEvolutionDecisionRecorder\(pool\) \} : \{\}\)/);
    expect(MAIN).toMatch(/evolutionApproval: evolutionApprovalOn\b/);
    expect(MAIN.match(/createEvolutionDecisionRecorder\(/g)).toHaveLength(1);
    expect(MAIN.match(/\bevolutionApprovalOn\b/g)).toHaveLength(3);
  });

  it("flaggnavnet står ikke som streng i main.ts (det kommer fra CONTROL_FEATURE_FLAGS), og workeren kjenner hverken flagget, skriveren eller verktøyet", () => {
    expect(MAIN).not.toContain("JARVIS_CONTROL_EVOLUTION_APPROVAL");
    for (const needle of ["JARVIS_CONTROL_EVOLUTION_APPROVAL", "record_evolution_decision", "createEvolutionDecisionRecorder", "evolutionApproval", "EVOLUTION_DECISION", "evolution.owner_decision"]) {
      expect(WORKER, needle).not.toContain(needle);
    }
  });

  it("registerControlCenters gir senteret `approval` KUN med eget flagg og en gateway - og risikoklassen slås opp lat", () => {
    expect(REGISTER).toMatch(/flagOn\(wiring\.env, CONTROL_FEATURE_FLAGS\.evolutionApproval\) && wiring\.toolGateway/);
    expect(REGISTER).toMatch(/risk_class: riskClassOf\(wiring\.toolGateway, "record_evolution_decision"\)/);
    expect(REGISTER).toMatch(/requires_step_up: actionRequiresStepUp\("record_evolution_decision"\)/);
  });

  it("ruten kjenner navnet kun som flaggstyrt (og kun når verktøyet er registrert); transporten registrerer det kun med `options.evolutionApproval === true`", () => {
    expect(SERVER).toMatch(/export const EXECUTIVE_MUTATE_FLAGGED_ACTIONS = \["revoke_autonomy_binding", "run_golden_suite", "record_evolution_decision"\] as const;/);
    expect(SERVER).not.toMatch(/export const EXECUTIVE_MUTATE_ACTIONS = \[[^\]]*record_evolution_decision/);
    expect(TRANSPORT).toMatch(/options\.evolutionApproval === true/);
    expect(TRANSPORT.match(/"record_evolution_decision"/g)?.length).toBe(2); // case-etiketten og verktøydefinisjonen
  });
});

describe("kildevakt: skriveren er smal", () => {
  it("importerer kun databaseklienten (type), kjernen (transaksjon + revisjon), executive-kontrakten, redigereren for revisjonsrader og id-filteret - ingen leverandør-SDK, ingen endringsregister-skriver", () => {
    const imports = [...RECORDER_RAW.matchAll(/^import[\s\S]*?from "([^"]+)";/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./autonomy-audit.ts", "./control-center/shared.ts", "@jarvis/core", "@jarvis/executive", "pg"].sort());
    expect(RECORDER).not.toContain("@jarvis/self-modification");
    expect(RECORDER).not.toMatch(/\bChangeLedger\b|\.append\(/);
  });

  it("ingen skriving utenom ÉN `writeAudit`; endringsregisteret leses kun med SELECT (siste rad: id, klasse, beslutning, hash, tidspunkt) og aldri tekstkolonnene", () => {
    expect(RECORDER.match(/\bwriteAudit\(/g)).toHaveLength(1);
    expect(RECORDER).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+TABLE)\b/i);
    const sqls = [...RECORDER_RAW.matchAll(/`(SELECT[\s\S]*?)`/g)].map((m) => m[1] as string);
    expect(sqls.length).toBe(2);
    for (const sql of sqls) {
      expect(sql).toMatch(/^SELECT /);
      for (const forbidden of ["subject", "evidence", "branch", "recorded_by", "head_sha", "paths", "SELECT *"]) expect(sql, forbidden).not.toContain(forbidden);
    }
    expect(sqls[0]).toContain("FROM evolution_change_ledger WHERE change_id = $1");
    // tenant-skopet og parametrisert (aldri strengsammenslåing av input i SQL)
    expect(sqls[1]).toContain("tenant_id = $1");
    expect(RECORDER).not.toMatch(/`SELECT[^`]*\$\{/);
  });

  it("ingen nettverk, filsystem, prosess eller direkte miljølesing, og ingen aktivering: `activation_decision` settes aldri til true og effekten er alltid «none»", () => {
    for (const source of [RECORDER, CONTRACT]) {
      expect(source).not.toMatch(/\bfetch\s*\(|node:(fs|http|https|net|child_process|dns|tls)|\bprocess\.env\b|\bspawn\(|\bexecSync\(|\bexecFile\(|child_process/);
      expect(source).not.toMatch(/activation_decision\s*[:=]\s*true/);
    }
    expect(RECORDER).toContain('effect: "none", activation_decision: false');
    expect(CONTRACT).toMatch(/effect: "none";/);
    expect(CONTRACT).toMatch(/activation_decision: false;/);
  });

  it("serialisert per forslag med advisory-lås i transaksjonen (med lock-/statement-timeout, kun lokalt i transaksjonen), og «siste» = høyeste audit_id (aldri `at`)", () => {
    expect(RECORDER).toMatch(/pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
    expect(RECORDER).toMatch(/set_config\('lock_timeout', \$1, true\), set_config\('statement_timeout', \$2, true\)/);
    expect(RECORDER).toMatch(/ORDER BY audit_id DESC LIMIT 1/);
    expect(RECORDER).not.toMatch(/ORDER BY at DESC/);
    expect(CENTER).toMatch(/ORDER BY payload->>'change_id', payload->>'proposal_digest', audit_id DESC/);
    expect(CENTER).not.toMatch(/ORDER BY[^`]*\bat DESC/);
  });

  it("GJENNOMGANG H1: «siste» ledger-rad sorteres på den KVALIFISERTE kolonnen (`evolution_change_ledger.seq`, bigint) - aldri på tekst-aliaset `seq`", () => {
    expect(RECORDER).toMatch(/ORDER BY evolution_change_ledger\.seq DESC LIMIT 1/);
    expect(RECORDER).not.toMatch(/ORDER BY seq\b/);
  });
});

describe("kildevakt (H1): ingen tekst-alias skygger for en sorteringskolonne i B3-spørringene", () => {
  // Postgres løser et BART ORDER BY-navn til en utdatakolonne med samme navn - også et `::text`-alias («9» foran «10»). Kvalifiser kolonnen (`tabell.kolonne`) eller bruk et annet aliasnavn.
  const FILES = ["apps/api/src/evolution-decisions.ts", "apps/api/src/control-center/evolution.ts", "apps/api/src/evolution-source.ts"];
  const sqlStrings = (src: string): string[] => [...src.matchAll(/`([^`]*\bSELECT\b[^`]*)`/g)].map((m) => m[1] as string);

  it("hver spørring (SELECT i en malstreng) har ingen ukvalifisert ORDER BY-referanse til et `::text`-alias - og sjekken er ikke tom", () => {
    let queries = 0;
    let aliases = 0;
    for (const rel of FILES) {
      for (const sql of sqlStrings(strip(read(rel)))) {
        queries += 1;
        // teksten etter FØRSTE ORDER BY (også en indre spørrings sortering og den ytre): en ukvalifisert alias-referanse hvor som helst der er farlig
        const orderBy = /ORDER BY([^`]*)$/i.exec(sql)?.[1] ?? "";
        for (const m of sql.matchAll(/::text\s+AS\s+(\w+)/gi)) {
          aliases += 1;
          const alias = m[1] as string;
          // ukvalifisert = ikke direkte etter et punktum eller et ord-tegn
          expect(new RegExp(`(^|[^.\\w])${alias}\\b`).test(orderBy), `${rel}: ORDER BY refererer det ukvalifiserte tekst-aliaset «${alias}» i: ${sql.replace(/\s+/g, " ").slice(0, 120)}`).toBe(false);
        }
      }
    }
    expect(queries).toBeGreaterThanOrEqual(8);
    expect(aliases).toBeGreaterThanOrEqual(3);
  });

  it("vakten biter: den GAMLE feilen (`seq::text AS seq ... ORDER BY seq DESC`) ville blitt fanget", () => {
    const bad = "SELECT seq::text AS seq, decision FROM evolution_change_ledger WHERE change_id = $1 ORDER BY seq DESC LIMIT 1";
    const orderBy = /ORDER BY([^`]*)$/i.exec(bad)?.[1] ?? "";
    expect(new RegExp("(^|[^.\\w])seq\\b").test(orderBy)).toBe(true);
    const good = "SELECT seq::text AS seq FROM evolution_change_ledger ORDER BY evolution_change_ledger.seq DESC LIMIT 1";
    expect(new RegExp("(^|[^.\\w])seq\\b").test(/ORDER BY([^`]*)$/i.exec(good)?.[1] ?? "")).toBe(false);
  });
});

describe("kildevakt: INGEN kode leser en registrert avgjørelse som tillatelse", () => {
  it("kun kontrakten (definisjon), skriveren og Evolusjon-senteret (visning) refererer revisjonstypen - ingen annen kode kan handle på en avgjørelse", () => {
    const referencing = SOURCE_FILES
      .filter((f) => /EVOLUTION_DECISION_AUDIT_TYPE|evolution\.owner_decision/.test(strip(readFileSync(f, "utf8"))))
      .map((f) => relative(REPO_ROOT, f).replace(/\\/g, "/"))
      .sort();
    // `transport.ts` nevner typen KUN i rollback-teksten til verktøydefinisjonen (en beskrivelse for mennesker: «alle avgjørelser står i revisjonssporet ...») - aldri som kode som leser den (sjekkes under).
    expect(referencing).toEqual(["apps/api/src/control-center/evolution.ts", "apps/api/src/evolution-decisions.ts", "modules/executive/src/evolution/decision.ts", "modules/executive/src/transport.ts"]);
    const mentions = TRANSPORT.match(/.*evolution\.owner_decision.*/g) ?? [];
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toContain("registrer en ny avgjørelse for samme forslag");
    expect(TRANSPORT).not.toContain("EVOLUTION_DECISION_AUDIT_TYPE");
  });

  it("det finnes ingen kodevei som skriver `approved` til endringsregisteret fra apps/api eller executive (ingen `ChangeLedger.append` utenfor selvmodifikasjonsmodulen og EV-0-oppstart)", () => {
    const appenders = SOURCE_FILES
      .filter((f) => /\.append\(/.test(strip(readFileSync(f, "utf8"))) && /ChangeLedger/.test(readFileSync(f, "utf8")))
      .map((f) => relative(REPO_ROOT, f).replace(/\\/g, "/"))
      .filter((f) => f.startsWith("apps/api/") || f.startsWith("modules/executive/"));
    expect(appenders).toEqual([]);
  });
});

describe("kildevakt: flagget er dokumentert AV og kun api-containeren får det", () => {
  const ENV_EXAMPLE = read(".env.example");
  const COMPOSE = read("infra/local/docker-compose.yml");

  it(".env.example har flagget kommentert ut med verdien off - aldri `on` som standard", () => {
    expect(ENV_EXAMPLE).toMatch(/^# JARVIS_CONTROL_EVOLUTION_APPROVAL=off$/m);
    expect(ENV_EXAMPLE).not.toMatch(/^\s*JARVIS_CONTROL_EVOLUTION_APPROVAL=on/m);
  });

  it("compose har nøyaktig én linje med tom standard (AV)", () => {
    const lines = COMPOSE.split("\n").filter((l) => l.includes("JARVIS_CONTROL_EVOLUTION_APPROVAL"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.trim()).toBe('JARVIS_CONTROL_EVOLUTION_APPROVAL: "${JARVIS_CONTROL_EVOLUTION_APPROVAL:-}"');
  });
});
