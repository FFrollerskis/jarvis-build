import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import type { BriefItem, BriefSource } from "@jarvis/tool-gateway";
import type { GrowthService } from "./service.ts";
import type { CampaignObservation } from "./types.ts";

/**
 * D-90 (UA-4 NESTE SLICE): Business OS × Marketing Memory-integrasjon.
 *
 * Denne filen ligger BEVISST i `@jarvis/growth`, ALDRI i `@jarvis/business`
 * - `@jarvis/growth` avhenger allerede av `@jarvis/business` (D-74/D-78),
 * så en ny `@jarvis/business` -> `@jarvis/growth`-avhengighet ville skapt
 * en sirkulær pakkeavhengighet. `BusinessTransport` (i `@jarvis/business`)
 * tar i stedet imot en valgfri `extraBriefSources: BriefSource[]`-liste i
 * konstruktøren (ren dependency injection av EKSISTERENDE `@jarvis/tool-
 * gateway`-kontrakter den allerede kjenner) - selve funksjonen under bygges
 * her, i app-laget (`apps/api/src/main.ts`) kobles den inn med
 * `marketingMemoryBriefSource(growthService)` som ett element i den
 * injiserte listen. `BusinessTransport` importerer ALDRI `@jarvis/growth`.
 *
 * Gjenbruker EKSAKT samme mønster som `businessOpenLoopsSource()`
 * (`@jarvis/business/business-brief.ts`, D-53): ingen ny brief-motor,
 * ingen duplisert observasjonsmotor - denne funksjonen kaller UTELUKKENDE
 * EKSISTERENDE `GrowthService.listMarketingObservations()`/`getCampaign()`
 * (D-89/D-74), aldri ny SQL, aldri ny persistens.
 *
 * EPISTEMISK GRENSE (D-89 uendret av denne sliceen): observasjonene som
 * vises her er FORTSATT `CURRENT_STATE_MEMORY` - kun status `'open'` hentes
 * (samme prinsipp som `businessOpenLoopsSource` som kun viser åpne loops),
 * og teksten her er BEVISST ikke-kausal og tidsvindu-fri (LIFETIME_ONLY,
 * se `CampaignPerformance`/D-88). Business OS forfremmer ALDRI disse til
 * "verifisert kunnskap" - `why`-feltet nevner eksplisitt at det er en
 * deterministisk avledet observasjon, ikke en konklusjon.
 */

function meetingsWithoutConversionBriefItem(obs: CampaignObservation, campaignLabel: string): BriefItem {
  const evidence = obs.evidence as { attributed_meetings?: number; won_opportunities?: number };
  const meetings = evidence.attributed_meetings ?? 0;
  return {
    source: "marketing-memory",
    ref: obs.observation_id,
    title: `${campaignLabel}: ${meetings} attribuert${meetings === 1 ? "" : "e"} møte${meetings === 1 ? "" : "r"}, ingen vunnet opportunity ennå`,
    detail: obs.summary,
    at: obs.observed_at,
    // Samme "lav/informasjonell, ikke overdue/kritisk"-score som businessOpenLoopsSource sin
    // default (55) - dette er et ærlig funnel-gap, ikke et akutt varsel; INGEN vilkårlig terskel
    // brukes til å heve prioriteten (§22 i byggeordren - ingen automatisk OpenLoop/eskalering).
    score: 55,
    why: "deterministisk markedsførings-observasjon (D-89) - nåværende funnel-gap under livstids-attribusjon, ikke en forklaring på hvorfor eller en påstand om kampanjekvalitet"
  };
}

function recommendationDispositionBriefItem(obs: CampaignObservation, campaignLabel: string): BriefItem {
  return {
    source: "marketing-memory",
    ref: obs.observation_id,
    title: `${campaignLabel}: anbefalings-/kommandostatus`,
    detail: obs.summary,
    at: obs.observed_at,
    // Ren FYI-opptelling (D-85/D-87-status), aldri en anbefaling om å handle - lav score som
    // emailSource sin "ny e-post" (30), havner i FYI-seksjonen (DailyBrief.generate: score<40).
    score: 30,
    why: "deterministisk opptelling av anbefalings-/kommandostatus (D-85/D-87) - INGEN provider-utførelse, D-87-kommandoer er fortsatt kun intern planleggingsrepresentasjon"
  };
}

/**
 * Ny `BriefSource` for Business OS-dagsbrief: overflater D-89 sine
 * `'open'`-markedsføringsobservasjoner som konsise, evidens-forankrede
 * punkter.
 *
 * KUN `status: 'open'` hentes - løste observasjoner forsvinner fra briefen
 * (samme "kun åpne loops"-prinsipp som `businessOpenLoopsSource`), ALDRI en
 * påstand om at tidligere episoder er bevart (D-89 er CURRENT_STATE_MEMORY,
 * se `CampaignObservation`-JSDoc i `types.ts`).
 *
 * `recommendation_disposition_summary` ekskluderes BEVISST når den er tom
 * (0 anbefalinger OG 0 kommandoer) - denne observasjonstypen er ALDRI
 * `'resolved'` (den er en løpende rapport, se `types.ts`), så uten dette
 * filteret ville EN tom rad vist seg permanent i briefen for enhver
 * kampanje uten anbefalingsaktivitet - ren støy, ingen ny persistens eller
 * statusverdi introdusert for å oppnå dette (kun et in-memory evidence-filter).
 */
export function marketingMemoryBriefSource(growth: GrowthService, memorySpace: MemorySpace = "business"): BriefSource {
  return {
    name: "marketing-memory",
    async collect(identity: IdentityContext): Promise<BriefItem[]> {
      const observations = await growth.listMarketingObservations(identity.tenant_id, memorySpace, { status: "open" });
      const items: BriefItem[] = [];
      const campaignLabelCache = new Map<string, string>();
      const campaignLabel = async (campaignId: string): Promise<string> => {
        const cached = campaignLabelCache.get(campaignId);
        if (cached) return cached;
        const campaign = await growth.getCampaign(identity.tenant_id, memorySpace, campaignId);
        const label = campaign?.name ?? campaignId;
        campaignLabelCache.set(campaignId, label);
        return label;
      };
      for (const obs of observations) {
        const label = await campaignLabel(obs.campaign_id);
        if (obs.observation_type === "meetings_without_conversion") {
          items.push(meetingsWithoutConversionBriefItem(obs, label));
        } else if (obs.observation_type === "recommendation_disposition_summary") {
          const evidence = obs.evidence as {
            recommendations?: { recommendation_ids?: string[] };
            commands?: { command_ids?: string[] };
          };
          const hasActivity =
            (evidence.recommendations?.recommendation_ids?.length ?? 0) > 0 ||
            (evidence.commands?.command_ids?.length ?? 0) > 0;
          if (hasActivity) items.push(recommendationDispositionBriefItem(obs, label));
        }
      }
      return items;
    }
  };
}
