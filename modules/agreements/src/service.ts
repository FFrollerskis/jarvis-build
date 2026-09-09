import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { recordActivityInTransaction } from "@jarvis/business";
import { assertValidContractTransition, assertValidObligationTransition } from "./state-machine.ts";
import type {
  AddObligationInput,
  AddVersionInput,
  Contract,
  ContractEvent,
  ContractEventType,
  ContractObligation,
  ContractStatus,
  ContractVersion,
  CreateContractInput,
  ObligationStatus
} from "./types.ts";

/**
 * Arkitekt-review MERGE BLOCKER (Q-33/D-130, PR #79): mirrors
 * `OperationsCrossScopeReferenceError` i `modules/operations/src/service.ts`
 * (D-129) - SAMME feilklasse/mønster, egen navngiving per domene. Postgres
 * sin FK-sjekk kjører med forhøyet privilegium og omgår RLS, saa en enkel FK
 * paa `company_id`/`contact_id` er ALDRI en tenant/space-autorisasjonsgrense
 * - se `assertCompanyContactInScope()` under.
 */
export class AgreementsCrossScopeReferenceError extends Error {
  constructor(
    public readonly field: string,
    public readonly id: string
  ) {
    super(`agreements_cross_scope_reference:${field}:${id}`);
    this.name = "AgreementsCrossScopeReferenceError";
  }
}

/** Kastes naar BÅDE company_id OG contact_id er oppgitt, men kontakten faktisk tilhoerer en ANNEN company. */
export class AgreementsContactCompanyMismatchError extends Error {
  constructor(
    public readonly contactId: string,
    public readonly companyId: string
  ) {
    super(`agreements_contact_company_mismatch:${contactId}:${companyId}`);
    this.name = "AgreementsContactCompanyMismatchError";
  }
}

export interface SearchContractsFilter {
  status?: ContractStatus;
  company_id?: string;
  contact_id?: string;
  owner_person_id?: string;
  /** Fritekst-substring mot `title` - deterministisk `ILIKE`, ingen semantisk søk (samme prinsipp som support_tickets.subject_contains). */
  title_contains?: string;
  contract_number?: number;
  limit?: number;
}

/**
 * UA-3 Native Jarvis Contracts Core (D-71): kjerne-domenetjeneste for
 * kontrakt-lifecycle/versjoner/forpliktelser. Gjenbruker `withMemoryTransaction`
 * (SAMME RLS-primitiv som resten av Business OS/Support) - ingen ny
 * sikkerhetsmodell. Motpart er de EKSISTERENDE
 * `business_companies`/`business_contacts`-entitetene - ingen ny
 * motpart-tabell/-tjeneste.
 */
export class AgreementsService {
  /**
   * UA-3 AC1 (D-73/Q-25 fiks, oppdatert D-130): tidslinje-speilingen kaller
   * `recordActivityInTransaction()` DIREKTE med den allerede-åpne `client`en
   * fra egen `withMemoryTransaction` (se `recordContractTimelineActivity()`
   * under) - `@jarvis/business` sin egen `BusinessService`-klasse (med sin
   * EGEN, frakoblede transaksjon) trengs derfor ikke lenger konstrueres her.
   * `@jarvis/business` forblir en deklarert `package.json`-avhengighet av
   * `@jarvis/agreements` (ingen sirkulær avhengighet - `@jarvis/business`
   * avhenger ALDRI av `@jarvis/agreements`) - kun for
   * `recordActivityInTransaction()`.
   */
  constructor(private readonly pool: pg.Pool) {}

