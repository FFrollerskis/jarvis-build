import { createFakeConnector, type ContractAdapter, type FakeConnectorSpec } from "../../src/index.ts";
import { STRIPE_MANIFEST } from "../../src/manifests/stripe.ts";

/**
 * WP-I (D-472): FAKE-adapter for Stripe-referansemanifestet (ingen nettverk, ingen ekte Stripe, ingen ekte nøkler). Saldoen er et heltall i minste enhet (strengt, aldri desimal); `submit_refund` flytter
 * «penger» i fake-tilstanden og er irreversibel (en feilaktig refusjon korrigeres av en NY finansoperasjon). Tenant kommer fra identiteten, aldri fra kroppen.
 */
export function createStripeFake(opts: Partial<Omit<FakeConnectorSpec, "manifest">> = {}): ContractAdapter {
  return createFakeConnector({
    manifest: STRIPE_MANIFEST,
    handlers: {
      "finance_stripe.get_balance": { read: () => ({ available: [{ amount: 125000, currency: "nok" }], pending: [{ amount: 0, currency: "nok" }] }) },
      "finance_stripe.submit_refund": {
        run: (params, state, n) => {
          state.resources[`refund:${String(params["refund_id"])}`] = { status: "succeeded", n };
          return { data: { status: "succeeded" }, external_id: `refund-${n}` };
        },
        readback: (params, state) => state.resources[`refund:${String(params["refund_id"])}`] ?? { status: "pending" }
      }
    },
    ...opts
  });
}
