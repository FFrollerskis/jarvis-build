import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs uten typer (delt med ops/security)
import { CONNECTOR_ENV, SERVICE_ENV, WORKER_CONNECTOR_ENV } from "../../../infra/local/service-env.mjs";

/**
 * D-395 (JARVIS-092): konfig-drift er en klasse feil, ikke enkeltfeil - 52 variabler ble lest uten å være dokumentert, døde nøkler lå igjen og
 * compose videresendte ikke variabler koden leste. Denne vakten gjør driften umulig å innføre på nytt:
 *  A. HVER miljøvariabel koden leser (JARVIS_*, INFISICAL_*, LANGFUSE_*) står i `.env.example` (aktiv eller kommentert),
 *  B. HVER variabel api/worker leser er videresendt til containeren (manifest) - eller står i en BEGRUNNET unntaksliste,
 *  C. hver `${NAVN:?...}` (påkrevd) i compose er dokumentert,
 *  D. ingen NY død nøkkel i `.env.example`: hver dokumentert nøkkel refereres av kode - eller står i en BEGRUNNET unntaksliste.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SOURCE_ROOTS = ["apps", "modules", "packages", "ops"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "test" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|mjs|js)$/.test(entry) && !/\.test\.(ts|mjs)$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const files = SOURCE_ROOTS.flatMap((r) => walk(join(ROOT, r)));
const text = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const NAME = "[A-Z][A-Z0-9_]+";
const READ_PATTERNS = [
  new RegExp(`(?:process\\.env|\\benv)\\[\\s*["'](${NAME})["']\\s*\\]`, "g"),
  new RegExp(`\\benv(?:Hour|Int|Port|PositiveInt)\\(\\s*["'](${NAME})["']`, "g")
];
const isConfigName = (n: string): boolean => /^(JARVIS_|INFISICAL_|LANGFUSE_)/.test(n);

function readsIn(paths: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    const src = text.get(join(ROOT, p)) ?? readFileSync(join(ROOT, p), "utf8");
    for (const re of READ_PATTERNS) for (const m of src.matchAll(re)) if (isConfigName(m[1] as string)) out.add(m[1] as string);
  }
  return out;
}

const example = readFileSync(join(ROOT, ".env.example"), "utf8");
const documented = new Set([...example.matchAll(new RegExp(`^\\s*#?\\s*(${NAME})=`, "gm"))].map((m) => m[1] as string));
const compose = readFileSync(join(ROOT, "infra/local/docker-compose.yml"), "utf8");

/** A: lest i koden men bevisst ikke i `.env.example` - hver med grunn. */
const NOT_IN_EXAMPLE: Record<string, string> = {
  JARVIS_SOME_HOUR: "eksempelnavn i dokumentasjonen til envHour (ikke en ekte variabel)",
  JARVIS_PROCESS: "D-394: settes av prosessen selv ved oppstart (`process.env[\"JARVIS_PROCESS\"] ??= \"api\"|\"worker\"`) for å merke audit-rader - ikke en operatør-innstilling"
};

/** B: lest av api/worker, men bevisst ikke videresendt av compose - hver med grunn. */
const NOT_IN_CONTAINER: Record<string, string> = {
  JARVIS_DB_RUN_MIGRATIONS: "migrasjoner kjøres av `migrate`-tjenesten; flagget er kun for lokal kjøring utenfor compose og krever admin-passord (api/worker får det aldri)",
  JARVIS_VOICE_DEVICE_ID: "seed-parameter for migrate-jobben (apps/api/src/seed.ts), ikke runtime",
  JARVIS_DB_HOST: "fast verdi satt av compose (FIXED_ENV)",
  JARVIS_PROCESS: "D-394: satt av prosessen selv (`??=` i main.ts/worker-main.ts) - compose trenger ikke videresende den",
  JARVIS_STRIPE_WEBHOOK_SECRET: "webhook-hemmeligheter leses av api (WEBHOOK_ENV); worker-main refererer dem kun i en kommentar/feilmelding",
  JARVIS_VIPPS_WEBHOOK_SECRET: "se JARVIS_STRIPE_WEBHOOK_SECRET",
  JARVIS_NEONOMICS_WEBHOOK_API_KEY: "se JARVIS_STRIPE_WEBHOOK_SECRET",
  JARVIS_WALLESTER_WEBHOOK_BASIC_USER: "se JARVIS_STRIPE_WEBHOOK_SECRET",
  JARVIS_WALLESTER_WEBHOOK_BASIC_PASSWORD: "se JARVIS_STRIPE_WEBHOOK_SECRET"
};

/**
 * B (kun worker): D-434/D-437 - worker-containeren får bevisst ikke disse (se WORKER_CONNECTOR_ENV). worker-main registrerer likevel transportene
 * (samme verktøyregister). Begrunnelsene er per variabel og SKAL være sanne - den read-only bakgrunnsflaten (e-post/kalender/GitHub/executive/memory)
 * er det som faktisk hindrer bruk; manglende env alene er ikke «fail closed» for alle (derfor beholder workeren modusvariablene som velger endepunkt).
 */
