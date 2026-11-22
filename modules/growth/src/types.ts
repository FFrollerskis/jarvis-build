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
  | "execution_command_cancelled"
  | "marketing_observation_generated"
  // WP-D3 (D-459, migrasjon 112-114): eksperimentregister og plattform-skrivinger
  | "experiment_variant_added"
  | "experiment_outcome_recorded"
  | "provider_write_applied"
  | "provider_write_unknown"
  | "provider_write_failed"
  | "execution_command_executed"
  | "execution_command_unknown";

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
/**
 * WP-D3 (D-459, migrasjon 114): `executed` finnes nå, men KUN med bevis - databasen krever en `applied` journalrad (`growth_write_journal`) for SAMME kampanje (`execution_write_id`) og
 * `executed_at`. `execution_unknown` = plattformen aksepterte skrivingen uten bekreftet utfall (avstemming gjenstår; kommandoen er verken «venter» eller «utført»).
 */
export type ExecutionCommandStatus = "pending_execution" | "cancelled" | "superseded" | "executed" | "execution_unknown";

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
  /** WP-D3 (migrasjon 114): satt når kommandoen er utført/ukjent - peker på journalraden som er beviset. */
  executed_at?: string | null;
  execution_write_id?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * D-89: MARKETING MEMORY v1 - et NARROW, deterministisk OBSERVASJON-lag
 * over ALLEREDE eksisterende kanonisk data (kampanje/utgift/attribusjon/
 * møte/anbefaling/kommando). Lukker masterplanens EGEN literale nevning
 * ("Experiment registry, anomaly detection, creative intelligence og
 * marketing memory", input/02_..._v4.0.md linje 479) - IKKE et generalisert
 * "AI lærer alt"-system.
 *
 * Begrepsskillet (BEVISST, ALDRI forvekslet):
 * - MARKETING FACT = kanonisk leverandør-/forretningsfakta (`marketing_
 *   campaigns`/`marketing_spend_events`/`marketing_attributions`/
 *   `business_activities` - ALLEREDE finnes, INGEN ny fact-tabell her).
 * - MARKETING OBSERVATION = deterministisk AVLEDET resultat FRA fakta
 *   (`CampaignObservation` under - DETTE laget).
 * - MARKETING HYPOTHESIS/LEARNING = en mulig forklaring/en gjenbrukbar
 *   generalisert konklusjon på tvers av kampanjer - EKSPLISITT IKKE bygget
 *   i v1 (ville krevd inferens/generalisering utover det eksplisitt
 *   lagrede - Q-26-risiko, se D-89 for full begrunnelse).
 * - MARKETING POLICY = eier-/systemdefinert regel (f.eks. D-85 sin
 *   `reduction_fraction`-default) - urørt av denne sliceen.
 *
 * `detection_method` er BEVISST LÅST til KUN `'deterministic'` (databasens
 * CHECK-constraint, `031_growth_marketing_observations.sql`) - ZERO
 * ModelGateway/AI-inferens er strukturelt umulig i v1, ikke bare en
 * kode-konvensjon. `status` inneholder BEVISST INGEN `'verified'`-verdi -
 * en observasjon er ALDRI "bekreftet sannhet" (Truth Promotion/Q-26
 * forblir eksplisitt ubygget), kun tilstede (`'open'`) eller ikke lenger
 * gjeldende (`'resolved'` - satt når det underliggende vilkåret opphører,
 * ALDRI slettet ved den overgangen).
 *
 * PRESIS MINNE-KLASSIFISERING (v1, verifisert eksplisitt mot PR #27-audit):
 * `marketing_campaign_observations` er CURRENT-STATE-minne PER (kampanje,
 * observasjonstype) - `UNIQUE (tenant_id, campaign_id, observation_type)`
 * betyr at raden viser den NYESTE episoden, IKKE en append-only logg over
 * ALLE tidligere åpne/løste episoder. Konkret: går `meetings_without_
 * conversion` open -> resolved -> (en senere korreksjon åpner vilkåret
 * igjen) -> open, OVERSKRIVER den nye episoden BEVISST den forrige
 * episodens evidence i SAMME rad (SAMME `observation_id`) - den FØRSTE
 * episodens evidence er DA ikke lenger separat gjenfinnbar i denne
 * tabellen. Dette er en BEVISST, dokumentert v1-omfangsgrense (garantien
 * er KUN "en 'resolved' rad slettes aldri FØR den ev. gjenåpnes", ALDRI en
 * full episodisk historikk-ledger) - IKKE HISTORICAL_EPISODIC_MEMORY. En
 * fremtidig v2 kunne legge til en separat, append-only episode-/hendelse-
 * tabell hvis flerepisode-historikk faktisk trengs - IKKE bygget her.
 *
 * To observasjonstyper, BEGGE trygt avledbare UTEN noe tidsvindu (unngår
 * "sammenlign livstids-kampanje A mot 7-dagers-kampanje B"-fellen, siden
 * `campaignPerformance()` er livstids-only - en FREMTIDIG tidsvindu-/
 * trend-observasjonstype er eksplisitt IKKE bygget her):
 * - `meetings_without_conversion`: kampanjen har ≥1 attribuert møte
 *   (D-88) MEN 0 vunne opportunities (livstids-snapshot) - en ærlig
 *   funnel-GAP, ALDRI en kausal påstand om HVORFOR.
 * - `recommendation_disposition_summary`: en alltid-oppdatert opptelling
 *   av D-85-anbefalingers/D-87-kommandoers status for kampanjen (aldri
 *   `'resolved'`, kun en løpende rapport).
 */
export type MarketingObservationType = "meetings_without_conversion" | "recommendation_disposition_summary";
export type MarketingObservationStatus = "open" | "resolved";
export type MarketingObservationDetectionMethod = "deterministic";

export interface CampaignObservation {
  observation_id: string;
  tenant_id: string;
  memory_space_id: string;
  campaign_id: string;
  observation_type: MarketingObservationType;
  detection_method: MarketingObservationDetectionMethod;
  status: MarketingObservationStatus;
  summary: string;
  evidence: Record<string, unknown>;
  observed_at: string;
  resolved_at: string | null;
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
  /** KUN NOK-utgift (én kilde per dato, D-395). Fremmed valuta står i `spend_currencies` og gjør cac/roas udefinerte. */
  total_spend_ore: string;
  /** Distinkte valutaer i (dedupliserte) utgiftsrader. Inneholder noe annet enn NOK ⇒ cac_ore/roas er null. */
  spend_currencies: string[];
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
