import { describe, expect, it } from "vitest";
import {
  STEPUP_BINDING_NOT_ENFORCED,
  STEPUP_CHANNEL_BINDING_ENV,
  applyStepUpBindingGate,
  describeStepUpBinding,
  deviceKindFromLegacyLabel,
  displayKindLabel
} from "../src/index.ts";

/**
 * WP-S1 K5 (mutantfunn): visningsetiketten i revisjon/status og status-objektet fra porten. Begge er flater der en ubetrodd klientverdi (etiketten i en innrullingsforespørsel) eller eierens miljøverdi vises: de skal være
 * avgrenset (aldri en vilkårlig stor eller kontrolltegn-fylt verdi i revisjonen) og ikke skjule en ugyldig modusverdi.
 */
describe("WP-S1: displayKindLabel - revisjonen får aldri en vilkårlig stor eller kontrolltegn-fylt klientverdi", () => {
  it("synlig ASCII beholdes uendret", () => {
    expect(displayKindLabel("iphone")).toBe("iphone");
    expect(displayKindLabel("Web_Browser-1.0")).toBe("Web_Browser-1.0");
  });

  it("avkortes til nøyaktig 40 tegn (ikke 39, ikke 41, ikke ubegrenset)", () => {
    expect(displayKindLabel("a".repeat(40))).toBe("a".repeat(40));
    expect(displayKindLabel("a".repeat(41))).toBe("a".repeat(40));
    expect(displayKindLabel("a".repeat(5000))).toHaveLength(40);
    expect(displayKindLabel("b".repeat(39))).toBe("b".repeat(39));
  });

  it("alt som ikke er synlig ASCII (mellomrom, kontrolltegn, Unicode, nullbyte, linjeskift) blir ?", () => {
    expect(displayKindLabel("a b")).toBe("a?b");
    expect(displayKindLabel("a\nb\r\tc")).toBe("a?b??c");
    expect(displayKindLabel("a\u0000b")).toBe("a?b");
    expect(displayKindLabel("w\u00e9b")).toBe("w?b");
    expect(displayKindLabel("\u202e\u200b")).toBe("??");
    expect(displayKindLabel("\u{1F600}")).toBe("??"); // to UTF-16-enheter
    expect(displayKindLabel("")).toBe("");
  });

  it("en verdi som ikke er en streng vises som `invalid` (aldri en krasj, aldri objektets innhold)", () => {
    for (const bad of [undefined, null, 0, 1, true, {}, [], ["iphone"], { toString: () => "iphone" }, Symbol.iterator]) {
      expect(displayKindLabel(bad as unknown)).toBe("invalid");
    }
  });
});

describe("WP-S1: den eldre etikett-avbildningen er eksakt og tåler ikke-ASCII (ingen oppslag på lookalike-tegn)", () => {
  it("lookalike-/kontrolltegn og Unicode-store/små bokstaver gir legacy_unknown (aldri en lukket type ved en tilfeldighet)", () => {
    for (const label of ["w\u0435b", "iph\u043ene", "\u212aiphone", "web\u200b", "\u200bweb", "web\u00a0", "we\u0000b", "\u0130phone", "ph\u0131ne", "iphone\u0301", "wa\u0442ch"]) {
      expect(deviceKindFromLegacyLabel(label), JSON.stringify(label)).toEqual({ device_kind: "legacy_unknown", mapped: false });
    }
  });

  it("prototype-nøkler og ikke-strenger gir legacy_unknown", () => {
    for (const label of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", undefined, null, 1, {}, ["web"]]) {
      expect(deviceKindFromLegacyLabel(label as unknown), String(label)).toEqual({ device_kind: "legacy_unknown", mapped: false });
    }
  });
});

describe("WP-S1 K4: describeStepUpBinding - status viser modus, ugyldig verdi og blokkerte flagg, og aldri en verdi", () => {
  it("en ugyldig modusverdi vises (avkortet, kun synlig ASCII) slik at eieren ser skrivefeilen", () => {
    const gate = applyStepUpBindingGate({ [STEPUP_CHANNEL_BINDING_ENV]: "enforced", JARVIS_SITUATION_SIGNALS: "on" });
    const status = describeStepUpBinding(gate);
    expect(status).toEqual({
      mode: "observe", enforced: false, invalid_value: "enforced",
      blocked: [{ flag: "JARVIS_SITUATION_SIGNALS", group: "situation_signals", reason: STEPUP_BINDING_NOT_ENFORCED }]
    });
  });

  it("en gyldig modus har invalid_value null; enforce har ingen blokkerte flagg selv om flaggene er på", () => {
    expect(describeStepUpBinding(applyStepUpBindingGate({}))).toEqual({ mode: "observe", enforced: false, invalid_value: null, blocked: [] });
    const enforced = describeStepUpBinding(applyStepUpBindingGate({ [STEPUP_CHANNEL_BINDING_ENV]: "enforce", JARVIS_PERSONAL_CAR: "on", JARVIS_COMMS_OUTBOUND: "on" }));
    expect(enforced).toEqual({ mode: "enforce", enforced: true, invalid_value: null, blocked: [] });
  });

  it("status inneholder kun flaggNAVN (ingen flaggverdier, ingen hemmeligheter fra miljøet) og er en kopi", () => {
    const secretish = "value-that-must-not-appear-in-status-0123456789";
    const gate = applyStepUpBindingGate({ JARVIS_GROWTH_WRITE_PLATFORMS: `google_ads,${secretish}`, JARVIS_PERSONAL_HOME_CRITICAL: "on", UNRELATED_SECRET: secretish });
    const status = describeStepUpBinding(gate);
    expect(JSON.stringify(status)).not.toContain(secretish);
    expect(status.blocked.map((b) => b.flag).sort()).toEqual(["JARVIS_GROWTH_WRITE_PLATFORMS", "JARVIS_PERSONAL_HOME_CRITICAL"]);
    expect(status.blocked.every((b) => b.reason === STEPUP_BINDING_NOT_ENFORCED)).toBe(true);
    // en endring av resultatet endrer ikke porten (kopi, ikke delt referanse)
    (status.blocked as unknown as Array<{ flag: string }>).length = 0;
    expect(describeStepUpBinding(gate).blocked).toHaveLength(2);
  });

  it("en lang/kontrolltegn-fylt ugyldig modusverdi vises avkortet og uten kontrolltegn", () => {
    const status = describeStepUpBinding(applyStepUpBindingGate({ [STEPUP_CHANNEL_BINDING_ENV]: `enf\norce${"x".repeat(100)}` }));
    expect(status.mode).toBe("observe");
    expect(status.invalid_value).toBe(`enf?orce${"x".repeat(32)}`);
    expect(status.invalid_value).toHaveLength(40);
  });
});