const NOT_IN_WORKER_CONTAINER: Record<string, string> = {
  JARVIS_NEONOMICS_TENANT_ID: "tenant-resolver for finans-synk (api-only); uten den gir resolveren null og transporten har ingen tenant å virke for",
  JARVIS_STRIPE_TENANT_ID: "som JARVIS_NEONOMICS_TENANT_ID",
  JARVIS_VIPPS_TENANT_ID: "som JARVIS_NEONOMICS_TENANT_ID",
  JARVIS_WALLESTER_TENANT_ID: "som JARVIS_NEONOMICS_TENANT_ID",
  JARVIS_DOCKER_MUTATION_TARGETS: "workeren har ingen docker-socket; tom liste = ingen docker-mutasjoner tillatt (parseDockerMutationTargets gir tomt sett)",
  JARVIS_GCE_MUTATION_TARGETS: "workeren har ikke GCE-credentials/prosjekt-id; tom liste = ingen GCE-mutasjoner tillatt",
  JARVIS_BROWSER_GATEWAY_TOKEN_SECRET: "HMAC-nøkkel for browser-gateway-kall; den read-only bakgrunnsflaten har ingen browser-handlinger (transporten får tom hemmelighet og avviser kall)"
};

/** D: dokumentert men ingen kode refererer den - bevisst reservert eller brukt av tredjeparts-container. */
const RESERVED_KEYS: Record<string, string> = {
  JARVIS_PLAYWRIGHT_API_KEY: "reservert for fremtidig connector (D-338/D-339); ingen kode leser den ennå",
  JARVIS_ZAPIER_API_KEY: "reservert (D-338: Zapier går via MCP-server-URL); ingen kode leser den ennå",
  JARVIS_PHILIPS_HUE_API_KEY: "reservert (D-336: Hue styres via Home Assistant); ingen kode leser den ennå",
  JARVIS_LIVEKIT_API_KEY: "reservert (D-328/Q-42: sanntids-transport er ikke besluttet)",
  JARVIS_OPENAI_REALTIME_API_KEY: "reservert (D-328/Q-42: sanntids-transport er ikke besluttet)"
};
const THIRD_PARTY_PREFIX = /^(INFISICAL_|LANGFUSE_|POSTGRES_|NEXTAUTH_|SALT$)/;

describe("A: alt koden leser er dokumentert", () => {
  const allReads = new Set<string>();
  for (const [, src] of text) for (const re of READ_PATTERNS) for (const m of src.matchAll(re)) if (isConfigName(m[1] as string)) allReads.add(m[1] as string);

  it("hver lest JARVIS_*/INFISICAL_*/LANGFUSE_*-variabel står i .env.example (aktiv eller kommentert)", () => {
    expect(allReads.size).toBeGreaterThan(100); // sanity: skanneren finner noe
    const missing = [...allReads].filter((n) => !documented.has(n) && !(n in NOT_IN_EXAMPLE)).sort();
    expect(missing, "dokumenter dem i .env.example (kommentert, med default) - eller begrunn unntaket i NOT_IN_EXAMPLE").toEqual([]);
  });

  it("unntakslisten inneholder ingen variabler som faktisk er dokumentert (ingen råtnende unntak)", () => {
    for (const n of Object.keys(NOT_IN_EXAMPLE)) expect(documented.has(n), n).toBe(false);
  });
});

describe("B: det api og worker leser når containeren", () => {
  const cases: Array<[string, string[]]> = [
    ["api", ["apps/api/src/main.ts", "apps/api/src/server.ts", "apps/api/src/seed.ts", "apps/api/src/conversation.ts", "apps/api/src/executive.ts", "apps/api/src/personality-config.ts", "apps/api/src/owner.ts"]],
    ["worker", ["apps/api/src/worker-main.ts"]]
  ];
  for (const [service, paths] of cases) {
    it(`${service}: hver variabel koden leser er i manifestet (infra/local/service-env.mjs) eller har en begrunnet unntaksgrunn`, () => {
      const manifest = new Set<string>(SERVICE_ENV[service] as string[]);
      const missing = [...readsIn(paths)].filter((n) => !manifest.has(n) && !(n in NOT_IN_CONTAINER) && !(service === "worker" && n in NOT_IN_WORKER_CONTAINER)).sort();
      expect(missing, "legg dem i SERVICE_ENV (og regenerer compose: node ops/security/generate-compose-env.mjs --write)").toEqual([]);
    });
  }
});

