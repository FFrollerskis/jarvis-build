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
    expect(main).toContain('msg: "stepup_channel_binding"');
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