  async createContract(tenantId: string, memorySpace: MemorySpace, input: CreateContractInput): Promise<Contract> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      // Q-33/D-130: verifiser FØR INSERT - et caller-oppgitt company_id/
      // contact_id fra en ANNEN tenant/space skal aldri kunne knyttes seg
      // til en kontrakt (Postgres sin FK-sjekk alene omgår RLS).
      await this.assertCompanyContactInScope(client, tenantId, memorySpace, input.company_id, input.contact_id);
      const contract = await insertContract(client, tenantId, memorySpace, input);
      await insertEvent(client, tenantId, memorySpace, {
        contract_id: contract.contract_id,
        event_type: "contract_created",
        summary: `Kontrakt opprettet: ${input.title}`,
        actor_person_id: input.actor_person_id ?? null,
        metadata: {}
      });
      // Arkitekt-review MERGE BLOCKER (D-130, PR #79): tidslinje-speilingen
      // skjer NAA INNE i SAMME transaksjon som selve kontrakt-raden - se
      // recordContractTimelineActivity() sin kommentar under.
      await this.recordContractTimelineActivity(
        client, tenantId, memorySpace, contract, "external_event", `Kontrakt opprettet: ${input.title}`, "created"
      );
      return contract;
    });
  }

  async getContract(tenantId: string, memorySpace: MemorySpace, contractId: string): Promise<Contract | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => this.readForUpdate(client, tenantId, contractId, false));
  }

  async listContracts(tenantId: string, memorySpace: MemorySpace, status: ContractStatus | "all" = "active"): Promise<Contract[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } =
        status === "all"
          ? await client.query(`SELECT * FROM contracts WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId])
          : await client.query(`SELECT * FROM contracts WHERE tenant_id = $1 AND status = $2 ORDER BY created_at DESC`, [tenantId, status]);
      return rows as Contract[];
    });
  }

  /** Deterministisk filter/søk - ingen LLM nødvendig for et strukturert oppslag (samme prinsipp som support_tickets.searchTickets). */
  async searchContracts(tenantId: string, memorySpace: MemorySpace, filter: SearchContractsFilter): Promise<Contract[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const clauses = ["tenant_id = $1"];
      const params: unknown[] = [tenantId];
      const push = (clause: string, value: unknown) => {
        params.push(value);
        clauses.push(clause.replace("$N", `$${params.length}`));
      };
      if (filter.status !== undefined) push("status = $N", filter.status);
      if (filter.company_id !== undefined) push("company_id = $N", filter.company_id);
      if (filter.contact_id !== undefined) push("contact_id = $N", filter.contact_id);
      if (filter.owner_person_id !== undefined) push("owner_person_id = $N", filter.owner_person_id);
      if (filter.contract_number !== undefined) push("contract_number = $N", filter.contract_number);
      if (filter.title_contains !== undefined) push("title ILIKE $N", `%${filter.title_contains}%`);
      const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
      const { rows } = await client.query(
        `SELECT * FROM contracts WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`,
        params
      );
      return rows as Contract[];
    });
  }

  /** "What does company X have active with us?" - deterministisk motparts-oppslag. */
  async listByCompany(tenantId: string, memorySpace: MemorySpace, companyId: string, status: ContractStatus | "all" = "all"): Promise<Contract[]> {
    return this.searchContracts(tenantId, memorySpace, { company_id: companyId, ...(status !== "all" ? { status } : {}), limit: 200 });
  }

  /** "Which contracts renew soon?" */
  async upcomingRenewals(tenantId: string, memorySpace: MemorySpace, withinDays = 30): Promise<Contract[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM contracts WHERE tenant_id = $1 AND status IN ('active','expiring')
           AND renewal_date IS NOT NULL AND renewal_date < now() + ($2 || ' days')::interval
         ORDER BY renewal_date ASC`,
        [tenantId, withinDays]
      );
      return rows as Contract[];
    });
  }

  /** "Which contracts can we cancel now?" - fortsatt innenfor oppsigelsesvinduet (frist ikke passert). */
  async cancellableNow(tenantId: string, memorySpace: MemorySpace): Promise<Contract[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM contracts WHERE tenant_id = $1 AND status = 'active'
           AND (termination_deadline IS NULL OR termination_deadline >= now())
         ORDER BY termination_deadline ASC NULLS LAST`,
        [tenantId]
      );
      return rows as Contract[];
    });
  }

  /** "Which agreements are expiring?" */
  async upcomingTerminationDeadlines(tenantId: string, memorySpace: MemorySpace, withinDays = 30): Promise<Contract[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM contracts WHERE tenant_id = $1 AND status IN ('active','expiring')
           AND termination_deadline IS NOT NULL AND termination_deadline < now() + ($2 || ' days')::interval
         ORDER BY termination_deadline ASC`,
        [tenantId, withinDays]
      );
      return rows as Contract[];
    });
  }

  /** Deterministisk statsovergang håndheves i state-machine.ts - ugyldig overgang kaster, endrer INGENTING. */
  async setStatus(tenantId: string, memorySpace: MemorySpace, contractId: string, status: ContractStatus, actorPersonId?: string): Promise<Contract | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, contractId, true);
      if (!current) return null;
      assertValidContractTransition(current.status, status);
      const { rows } = await client.query(
        `UPDATE contracts SET status = $1, updated_at = now() WHERE tenant_id = $2 AND contract_id = $3 RETURNING *`,
        [status, tenantId, contractId]
      );
      const updated = rows[0] as Contract;
      await insertEvent(client, tenantId, memorySpace, {
        contract_id: contractId, event_type: "status_changed", summary: `Status endret: ${current.status} -> ${status}`,
        actor_person_id: actorPersonId ?? null, metadata: { from: current.status, to: status }
      });
      // D-130: samme SAMME-transaksjon, rent additive tidslinje-speiling som
      // createContract() - se recordContractTimelineActivity() sin kommentar.
      await this.recordContractTimelineActivity(
        client, tenantId, memorySpace, updated, "status_change",
        `Status endret: ${current.status} -> ${status}`, `status:${status}`
      );
      return updated;
    });
  }

  async setOwner(tenantId: string, memorySpace: MemorySpace, contractId: string, ownerPersonId: string | null, actorPersonId?: string): Promise<Contract | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, contractId, true);
      if (!current) return null;
      const { rows } = await client.query(
        `UPDATE contracts SET owner_person_id = $1, updated_at = now() WHERE tenant_id = $2 AND contract_id = $3 RETURNING *`,
        [ownerPersonId, tenantId, contractId]
      );
      await insertEvent(client, tenantId, memorySpace, {
        contract_id: contractId, event_type: "owner_changed", summary: ownerPersonId ? `Eier satt til ${ownerPersonId}` : "Eier fjernet",
        actor_person_id: actorPersonId ?? null, metadata: { from: current.owner_person_id, to: ownerPersonId }
      });
      return rows[0] as Contract;
    });
  }

  /** Motparts-kobling gjenbruker EKSISTERENDE Business OS-entiteter - ingen ny motpart-tabell. */
  async linkCounterparty(
    tenantId: string,
    memorySpace: MemorySpace,
    contractId: string,
    companyId: string | null,
    contactId: string | null,
    actorPersonId?: string
  ): Promise<Contract | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, contractId, true);
      if (!current) return null;
      // Q-33/D-130: `null` betyr eksplisitt "fjern koblingen" - hoppes over
      // (ingenting å verifisere); en oppgitt streng-verdi maa derimot
      // finnes i EGEN tenant+memory_space FØR den lagres på kontrakten.
      await this.assertCompanyContactInScope(client, tenantId, memorySpace, companyId ?? undefined, contactId ?? undefined);
      const { rows } = await client.query(
        `UPDATE contracts SET company_id = $1, contact_id = $2, updated_at = now() WHERE tenant_id = $3 AND contract_id = $4 RETURNING *`,
        [companyId, contactId, tenantId, contractId]
      );
      await insertEvent(client, tenantId, memorySpace, {
        contract_id: contractId, event_type: "counterparty_linked", summary: "Motpart oppdatert",
        actor_person_id: actorPersonId ?? null, metadata: { company_id: companyId, contact_id: contactId }
      });
      return rows[0] as Contract;
    });
  }

  async setRenewalDate(tenantId: string, memorySpace: MemorySpace, contractId: string, renewalDate: string | null, actorPersonId?: string): Promise<Contract | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE contracts SET renewal_date = $1, updated_at = now() WHERE tenant_id = $2 AND contract_id = $3 RETURNING *`,
        [renewalDate, tenantId, contractId]
      );
      if (rows[0]) {
        await insertEvent(client, tenantId, memorySpace, {
          contract_id: contractId, event_type: "renewal_date_changed", summary: `Fornyelsesdato satt til ${renewalDate ?? "(fjernet)"}`,
          actor_person_id: actorPersonId ?? null, metadata: { to: renewalDate }
        });
      }
      return (rows[0] as Contract) ?? null;
    });
  }

  async setTerminationDeadline(tenantId: string, memorySpace: MemorySpace, contractId: string, deadline: string | null, actorPersonId?: string): Promise<Contract | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE contracts SET termination_deadline = $1, updated_at = now() WHERE tenant_id = $2 AND contract_id = $3 RETURNING *`,
        [deadline, tenantId, contractId]
      );
      if (rows[0]) {
        await insertEvent(client, tenantId, memorySpace, {
          contract_id: contractId, event_type: "termination_deadline_changed", summary: `Oppsigelsesfrist satt til ${deadline ?? "(fjernet)"}`,
          actor_person_id: actorPersonId ?? null, metadata: { to: deadline }
        });
      }
      return (rows[0] as Contract) ?? null;
    });
  }

  /**
   * Kontraktversjoner er EKSPLISITTE og IMMUTABLE (byggeordren) - kun nye
   * append-only rader, ALDRI en UPDATE av en eksisterende versjon.
   * `version_number` beregnes ATOMISK under en radlås på foreldre-kontrakten
   * (`FOR UPDATE`) for å unngå et race mellom to samtidige versjonsopprettelser.
   */
  async addVersion(tenantId: string, memorySpace: MemorySpace, contractId: string, input: AddVersionInput): Promise<ContractVersion> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, contractId, true);
      if (!current) throw new Error("contract_not_found");
      const { rows: maxRows } = await client.query(
        `SELECT COALESCE(MAX(version_number), 0) AS max_version FROM contract_versions WHERE tenant_id = $1 AND contract_id = $2`,
        [tenantId, contractId]
      );
      const nextVersion = Number((maxRows[0] as { max_version: string | number }).max_version) + 1;
      const version_id = `agr-cv-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO contract_versions
           (version_id, tenant_id, memory_space_id, contract_id, version_number, summary, status_at_version,
            source_type, source_instance_id, source_message_id, canonical_uri, created_by_person_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [
          version_id, tenantId, memorySpace, contractId, nextVersion, input.summary, current.status,
          input.source_type ?? null, input.source_instance_id ?? null, input.source_message_id ?? null,
          input.canonical_uri ?? null, input.created_by_person_id ?? null
        ]
      );
      await insertEvent(client, tenantId, memorySpace, {
        contract_id: contractId, event_type: "version_added", summary: `Versjon ${nextVersion} lagt til: ${input.summary}`,
        actor_person_id: input.created_by_person_id ?? null, metadata: { version_number: nextVersion }
      });
      const version = rows[0] as ContractVersion;
      // UA-3 AC1 / D-130: en ny kontraktversjon er et dokument-øyeblikksbilde
      // (§"Peker til Knowledge/kilde - ALDRI kopi av full innhold") -
      // `activity_type: "document"` (EKSISTERENDE CHECK-verdi, ingen
      // skjemaendring nødvendig). Skrives NAA i SAMME transaksjon som selve
      // versjonsraden - se recordContractTimelineActivity() sin kommentar.
      await this.recordContractTimelineActivity(
        client, tenantId, memorySpace, current, "document",
        `Versjon ${version.version_number} lagt til: ${input.summary}`, `version:${version.version_number}`
      );
      return version;
    });
  }

  async listVersions(tenantId: string, memorySpace: MemorySpace, contractId: string): Promise<ContractVersion[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM contract_versions WHERE tenant_id = $1 AND contract_id = $2 ORDER BY version_number DESC`,
        [tenantId, contractId]
      );
      return rows as ContractVersion[];
    });
  }

  /** Gjeldende versjon er alltid den med høyest `version_number` - ingen egen `current_version_id`-kolonne (unngår en sirkulær FK mot contracts). */
  async getCurrentVersion(tenantId: string, memorySpace: MemorySpace, contractId: string): Promise<ContractVersion | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM contract_versions WHERE tenant_id = $1 AND contract_id = $2 ORDER BY version_number DESC LIMIT 1`,
        [tenantId, contractId]
      );
      return (rows[0] as ContractVersion) ?? null;
    });
  }

  async addObligation(tenantId: string, memorySpace: MemorySpace, contractId: string, input: AddObligationInput): Promise<ContractObligation> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, contractId, true);
      if (!current) throw new Error("contract_not_found");
      const obligation_id = `agr-ob-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO contract_obligations (obligation_id, tenant_id, memory_space_id, contract_id, description, owner_person_id, due_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [obligation_id, tenantId, memorySpace, contractId, input.description, input.owner_person_id ?? null, input.due_at ?? null]
      );
      await insertEvent(client, tenantId, memorySpace, {
        contract_id: contractId, event_type: "obligation_added", summary: `Forpliktelse lagt til: ${input.description}`,
        actor_person_id: input.actor_person_id ?? null, metadata: { obligation_id, due_at: input.due_at ?? null }
      });
      return rows[0] as ContractObligation;
    });
  }

  async listObligations(tenantId: string, memorySpace: MemorySpace, contractId: string, status: ObligationStatus | "all" = "all"): Promise<ContractObligation[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } =
        status === "all"
          ? await client.query(`SELECT * FROM contract_obligations WHERE tenant_id = $1 AND contract_id = $2 ORDER BY due_at ASC NULLS LAST`, [tenantId, contractId])
          : await client.query(
              `SELECT * FROM contract_obligations WHERE tenant_id = $1 AND contract_id = $2 AND status = $3 ORDER BY due_at ASC NULLS LAST`,
              [tenantId, contractId, status]
            );
      return rows as ContractObligation[];
    });
  }

  /** "What is due next?" - alle åpne forpliktelser på tvers av kontrakter, sortert på frist. */
  async dueObligations(tenantId: string, memorySpace: MemorySpace, withinDays?: number): Promise<ContractObligation[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } =
        withinDays === undefined
          ? await client.query(
              `SELECT * FROM contract_obligations WHERE tenant_id = $1 AND status = 'open' ORDER BY due_at ASC NULLS LAST`,
              [tenantId]
            )
          : await client.query(
              `SELECT * FROM contract_obligations WHERE tenant_id = $1 AND status = 'open'
                 AND due_at IS NOT NULL AND due_at < now() + ($2 || ' days')::interval
               ORDER BY due_at ASC`,
              [tenantId, withinDays]
            );
      return rows as ContractObligation[];
    });
  }

  async overdueObligations(tenantId: string, memorySpace: MemorySpace): Promise<ContractObligation[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM contract_obligations WHERE tenant_id = $1 AND status = 'open' AND due_at IS NOT NULL AND due_at < now() ORDER BY due_at ASC`,
        [tenantId]
      );
      return rows as ContractObligation[];
    });
  }

  private async setObligationStatus(
    tenantId: string,
    memorySpace: MemorySpace,
    obligationId: string,
    status: ObligationStatus,
    eventType: ContractEventType,
    actorPersonId?: string
  ): Promise<ContractObligation | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows: currentRows } = await client.query(
        `SELECT * FROM contract_obligations WHERE tenant_id = $1 AND obligation_id = $2 FOR UPDATE`,
        [tenantId, obligationId]
      );
      const current = currentRows[0] as ContractObligation | undefined;
      if (!current) return null;
      assertValidObligationTransition(current.status, status);
      const completedAtClause = status === "completed" ? ", completed_at = now()" : current.status === "completed" ? ", completed_at = NULL" : "";
      const { rows } = await client.query(
        `UPDATE contract_obligations SET status = $1, updated_at = now()${completedAtClause} WHERE tenant_id = $2 AND obligation_id = $3 RETURNING *`,
        [status, tenantId, obligationId]
      );
      const updated = rows[0] as ContractObligation;
      await insertEvent(client, tenantId, memorySpace, {
        contract_id: updated.contract_id, event_type: eventType, summary: `Forpliktelse ${status}: ${updated.description}`,
        actor_person_id: actorPersonId ?? null, metadata: { obligation_id: obligationId, from: current.status, to: status }
      });
      return updated;
    });
  }

  async completeObligation(tenantId: string, memorySpace: MemorySpace, obligationId: string, actorPersonId?: string): Promise<ContractObligation | null> {
    return this.setObligationStatus(tenantId, memorySpace, obligationId, "completed", "obligation_completed", actorPersonId);
  }

  async waiveObligation(tenantId: string, memorySpace: MemorySpace, obligationId: string, actorPersonId?: string): Promise<ContractObligation | null> {
    return this.setObligationStatus(tenantId, memorySpace, obligationId, "waived", "obligation_waived", actorPersonId);
  }

  async reopenObligation(tenantId: string, memorySpace: MemorySpace, obligationId: string, actorPersonId?: string): Promise<ContractObligation | null> {
    return this.setObligationStatus(tenantId, memorySpace, obligationId, "open", "obligation_added", actorPersonId);
  }

  async listEvents(tenantId: string, memorySpace: MemorySpace, contractId: string): Promise<ContractEvent[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM contract_events WHERE tenant_id = $1 AND contract_id = $2 ORDER BY occurred_at ASC`,
        [tenantId, contractId]
      );
      return rows as ContractEvent[];
    });
  }

  private async readForUpdate(client: pg.PoolClient, tenantId: string, contractId: string, lock: boolean): Promise<Contract | null> {
    const { rows } = await client.query(
      `SELECT * FROM contracts WHERE tenant_id = $1 AND contract_id = $2${lock ? " FOR UPDATE" : ""}`,
      [tenantId, contractId]
    );
    return (rows[0] as Contract) ?? null;
  }

  /**
   * UA-3 akseptansekriterium 1 ("Hva skjer med kunde X?"): speiler kontrakt-
   * lifecycle-hendelser inn i `business_activities`.
   *
   * Arkitekt-review MERGE BLOCKER (D-130, PR #79): kaller NAA
   * `recordActivityInTransaction()` DIREKTE med den ALLEREDE ÅPNE `client`
   * fra kallerens `withMemoryTransaction`-blokk - IKKE lenger
   * `this.business.recordActivity()` (som åpner sin EGEN, frakoblede
   * transaksjon) - se samme kommentar i `modules/support/src/service.ts`
   * sin `recordTicketTimelineActivity()`. Dette gjør skrivingen ATOMISK med
   * selve kontrakt-/versjons-raden: feiler denne INSERT-en, ruller HELE den
   * omsluttende transaksjonen tilbake. En kontrakt UTEN `company_id`/
   * `contact_id` har ingen motpart å feste seg til på tidslinjen - hoppes
   * BEVISST over her (ALDRI en oppdiktet plassholder-kobling). `external_id`
   * er en stabil, deterministisk nøkkel per LOGISK hendelse
   * (`{contract_id}:created` / `{contract_id}:status:{status}` /
   * `{contract_id}:version:{version_number}`) - `recordActivityInTransaction()`
   * sin EKSISTERENDE `ON CONFLICT`-idempotens hindrer derfor en duplikat rad
   * ved en gjentatt/retried kilde-hendelse (§22). `canonical_uri` peker
   * TILBAKE til selve kontrakten - ALDRI en kopi av kontraktinnhold.
   */
  private async recordContractTimelineActivity(
    client: pg.PoolClient,
    tenantId: string,
    memorySpace: MemorySpace,
    contract: Pick<Contract, "contract_id" | "company_id" | "contact_id">,
    activityType: "external_event" | "status_change" | "document",
    summary: string,
    externalIdSuffix: string
  ): Promise<void> {
    if (!contract.company_id && !contract.contact_id) return;
    await recordActivityInTransaction(client, tenantId, memorySpace, {
      activity_type: activityType,
      summary,
      ...(contract.company_id ? { company_id: contract.company_id } : {}),
      ...(contract.contact_id ? { contact_id: contract.contact_id } : {}),
      source_type: "contract",
      source_instance_id: "native",
      external_id: `${contract.contract_id}:${externalIdSuffix}`,
      canonical_uri: `jarvis:contract:${contract.contract_id}`
    });
  }

  /**
   * Arkitekt-review MERGE BLOCKER (Q-33/D-130, PR #79): mirrors
   * `OperationsService.assertCompanyContactInScope()` i
   * `modules/operations/src/service.ts` (D-129) - SAMME mønster/håndheving,
   * kun flyttet til Agreements. `business_companies.company_id`/
   * `business_contacts.contact_id` er GLOBALE primærnøkler (ingen sammensatt
   * `(tenant_id, memory_space_id, id)`-nøkkel der - bevisst unngått en bred,
   * urelatert Business OS-skjemaendring, se D-129). Denne
   * tjenestelags-vakten er derfor den ENESTE håndhevingen for disse to
   * relasjonene fra Agreements: begge maa eksistere i EGEN
   * tenant+memory_space, og dersom BEGGE er oppgitt maa kontakten faktisk
   * tilhøre den oppgitte company-en. Kalles FØR enhver INSERT/UPDATE som
   * setter company_id/contact_id, INNE i samme åpne transaksjon (client) -
   * avslag etterlater derfor INGEN rad noe sted.
   */
  private async assertCompanyContactInScope(
    client: pg.PoolClient,
    tenantId: string,
    memorySpace: MemorySpace,
    companyId: string | undefined,
    contactId: string | undefined
  ): Promise<void> {
    if (companyId !== undefined) {
      const { rows } = await client.query(
        `SELECT 1 FROM business_companies WHERE tenant_id = $1 AND memory_space_id = $2 AND company_id = $3`,
        [tenantId, memorySpace, companyId]
      );
      if (rows.length === 0) throw new AgreementsCrossScopeReferenceError("company_id", companyId);
    }
    if (contactId !== undefined) {
      const { rows } = await client.query(
        `SELECT company_id FROM business_contacts WHERE tenant_id = $1 AND memory_space_id = $2 AND contact_id = $3`,
        [tenantId, memorySpace, contactId]
      );
      if (rows.length === 0) throw new AgreementsCrossScopeReferenceError("contact_id", contactId);
      if (companyId !== undefined) {
        const contactCompanyId = (rows[0] as { company_id: string | null }).company_id;
        if (contactCompanyId !== companyId) throw new AgreementsContactCompanyMismatchError(contactId, companyId);
      }
    }
  }
}

