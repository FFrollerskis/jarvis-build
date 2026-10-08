import type pg from "pg";
import { listAllTenantIds, listTenantMemorySpaces } from "@jarvis/core";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { withMemoryTransaction } from "./spaces.ts";
import type { MemoryWriter } from "./memory-writer.ts";
import type { SummaryService } from "./summaries.ts";

/** Automatisk, tenant-uavhengig jobb - ALDRI en eierhandling. En dedikert,
 * lett-gjenkjennelig `person_id` unngår at revisjonssporet feilaktig
 * tilskriver en konsolidering til en faktisk person. */
const SYSTEM_PERSON_ID = "system-memory-retention";

function systemIdentity(tenantId: string, space: MemorySpace): IdentityContext {
  return {
    person_id: SYSTEM_PERSON_ID,
    tenant_id: tenantId,
    memory_space_id: space,
    session_id: "sess-memory-retention-sweep",
    device_id: "jarvis-core",
    channel: "api",
    auth_strength: "active"
  };
}

export interface MemoryRetentionSweepFailure {
  tenant_id: string;
  /** `"*"` når selve space-oppslaget for tenanten feilet (ikke ett enkelt space). */
  memory_space_id: string;
  error: string;
}

export interface MemoryRetentionSweepSummary {
  /** Antall (tenant, memory_space)-kombinasjoner der sveipet FULLFØRTE uten feil. */
  succeeded: number;
  /** Antall episodiske minner konsolidert per `"<tenant_id>:<space>"`. */
  consolidatedByTenant: Record<string, number>;
  failed: MemoryRetentionSweepFailure[];
}

interface EpisodicCandidate {
  memory_item_id: string;
  day: string;
}

async function findEpisodicCandidates(
  pool: pg.Pool,
  tenantId: string,
  space: MemorySpace,
  retentionDays: number
): Promise<EpisodicCandidate[]> {
  return withMemoryTransaction(pool, tenantId, [space], async (client) => {
    const result = await client.query<{ memory_item_id: string; day: string }>(
      `SELECT mi.memory_item_id, mi.observed_at::date::text AS day
       FROM memory_items mi
       JOIN memory_sources ms ON ms.source_id = mi.source_id
       WHERE mi.tenant_id = $1 AND mi.space = $2 AND mi.status = 'active'
         AND mi.type = 'episodic' AND ms.kind = 'conversation'
         -- D-386: special (helse/finans) konsolideres ALDRI inn i et sammendrag (som ikke bærer sensitivitet) - de forblir egne items.
         AND mi.sensitivity <> 'special'
         AND mi.observed_at < now() - ($3 || ' days')::interval
       ORDER BY day`,
      [tenantId, space, retentionDays]
    );
    return result.rows;
  });
}

/**
 * D-286 (Tobias direkte i chat, "alle" - alle tre foreslåtte tilnærminger
 * til ubegrenset minnevekst): periodisk KONSOLIDERING av gamle EPISODISKE
 * samtale-minner - SAMME reboot-durable `DailyScheduler`-mekanisme/mønster
 * som `runLocationRetentionSweepForAllTenants`/`runHealthRetentionSweepForAllTenants`/
 * `runVisionRetentionSweepForAllTenants` (multi-space, som vision - bruker
 * derfor `listTenantMemorySpaces` per tenant, ikke ett hardkodet space).
 *
 * BEVISST SNEVER SCOPE (KUN `type = 'episodic'`, KUN `source.kind =
 * 'conversation'`): `preference`/`decision`/`relation`/`semantic`/
 * `commitment`/`procedure`/`operational`/`project`-typer røres ALDRI av
 * dette sveipet - de representerer VARIGE fakta (identitet, relasjoner,
 * preferanser, beslutninger - PRESIST den typen minne D-283→D-285 beviste
 * faktisk fungerer, f.eks. "pappa heter Henrik") og skal IKKE
 * konsolideres/fjernes bare fordi de er gamle. KUN `episodic` (tidsbundne
 * hendelser, f.eks. "jeg dro til Oslo i går") er naturlig forgjengelig -
 * verdien i én spesifikk gammel hendelse avtar naturlig over tid, mens et
 * dagssammendrag (`SummaryService`, allerede bygget, men ALDRI koblet inn
 * FØR denne posten - se D-286 sitt funn) bevarer det vesentligste.
 *
 * Gjenbruker EKSISTERENDE, allerede testede skriveveier fremfor å finne opp
 * SQL på nytt: `SummaryService.generateDaily()` (kalt FØR originalene
 * fjernes fra 'active'-status - funksjonen leser kun 'active'-rader, så
 * rekkefølgen her er avgjørende for at sammendraget faktisk fanger opp
 * innholdet) og `MemoryWriter.invalidate()` (SAMME bitemporale, MYKE
 * slettevei enhetstestene allerede dekker - raden forblir i
 * `memory_versions`, ALDRI en hard DELETE - se D-286 sin dokumentasjon av
 * `forbid_mutation`-triggeren som uansett ville blokkert en hard DELETE).
 * Bruker en SYNTETISK system-identitet (ALDRI eierens egen) for
 * revisjonssporet - dette er en automatisk, tenant-uavhengig jobb, ikke en
 * eierhandling.
 *
 * Standard 60 dager (`JARVIS_MEMORY_RETENTION_DAYS` i main.ts sin
 * wiring) - bevisst romslig: dette er en engangsveis, myk konsolidering av
 * hverdagslig samtale-småprat forbi episodic-terskelen, ikke en aggressiv
 * sletting.
 */
