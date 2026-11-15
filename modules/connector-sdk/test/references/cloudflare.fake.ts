import { createFakeConnector, type ContractAdapter, type FakeConnectorSpec } from "../../src/index.ts";
import { CLOUDFLARE_MANIFEST } from "../../src/manifests/cloudflare.ts";

/**
 * WP-I (D-472): FAKE-adapter for Cloudflare-referansemanifestet (ingen nettverk, ingen ekte Cloudflare). `check_token` returnerer status uten selve tokenet (runbook §1: «selve tokenet returneres aldri»);
 * `purge_cache` har ingen lesbar før-/etter-tilstand og kan ikke angres (klasse C, «ingen reversering»). Resten bruker harnessens generiske ressursmodell (DNS-poster/regler/innstillinger som ressurser).
 */
export function createCloudflareFake(opts: Partial<Omit<FakeConnectorSpec, "manifest">> = {}): ContractAdapter {
  return createFakeConnector({
    manifest: CLOUDFLARE_MANIFEST,
    handlers: {
      "cloudflare.check_token": { read: () => ({ status: "active", kind: "account" }) },
      "cloudflare.purge_cache": {
        run: (_params, _state, n) => ({ data: { purged: true, n }, external_id: `purge-${n}` }),
        readback: () => null
      }
    },
    ...opts
  });
}
