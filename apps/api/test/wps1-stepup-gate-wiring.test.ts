import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyStepUpBindingGate, STEPUP_BOUND_FLAG_GROUPS, STEPUP_CHANNEL_BINDING_ENV } from "@jarvis/contracts";
import { InvalidCommsConfigError, parseCommsConfig } from "@jarvis/comms";
import { growthWriteConfigFromEnv } from "@jarvis/growth";
import { SITUATION_FLAG_NAMES, situationFlagsFromEnv } from "@jarvis/situations";
import { PERSONAL_FLAG_NAMES } from "@jarvis/tool-gateway";
// @ts-expect-error - .mjs uten typer (delt med ops/security)
import { SERVICE_ENV } from "../../../infra/local/service-env.mjs";
import { createPersonalWiring } from "../src/personal-wiring.ts";
import { aggregate, scanSource, type GateRules, type ScanResult } from "./support/stepup-gate-ast.ts";

/**
 * WP-S1 K4: FAIL-CLOSED kobling mellom `JARVIS_STEPUP_CHANNEL_BINDING` og høyrisiko-flaggene som ventet på bindingen (JARVIS-111/Q-71). Uten `enforce` har flaggene INGEN effekt (kapabiliteten finnes ikke, med klar årsak
 * `stepup_binding_not_enforced` i status), uten krasj ved oppstart og uten stille suksess. Med `enforce` virker de som før. Med alle flaggene AV er alt identisk med main.
 *
 * Fire flaggfamilier: personal (7), vekstskriving (plattformlisten), utgående kommunikasjon (utgående + 4 avhengige) og hendelsesabonnementet (hovedbryteren). Testen bevisser BÅDE porten (registeret) OG at hver
 * families egen parser faktisk ser den gatede kopien, og at `main.ts` aldri gir en av dem rå `process.env`.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const groupFlags = (id: string): string[] => (STEPUP_BOUND_FLAG_GROUPS.find((g) => g.id === id)?.flags ?? []).map((f) => f.name);

const ALL_ON_NOT_ENFORCED: Record<string, string> = {
  JARVIS_PERSONAL_HOME_CRITICAL: "on", JARVIS_PERSONAL_CAR: "on", JARVIS_PERSONAL_FAMILY: "on", JARVIS_PERSONAL_HEALTH_INGEST: "on", JARVIS_PERSONAL_APPLE_DAV: "on", JARVIS_PERSONAL_FINANCE_READ: "on", JARVIS_PERSONAL_CONTEXT: "on",
  JARVIS_PERSONAL_HOME_TARGETS: "lock.inngang", JARVIS_PERSONAL_CAR_TARGETS: "bil1",
  JARVIS_GROWTH_WRITE_PLATFORMS: "google_ads,ga4", JARVIS_GROWTH_WRITE_TARGETS: "ga4:123456",
  JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: "sms", JARVIS_COMMS_VENDOR_READS: "on", JARVIS_COMMS_CALLS: "on", JARVIS_COMMS_CONTACTS: "on", JARVIS_COMMS_MEETINGS: "on",
  JARVIS_SITUATION_SIGNALS: "on", JARVIS_SITUATION_HOME: "on", JARVIS_SITUATION_VISION: "on", JARVIS_SITUATION_HEALTH: "on", JARVIS_SITUATION_INCIDENTS: "on", JARVIS_SITUATION_MODEL_ASSIST: "on", JARVIS_SITUATION_FEEDBACK: "on"
};
const ENFORCED = { ...ALL_ON_NOT_ENFORCED, [STEPUP_CHANNEL_BINDING_ENV]: "enforce" };

describe("A: registeret dekker NØYAKTIG flaggene koden faktisk leser (en ny/utelatt flagg feller testen)", () => {
  it("personal: registeret = PERSONAL_FLAG_NAMES (alle syv)", () => {
    expect(new Set(groupFlags("personal"))).toEqual(new Set(Object.values(PERSONAL_FLAG_NAMES)));
  });

  it("hendelsesabonnementet: hovedbryteren; underflaggene gjelder kun under den (situationFlagsFromEnv)", () => {
    expect(groupFlags("situation_signals")).toEqual([SITUATION_FLAG_NAMES.signals]);
    const subOnly = situationFlagsFromEnv({ JARVIS_SITUATION_HOME: "on", JARVIS_SITUATION_VISION: "on", JARVIS_SITUATION_HEALTH: "on", JARVIS_SITUATION_INCIDENTS: "on", JARVIS_SITUATION_MODEL_ASSIST: "on", JARVIS_SITUATION_FEEDBACK: "on" });
    expect(Object.values(subOnly).every((v) => v === false)).toBe(true); // uten hovedbryteren er alt av, så å blokkere hovedbryteren er nok
  });

  it("vekstskriving: plattformlisten er det som slår skriving på (tom liste = ingen verktøy, ingen rute)", () => {
    expect(groupFlags("growth_write")).toEqual(["JARVIS_GROWTH_WRITE_PLATFORMS"]);
    expect(growthWriteConfigFromEnv({ JARVIS_GROWTH_WRITE_PLATFORMS: "ga4" }).platforms.size).toBe(1);
    expect(growthWriteConfigFromEnv({ JARVIS_GROWTH_WRITE_TARGETS: "ga4:123456" }).platforms.size).toBe(0); // målene alene slår ingenting på
  });

  it("utgående kommunikasjon: de fire avhengige flaggene krever utgående (ellers STOPPER parseren oppstarten), og registeret har nøyaktig dem", () => {
    const dependents = groupFlags("comms_outbound").filter((f) => f !== "JARVIS_COMMS_OUTBOUND");
    expect(dependents.sort()).toEqual(["JARVIS_COMMS_CALLS", "JARVIS_COMMS_CONTACTS", "JARVIS_COMMS_MEETINGS", "JARVIS_COMMS_VENDOR_READS"]);
    for (const dependent of dependents) expect(() => parseCommsConfig({ [dependent]: "on" }), dependent).toThrow(InvalidCommsConfigError);
    // Kildevakt mot at parseren får en NY avhengighet uten at registeret følger med: listen i `config.ts` er nøyaktig denne.
    const source = read("modules/comms/src/config.ts");
    const declared = [...(/for \(const dependent of \[([^\]]+)\] as const\)/.exec(source)?.[1] ?? "").matchAll(/"(JARVIS_COMMS_[A-Z_]+)"/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual(dependents);
  });

  it("INGEN kode utenfor porten leser en bundet flaggfamilie direkte fra process.env (ellers kunne en kodevei omgå den)", () => {
    const flagNames = STEPUP_BOUND_FLAG_GROUPS.flatMap((g) => g.flags.map((f) => f.name));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "test" || entry === "dist") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(ts|mjs)$/.test(entry) || entry.endsWith(".d.ts")) continue;
        const text = readFileSync(full, "utf8");
        for (const name of flagNames) if (new RegExp(`process\\.env\\[\\s*["']${name}["']\\s*\\]|process\\.env\\.${name}\\b`).test(text)) offenders.push(`${full.slice(ROOT.length + 1)}:${name}`);
      }
    };
    for (const root of ["apps", "modules", "packages", "ops"]) walk(join(ROOT, root));
    expect(offenders).toEqual([]);
  });
});

describe("B: uten `enforce` har flaggene INGEN effekt (ingen krasj), med `enforce` virker de som før", () => {
  const readSecret = async (): Promise<string | null> => null;
  const base = { pool: {} as never, gateway: {} as never, readSecret, ownerPersonId: "p-owner" };

  it("personal: alle flagg på uten enforce => ingen verktøy, ingen rute-avhengigheter, ingen loggline; med enforce => verktøy og avhengigheter finnes", () => {
    const blocked = applyStepUpBindingGate(ALL_ON_NOT_ENFORCED);
    expect(blocked.blocked.map((b) => b.flag)).toEqual(expect.arrayContaining(Object.values(PERSONAL_FLAG_NAMES)));
    const off = createPersonalWiring({ ...base, env: blocked.env });
    expect(off.tools).toEqual([]);
    expect(off.deps).toBeUndefined();
    expect(off.describe()).toBeNull();
    const enforced = applyStepUpBindingGate(ENFORCED);
    const on = createPersonalWiring({ ...base, env: enforced.env, controls: { killSwitch: { isActiveDurable: async () => false }, ownerControls: { isRevokedDurable: async () => false } } });
    expect(on.tools.length).toBeGreaterThan(0);
    expect(on.deps).toBeDefined();
    expect(on.describe()).not.toBeNull();
  });

  it("vekstskriving: uten enforce er plattformlisten tom (AV); med enforce er den uendret", () => {
    expect(growthWriteConfigFromEnv(applyStepUpBindingGate(ALL_ON_NOT_ENFORCED).env).platforms.size).toBe(0);
    expect([...growthWriteConfigFromEnv(applyStepUpBindingGate(ENFORCED).env).platforms].sort()).toEqual(["ga4", "google_ads"]);
  });

  it("utgående kommunikasjon: uten enforce er utgående og ALLE avhengige av, og parseren KRASJER IKKE (de avhengige blokkeres sammen med utgående); med enforce uendret", () => {
    const gate = applyStepUpBindingGate(ALL_ON_NOT_ENFORCED);
    const off = parseCommsConfig(gate.env);
    expect([off.outbound, off.calls, off.contacts, off.meetings, off.vendor_reads]).toEqual([false, false, false, false, false]);
    expect([...off.channels]).toEqual(["sms"]); // ren konfigurasjon er uendret
    const on = parseCommsConfig(applyStepUpBindingGate(ENFORCED).env);
    expect([on.outbound, on.calls, on.contacts, on.meetings, on.vendor_reads]).toEqual([true, true, true, true, true]);
    // en eier som har slått på BARE en avhengig uten utgående: uten enforce er det et blokkert flagg (ikke en oppstartskrasj); med enforce gjelder den vanlige konfigurasjonsfeilen
    const onlyDependent = { JARVIS_COMMS_CALLS: "on" };
    expect(() => parseCommsConfig(applyStepUpBindingGate(onlyDependent).env)).not.toThrow();
    expect(() => parseCommsConfig(applyStepUpBindingGate({ ...onlyDependent, [STEPUP_CHANNEL_BINDING_ENV]: "enforce" }).env)).toThrow(InvalidCommsConfigError);
  });

  it("hendelsesabonnementet: uten enforce er hovedbryteren (og dermed alle underflagg) av; med enforce virker de", () => {
    const off = situationFlagsFromEnv(applyStepUpBindingGate(ALL_ON_NOT_ENFORCED).env);
    expect(Object.values(off).every((v) => v === false)).toBe(true);
    const on = situationFlagsFromEnv(applyStepUpBindingGate(ENFORCED).env);
    expect(Object.values(on).every((v) => v === true)).toBe(true);
  });

  it("en skrivefeil i modusen (`enforced`, `ENFORCE`, `on`) gir observe: flaggene er blokkert, aldri en stille effekt, og statusen melder den ugyldige verdien", () => {
    for (const bad of ["enforced", "ENFORCE", "on", "true", " enforce"]) {
      const gate = applyStepUpBindingGate({ ...ALL_ON_NOT_ENFORCED, [STEPUP_CHANNEL_BINDING_ENV]: bad });
      expect(gate.setting.enforced, bad).toBe(false);
      expect(gate.setting.invalid_value, bad).not.toBeNull();
      expect(situationFlagsFromEnv(gate.env).signals, bad).toBe(false);
      expect(growthWriteConfigFromEnv(gate.env).platforms.size, bad).toBe(0);
      expect(parseCommsConfig(gate.env).outbound, bad).toBe(false);
      expect(createPersonalWiring({ ...base, env: gate.env }).tools, bad).toEqual([]);
    }
  });
});

describe("C: flagg AV er identisk med main (differensial mot de rå parserne)", () => {
  const readSecret = async (): Promise<string | null> => null;
  const base = { pool: {} as never, gateway: {} as never, readSecret, ownerPersonId: "p-owner" };
  const EMPTY_LIKE: Array<Record<string, string>> = [
    {}, { JARVIS_TENANT_ID: "t" }, { JARVIS_COMMS_CHANNELS: "slack,sms", JARVIS_COMMS_WEBHOOKS: "slack" }, { JARVIS_GROWTH_WRITE_TARGETS: "ga4:123456" },
    { JARVIS_PERSONAL_HOME_TARGETS: "lock.inngang" }, { JARVIS_SITUATION_HOME: "on" },
    // flagg som ER satt men ikke «på» (feil verdi) er også AV i rå parser og gir ingen blokkert oppføring
    { JARVIS_PERSONAL_HOME_CRITICAL: "true", JARVIS_COMMS_OUTBOUND: "1", JARVIS_SITUATION_SIGNALS: "ON" }
  ];
  it("for hvert miljø uten noe flagg på: porten blokkerer ingenting, og hver families parser gir NØYAKTIG samme resultat på den gatede kopien som på det rå miljøet", () => {
    for (const env of EMPTY_LIKE) {
      const gate = applyStepUpBindingGate(env);
      expect(gate.blocked, JSON.stringify(env)).toEqual([]);
      expect(parseCommsConfig(gate.env), JSON.stringify(env)).toEqual(parseCommsConfig(env));
      expect(growthWriteConfigFromEnv(gate.env), JSON.stringify(env)).toEqual(growthWriteConfigFromEnv(env));
      expect(situationFlagsFromEnv(gate.env), JSON.stringify(env)).toEqual(situationFlagsFromEnv(env));
      const a = createPersonalWiring({ ...base, env: gate.env });
      const b = createPersonalWiring({ ...base, env });
      expect([a.tools, a.deps, a.describe()], JSON.stringify(env)).toEqual([b.tools, b.deps, b.describe()]);
    }
  });
});

describe("D: main.ts gir ALDRI rå process.env til de fire flaggfamiliene, og modusen når alle tre autoritetene", () => {
  const main = read("apps/api/src/main.ts");
  const count = (needle: string): number => main.split(needle).length - 1;

  it("porten bygges nøyaktig én gang, og hver av de fire wiringene leser `stepUpGate.env`", () => {
    expect(count("applyStepUpBindingGate(process.env)")).toBe(1);
    expect(count("growthWriteConfigFromEnv(stepUpGate.env)")).toBe(1);
    expect(count("createPersonalWiring({ env: stepUpGate.env,")).toBe(1);
    expect(/buildCommsRuntime\(\{\s*env: stepUpGate\.env,/.test(main)).toBe(true);
    expect(/createSituationSignalsWiring\(\{\s*env: stepUpGate\.env,/.test(main)).toBe(true);
  });

  it("ingen av de fire kallene får rå `process.env` (en kodevei som omgår porten ville gjort flaggene virksomme uten enforce)", () => {
    expect(main).not.toMatch(/growthWriteConfigFromEnv\(\s*process\.env\s*\)/);
    expect(main).not.toMatch(/createPersonalWiring\(\{\s*env:\s*process\.env/);
    expect(main).not.toMatch(/buildCommsRuntime\(\{\s*env:\s*process\.env/);
    expect(main).not.toMatch(/createSituationSignalsWiring\(\{\s*env:\s*process\.env/);
  });

  it("modusen når grant-tjenesten (verify), innrullingen og begge autoritetene (delt authorityDeps): nøyaktig tre steder, og begge autoritetene bruker SAMME authorityDeps", () => {
    expect(count("channelBindingMode: stepUpGate.setting.mode")).toBe(3);
    expect(main).toContain("new SessionGrantService(pool, { channelBindingMode: stepUpGate.setting.mode })");
    expect(main).toContain("voiceAuthority: new VoiceSessionAuthority(authorityDeps)");
    expect(main).toContain("channelAuthority: new ChannelSessionAuthority(authorityDeps)");
    expect(/enrollmentService = new DeviceEnrollmentService\(\{[^}]*channelBindingMode: stepUpGate\.setting\.mode/s.test(main)).toBe(true);
  });

  it("status: oppstartsloggen og /infra/status får modus og blokkerte flagg", () => {
    expect(main).toContain("stepUpBinding: describeStepUpBinding(stepUpGate)");
    // oppstartsloggen: betingelsen og innholdet er testet i contracts (`stepUpBindingLogEvent`); main.ts skal bruke funksjonen og skrive nøyaktig det den returnerer
    expect(count("const stepUpLog = stepUpBindingLogEvent(stepUpGate);")).toBe(1);
    expect(count("if (stepUpLog !== null) console.log(JSON.stringify(stepUpLog));")).toBe(1);
    expect(main).not.toContain('msg: "stepup_channel_binding"'); // meldingsnavnet bor kun i contracts (én kilde)
  });

  it("worker-main kobler aldri inn noen av de fire flaggfamiliene (kun api-prosessen har dem, så porten i main.ts dekker alle)", () => {
    const worker = read("apps/api/src/worker-main.ts");
    for (const needle of ["createPersonalWiring", "buildCommsRuntime", "createSituationSignalsWiring", "growthWriteConfigFromEnv"]) expect(worker, needle).not.toContain(needle);
  });
});

describe("E: miljøoppsett - modusen når api-containeren (og ingen andre), og er AV/observe som standard", () => {
  it("SERVICE_ENV.api har JARVIS_STEPUP_CHANNEL_BINDING; worker/voice/browser/migrate har den ikke", () => {
    expect(SERVICE_ENV.api).toContain(STEPUP_CHANNEL_BINDING_ENV);
    for (const service of ["worker", "voice", "browser", "migrate"]) expect(SERVICE_ENV[service], service).not.toContain(STEPUP_CHANNEL_BINDING_ENV);
  });

  it("compose videresender den kun til api-tjenesten (generert fra manifestet)", () => {
    const compose = read("infra/local/docker-compose.yml");
    expect([...compose.matchAll(new RegExp(`^\\s+${STEPUP_CHANNEL_BINDING_ENV}:`, "gm"))]).toHaveLength(1);
    const apiStart = compose.indexOf("\n  api:");
    const nextService = compose.indexOf("\n  worker:", apiStart);
    const line = compose.indexOf(`    ${STEPUP_CHANNEL_BINDING_ENV}:`);
    expect(line).toBeGreaterThan(apiStart);
    expect(line).toBeLessThan(nextService === -1 ? compose.length : nextService);
  });

  it(".env.example dokumenterer modusen (kommentert, observe) og setter den ikke aktivt; porten er AV uten at eieren handler", () => {
    const example = read(".env.example");
    expect(example).toMatch(/^# JARVIS_STEPUP_CHANNEL_BINDING=observe$/m);
    expect(example).not.toMatch(/^JARVIS_STEPUP_CHANNEL_BINDING=/m);
  });
});

describe("F: KUN innrullingsstien setter enhetstype - ingen annen produksjonskode skriver `devices` eller lager billetter", () => {
  /** Alle produksjonsfiler (ikke test/node_modules) som inneholder `needle`, som repo-relative stier. */
  function filesWith(needle: RegExp): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "test" || entry === "dist" || entry === ".git") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(ts|mjs)$/.test(entry) || entry.endsWith(".d.ts")) continue;
        if (needle.test(readFileSync(full, "utf8"))) found.push(full.slice(ROOT.length + 1));
      }
    };
    for (const root of ["apps", "modules", "packages", "ops"]) walk(join(ROOT, root));
    return found.sort();
  }

  it("rå skriving til devices: seed (eksplisitt type), DeviceService (innrulling/tilbakekalling) og en vertsskript som setter inn en nøkkelløs syntetisk rad (aldri en nøkkel, så ingen autorisasjon)", () => {
    expect(filesWith(/INSERT INTO devices/)).toEqual([
      "apps/api/src/seed.ts", "modules/core/src/services/device-service.ts", "modules/executive/scripts/d174-executive-control-surface-live.ts"
    ]);
    expect(filesWith(/UPDATE devices/)).toEqual(["modules/core/src/services/device-service.ts"]);
  });

  it("registerDeviceOn/registerDeviceTrusted kalles kun fra DeviceService og DeviceEnrollmentService (den ENESTE nettverksnære veien); billetter lages kun av eier-CLI-en via createEnrollmentTicket", () => {
    expect(filesWith(/registerDeviceOn\(/)).toEqual(["modules/core/src/services/device-enrollment-service.ts", "modules/core/src/services/device-service.ts"]);
    expect(filesWith(/registerDeviceTrusted\(/)).toEqual(["modules/core/src/services/device-service.ts"]);
    expect(filesWith(/createEnrollmentTicket\(/)).toEqual(["apps/api/src/enroll-ticket-main.ts", "modules/core/src/services/device-enrollment-service.ts"]);
  });

  it("tillatelsen til å endre typen (`jarvis.device_kind_change`) settes av nøyaktig én kodevei: registerDeviceOn", () => {
    expect(filesWith(/jarvis\.device_kind_change/)).toEqual(["modules/core/src/services/device-service.ts"]);
    const service = read("modules/core/src/services/device-service.ts");
    expect(service.split("jarvis.device_kind_change").length - 1).toBe(2); // sett på, og nullstilt igjen i `finally`
  });
});

describe("G: STRUKTURELL (AST) vakt - parser-/wiring-funksjonene for de fire familiene kalles kun fra en eksakt tillatelsesliste, og aldri med rått prosessmiljø (B-M1)", () => {
  const MAIN = "apps/api/src/main.ts";
  const COMMS_WIRING = "apps/api/src/comms-wiring.ts";
  const SITUATION_WIRING = "apps/api/src/situation-signals-wiring.ts";
  const PERSONAL_WIRING = "apps/api/src/personal-wiring.ts";
  const RULES: GateRules = {
    guardedCalls: {
      growthWriteConfigFromEnv: { [MAIN]: 1 },
      parseGrowthWritePlatforms: { "modules/growth/src/write/config.ts": "some" },
      parseCommsConfig: { [COMMS_WIRING]: 1 },
      buildCommsRuntime: { [MAIN]: 1 },
      situationFlagsFromEnv: { [SITUATION_WIRING]: 1 },
      situationFlagOn: { "modules/situations/src/flags.ts": "some" },
      createSituationSignalsWiring: { [MAIN]: 1 },
      createPersonalWiring: { [MAIN]: 1 },
      personalFlagOn: { [PERSONAL_WIRING]: "some" }
    },
    envArgs: [
      { fn: "growthWriteConfigFromEnv", file: MAIN, position: "arg0", allowed: ["stepUpGate.env"] },
      { fn: "buildCommsRuntime", file: MAIN, position: "env-prop", allowed: ["stepUpGate.env"] },
      { fn: "createSituationSignalsWiring", file: MAIN, position: "env-prop", allowed: ["stepUpGate.env"] },
      { fn: "createPersonalWiring", file: MAIN, position: "env-prop", allowed: ["stepUpGate.env"] },
      { fn: "parseCommsConfig", file: COMMS_WIRING, position: "arg0", allowed: ["input.env"] },
      { fn: "situationFlagsFromEnv", file: SITUATION_WIRING, position: "arg0", allowed: ["deps.env"] },
      { fn: "parseGrowthWritePlatforms", file: "modules/growth/src/write/config.ts", position: "arg0", allowed: ['env["JARVIS_GROWTH_WRITE_PLATFORMS"]'] },
      { fn: "situationFlagOn", file: "modules/situations/src/flags.ts", position: "arg0", allowed: ["env"] },
      { fn: "personalFlagOn", file: PERSONAL_WIRING, position: "arg0", allowed: ["env"] }
    ],
    envFreeFiles: ["modules/comms/src/config.ts", "modules/growth/src/write/config.ts", "modules/situations/src/flags.ts", "modules/tool-gateway/src/personal/flags.ts", COMMS_WIRING, PERSONAL_WIRING, SITUATION_WIRING],
    gateFunction: "applyStepUpBindingGate",
    gateFile: MAIN,
    boundFlagNames: new Set(STEPUP_BOUND_FLAG_GROUPS.flatMap((g) => g.flags.map((f) => f.name)))
  };

  const productionFiles = (): string[] => {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "test" || entry === "dist" || entry === ".git") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(ts|mjs)$/.test(entry) || entry.endsWith(".d.ts")) continue;
        found.push(full.slice(ROOT.length + 1));
      }
    };
    for (const root of ["apps", "modules", "packages", "ops", "infra"]) walk(join(ROOT, root));
    return found.sort();
  };

  let cache: Map<string, ScanResult> | undefined;
  const sources = new Map<string, string>();
  const baseline = (): Map<string, ScanResult> => {
    if (cache !== undefined) return cache;
    cache = new Map();
    for (const rel of productionFiles()) {
      const text = read(rel);
      sources.set(rel, text);
      cache.set(rel, scanSource(rel, text, RULES));
    }
    return cache;
  };
  /** Hele treet med én fil byttet ut (omgåelsen er gjort i MINNET; ingenting skrives til disk). */
  const withFile = (rel: string, text: string): string[] => {
    const results = new Map(baseline());
    results.set(rel, scanSource(rel, text, RULES));
    return aggregate(results.values(), RULES);
  };
  const mutate = (rel: string, oldText: string, newText: string): string => {
    baseline();
    const text = sources.get(rel) as string;
    expect(text.split(oldText).length - 1, `mutasjonsmønsteret finnes nøyaktig én gang i ${rel}`).toBe(1);
    return text.replace(oldText, () => newText);
  };
  const violations = (rel: string, code: string): string[] => scanSource(rel, code, RULES).violations;

  it("DEN EKTE KODEN: ingen brudd mot L1-L7 i hele produksjonstreet (tillatelseslister, eksakte antall, miljø-opprinnelse, ingen rått prosessmiljø, én port)", () => {
    expect(aggregate(baseline().values(), RULES)).toEqual([]);
    // analysen ser faktisk noe: alle de ni funksjonene og porten er funnet der listen sier
    const all = [...baseline().values()];
    for (const [fn, files] of Object.entries(RULES.guardedCalls)) for (const file of Object.keys(files)) expect(baseline().get(file)?.guardedCalls[fn], `${fn} i ${file}`).toBeGreaterThan(0);
    expect(all.reduce((n, r) => n + r.gateCalls, 0)).toBe(1);
    expect(baseline().size).toBeGreaterThan(500); // hele treet er skannet, ikke bare noen få filer
  }, 120_000);

  it("parseCommsConfig har ingen standardverdi for miljøet (`= process.env` var en innebygd omgåelse), og parser-/wiringfilene nevner aldri `process`", () => {
    const config = read("modules/comms/src/config.ts");
    expect(config).toMatch(/export function parseCommsConfig\(env: Readonly<Record<string, string \| undefined>>\): CommsConfig \{/);
    for (const file of RULES.envFreeFiles) expect(scanSource(file, read(file), RULES).violations.filter((v) => v.includes("[L4]")), file).toEqual([]);
  });

  // ---------- reviewerens omgåelses-mutanter (mutants-b.json: MG01-MG08), nå mot den ekte koden i minnet ----------
  const SERVER_ANCHOR = 'import type { IdentityContext, JsonValue, StepUpBindingStatus } from "@jarvis/contracts";';
  const GATE_LINE = "const stepUpGate = applyStepUpBindingGate(process.env);";
  const REVIEWER_MUTANTS: ReadonlyArray<{ id: string; file: string; anchor: string; extra: string; note: string }> = [
    { id: "MG01", file: MAIN, anchor: GATE_LINE, extra: "\n  const __bypassGrowth = growthWriteConfigFromEnv({ ...process.env }).platforms.size;", note: "spredning av rått miljø i vekstparseren" },
    { id: "MG02", file: MAIN, anchor: GATE_LINE, extra: "\n  const __rawEnv = process.env;\n  const __bypassGrowth2 = growthWriteConfigFromEnv(__rawEnv).platforms.size;", note: "alias av process.env" },
    { id: "MG03", file: "apps/api/src/server.ts", anchor: SERVER_ANCHOR, extra: '\nimport { parseCommsConfig as __parseComms } from "@jarvis/comms";\nexport const __bypassComms = (): boolean => __parseComms(process.env).outbound;', note: "kommunikasjonsparseren fra server.ts via import-alias" },
    { id: "MG04", file: "apps/api/src/server.ts", anchor: SERVER_ANCHOR, extra: '\nimport { situationFlagsFromEnv as __sf } from "@jarvis/situations";\nexport const __bypassSit = (): boolean => __sf(process.env).signals;', note: "situasjonsparseren fra server.ts via import-alias" },
    { id: "MG05", file: "apps/api/src/server.ts", anchor: SERVER_ANCHOR, extra: '\nexport const __bypassDirect = (): boolean => process.env["JARVIS_COMMS_OUTBOUND"] === "on";', note: "KONTROLL: direkte process.env[...]" },
    { id: "MG06", file: "apps/api/src/server.ts", anchor: SERVER_ANCHOR, extra: "\nexport const __bypassTpl = (): boolean => process.env[`JARVIS_COMMS_OUTBOUND`] === \"on\";", note: "mal-literal-nøkkel" },
    { id: "MG07", file: "apps/api/src/server.ts", anchor: SERVER_ANCHOR, extra: '\nconst __e = process.env;\nexport const __bypassAlias = (): boolean => __e["JARVIS_PERSONAL_CAR"] === "on";', note: "alias av process.env med flaggnavn" },
    { id: "MG08", file: "apps/api/src/vision-runtime.ts", anchor: 'import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";', extra: '\nimport { createPersonalWiring as __cpw } from "./personal-wiring.ts";\nexport const __bypassPersonal = (): number => __cpw({ env: process.env, pool: {} as never, gateway: {} as never, readSecret: async () => null, ownerPersonId: "x" }).tools.length;', note: "personlig-wiring med rått miljø fra vision-runtime.ts" }
  ];
  for (const m of REVIEWER_MUTANTS) {
    it(`${m.id} (${m.note}) gir nå RØDT: analysen feller omgåelsen`, () => {
      const found = withFile(m.file, mutate(m.file, m.anchor, m.anchor + m.extra));
      expect(found.length, `${m.id} ble IKKE felt`).toBeGreaterThan(0);
    });
  }

  // ---------- flere omgåelsesformer, mot den ekte main.ts (L1-L3) ----------
  const MAIN_FORMS: ReadonlyArray<[string, string, string]> = [
    ["MG09 bracket-notasjon", GATE_LINE, '\n  const __a = growthWriteConfigFromEnv(process["env"]);'],
    ["MG10 mal-literal i bracket", GATE_LINE, "\n  const __a = growthWriteConfigFromEnv(process[`env`]);"],
    ["MG11 globalThis.process.env", GATE_LINE, "\n  const __a = growthWriteConfigFromEnv(globalThis.process.env);"],
    ["MG12 destrukturering fra process", GATE_LINE, "\n  const { env: __e } = process;\n  const __a = growthWriteConfigFromEnv(__e);"],
    ["MG13 alias av alias", GATE_LINE, "\n  const __a1 = process.env;\n  const __a2 = __a1;\n  const __a = growthWriteConfigFromEnv(__a2);"],
    ["MG14 Object.assign av rått miljø", GATE_LINE, "\n  const __a = growthWriteConfigFromEnv(Object.assign({}, process.env));"],
    ["MG15 funksjon som returnerer rått miljø", GATE_LINE, "\n  const __get = () => process.env;\n  const __a = growthWriteConfigFromEnv(__get());"],
    ["MG16 betinget uttrykk", GATE_LINE, "\n  const __a = growthWriteConfigFromEnv(pool ? process.env : {});"],
    ["MG17 typeassertion", GATE_LINE, "\n  const __a = growthWriteConfigFromEnv(process.env as Record<string, string>);"],
    ["MG18 spredning i objektargument (kommunikasjon)", GATE_LINE, "\n  const __a = buildCommsRuntime({ env: { ...process.env }, pool } as never);"],
    ["MG19 shorthand env i objektargument", GATE_LINE, "\n  const env = process.env;\n  const __a = createPersonalWiring({ env, pool } as never);"],
    ["MG20 andre ukjente identifikator som miljø (importert fra en annen fil)", GATE_LINE, "\n  const __a = growthWriteConfigFromEnv(rawEnvFromElsewhere);"],
    ["MG21 porten bygget av noe annet enn rått miljø", GATE_LINE, '\n  const __g = applyStepUpBindingGate({ ...process.env, JARVIS_STEPUP_CHANNEL_BINDING: "enforce" });'],
    ["MG22 andre port-kall", GATE_LINE, "\n  const __g2 = applyStepUpBindingGate(process.env);"],
    ["MG23 nytt ekstra kall med gatet miljø (antallet er en del av tillatelseslisten)", GATE_LINE, "\n  const __a = growthWriteConfigFromEnv(stepUpGate.env);"],
    ["MG24 ekstra kommunikasjonsruntime", GATE_LINE, "\n  const __a = buildCommsRuntime({ env: stepUpGate.env } as never);"],
    ["MG25 guardet funksjon brukt som verdi (videresending)", GATE_LINE, "\n  const __f = growthWriteConfigFromEnv;"],
    ["MG26 .call med rått miljø", GATE_LINE, "\n  const __a = growthWriteConfigFromEnv.call(null, process.env);"],
    ["MG27 som callback", GATE_LINE, "\n  const __a = [stepUpGate.env].map(growthWriteConfigFromEnv);"],
    ["MG28 bundet flagg lest fra rått miljø", GATE_LINE, '\n  const __a = process.env["JARVIS_SITUATION_SIGNALS"] === "on";'],
    ["MG29 punktum-notasjon på flagg", GATE_LINE, '\n  const __a = process.env.JARVIS_PERSONAL_FAMILY === "on";'],
    ["MG30 destrukturering av flagg fra rått miljø", GATE_LINE, "\n  const { JARVIS_GROWTH_WRITE_PLATFORMS: __p } = process.env;"]
  ];
  for (const [name, anchor, extra] of MAIN_FORMS) {
    it(`${name}: felt av analysen`, () => {
      expect(withFile(MAIN, mutate(MAIN, anchor, anchor + extra)).length, name).toBeGreaterThan(0);
    });
  }

  it("fjernes kallet fra main.ts (eller flyttes det til en fil som ikke er vurdert), er tillatelseslisten foreldet og feller testen", () => {
    expect(withFile(MAIN, mutate(MAIN, "const growthWriteConfig = growthWriteConfigFromEnv(stepUpGate.env);", "const growthWriteConfig = { platforms: new Set<string>(), targets: new Map(), creativeHosts: new Set<string>() } as never;")).join("\n")).toMatch(/growthWriteConfigFromEnv kalles ikke lenger/);
  });

  // ---------- parser-definisjoner og wiringfiler ----------
  it("L5: `= process.env` som standardverdi i parseren (den opprinnelige omgåelsen i parseCommsConfig), `= {}` og valgfri parameter er alle felt", () => {
    const file = "modules/comms/src/config.ts";
    const original = "export function parseCommsConfig(env: Readonly<Record<string, string | undefined>>): CommsConfig {";
    for (const replacement of [
      "export function parseCommsConfig(env: Readonly<Record<string, string | undefined>> = process.env): CommsConfig {",
      "export function parseCommsConfig(env: Readonly<Record<string, string | undefined>> = {}): CommsConfig {",
      "export function parseCommsConfig(env?: Readonly<Record<string, string | undefined>>): CommsConfig {"
    ]) {
      const found = withFile(file, mutate(file, original, replacement));
      expect(found.some((v) => v.includes("[L5]")), replacement).toBe(true);
    }
    expect(withFile(file, mutate(file, original, "export function parseCommsConfig(env: Readonly<Record<string, string | undefined>> = process.env): CommsConfig {")).some((v) => v.includes("[L4]"))).toBe(true);
  });

  it("L4: en `process`-referanse i en parser-/wiringfil er et brudd, også uten et kall (`const p = process.pid`)", () => {
    for (const file of RULES.envFreeFiles) expect(violations(file, "export const __x = process.pid;").some((v) => v.includes("[L4]")), file).toBe(true);
    expect(violations(PERSONAL_WIRING, 'import { env } from "node:process";\nexport const __x = 1;').some((v) => v.includes("[L4]"))).toBe(true);
  });

  it("L1: miljø-opprinnelsen i wiringfilene er eksakt (`input.env`, `deps.env`, `env`): en annen kilde feller", () => {
    expect(withFile(COMMS_WIRING, mutate(COMMS_WIRING, "parseCommsConfig(input.env)", "parseCommsConfig(input.pool as never)")).some((v) => v.includes("[L2]"))).toBe(true);
    expect(withFile(SITUATION_WIRING, mutate(SITUATION_WIRING, "situationFlagsFromEnv(deps.env)", "situationFlagsFromEnv(deps as never)")).some((v) => v.includes("[L2]"))).toBe(true);
    expect(withFile(COMMS_WIRING, mutate(COMMS_WIRING, "parseCommsConfig(input.env)", "parseCommsConfig()")).some((v) => v.includes("[L2]"))).toBe(true);
    expect(withFile(COMMS_WIRING, mutate(COMMS_WIRING, "parseCommsConfig(input.env)", "parseCommsConfig.call(null, input.env)")).some((v) => v.includes("[L1]"))).toBe(true);
  });

  // ---------- syntetiske omgåelser i filer som IKKE er på listen ----------
  const OTHER = "apps/api/src/some-new-file.ts";
  const SYNTHETIC: ReadonlyArray<[string, string]> = [
    ["navneromsimport", 'import * as comms from "@jarvis/comms";\nexport const x = comms.parseCommsConfig(process.env);'],
    ["import-alias", 'import { situationFlagsFromEnv as sf } from "@jarvis/situations";\nexport const x = sf(process.env);'],
    ["destrukturert require", 'const { growthWriteConfigFromEnv: g } = require("@jarvis/growth");\nexport const x = g(process.env);'],
    ["alias av funksjonen", 'import { createPersonalWiring } from "./personal-wiring.ts";\nconst f = createPersonalWiring;\nexport const x = f({ env: {} } as never);'],
    ["node:process-importen `env`", 'import { env as penv } from "node:process";\nimport { parseCommsConfig } from "@jarvis/comms";\nexport const x = parseCommsConfig(penv);'],
    ["standardimport av node:process", 'import proc from "node:process";\nimport { parseCommsConfig } from "@jarvis/comms";\nexport const x = parseCommsConfig(proc.env);'],
    ["et kall med gatet miljø fra en uvurdert fil", 'import { parseCommsConfig } from "@jarvis/comms";\nexport const x = (gate: { env: Record<string, string> }) => parseCommsConfig(gate.env);'],
    ["flagglesing via alias fra node:process", 'import { env } from "node:process";\nexport const x = env["JARVIS_COMMS_OUTBOUND"];'],
    ["flagglesing via punktum", "export const x = process.env.JARVIS_COMMS_CALLS;"],
    ["flagglesing via kopi", 'const copy = { ...process.env };\nexport const x = copy["JARVIS_PERSONAL_HOME_CRITICAL"];'],
    ["flagglesing via destrukturering", "export const { JARVIS_COMMS_OUTBOUND } = process.env;"]
  ];
  for (const [name, code] of SYNTHETIC) {
    it(`syntetisk omgåelse i en ny fil (${name}): felt`, () => {
      expect(withFile(OTHER, code).length, name).toBeGreaterThan(0);
    });
  }

  it("L6: et andre sted som bygger porten feller testen (porten finnes kun i main.ts)", () => {
    expect(withFile(OTHER, "export const g = applyStepUpBindingGate(process.env);").some((v) => v.includes("[L6]"))).toBe(true);
  });

  // ---------- ingen falske positiver: riktig bruk og vanlige mønstre passerer ----------
  it("riktig bruk gir INGEN brudd: gatet miljø, en variabel kalt `env`, egenskapen `.env` på porten, og urelaterte lesinger av rått miljø", () => {
    const clean = [
      "const stepUpGate = applyStepUpBindingGate(process.env);",
      "const env = process.env;",
      'const port = Number(env["PORT"] ?? 3000);',
      'const flag = process.env["JARVIS_GROWTH_EXPERIMENTS"] === "on";',
      "const growthWriteConfig = growthWriteConfigFromEnv(stepUpGate.env);",
      "const commsRuntime = buildCommsRuntime({ env: stepUpGate.env, pool } as never);",
      "const personal = createPersonalWiring({ env: stepUpGate.env, pool } as never);",
      "const situationSignals = createSituationSignalsWiring({ env: stepUpGate.env, pool } as never);",
      "export const used = [port, flag, growthWriteConfig, commsRuntime, personal, situationSignals];"
    ].join("\n");
    expect(violations(MAIN, clean)).toEqual([]);
  });

  it("registeret og analysen deler flaggnavn: alle 14 koblede flagg er under L7, og ingen annen konstant er med", () => {
    expect([...RULES.boundFlagNames].sort()).toEqual(STEPUP_BOUND_FLAG_GROUPS.flatMap((g) => g.flags.map((f) => f.name)).sort());
    expect(RULES.boundFlagNames.size).toBe(14);
  });
});
