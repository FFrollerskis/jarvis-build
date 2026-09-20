import { describe, expect, it } from "vitest";
import { classifySelfModification, FORBIDDEN_PATH_PATTERNS, ZERO_REVIEW_ALLOWLIST } from "../src/policy.ts";

/**
 * Task #121 (D-214): rene, deterministiske enhetstester for selve
 * håndhevingsmekanismen CLAUDE.md regel #2 krever - INGEN DB, INGEN I/O.
 */
describe("A: zero_review - kun den navngitte allowlisten, og KUN når den er den ENESTE endrede stien", () => {
  it("A1: den ene allowlistede filen alene -> zero_review", () => {
    expect(classifySelfModification(["config/charlie-personality.json"])).toBe("zero_review");
  });

  it("A2: allowlisten inneholder eksakt den forventede oppføringen (regresjonsvakt mot en fremtidig, utilsiktet utvidelse)", () => {
    expect([...ZERO_REVIEW_ALLOWLIST]).toEqual(["config/charlie-personality.json"]);
  });

  it("A3: samme fil, med en ledende './' normaliseres til samme kanoniske sti -> zero_review", () => {
    expect(classifySelfModification(["./config/charlie-personality.json"])).toBe("zero_review");
  });
});

describe("B: requires_approval - alt annet ikke-forbudt", () => {
  it("B1: en enkelt, ikke-allowlistet, ikke-forbudt fil", () => {
    expect(classifySelfModification(["apps/api/src/server.ts"])).toBe("requires_approval");
  });

  it("B2: allowlistet fil BLANDET med en annen ikke-forbudt fil -> requires_approval (ikke zero_review)", () => {
    expect(classifySelfModification(["config/charlie-personality.json", "apps/api/src/server.ts"])).toBe("requires_approval");
  });
});

describe("C: forbidden - hardkodede sikkerhetskritiske mønstre VINNER alltid", () => {
  it("C1: tom diff -> forbidden", () => {
    expect(classifySelfModification([])).toBe("forbidden");
  });

  it("C2: en fil i modules/policy/ -> forbidden", () => {
    expect(classifySelfModification(["modules/policy/src/gateway.ts"])).toBe("forbidden");
  });

  it("C3: en fil i modules/owner-controls/ -> forbidden", () => {
    expect(classifySelfModification(["modules/owner-controls/src/service.ts"])).toBe("forbidden");
  });

  it("C4: en fil i modules/self-modification/ selv -> forbidden (kan ikke utvide sin egen kapabilitet)", () => {
    expect(classifySelfModification(["modules/self-modification/src/policy.ts"])).toBe("forbidden");
  });

  it("C5: ToolGateway sin kjerne-pipeline (gateway.ts eksakt) -> forbidden", () => {
    expect(classifySelfModification(["modules/tool-gateway/src/gateway.ts"])).toBe("forbidden");
  });

  it("C5b: andre filer i modules/tool-gateway/src/ (ikke gateway.ts) er IKKE forbudt av dette mønsteret alene", () => {
    expect(classifySelfModification(["modules/tool-gateway/src/live-transports.ts"])).toBe("requires_approval");
  });

  it("C6: en migrasjon -> forbidden", () => {
    expect(classifySelfModification(["modules/core/src/db/migrations/061_ny.sql"])).toBe("forbidden");
  });

  it("C7: CI-workflow (.github/) -> forbidden", () => {
    expect(classifySelfModification([".github/workflows/ci.yml"])).toBe("forbidden");
  });

  it("C8: infra/ -> forbidden", () => {
    expect(classifySelfModification(["infra/docker-compose.yml"])).toBe("forbidden");
  });

  it("C9: package.json (rot eller nøstet) -> forbidden", () => {
    expect(classifySelfModification(["package.json"])).toBe("forbidden");
    expect(classifySelfModification(["modules/tasks/package.json"])).toBe("forbidden");
  });

  it("C10: pnpm-lock.yaml/pnpm-workspace.yaml -> forbidden", () => {
    expect(classifySelfModification(["pnpm-lock.yaml"])).toBe("forbidden");
    expect(classifySelfModification(["pnpm-workspace.yaml"])).toBe("forbidden");
  });

  it("C11: .env-filer -> forbidden", () => {
    expect(classifySelfModification([".env"])).toBe("forbidden");
    expect(classifySelfModification([".env.production"])).toBe("forbidden");
  });

  it("C12: docs/security/ -> forbidden", () => {
    expect(classifySelfModification(["docs/security/SECURITY_MODEL.md"])).toBe("forbidden");
  });

  it("C13: CLAUDE.md -> forbidden", () => {
    expect(classifySelfModification(["CLAUDE.md"])).toBe("forbidden");
  });

  it("C14: forbudt mønster BLANDET med den allowlistede filen -> forbidden VINNER, ALDRI zero_review", () => {
    expect(classifySelfModification(["config/charlie-personality.json", "modules/policy/src/gateway.ts"])).toBe("forbidden");
  });

  it("C15: FORBIDDEN_PATH_PATTERNS er ikke tom (regresjonsvakt mot en utilsiktet tømt liste)", () => {
    expect(FORBIDDEN_PATH_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe("D: sti-normalisering er fail-closed - en utbrytingsforsøk klassifiseres ALDRI som zero_review", () => {
  it("D1: '../'-utbrytning -> aldri zero_review (faller til requires_approval, ingen forbudt-match her)", () => {
    expect(classifySelfModification(["../outside-repo.json"])).not.toBe("zero_review");
  });

  it("D2: absolutt sti -> aldri zero_review", () => {
    expect(classifySelfModification(["/etc/passwd"])).not.toBe("zero_review");
  });

  it("D3: en '../'-utbrytning som (etter normalisering) ser ut som allowlist-filen, matcher IKKE allowlisten", () => {
    expect(classifySelfModification(["../config/charlie-personality.json"])).not.toBe("zero_review");
  });

  it("D4: backslash-separert sti normaliseres til samme forward-slash-form (Windows-stil input)", () => {
    expect(classifySelfModification(["config\\charlie-personality.json"])).toBe("zero_review");
  });

  it("D5: doble skråstreker kollapses til én", () => {
    expect(classifySelfModification(["config//charlie-personality.json"])).toBe("zero_review");
  });
});
