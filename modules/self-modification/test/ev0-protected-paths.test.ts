import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_PATH_PATTERNS, INVALID_PATH_KEY, REQUIRED_E3_ACTIONS, REQUIRED_PROTECTED_PROBES, buildConstitution, classifySelfModification, isInvalidPathKey,
  protectionKey, type ConstitutionManifest
} from "../src/index.ts";

/**
 * WP-EV0 (HF2 EV-0, K2): utvidede beskyttede stier, sonder og E3-handlinger FØR eierens signering, samt sti-normalisering som ikke lar en
 * endring «slippe unna» ved å se annerledes ut (store/små bokstaver, `..`, `./`, etterfølgende punktum, Unicode-kompatibilitetstegn).
 * Ren logikk (ingen DB).
 */
const ROOT = new URL("../../../", import.meta.url);
const manifest = (): ConstitutionManifest => JSON.parse(readFileSync(new URL("config/evolution/constitution.v1.json", ROOT), "utf8")) as ConstitutionManifest;
const constitution = buildConstitution(manifest());
const msg = (fn: () => unknown): string => {
  try { fn(); } catch (err) { return (err as Error).message; }
  return "no_error";
};
type Rule = ConstitutionManifest["protected_paths"][number];
/** Dekker regelen stien? Samme semantikk som konstitusjonen (foldet nøkkel), skrevet på nytt her så testen ikke deler en feil med koden. */
const ruleCovers = (r: Rule, probe: string): boolean => {
  const key = protectionKey(probe);
  const v = protectionKey(r.value);
  return r.kind === "prefix" ? key.startsWith(v) : r.kind === "exact" ? key === v : r.kind === "suffix" ? key.endsWith(v) : key === v || key.endsWith(`/${v}`);
};

/** Filene WP-EV0 la til (utover de 20 opprinnelige sondene). Hver MÅ være E3 (forbudt for Evolution Engine) uansett skrivemåte. */
const NEW_PROTECTED_FILES = [
  "modules/tool-gateway/src/class-d-pipeline.ts", "modules/tool-gateway/src/finance-class-d.ts", "modules/tool-gateway/src/model-tool-surface.ts",
  "apps/api/src/step-up.ts",
  "modules/core/src/services/audit-writer.ts", "modules/core/src/services/policy-audit-sink.ts", "modules/core/src/services/approval-store.ts",
  "modules/core/src/services/identity-service.ts", "modules/core/src/services/session-grant-service.ts", "modules/core/src/services/device-authority.ts",
  "modules/core/src/services/channel-session-authority.ts", "modules/core/src/services/voice-session-authority.ts",
  "modules/core/src/services/telegram-owner-authority.ts", "modules/core/src/services/runtime-role.ts",
  "modules/core/src/db/pool.ts", "modules/executive/src/self-model/confidence-gate.ts",
  "modules/policy/src/policy-gateway.ts", "modules/policy/src/approval-verifier.ts", "modules/policy/src/kill-switch.ts",
  "config/program/index.json", "docs/remediation/ADR-001-dokumenthierarki.md", "docs/SECURITY_MODEL.md", "docs/CANONICAL_SPEC.md", "ops/job-runner/egress-proxy.mjs", "ops/job-runner/lib/config.mjs",
  "ops/claude-worker/worker.mjs", "ops/backup/jarvis-backup.mjs", "ops/security/check-containment.mjs"
];

/** Ting som LIGNER på beskyttede filer, men ikke er det: skal fortsatt være E2 (ikke E3) - ellers er mønstrene for brede. */
const NEAR_MISSES = [
  "modules/tool-gateway/src/live-transports.ts", "modules/tool-gateway/src/class-d-pipeline.test.ts", "apps/api/src/step-up-helper.ts",
  "apps/api/src/server.ts", "modules/core/src/services/message-store.ts", "modules/core/src/services/audit-writer.ts.bak", "modules/core/src/db/pool.tsx",
  "modules/executive/src/self-model/diagnosis.ts", "modules/executive/src/slo/definitions.ts", "ops/evolution/dependency-check.ts", "ops/acceptance/record-evidence.mjs",
  "docs/runbooks/WPP3_SMALL_FIXES.md", "docs/ARCHITECTURE.md", "docs/SECURITY_MODEL.md.bak", "config/charlie-personality.json.bak", "apps/web/index.html"
];

