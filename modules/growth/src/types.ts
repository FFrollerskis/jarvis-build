/**
 * UA-4 Native Jarvis Growth Core (D-74). Jarvis EIER selv vekst-/
 * markedsføringsdomenet (JARVIS_CANONICAL/HYBRID_WITH_CLEAR_AUTHORITY,
 * D-64 Core-vs-Adapter-porten kjørt FØRST - se
 * DECISIONS_AND_ASSUMPTIONS.md D-74). ZERO leverandør-spesifikke felter
 * her - live annonseplattform-tilkobling er en FREMTIDIG, valgfri
 * datakilde-/utførelsesadapter, aldri domeneeier. "Smallest complete": kun
 * det som faktisk kreves for kampanje-lifecycle/utgiftsledger/attribusjon
 * mot eksisterende CRM/eksperimentregister - ingen markedsførings-
 * plattform-kompleksitet uten reelt behov.
 */

export type CampaignChannel =
  | "google_ads"
  | "meta_ads"
  | "ga4"
  | "search_console"
  | "google_business_profile"
  | "linkedin"
  | "youtube"
  | "tiktok"
  | "other";

export type CampaignStatus = "draft" | "active" | "paused" | "ended";
export type SpendSourceType = "manual" | "csv_import" | "provider_sync";
export type AttributionEntityType = "lead" | "opportunity";
export type AttributionModel = "first_touch" | "last_touch";
export type ExperimentStatus = "draft" | "running" | "concluded" | "abandoned";

export type CampaignEventType =
  | "campaign_created"
  | "status_changed"
  | "spend_recorded"
  | "budget_changed"
  | "attribution_created"
  | "experiment_created"
  | "experiment_status_changed";

export interface Campaign {
  campaign_id: string;
  tenant_id: string;
  memory_space_id: string;
  channel: CampaignChannel;
  name: string;
  status: CampaignStatus;
  budget_amount_ore: string | null;
  currency: string;
  external_campaign_id: string | null;
  canonical_uri: string | null;
  owner_person_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SpendEvent {
  spend_event_id: string;
  tenant_id: string;
  memory_space_id: string;
  campaign_id: string;
  event_date: string;
  spend_amount_ore: string;
  currency: string;
  clicks: number | null;
  impressions: number | null;
  source_type: SpendSourceType;
  source_pointer: string | null;
  created_at: string;
  updated_at: string;
}

export interface Attribution {
  attribution_id: string;
  tenant_id: string;
  memory_space_id: string;
  campaign_id: string;
  entity_type: AttributionEntityType;
  entity_id: string;
  attribution_model: AttributionModel;
  source_pointer: string | null;
  attributed_at: string;
  created_at: string;
}

export interface Experiment {
  experiment_id: string;
  tenant_id: string;
  memory_space_id: string;
  campaign_id: string | null;
  name: string;
  hypothesis: string | null;
  status: ExperimentStatus;
  result_summary: string | null;
  owner_person_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignEvent {
  event_id: string;
  tenant_id: string;
  memory_space_id: string;
  campaign_id: string;
  event_type: CampaignEventType;
  summary: string;
  actor_person_id: string | null;
  metadata: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
}

/**
 * Deterministisk CAC/ROAS - UA-4 akseptansekriterium 1 ("CAC/ROAS knyttes
 * til real CRM/revenue"). `won_opportunities`/`attributed_revenue_ore`
 * kommer FRA `business_opportunities.stage='won'`/`value_ore` (ekte CRM-
 * data, ALDRI fabrikkert). `cac_ore`/`roas` er `null` (ikke `0` eller en
 * gjettet verdi) når nevneren er `0` - en udefinert ratio er ærlig
 * rapportert som udefinert, aldri stille avrundet.
 */
export interface CampaignPerformance {
  campaign_id: string;
  total_spend_ore: string;
  attributed_leads: number;
  attributed_opportunities: number;
  won_opportunities: number;
  attributed_revenue_ore: string;
  cac_ore: number | null;
  roas: number | null;
}

export interface CreateCampaignInput {
  channel: CampaignChannel;
  name: string;
  budget_amount_ore?: number;
  currency?: string;
  external_campaign_id?: string;
  canonical_uri?: string;
  owner_person_id?: string;
  started_at?: string;
  actor_person_id?: string;
}

export interface RecordSpendEventInput {
  event_date: string;
  spend_amount_ore: number;
  currency?: string;
  clicks?: number;
  impressions?: number;
  source_type?: SpendSourceType;
  source_pointer?: string;
  actor_person_id?: string;
}

export interface AttributeToCampaignInput {
  entity_type: AttributionEntityType;
  entity_id: string;
  attribution_model?: AttributionModel;
  source_pointer?: string;
  actor_person_id?: string;
}

export interface CreateExperimentInput {
  name: string;
  hypothesis?: string;
  campaign_id?: string;
  owner_person_id?: string;
  actor_person_id?: string;
}
