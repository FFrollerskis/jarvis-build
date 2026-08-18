/**
 * UA-3 Native Jarvis Contracts Core (D-71). Jarvis EIER selv kontrakt-
 * domenemodellen (JARVIS_CANONICAL, D-64 Core-vs-Adapter-porten kjørt FØRST
 * - se DECISIONS_AND_ASSUMPTIONS.md D-71). ZERO leverandør-spesifikke felter
 * her - juridisk signeringsutførelse er en FREMTIDIG, valgfri
 * utførelsesadapter, aldri domeneeier. "Smallest complete": kun det som
 * faktisk kreves for lifecycle/versjonering/forpliktelser/frister/
 * motpartskobling - ingen contract-lifecycle-management-plattform-
 * kompleksitet uten reelt behov.
 */

export type ContractStatus = "draft" | "review" | "approved" | "active" | "expiring" | "expired" | "terminated" | "cancelled";
export type ObligationStatus = "open" | "completed" | "waived";

export type ContractEventType =
  | "contract_created"
  | "version_added"
  | "status_changed"
  | "obligation_added"
  | "obligation_completed"
  | "obligation_waived"
  | "renewal_date_changed"
  | "termination_deadline_changed"
  | "counterparty_linked"
  | "owner_changed";

export interface Contract {
  contract_id: string;
  contract_number: string;
  tenant_id: string;
  memory_space_id: string;
  company_id: string | null;
  contact_id: string | null;
  title: string;
  contract_type: string;
  status: ContractStatus;
  effective_date: string | null;
  start_date: string | null;
  end_date: string | null;
  termination_deadline: string | null;
  renewal_date: string | null;
  auto_renew: boolean;
  owner_person_id: string | null;
  source_type: string;
  source_instance_id: string | null;
  source_thread_id: string | null;
  source_message_id: string | null;
  canonical_uri: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContractVersion {
  version_id: string;
  tenant_id: string;
  memory_space_id: string;
  contract_id: string;
  version_number: string;
  summary: string;
  status_at_version: string | null;
  source_type: string | null;
  source_instance_id: string | null;
  source_message_id: string | null;
  canonical_uri: string | null;
  created_by_person_id: string | null;
  created_at: string;
}

export interface ContractObligation {
  obligation_id: string;
  tenant_id: string;
  memory_space_id: string;
  contract_id: string;
  description: string;
  owner_person_id: string | null;
  due_at: string | null;
  status: ObligationStatus;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContractEvent {
  event_id: string;
  tenant_id: string;
  memory_space_id: string;
  contract_id: string;
  event_type: ContractEventType;
  summary: string;
  actor_person_id: string | null;
  metadata: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
}

export interface CreateContractInput {
  title: string;
  contract_type?: string;
  company_id?: string;
  contact_id?: string;
  effective_date?: string;
  start_date?: string;
  end_date?: string;
  termination_deadline?: string;
  renewal_date?: string;
  auto_renew?: boolean;
  owner_person_id?: string;
  source_type?: string;
  source_instance_id?: string;
  source_thread_id?: string;
  source_message_id?: string;
  canonical_uri?: string;
  actor_person_id?: string;
}

/** §"Contract versions must be explicit and immutable" i byggeordren: en versjon er ALDRI en oppdatering av en eksisterende rad, kun et nytt, append-only øyeblikksbilde. */
export interface AddVersionInput {
  summary: string;
  source_type?: string;
  source_instance_id?: string;
  source_message_id?: string;
  canonical_uri?: string;
  created_by_person_id?: string;
}

export interface AddObligationInput {
  description: string;
  owner_person_id?: string;
  due_at?: string;
  actor_person_id?: string;
}
