import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error - ren .mjs uten typer (genererer compose-blokkene)
import { NEVER_IN_RUNTIME, SERVICE_ENV } from "../../../infra/local/service-env.mjs";
import { FAST_INTENT_RESTRICTED, RESTRICTED_CONTEXT_GUARD_FLAG, parseRestrictedContextGuard } from "../src/restricted-context-guard.ts";

/**
 * WP-N1 (K5): FLAGGET NÅR CONTAINEREN, og ingen leser det utenom parseren. Mønster fra `wph1-control-env.test.ts`: compose sender KUN det `infra/local/service-env.mjs` lister, så et flagg som ikke står der ville vært stille
 * virkningsløst. Parseren er den ENESTE som leser det (som `parseCommsConfig`); resten av koden får en ferdig avgjort verdi injisert.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const COMPOSE = read("infra/local/docker-compose.yml");
const FLAG = "JARVIS_RESTRICTED_CONTEXT_GUARD";

describe("flagget når api-containeren (og ingen andre)", () => {
  it("konstanten er det eksakte navnet", () => {
    expect(RESTRICTED_CONTEXT_GUARD_FLAG).toBe(FLAG);
  });

  it("står i SERVICE_ENV.api - og ikke i worker, voice, browser eller migrate (kun api leser det)", () => {
    expect(SERVICE_ENV.api).toContain(FLAG);
    expect((SERVICE_ENV.api as string[]).filter((n) => n === FLAG)).toHaveLength(1);
    for (const service of ["worker", "voice", "browser", "migrate"] as const) expect(SERVICE_ENV[service], service).not.toContain(FLAG);
  });

  it("compose har nøyaktig én videresendingslinje (tom standard = AV), generert fra manifestet, og kun i api-blokken", () => {
    const lines = COMPOSE.split("\n").filter((l) => l.trim().startsWith(`${FLAG}:`));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.trim()).toBe(`${FLAG}: "\${${FLAG}:-}"`);
  });

  it("er ikke en hemmelighet (står ikke i NEVER_IN_RUNTIME) og er dokumentert i .env.example som AV", () => {
    expect(NEVER_IN_RUNTIME).not.toContain(FLAG);
    const example = read(".env.example");
    expect(example).toContain(`# ${FLAG}=off`);
    expect(example.split("\n").filter((l) => new RegExp(`^${FLAG}=.+`).test(l))).toEqual([]); // aldri påslått i eksempelfilen
  });
});

describe("parseren: kun den EKSAKTE verdien «on» slår det på", () => {
  it("on = på; alt annet er AV (også true/1/ON/On/mellomrom/tom/ukjent/usatt)", () => {
    expect(parseRestrictedContextGuard({ [FLAG]: "on" })).toEqual({ enabled: true });
    for (const value of ["", " ", "off", "ON", "On", "true", "1", " on", "on ", "yes", "enabled", "on\n", undefined]) {
      expect(parseRestrictedContextGuard({ [FLAG]: value }), JSON.stringify(value)).toEqual({ enabled: false });
    }
    expect(parseRestrictedContextGuard({})).toEqual({ enabled: false });
  });

  it("standardmiljøet (process.env) uten flagget gir AV", () => {
    const saved = process.env[FLAG];
    delete process.env[FLAG];
    try {
      expect(parseRestrictedContextGuard()).toEqual({ enabled: false });
    } finally {
      if (saved !== undefined) process.env[FLAG] = saved;
    }
  });
});

/** Alle produksjonskildefiler (ikke tester, ikke node_modules, ikke genererte kataloger). */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "test" || name === ".git" || name === "worktrees") continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|mts|mjs|js|cjs|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("ingen direkte flaggavlesing utenfor parseren", () => {
  const files = ["apps", "modules", "packages", "infra", "ops"].flatMap((d) => sourceFiles(join(ROOT, d)));

  it("det bokstavelige navnet står kun i parseren (restricted-context-guard.ts) og i manifestet (service-env.mjs)", () => {
    const hits = files.filter((f) => readFileSync(f, "utf8").includes(FLAG)).map((f) => f.slice(ROOT.length));
    expect(hits.sort()).toEqual(["apps/api/src/restricted-context-guard.ts", "infra/local/service-env.mjs"]);
  });

  it("main.ts leser flagget KUN via parseren (ingen process.env[...GUARD] eller bokstavelig navn), og sender den ferdig avgjorte verdien til gatewayen (utførelseslåsen) - kun når flagget er på", () => {
    const main = read("apps/api/src/main.ts");
    expect(main).not.toMatch(/process\.env\[\s*["']JARVIS_RESTRICTED/);
    expect(main).not.toContain(FLAG);
    expect(main).toContain("parseRestrictedContextGuard(process.env)");
    expect(main).toMatch(/\.\.\.\(restrictedContextGuard\.enabled \? \{ financeExecutionLock: \{ servedLocally: /);
    expect(main).toMatch(/\.\.\.\(restrictedContextGuard\.enabled \? \{ restrictedContextGuard: true \} : \{\}\)/); // og til samtalemotoren
  });

  it("F-B1: executive-tjenesten får `withholdFinanceFromCloud` KUN når flagget er på (betinget spredning: AV = feltet settes ikke), og ingen annen kode setter det", () => {
    const main = read("apps/api/src/main.ts");
    expect(main.match(/withholdFinanceFromCloud/g)).toHaveLength(1);
    expect(main).toMatch(/\.\.\.\(restrictedContextGuard\.enabled \? \{ withholdFinanceFromCloud: true \} : \{\}\)/);
    expect(read("apps/api/src/worker-main.ts")).not.toContain("withholdFinanceFromCloud"); // worker: flagget er api-only
  });
});

describe("hurtigbane-tabellen dekker hver intensjon eksplisitt", () => {
  it("alle FastIntent-typer står i tabellen, og kun kostnads-/verdirapportene (AI-kost i øre, Q-64 pkt 1 strengeste regel) er merket begrenset", () => {
    const fastRouter = read("modules/core/src/services/fast-router.ts");
    const kinds = [...fastRouter.matchAll(/\| \{ kind: "([a-z_]+)"/g)].map((m) => m[1]!).sort();
    expect(kinds.length).toBeGreaterThanOrEqual(12);
    expect(Object.keys(FAST_INTENT_RESTRICTED).sort()).toEqual(kinds);
    expect(Object.entries(FAST_INTENT_RESTRICTED).filter(([, restricted]) => restricted).map(([kind]) => kind).sort()).toEqual(["cost_report", "value_report"]);
  });
});