export async function runMemoryRetentionSweepForAllTenants(
  pool: pg.Pool,
  writer: MemoryWriter,
  summaries: SummaryService,
  retentionDays = 60
): Promise<MemoryRetentionSweepSummary> {
  const tenantIds = await listAllTenantIds(pool, 200);
  let succeeded = 0;
  const consolidatedByTenant: Record<string, number> = {};
  const failed: MemoryRetentionSweepFailure[] = [];

  for (const tenantId of tenantIds) {
    let spaces: string[];
    try {
      spaces = await listTenantMemorySpaces(pool, tenantId);
    } catch (err) {
      const failure: MemoryRetentionSweepFailure = {
        tenant_id: tenantId,
        memory_space_id: "*",
        error: (err as Error).message.slice(0, 200)
      };
      failed.push(failure);
      console.error(JSON.stringify({ msg: "memory_retention_sweep_failed", ...failure }));
      continue;
    }

    for (const space of spaces) {
      try {
        const identity = systemIdentity(tenantId, space as MemorySpace);
        const candidates = await findEpisodicCandidates(pool, tenantId, space as MemorySpace, retentionDays);
        // D-442: PER DAG - sammendraget for en dag genereres (LLM-kall) og dagens originaler fjernes umiddelbart etter. Feiler en senere dag eller en invalidering, er de
        // tidligere dagene ferdig konsolidert og er ikke lenger kandidater, så et nytt forsøk (DailyScheduler prøver på nytt ved feil) gjentar ikke LLM-kallene for dem.
        // Rekkefølgen sammendrag-FØR-invalidering er bevart innen hver dag (`generateDaily` leser kun 'active'-rader).
        const byDay = new Map<string, EpisodicCandidate[]>();
        for (const candidate of candidates) {
          const dayItems = byDay.get(candidate.day);
          if (dayItems) dayItems.push(candidate);
          else byDay.set(candidate.day, [candidate]);
        }
        for (const [day, dayItems] of byDay) {
          await summaries.generateDaily(identity, space as MemorySpace, day);
          for (const candidate of dayItems) {
            await writer.invalidate(
              identity,
              space as MemorySpace,
              candidate.memory_item_id,
              "consolidated_into_daily_summary"
            );
          }
        }
        consolidatedByTenant[`${tenantId}:${space}`] = candidates.length;
        succeeded += 1;
      } catch (err) {
        // Én tenant/space sin konsolideringsfeil skal ALDRI velte resten av
        // sveipet (samme per-tenant/per-space-isolasjon som location/health/
        // vision) - men skal heller ALDRI forsvinne stille (D-227-disiplin).
        const failure: MemoryRetentionSweepFailure = {
          tenant_id: tenantId,
          memory_space_id: space,
          error: (err as Error).message.slice(0, 200)
        };
        failed.push(failure);
        console.error(JSON.stringify({ msg: "memory_retention_sweep_failed", ...failure }));
      }
    }
  }

  return { succeeded, consolidatedByTenant, failed };
}
