import type { IdentityContext } from "@jarvis/contracts";
import { CONNECTOR_REGISTRY } from "./connector-registry.ts";
import type { ToolGateway } from "./gateway.ts";

/**
 * D-242 (2026-09-22, Tobias direkte chat-instruks: "du skal bygge det for
 * absolutt alle som tester en gang om dagen så vi vet om credentials
 * fungerer eller ikke hele tiden"). Kjører `owner_controls.test_connector`
 * sitt EKSAKTE nøstede `gateway.execute()`-mønster (D-213) for HVER
 * connector i `CONNECTOR_REGISTRY` som BÅDE har en `live_test` OG er fullt
 * konfigurert (`hasSecret()` for hver `credential_ref`) - IKKE en ny
 * helsesjekk-mekanisme, gjenbruker BEVISST SAMME `ToolGateway.health`-kart
 * (BO-03) `listConnectorStatus()` allerede leser, slik at en connector ingen
 * annen reell trafikk nylig brukte (Vercel/Neonomics/Wallester/Fiken/
 * Stripe/Vipps er alle typisk IKKE i den daglige samtale-/business-flyten)
 * likevel får en FRISK helsestatus i dashbordet minst én gang daglig.
 *
 * Per-connector isolasjon (SAMME "én feilende rad stopper ALDRI resten av
 * sveipen"-disiplin D-227 håndhevet på tvers av finance-/business-/growth-
 * sveipene) - `gateway.execute()` selv kaster ALDRI for en ordinær
 * providerfeil (returnerer alltid `{ok:false, reason}`, se `gateway.ts` sin
 * `execute()`), men `try/catch` her er et SISTE sikkerhetsnett mot en
 * uventet programmeringsfeil i selve kallet (samme presedens som
 * `vision/sweep.ts`).
 *
 * BEVISST INGEN nytt persisteringslag: `ToolGateway.health` er allerede
 * in-memory (BO-03, uendret av denne fila) - en connector som ALDRI har
 * kjørt siden siste prosess-restart viser `health: null` i dashbordet inntil
 * enten et ekte kall ELLER denne sveipen kjører, SAMME kjente, aksepterte
 * begrensning som allerede gjaldt FØR denne fila (D-211/D-213s egen
 * BO-03-presedens) - IKKE en ny regresjon introdusert her.
 */
export interface ConnectorHealthSweepResult {
  checked: string[];
  skipped_not_configured: string[];
  skipped_no_live_test: string[];
  failed: Array<{ connector_id: string; reason: string }>;
}

export async function runConnectorHealthSweep(
  gateway: Pick<ToolGateway, "execute" | "hasSecret">,
  identity: IdentityContext
): Promise<ConnectorHealthSweepResult> {
  const checked: string[] = [];
  const skipped_not_configured: string[] = [];
  const skipped_no_live_test: string[] = [];
  const failed: Array<{ connector_id: string; reason: string }> = [];

  for (const def of CONNECTOR_REGISTRY) {
    if (!def.live_test) {
      skipped_no_live_test.push(def.id);
      continue;
    }
    const configured = (await Promise.all(def.credential_refs.map((ref) => gateway.hasSecret(ref)))).every(Boolean);
    if (!configured) {
      skipped_not_configured.push(def.id);
      continue;
    }
    try {
      const result = await gateway.execute({
        identity,
        tool_id: def.live_test.tool_id,
        action: def.live_test.action,
        parameters: def.live_test.parameters(identity)
      });
      checked.push(def.id);
      if (!result.ok) {
        failed.push({ connector_id: def.id, reason: result.reason });
        console.error(JSON.stringify({ msg: "connector_health_sweep_check_failed", connector_id: def.id, reason: result.reason }));
      }
    } catch (err) {
      const reason = (err as Error).message.slice(0, 200);
      failed.push({ connector_id: def.id, reason });
      console.error(JSON.stringify({ msg: "connector_health_sweep_check_threw", connector_id: def.id, reason }));
    }
  }

  return { checked, skipped_not_configured, skipped_no_live_test, failed };
}
