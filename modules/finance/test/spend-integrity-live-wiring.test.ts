import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * HOST FIX #1 (D-116, run_id f271e1db): `spend-integrity-live.ts` sin
 * "VENDOR BINDING MATCH"-fixture manglet `counter_account_code` -
 * D-116-vendor-gaten PASSERTE korrekt, men den ELDRE, urelaterte
 * Fiken-innsendingskontrollen (service.ts, uendret siden D-107/D-109:
 * "provider === 'fiken'"-grenen krever BÅDE `vendor_provider_ref` OG
 * `counter_account_code` FØR selve Fiken-transporten nås) kastet deretter
 * `MissingCounterAccountError`, så `finance_vendor_binding_match` ble
 * stående `NOT_RUN` (harness-fixturfeil, ikke en vendor-registry-runtime-feil).
 * Denne suiten beviser strukturelt at fixturen forblir komplett, uten å
 * kjøre selve host-scriptet (det er host-akseptansens jobb).
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const liveScriptSource = readSource("../scripts/spend-integrity-live.ts");

describe("VENDOR BINDING MATCH-fixturen (D-116) er strukturelt komplett for Fiken-innsendingsstien", () => {
  it("createPaymentIntent-kallet i VENDOR BINDING MATCH-seksjonen inkluderer counter_account_code", () => {
    const sectionIdx = liveScriptSource.indexOf('"VENDOR BINDING MATCH');
    const nextSectionIdx = liveScriptSource.indexOf('"VENDOR BINDING MISMATCH BLOCKED');
    expect(sectionIdx).toBeGreaterThan(-1);
    expect(nextSectionIdx).toBeGreaterThan(sectionIdx);
    const section = liveScriptSource.slice(sectionIdx, nextSectionIdx);
    expect(section).toMatch(/vendor_provider_ref:\s*`fiken-ref-\$\{runId\}`/);
    expect(section).toContain('counter_account_code: "1920"');
  });
});
