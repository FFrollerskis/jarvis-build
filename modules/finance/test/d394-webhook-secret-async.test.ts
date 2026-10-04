import { describe, expect, it } from "vitest";
import type pg from "pg";
import { FinanceService } from "../src/service.ts";
import { InvalidWebhookSignatureError, StripeCredentialsUnavailableError } from "../src/types.ts";

/** D-394 (JARVIS-056): webhook-hemmeligheten kan hentes asynkront fra den delte SecretProvider-kjeden (Infisical-primær). */
function service(provider: () => Promise<string | null>): FinanceService {
  return new FinanceService({} as pg.Pool, undefined, undefined, undefined, provider, () => "tenant-x");
}

describe("JARVIS-056: asynkron webhook-hemmelighet", () => {
  it("manglende hemmelighet (async null) → fail-closed StripeCredentialsUnavailableError", async () => {
    await expect(service(async () => null).ingestStripeWebhookEvent(Buffer.from("{}"), "t=1,v1=00", 1)).rejects.toThrow(StripeCredentialsUnavailableError);
  });

  it("hemmelighet hentet asynkront brukes til signaturkontroll (feil signatur → InvalidWebhookSignatureError)", async () => {
    let asked = 0;
    const svc = service(async () => { asked += 1; return "whsec-test-fixture-not-real"; });
    await expect(svc.ingestStripeWebhookEvent(Buffer.from("{}"), `t=${Math.floor(Date.now() / 1000)},v1=deadbeef`)).rejects.toThrow(InvalidWebhookSignatureError);
    expect(asked).toBe(1);
  });
});