async function insertContract(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, input: CreateContractInput): Promise<Contract> {
  const contract_id = `agr-ct-${randomUUID()}`;
  const { rows } = await client.query(
    `INSERT INTO contracts
       (contract_id, tenant_id, memory_space_id, company_id, contact_id, title, contract_type,
        effective_date, start_date, end_date, termination_deadline, renewal_date, auto_renew, owner_person_id,
        source_type, source_instance_id, source_thread_id, source_message_id, canonical_uri)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING *`,
    [
      contract_id, tenantId, memorySpace, input.company_id ?? null, input.contact_id ?? null, input.title,
      input.contract_type ?? "other", input.effective_date ?? null, input.start_date ?? null, input.end_date ?? null,
      input.termination_deadline ?? null, input.renewal_date ?? null, input.auto_renew ?? false, input.owner_person_id ?? null,
      input.source_type ?? "native", input.source_instance_id ?? null, input.source_thread_id ?? null,
      input.source_message_id ?? null, input.canonical_uri ?? null
    ]
  );
  return rows[0] as Contract;
}

interface InsertEventInput {
  contract_id: string;
  event_type: ContractEventType;
  summary: string;
  actor_person_id: string | null;
  metadata: Record<string, unknown>;
}

async function insertEvent(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, input: InsertEventInput): Promise<ContractEvent> {
  const event_id = `agr-ev-${randomUUID()}`;
  const { rows } = await client.query(
    `INSERT INTO contract_events (event_id, tenant_id, memory_space_id, contract_id, event_type, summary, actor_person_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [event_id, tenantId, memorySpace, input.contract_id, input.event_type, input.summary, input.actor_person_id, JSON.stringify(input.metadata)]
  );
  return rows[0] as ContractEvent;
}