describe("A: protectionKey - kanonisk, kun-for-beskyttelse sti-nøkkel (over-treff er sikker side)", () => {
  it("A1: vanlige stier får små bokstaver, / som skille og ingen ledende ./ eller doble skråstreker", () => {
    expect(protectionKey("Modules/Policy/src/X.ts")).toBe("modules/policy/src/x.ts");
    expect(protectionKey("./modules//policy\\src/x.ts")).toBe("modules/policy/src/x.ts");
    expect(protectionKey("modules/policy/")).toBe("modules/policy/");
    expect(protectionKey("a/./b/./c.ts")).toBe("a/b/c.ts");
  });

  it("A2: etterfølgende punktum/mellomrom pr. segment (Windows-aliaser) strippes", () => {
    expect(protectionKey("modules/policy/src/policy-gateway.ts.")).toBe("modules/policy/src/policy-gateway.ts");
    expect(protectionKey("modules/policy /src/x.ts  ")).toBe("modules/policy/src/x.ts");
    expect(protectionKey("modules/policy.../src/x.ts")).toBe(INVALID_PATH_KEY); // «..» i et segment er alltid ugyldig
  });

  it("A3: Unicode-kompatibilitetstegn foldes (NFKC) FØR sjekken - fullbredde punktum/skråstrek kan ikke forkles", () => {
    const fullwidthDots = String.fromCodePoint(0xff0e, 0xff0e);
    const fullwidthSlash = String.fromCodePoint(0xff0f);
    expect(protectionKey(`modules${fullwidthSlash}policy${fullwidthSlash}x.ts`)).toBe("modules/policy/x.ts");
    expect(protectionKey(`apps${fullwidthSlash}${fullwidthDots}${fullwidthSlash}modules/policy/x.ts`)).toBe(INVALID_PATH_KEY);
    // Kelvin-tegnet (U+212A) og lang s (U+017F) foldes til k/s: «pac<Kelvin>age.json» er package.json, «ops/<lang s>ecurity/» er ops/security/.
    expect(protectionKey(`apps/api/pac${String.fromCodePoint(0x212a)}age.json`)).toBe("apps/api/package.json");
    expect(protectionKey(`ops/${String.fromCodePoint(0x17f)}ecurity/x`)).toBe("ops/security/x");
  });

  it("A4: ugyldige stier gir INVALID: .., absolutt, ~, stasjonsbokstav/kolon, NUL/kontrolltegn, 8.3-kortnavn og tom", () => {
    for (const bad of [
      "../x", "a/../b", "a/b/..", "/etc/passwd", "~/x", "~root/x", "C:/x", "C:\\x", "a:b", "modules/policy/x.ts::$DATA", "a\u0000b", "a\u001fb", "a\u007fb", "a\nb",
      "modules/POLIC~1/x.ts", "", " ", ".", "./", "//", "\\\\?\\C:\\x"
    ]) {
      expect(protectionKey(bad), JSON.stringify(bad)).toBe(INVALID_PATH_KEY);
    }
    expect(isInvalidPathKey(INVALID_PATH_KEY)).toBe(true);
    expect(isInvalidPathKey("modules/policy/x.ts")).toBe(false);
  });

  it("A5: INVALID kan aldri forveksles med en ekte sti (sentinelen inneholder NUL, som en gyldig nøkkel aldri kan)", () => {
    expect(INVALID_PATH_KEY).toContain("\u0000");
    expect(protectionKey("a\u0000b")).toBe(INVALID_PATH_KEY);
  });
});

