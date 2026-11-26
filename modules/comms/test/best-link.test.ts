import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import { recipientHint } from "../src/index.ts";
import { TENANT_A } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1c K7 (JARVIS-112 h): beste-lenke-valget i `resolveRecipientIdentity` (`funnel.ts`). Reviewer A (delta2, N-B) fant at mutanten som fjerner preferansen for relasjonsbevis (`pool = matching`) overlevde ALLE byggerens tester; hennes test
 * (`/tmp/lead/G1-review-A-delta2-bestlink.test.ts`) er gjort permanent her, sammen med de tre naboforholdene en slik mutant ellers skjuler: høyeste confidence blant BEVIS-lenkene, høyeste confidence når ingen lenke teller som bevis (revisjonssporet), og at
 * en lenke for et ANNET nummer på samme identitet aldri er bevis for dette nummeret. Alt mot ekte Postgres, ekte Conversation Graph og den ekte eier-kjeden.
 */
let chain: Chain;
beforeAll(async () => {
  chain = await startChain("g1cbl", { JARVIS_COMMS_MAX_PER_ACCOUNT_HOUR: "1000" });
  await authorizeAll(chain, [["sms", "+4791000000", "twilio"]]);
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);

/** UTEN `purpose_basis`: en kald mottaker avslås (`purpose_basis_required`), en varm sendes. Det er hele forskjellen testene måler. */
const p = (recipient: string): Record<string, JsonValue> => ({ channel: "sms", account_ref: "+4791000000", recipient, purpose: "transactional", text: "Hei, timen din er bekreftet." });
const link = (channel: "phone" | "whatsapp" | "sms", identifier: string, confidence: number, match_method: "contact_sync" | "exact_phone_e164" | "owner_configured" | "manual", identity_id?: string) =>
  chain.graph.linkChannelIdentity(TENANT_A, "business", { channel, channel_identifier: identifier, confidence, match_method, ...(identity_id !== undefined ? { identity_id } : {}) });
const sendOk = async (n: string): Promise<boolean> => (await chain.act("send", p(n), chain.key("bl"))).ok;
/** Mottakerbeviset journalen lagret for den SISTE sendingen til nummeret (revisjonssporet): metoden som gjorde mottakeren varm/kald. */
const proofMethod = async (n: string): Promise<string | null> => {
  const r = await chain.db.admin.query(
    "SELECT recipient_proof->>'identity_match_method' AS m FROM comms_outbound_log WHERE tenant_id = $1 AND recipient_hint = $2 ORDER BY created_at DESC, log_id DESC LIMIT 1",
    [TENANT_A, recipientHint("sms", n)]
  );
  return r.rowCount === 0 ? null : ((r.rows[0] as { m: string | null }).m);
};

describe("beste lenke: relasjonsbevis velges framfor en høyere-confidence lenke som ikke teller", () => {
  it("phone-lenke contact_sync 1,0 + whatsapp-lenke exact_phone_e164 0,9 for SAMME nummer => VARM (ingen basis kreves) - reviewer A sin probe", async () => {
    const n = chain.phone();
    const a = await link("phone", n, 1, "contact_sync");
    await link("whatsapp", n, 0.9, "exact_phone_e164", a.identity_id);
    const r = await chain.act("send", p(n), chain.key("bl"));
    expect(r.ok, JSON.stringify(r).slice(0, 240)).toBe(true);
    expect(await proofMethod(n)).toBe("exact_phone_e164");
  });

  it("kontroll: kun contact_sync 1,0 (phone) => KALD (avslått uten grunnlag), og revisjonssporet viser hvorfor", async () => {
    const n = chain.phone();
    await link("phone", n, 1, "contact_sync");
    const r = await chain.act("send", p(n), chain.key("bl2"));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("purpose_basis_required");
    expect(await proofMethod(n)).toBe("contact_sync");
  });

  it("blant BEVIS-lenkene vinner den med høyest confidence (exact_phone_e164 0,9 på whatsapp, owner_configured 1,0 på phone) - og den ligger i revisjonssporet", async () => {
    const n = chain.phone();
    const a = await link("whatsapp", n, 0.9, "exact_phone_e164");
    await link("phone", n, 1, "owner_configured", a.identity_id);
    expect(await sendOk(n)).toBe(true);
    expect(await proofMethod(n)).toBe("owner_configured");
  });

  it("uten noen lenke som teller som bevis velges den med høyest confidence til revisjonssporet (contact_sync 0,9 slår manual 0,5), og mottakeren er fortsatt KALD", async () => {
    const n = chain.phone();
    const a = await link("phone", n, 0.5, "manual");
    await link("whatsapp", n, 0.9, "contact_sync", a.identity_id);
    expect((await chain.act("send", p(n), chain.key("bl3"))).ok).toBe(false);
    expect(await proofMethod(n)).toBe("contact_sync");
  });

  it("en lenke for et ANNET nummer på samme identitet er aldri bevis for DETTE nummeret: identiteten har et eksakt, bekreftet nummer (n1), men sendingen går til et nummer lenket bare via contact_sync (n2) => KALD", async () => {
    const n1 = chain.phone();
    const n2 = chain.phone();
    const a = await link("phone", n1, 1, "owner_configured");
    await link("phone", n2, 0.9, "contact_sync", a.identity_id);
    expect(await sendOk(n1)).toBe(true); // n1 er varm
    const r = await chain.act("send", p(n2), chain.key("bl4"));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("purpose_basis_required");
    expect(await proofMethod(n2)).toBe("contact_sync");
  });
});
