/**
 * UA-3 P0 Business Graph-domenemodell (docs/input/02_..._v4.0.md §"Business
 * Operating System"). Kun de entitetene/feltene som kreves for det FOERSTE
 * koherente UA-3-slice-et: Company/Contact/Lead/Opportunity/Activity/
 * Followup. Kontrakt/faktura/inntekt/scoring/attention-queue er BEVISST
 * utelatt (se docs/OPEN_QUESTIONS.md Q-25) - ingen ERP-klone.
 */

export type CompanyStatus = "prospect" | "active" | "inactive" | "churned";
export type LeadStatus = "new" | "contacted" | "qualified" | "disqualified" | "converted";
export type OpportunityStage = "new" | "qualified" | "proposal" | "negotiation" | "won" | "lost";
export type ActivityType = "email" | "call" | "meeting" | "note" | "status_change" | "task" | "document" | "external_event";
export type FollowupPriority = "low" | "normal" | "high";
export type FollowupStatus = "open" | "completed" | "cancelled";

export interface BusinessCompany {
  company_id: string;
  tenant_id: string;
  memory_space_id: string;
  name: string;
  domain: string | null;
  status: CompanyStatus;
  source: string | null;
  owner_person_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessContact {
  contact_id: string;
  tenant_id: string;
  memory_space_id: string;
  company_id: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  source: string | null;
  owner_person_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessLead {
  lead_id: string;
  tenant_id: string;
  memory_space_id: string;
  company_id: string | null;
  contact_id: string | null;
  title: string;
  status: LeadStatus;
  source: string | null;
  source_type: string | null;
  source_instance_id: string | null;
  external_id: string | null;
  owner_person_id: string | null;
  /** WP-D2 (089_business_pipeline_writes.sql): neste steg + valgfri frist, og lukketidspunkt/-grunn ved terminal status. */
  next_action: string | null;
  next_action_due_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessOpportunity {
  opportunity_id: string;
  tenant_id: string;
  memory_space_id: string;
  company_id: string | null;
  contact_id: string | null;
  lead_id: string | null;
  title: string;
  stage: OpportunityStage;
  value_ore: number | null;
  currency: string;
  expected_close_date: string | null;
  owner_person_id: string | null;
  /** WP-D2 (089_business_pipeline_writes.sql): neste steg + valgfri frist, og lukketidspunkt/-grunn ved won/lost. */
  next_action: string | null;
  next_action_due_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessActivity {
  activity_id: string;
  tenant_id: string;
  memory_space_id: string;
  company_id: string | null;
  contact_id: string | null;
  opportunity_id: string | null;
  lead_id: string | null;
  activity_type: ActivityType;
  summary: string;
  source_type: string | null;
  source_instance_id: string | null;
  external_id: string | null;
  /** Peker til Knowledge-dokument/kilde - ALDRI kopi av fullt innhold (§15). */
  canonical_uri: string | null;
  owner_person_id: string | null;
  occurred_at: string;
  created_at: string;
}

export interface BusinessFollowup {
  followup_id: string;
  tenant_id: string;
  memory_space_id: string;
  company_id: string | null;
  contact_id: string | null;
  opportunity_id: string | null;
  lead_id: string | null;
  activity_id: string | null;
  title: string;
  reason: string | null;
  next_action: string | null;
  due_at: string;
  priority: FollowupPriority;
  status: FollowupStatus;
  owner_person_id: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  idempotency_key: string | null;
}

/** "Hva skjer med kunde X?" - append-vennlig, kilde-referert tidslinje (akseptansekriterium 1). */
export interface CustomerTimelineEntry {
  activity_id: string;
  activity_type: ActivityType;
  summary: string;
  canonical_uri: string | null;
  occurred_at: string;
}

/** Grunnleggende drifts-metrikker (§19) - avledet fra autoritativ state, ikke et eget BI-lag. */
export interface BusinessMetrics {
  open_leads: number;
  active_opportunities: number;
  open_pipeline_value_ore: number;
  overdue_followups: number;
  won_opportunities_30d: number;
}