describe("B: hver beskyttede fil er E3 - uansett skrivemåte (hardkodede mønstre OG signert manifest)", () => {
  const variants = (p: string): string[] => [
    p, p.toUpperCase(), `./${p}`, p.replace(/\//g, "\\"), p.replace(/\//g, "//"), `${p}.`, `${p} `, p.replace("/", "/./"),
    p.replace(/[a-z]/, (c) => c.toUpperCase()), p.replace(/\//g, String.fromCodePoint(0xff0f))
  ];

  it("B1: alle nye beskyttede filer + alle sonder: forbidden (legacy) og E3 (konstitusjon), i alle skrivemåter", () => {
    for (const file of [...NEW_PROTECTED_FILES, ...REQUIRED_PROTECTED_PROBES]) {
      for (const v of variants(file)) {
        expect(classifySelfModification([v]), `legacy ${JSON.stringify(v)}`).toBe("forbidden");
        expect(constitution.classify([v]), `E ${JSON.stringify(v)}`).toBe("E3");
      }
    }
  });

  it("B1b: Unicode-forkledning (Kelvin-tegn, lang s, fullbredde bokstaver) gir fortsatt E3", () => {
    const kelvin = String.fromCodePoint(0x212a);
    const longS = String.fromCodePoint(0x17f);
    const fullwidthP = String.fromCodePoint(0xff50);
    for (const p of [`apps/api/pac${kelvin}age.json`, `ops/${longS}ecurity/x.mjs`, `modules/${fullwidthP}olicy/src/x.ts`]) {
      expect(classifySelfModification([p]), p).toBe("forbidden");
      expect(constitution.classify([p]), p).toBe("E3");
    }
  });

  it("B2: en beskyttet fil blandet med en uskyldig fil er fortsatt E3 / forbidden (forbud vinner alltid)", () => {
    for (const file of NEW_PROTECTED_FILES) {
      expect(classifySelfModification(["config/charlie-personality.json", file])).toBe("forbidden");
      expect(constitution.classify(["config/charlie-personality.json", file])).toBe("E3");
    }
  });

  it("B3: nære bom (lignende navn, annen filtype, backup-suffiks) er IKKE E3 - mønstrene er forankret (E2: vanlig kode)", () => {
    for (const p of NEAR_MISSES) {
      expect(classifySelfModification([p]), p).toBe("requires_approval");
      expect(constitution.classify([p]), p).toBe("E2");
    }
  });

  it("B4: en sti som ikke kan normaliseres trygt er E3/forbidden (ikke E2): `..`-utbrytning kan ikke gi eieren et «godkjenn»-valg på en skjult beskyttet fil", () => {
    for (const p of ["a/../modules/policy/src/policy-gateway.ts", "../x", "/etc/passwd", "modules/./policy/../policy/x.ts", "x\u0000y", "C:/windows/x"]) {
      expect(classifySelfModification([p]), JSON.stringify(p)).toBe("forbidden");
      expect(constitution.classify([p]), JSON.stringify(p)).toBe("E3");
      expect(constitution.classify(["config/charlie-personality.json", p]), JSON.stringify(p)).toBe("E3");
    }
  });

  it("B5: allowlisten (E1) er fortsatt EKSAKT og store/små-bokstav-sensitiv - kun nøyaktig den ene filen gir E1", () => {
    expect(constitution.classify(["config/charlie-personality.json"])).toBe("E1");
    expect(constitution.classify(["./config/charlie-personality.json"])).toBe("E1");
    for (const p of ["Config/charlie-personality.json", "config/Charlie-Personality.json", "config/charlie-personality.json.", "config/./charlie-personality.json/x"]) {
      expect(constitution.classify([p]), p).not.toBe("E1");
    }
  });

  it("B6: den gamle policyen ALENE (uten manifestet) har samme eksakte allowliste: en annen skrivemåte gir requires_approval, aldri zero_review", () => {
    expect(classifySelfModification(["config/charlie-personality.json"])).toBe("zero_review");
    expect(classifySelfModification(["./config/charlie-personality.json"])).toBe("zero_review");
    for (const p of ["Config/charlie-personality.json", "config/Charlie-Personality.json", "CONFIG/CHARLIE-PERSONALITY.JSON", "config/charlie-personality.json.", "config/./charlie-personality.json/x"]) {
      expect(classifySelfModification([p]), p).toBe("requires_approval");
    }
  });
});

describe("C: invarianter mellom hardkodede mønstre, sonder og signert manifest", () => {
  it("C1: HVER påkrevd sonde er forbudt av de hardkodede mønstrene ALENE (beskyttelsen hviler aldri bare på manifestet)", () => {
    for (const probe of REQUIRED_PROTECTED_PROBES) {
      const key = protectionKey(probe);
      expect(FORBIDDEN_PATH_PATTERNS.some((rx) => rx.test(key)), probe).toBe(true);
    }
  });

  it("C2: HVERT hardkodet mønster dekkes av minst én påkrevd sonde (ingen mønster er en «ukontrollert» regel som kan fjernes uten at en test feiler)", () => {
    FORBIDDEN_PATH_PATTERNS.forEach((rx, i) => {
      const hit = REQUIRED_PROTECTED_PROBES.filter((probe) => rx.test(protectionKey(probe)));
      expect(hit.length, `mønster #${i} ${String(rx)}`).toBeGreaterThan(0);
    });
  });

  it("C3: alle nye beskyttede filer finnes som sonder (nye filer kan ikke glemmes i gulvet)", () => {
    for (const f of NEW_PROTECTED_FILES.filter((p) => !p.startsWith("ops/job-runner/lib/"))) {
      expect(REQUIRED_PROTECTED_PROBES, f).toContain(f);
    }
  });

  it("C4: sondene er sporbare filer - bortsett fra de dokumenterte unntakene (eier-opprettede filer, framtidig program-indeks, gammel sondenavn)", () => {
    const ABSENT_OK = new Set([
      "config/evolution/constitution.v1.sig", "config/evolution/constitution.pub.pem", // opprettes av eieren ved signering
      ".env", ".env.production", // aldri sjekket inn
      "config/program/index.json", // HF6 program-indeks (finnes ikke i basen ennå)
      // opprinnelige sondenavn som ikke samsvarer med en fil, beholdt: gulvet er monotont (en sonde fjernes aldri); de ekte navnene er sonder ved siden av
      "modules/policy/src/gateway.ts", "modules/core/src/db/migrations/001_init.sql", "docs/security/SECURITY_MODEL.md"
    ]);
    const missing = REQUIRED_PROTECTED_PROBES.filter((p) => !existsSync(new URL(p, ROOT)) && !ABSENT_OK.has(p));
    expect(missing).toEqual([]);
    for (const p of ABSENT_OK) expect(REQUIRED_PROTECTED_PROBES, p).toContain(p);
  });

  it("C5: fjernes ALLE regler som dekker en sonde fra manifestet, avvises manifestet (for hver sonde) - første udekkede sonde står i feilen", () => {
    for (const probe of REQUIRED_PROTECTED_PROBES) {
      const m = manifest();
      const original = m.protected_paths;
      m.protected_paths = original.filter((r) => !ruleCovers(r, probe));
      expect(m.protected_paths.length, probe).toBeLessThan(original.length);
      const first = REQUIRED_PROTECTED_PROBES.find((p) => !m.protected_paths.some((r) => ruleCovers(r, p)));
      expect(first, probe).toBeDefined();
      expect(msg(() => buildConstitution(m)), probe).toBe(`constitution_weakened:unprotected:${first}`);
    }
  });

  it("C6: manifestets beskyttelse er IKKE svakere enn de hardkodede mønstrene: hver sonde er dekket av en manifest-regel", () => {
    const m = manifest();
    for (const probe of REQUIRED_PROTECTED_PROBES) expect(m.protected_paths.some((r) => ruleCovers(r, probe)), probe).toBe(true);
  });

  it("C7: store/små bokstaver i en manifest-regel skiller seg ikke fra stien (regelverdier foldes likt)", () => {
    const m = manifest();
    m.protected_paths = m.protected_paths.map((r) => ({ ...r, value: r.value.toUpperCase() }));
    expect(() => buildConstitution(m)).not.toThrow();
    expect(buildConstitution(m).classify(["modules/policy/src/x.ts"])).toBe("E3");
  });
});

describe("C2: de hardkodede mønstrene beskytter hele trærne selv når manifestet er minimalt", () => {
  /** Et gyldig, men MINIMALT manifest: kun én eksakt regel pr. sonde (ingen prefiks) - så beskyttelsen av resten av treet må komme fra de hardkodede mønstrene. */
  const minimal = (): ConstitutionManifest => ({ ...manifest(), protected_paths: REQUIRED_PROTECTED_PROBES.map((value) => ({ kind: "exact" as const, value })) });

  it("C2a: manifestet er gyldig (alle sonder dekket), og en fil UTENFOR sondene men under et beskyttet tre er likevel E3", () => {
    const c = buildConstitution(minimal());
    for (const p of [
      "modules/policy/src/aldri-sett.ts", "modules/owner-controls/src/ny.ts", "modules/self-modification/src/ny.ts", "modules/core/src/db/migrations/999_ny.sql", "infra/local/ny.yml",
      "ops/security/ny.mjs", "ops/job-runner/lib/ny.mjs", "ops/claude-worker/ny.mjs", "docs/remediation/NY.md", "config/program/ny.json", ".github/workflows/ny.yml", "apps/web/package.json"
    ]) {
      expect(c.classify([p]), p).toBe("E3");
    }
  });

  it("C2b: og vanlig kode er fortsatt E2 med et minimalt manifest (mønstrene er ikke for brede)", () => {
    const c = buildConstitution(minimal());
    for (const p of NEAR_MISSES) expect(c.classify([p]), p).toBe("E2");
    expect(c.classify(["config/charlie-personality.json"])).toBe("E1");
  });
});

describe("D: E3-handlinger - gulvet i koden og i manifestet", () => {
  it("D1: de 6 opprinnelige + 7 nye (HF2 kap. 5/6/13/28) handlingene er påkrevd", () => {
    expect([...REQUIRED_E3_ACTIONS].sort()).toEqual([
      "disable_security_alarm", "export_break_glass_key", "grant_self_root", "modify_approval_verifier", "modify_audit_integrity", "modify_kill_switch",
      "modify_protected_path_manifest", "push_to_protected_branch", "raise_autonomy_level", "raise_own_authority_or_budget_limits", "read_break_glass_key",
      "rotate_break_glass_key", "self_approve_change"
    ]);
  });

  it("D2: repoets manifest forbyr alle påkrevde handlinger, og ukjente handlinger er ikke forbudt her", () => {
    for (const a of REQUIRED_E3_ACTIONS) expect(constitution.isActionForbidden(a), a).toBe(true);
    expect(constitution.isActionForbidden("send_status_email")).toBe(false);
    expect(constitution.isActionForbidden("")).toBe(false);
  });

  it("D3: hver påkrevde handling kan ikke fjernes fra et (signert) manifest", () => {
    for (const action of REQUIRED_E3_ACTIONS) {
      const m = manifest();
      m.e3_actions = m.e3_actions.filter((a) => a !== action);
      expect(msg(() => buildConstitution(m)), action).toBe(`constitution_weakened:e3_action_missing:${action}`);
    }
  });
});