describe("B2: worker-minste-privilegium (D-434/D-437)", () => {
  const worker = new Set<string>(SERVICE_ENV.worker as string[]);
  const allowed = new Set<string>(WORKER_CONNECTOR_ENV as string[]);

  it("worker får av CONNECTOR_ENV NØYAKTIG WORKER_CONNECTOR_ENV - ingen andre connector-variabler", () => {
    const fromConnector = (CONNECTOR_ENV as string[]).filter((n) => worker.has(n)).sort();
    expect(fromConnector).toEqual([...allowed].sort());
    for (const n of CONNECTOR_ENV as string[]) if (!allowed.has(n)) expect(worker.has(n), n).toBe(false);
  });

  it("hver WORKER_CONNECTOR_ENV-variabel er en ekte connector-variabel (ikke en skrivefeil)", () => {
    for (const n of allowed) expect((CONNECTOR_ENV as string[]).includes(n), n).toBe(true);
  });

  it("ingen råtnende unntak: ingen NOT_IN_WORKER_CONTAINER-variabel står i worker-manifestet", () => {
    for (const n of Object.keys(NOT_IN_WORKER_CONTAINER)) expect(worker.has(n), n).toBe(false);
  });

  it("worker beholder det kodejobb, e-postingestion, bakgrunnslesing og Telegram-varsling trenger", () => {
    for (const n of ["ANTHROPIC_API_KEY", "JARVIS_GITHUB_TOKEN", "JARVIS_GITHUB_REPO", "JARVIS_GIT_CREDENTIAL_TOKEN", "JARVIS_EMAIL_TOKEN", "JARVIS_GOOGLE_TOKEN",
      "JARVIS_GOOGLE_CLIENT_ID", "JARVIS_GOOGLE_CLIENT_SECRET", "JARVIS_GOOGLE_ACCOUNT", "JARVIS_TELEGRAM_TOKEN", "JARVIS_TELEGRAM_CHAT_ID"]) {
      expect(worker.has(n), n).toBe(true);
    }
  });

  it("modusvariabler som velger endepunkt (Vipps/Neonomics/Wallester) følger med, så en transport aldri stille velger test/sandbox", () => {
    for (const n of ["JARVIS_VIPPS_ENVIRONMENT", "JARVIS_NEONOMICS_ENVIRONMENT", "JARVIS_NEONOMICS_REALM", "JARVIS_WALLESTER_ENVIRONMENT", "JARVIS_SUPPORT_INBOX_EMAILS"]) {
      expect(worker.has(n), n).toBe(true);
    }
  });

  it("browser-gateway-hemmeligheten og docker-/GCE-mutasjonsmål er ikke i worker", () => {
    for (const n of ["JARVIS_BROWSER_GATEWAY_TOKEN_SECRET", "JARVIS_DOCKER_MUTATION_TARGETS", "JARVIS_GCE_MUTATION_TARGETS", "JARVIS_DOCKER_BIN"]) {
      expect(worker.has(n), n).toBe(false);
    }
  });
});

describe("C: påkrevde compose-variabler er dokumentert", () => {
  it("hver ${NAVN:?...} i compose står i .env.example", () => {
    const required = [...compose.matchAll(new RegExp(`\\$\\{(${NAME}):\\?`, "g"))].map((m) => m[1] as string);
    expect(required.length).toBeGreaterThan(0);
    expect(required.filter((n) => !documented.has(n))).toEqual([]);
  });
});

describe("D: ingen døde nøkler", () => {
  it("hver dokumenterte JARVIS_*-nøkkel refereres av kode (apps/modules/packages/ops) eller er begrunnet reservert", () => {
    const joined = [...text.values()].join("\n");
    const dead = [...documented]
      .filter((n) => !THIRD_PARTY_PREFIX.test(n))
      .filter((n) => !joined.includes(n))
      .filter((n) => !(n in RESERVED_KEYS))
      .sort();
    expect(dead, "fjern nøkkelen fra .env.example/manifestet - eller begrunn den i RESERVED_KEYS").toEqual([]);
  });

  it("reservasjonslisten er ærlig: ingen oppført nøkkel refereres faktisk av kode (da skal den ut av listen)", () => {
    const joined = [...text.values()].join("\n");
    for (const n of Object.keys(RESERVED_KEYS)) expect(joined.includes(n), n).toBe(false);
  });

  it("de reserverte nøklene er merket som reservert i .env.example", () => {
    for (const n of Object.keys(RESERVED_KEYS)) expect(example.includes(n)).toBe(true);
    expect(example).toMatch(/RESERVERTE nøkler/);
  });
});

describe("E: .sops.yaml er ærlig om at SOPS ikke er i bruk", () => {
  it("filen sier eksplisitt at den er inaktiv (ingen kryptert fil finnes; Infisical er primær)", () => {
    const sops = readFileSync(join(ROOT, ".sops.yaml"), "utf8");
    expect(sops).toMatch(/INAKTIV/);
    expect(relative(ROOT, join(ROOT, "config/secrets"))).toBe("config/secrets");
    let hasEncrypted = false;
    try {
      hasEncrypted = readdirSync(join(ROOT, "config/secrets")).some((f) => /\.(ya?ml|json|env)$/.test(f));
    } catch {
      hasEncrypted = false;
    }
    expect(hasEncrypted).toBe(false);
  });
});
