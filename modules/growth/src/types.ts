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
  | "experiment_status_changed"
  | "tracking_tag_registered"
  | "action_recommendation_created"
  | "action_recommendation_resolved"
  | "execution_command_generated"
  | "execution_command_cancelled";

/**
 * D-85: anomaly -> recommended-action control-plane-fundament.
 * BESLUTNINGS-laget ("hva BØR gjøres"), ALDRI utførelses-laget ("gjør det
 * MOT en leverandør") - `accepted` sporer KUN Jarvis sin egen interne
 * disposisjon, utfører INGENTING mot en ekte annonseplattform (krever en
 * separat, fremtidig provider-mutate-kapabilitet + UA-6 Finance Integrity
 * Gateway, ingen av delene bygget). `source` er BEVISST alltid
 * `'deterministic_rule'` i denne runden - ZERO AI-inferens (Q-26-grensen).
 */
export type RecommendationType = "reduce_budget" | "investigate";
export type RecommendationStatus = "proposed" | "accepted" | "dismissed" | "superseded";
export type RecommendationSource = "deterministic_rule";

/**
 * D-82: deterministisk UTM-/klikk-ID-basert auto-attribusjon. `click_id`
 * (gclid/fbclid/msclkid) er det sterkeste, mest entydige signalet; `utm`
 * krever ALLTID hele (source, medium, campaign)-tripletten sammen - ALDRI
 * et delvis felt alene (for grovt, falske positiver). Gjensidig
 * utelukkende med databasen selv (CHECK-constraint i migrasjonen).
 */
export type TrackingTagType = "click_id" | "utm";
export type ClickIdParam = "gclid" | "fbclid" | "msclkid";

export interface CampaignTrackingTag {
  tag_id: string;
  tenant_id: string;
  memory_space_id: string;
  campaign_id: string;
  tag_type: TrackingTagType;
  click_id_param: ClickIdParam | null;
  click_id_value: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  created_at: string;
}

export interface CampaignActionRecommendation {
  recommendation_id: string;
  tenant_id: string;
  memory_space_id: string;
  campaign_id: string;
  open_loop_id: string | null;
  recommendation_type: RecommendationType;
  status: RecommendationStatus;
  rationale: string;
  evidence: Record<string, unknown>;
  source: RecommendationSource;
  detection_key: string;
  resolved_at: string | null;
  resolved_by_person_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * D-87: provider-nøytral UTFØRELSES-KOMMANDO-modell - det strukturelle
 * bindeleddet mellom BESLUTNINGS-laget (D-85, `CampaignActionRecommendation`)
 * og en FREMTIDIG utførelses-kapabilitet ("gjør det MOT en leverandør"),
 * INGEN av delene bygget her. Et command er en deterministisk OVERSETTELSE
 * av en ALLEREDE eier-godkjent (`status='accepted'`) anbefaling til de
 * EKSAKTE parametrene en fremtidig utfører ville trengt - beregnet og
 * lagret NÅ, ALDRI utført. `status` inneholder BEVISST INGEN 'executed'-
 * verdi (håndhevet av databasens CHECK-constraint, `030_growth_execution_
 * commands.sql`) - dette er en STRUKTURELL, ikke bare en kode-konvensjonell,
 * Finance Integrity-grense.
 */
export type ExecutionCommandType = "reduce_budget";
export type ExecutionCommandStatus = "pending_execution" | "cancelled" | "superseded";

export interface CampaignExecutionCommand {
  command_id: string;
  tenant_id: string;
  memory_space_id: string;
  campaign_id: string;
  recommendation_id: string;
  command_type: ExecutionCommandType;
  current_budget_ore: string;
  proposed_budget_ore: string;
  reduction_fraction: string;
  currency: string;
  status: ExecutionCommandStatus;
  cancelled_at: string | null;
  cancelled_by_person_id: string | null;
  cancellation_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** Nøyaktig ÉN av de to formene - håndhevet av TypeScript her OG av databasens CHECK-constraint. */
export type RegisterCampaignTrackingTagInput =
  | { click_id_param: ClickIdParam; click_id_value: string; actor_person_id?: string }
  | { utm_source: string; utm_medium: string; utm_campaign: string; actor_person_id?: string };

/** Samme unionsform som registrering - matching bruker EKSAKT de samme feltene, aldri en løsere variant. */
export type TrackingLookup =
  | { click_id_param: ClickIdParam; click_id_value: string }
  | { utm_source: string; utm_medium: string; utm_campaign: string };

export interface AttributeFromTrackingInput {
  entity_type: AttributionEntityType;
  entity_id: string;
  tracking: TrackingLookup;
  attribution_model?: AttributionModel;
  actor_person_id?: string;
}

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
 *
 * D-88: `attributed_meetings` lukker det litterale funnel-gapet mellom
 * LEAD/OPPORTUNITY-attribusjon og WON/REVENUE - CAMPAIGN -> SPEND ->
 * TRACKING -> LEAD -> KONTAKT -> **MØTE** -> OPPORTUNITY -> WON -> REVENUE.
 * Deterministisk, ZERO ny tabell/migrasjon - utledet UTELUKKENDE fra
 * EKSISTERENDE FK-kjeder (`marketing_attributions` -> `business_leads`/
 * `business_opportunities.contact_id` -> `business_activities` der
 * `activity_type='meeting'`), ALDRI en gjettet/AI-utledet kobling
 * (Q-26-grensen). Et møte telles KUN når det inntraff PÅ ELLER ETTER
 * attribusjonstidspunktet (`occurred_at >= attributed_at`) - et møte FØR
 * kampanjen noensinne ble tilskrevet kontakten kan umulig være et resultat
 * av DENNE kampanjen, og telles derfor aldri med (fail-closed, ikke gjettet).
 *
 * PRESISERING (semantisk grense, ikke bare en implementasjonsdetalj):
 * `attributed_meetings` betyr "et kanonisk møte KOBLET til en forretnings-
 * entitet som ALLEREDE bærer kampanje-attribusjon, inntruffet ETTER
 * attribusjonstidspunktet" - EN DERIVERT ATTRIBUSJONSKJEDE (deterministisk
 * lineage), IKKE en eksperimentelt bevist kausal påstand om at KAMPANJEN
 * "forårsaket"/"genererte" møtet. Samme kontakt kan ha egne, uavhengige
 * grunner til å bli møtt; feltet sier KUN at lineage-kjeden (attribusjon ->
 * kontakt -> møte, i riktig tidsrekkefølge) eksisterer, aldri at kjeden er
 * den ENESTE eller SANNE årsaken (Q-26-grensen: ingen "sannhets"-forfremmelse
 * utover det de underliggende, allerede-lagrede faktaene faktisk beviser).
 */
export interface CampaignPerformance {
  campaign_id: string;
  total_spend_ore: string;
  attributed_leads: number;
  attributed_opportunities: number;
  attributed_meetings: number;
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
