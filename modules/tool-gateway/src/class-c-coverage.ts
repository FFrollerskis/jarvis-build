/**
 * WP-AUTH2a (K5/K6): DEKNINGSTABELLEN for deterministisk klasse C-behandling. ÉN stilling per klasse C-handling i produksjonsregisteret (alle flaggstyrte sett med flaggene PÅ): hva som er dekket av en adapter,
 * hva som har en egen full kjede fra før, hva som er eierens stopp-/kontrollhandlinger (aldri blokkerbare), og hva som er utsatt (`deferred`) - med KATEGORI og en konkret begrunnelse som WP-AUTH2b bygger videre på.
 * Ingen handling er «stille utelatt»: vakten `apps/api/test/wpauth2a-class-c-coverage.test.ts` feller en NY klasse C-handling som ikke har en stilling her (mønster: `part3-tool-manifest`), og runbooken
 * `docs/runbooks/WPAUTH2A_CLASS_C.md` har samme tabell (pinnet av en drift-test).
 *
 * STATUS
 *   covered         - en adapter er registrert (`class-c-adapters.ts` + domenemodulene); modus observe/enforce engasjerer pipelinen.
 *   existing_chain  - handlingen har ALLEREDE en full, egen kjede (fersk lesing, validator, etterbetingelse, step-up, journal); AUTH2a rører den ikke.
 *   owner_override  - eierens stopp-/kontrollhandling: skal aldri blokkeres/forsinkes av pipelinen (`isClassCOwnerOverride`); utelukket strukturelt.
 *   deferred        - ikke dekket i AUTH2a; `category` + `reason` sier hvorfor og hva som trengs.
 *
 * KATEGORIER (kun for `deferred`)
 *   no_live_write_transport - live-transporten støtter ikke skrivehandlingen (adapter ville vært død kode)
 *   effect_not_observable   - effekten kan ikke leses tilbake med eksisterende lesehandlinger (ville krevd en udokumentert leverandørantakelse)
 *   no_readback_action      - ingen eksisterende lesehandling gir readback av akkurat denne effekten
 *   async_effect            - effekten inntreffer etter at kallet returnerer (umiddelbar readback viser ikke sluttilstanden)
 *   sibling_of_covered      - samme form som en dekket handling og med eksisterende lesehandling: første AUTH2b-tillegg
 *   finance_owner_gated     - pengehandling bak eier-/step-up-port; leverandørsemantikk uverifisert mot dokumentasjon
 *   internal_registration   - Jarvis' egen tilstand/journal (JARVIS_CANONICAL) uten ekstern effekt å lese tilbake
 */
import type { ToolDefinition } from "./gateway.ts";
import { isClassCOwnerOverride } from "./class-c-pipeline.ts";

export type ClassCCoverageStatus = "covered" | "existing_chain" | "owner_override" | "deferred";
export type ClassCDeferredCategory =
  | "no_live_write_transport" | "effect_not_observable" | "no_readback_action" | "async_effect" | "sibling_of_covered" | "finance_owner_gated" | "internal_registration";

export interface ClassCCoverageEntry {
  status: ClassCCoverageStatus;
  /** Påkrevd (og kun tillatt) for `deferred`. */
  category?: ClassCDeferredCategory;
  reason: string;
}

export const CLASS_C_COVERAGE: Readonly<Record<string, ClassCCoverageEntry>> = {
  "business.cancel_followup": { status: "deferred", category: "no_readback_action", reason: "Som `business.complete_followup`: ingen lesing av én oppfølging etter avlysning." },
  "business.close_lead": { status: "deferred", category: "sibling_of_covered", reason: "Samme form som `business.update_lead_status` (`inspect_lead`); forventet diff = status + lukketidspunkt satt. Første AUTH2b-tillegg." },
  "business.close_opportunity": { status: "deferred", category: "sibling_of_covered", reason: "Samme form som `business.update_opportunity_stage` (`inspect_opportunity`); forventet diff = stadium + lukketidspunkt (+ endelig verdi). AUTH2b." },
  "business.complete_followup": { status: "deferred", category: "no_readback_action", reason: "Ingen lesing av én oppfølging (kun `list_overdue_followups`, som ikke viser fullførte). Krever en `get_followup`-lesehandling." },
  "business.defer_open_loop": { status: "deferred", category: "sibling_of_covered", reason: "`business.read_open_loop` finnes; forventet diff = utsatt til gitt tidspunkt. AUTH2b." },
  "business.delete_lead": { status: "deferred", category: "sibling_of_covered", reason: "`inspect_lead` finnes; etterbetingelsen er «målet er borte» (`data: null`), som adapter-grensesnittet støtter (absent-forventning), men sletting er irreversibel og bør få en egen avgjørelse om rollback (manuell fra `business_change_log`). AUTH2b." },
  "business.delete_opportunity": { status: "deferred", category: "sibling_of_covered", reason: "Som `business.delete_lead` (`inspect_opportunity`; etterbetingelse «borte»). AUTH2b." },
  "business.resolve_open_loop": { status: "deferred", category: "sibling_of_covered", reason: "`business.read_open_loop` finnes (klasse A) og kan brukes som readback; status/løsning følger tjenestens regler. AUTH2b." },
  "business.update_lead_status": { status: "covered", reason: "Domene-adapter i `modules/business/src/class-c-adapter.ts`: `inspect_lead`, tjenestens egne konstanter (`LEAD_STATUSES`/`LEAD_TERMINAL`); lukket-flagget følger terminal status; rollback = forrige status." },
  "business.update_opportunity_stage": { status: "deferred", category: "sibling_of_covered", reason: "Samme form som `business.update_lead_status` (`inspect_opportunity` finnes og er allerede `preflight_action`; terminalreglene ligger i tjenesten). Første AUTH2b-tillegg." },
  "calendar.create_event": { status: "deferred", category: "no_live_write_transport", reason: "Live-transporten (`GoogleCalendarTransport`) støtter kun `read_events`/`list_events` og kaster `calendar_unsupported_action_create_event`: en adapter ville vært død kode. Krever først en skriveimplementasjon (connector-bygg, scope verifisert mot offisiell dokumentasjon, D-41) og deretter en adapter med readback via `list_events`." },
  "cloudflare.purge_cache": { status: "deferred", category: "no_readback_action", reason: "Cache-tilstand kan ikke leses og handlingen er ikke reverserbar (`reversible: false`); mål-autorisasjon (`parameterAuthorizer`) og step-up håndheves allerede av gatewayen. Ingen meningsfull før/etter-diff." },
  "comms.authorize_account": { status: "deferred", category: "internal_registration", reason: "Registrering i Jarvis' egen kontoregister (JARVIS_CANONICAL) med egen revisjon; `list_accounts` finnes. Ingen ekstern effekt å lese tilbake fra en leverandør." },
  "comms.contacts_create": { status: "deferred", category: "sibling_of_covered", reason: "Oppretter kontakt i Google Contacts; `contacts_get` finnes som readback. comms har egen policy/journal, så adapteren hører til comms-modulen. AUTH2b." },
  "comms.contacts_sync": { status: "deferred", category: "no_readback_action", reason: "Samlet synkronisering (flere kontakter): ingen enkelt målpost å lese tilbake; resultatet er et antall. Krever en egen sammendragskontroll." },
  "comms.contacts_unlink": { status: "deferred", category: "internal_registration", reason: "Fjerner Jarvis' kobling mellom kontakt og identitet (intern tilstand); ingen leverandøreffekt." },
  "comms.contacts_update": { status: "deferred", category: "sibling_of_covered", reason: "`contacts_get` finnes som readback (som `contacts_create`). AUTH2b." },
  "comms.decide_contact_conflict": { status: "deferred", category: "internal_registration", reason: "Eierens avgjørelse i en konflikt mellom kilder (intern tilstand, `list_contact_conflicts` leser)." },
  "comms.edit_message": { status: "deferred", category: "sibling_of_covered", reason: "`comms.get_message` finnes som readback og `check_message_target` er allerede `preflight_action`; comms har egen policy og journal, så adapteren hører til comms-modulen. AUTH2b." },
  "comms.meeting_confirm_participant": { status: "deferred", category: "internal_registration", reason: "Eierens bekreftelse av deltaker (intern tilstand, `meeting_get` leser)." },
  "comms.meeting_decide_commitment": { status: "deferred", category: "internal_registration", reason: "Eierens avgjørelse om en foreslått forpliktelse (intern tilstand, `meeting_commitments` leser)." },
  "comms.meeting_ingest_text": { status: "deferred", category: "internal_registration", reason: "Intern behandling av møtetekst til forslag (egen journal i comms); ingen ekstern leverandør." },
  "comms.revoke_account": { status: "owner_override", reason: "Eierens stopp-/kontrollhandling (pause, frys, tilbakekall): skal ALDRI kunne blokkeres eller forsinkes av en preflight/etterkontroll. Utelukket strukturelt (`class_c_adapter_forbidden`, `begin()` gir ingen kjøring); handlingen kjører som før." },
  "contract.set_status": { status: "deferred", category: "sibling_of_covered", reason: "Samme form som `growth.set_campaign_status`: tilstandsmaskin i tjenesten og `contract.get_contract` som readback. AUTH2b (adapter i kontraktmodulen)." },
  "discord.notify": { status: "deferred", category: "no_readback_action", reason: "Utgående melding uten lesing av levert melding (som `slack.notify`)." },
  "drive.create_file": { status: "covered", reason: "Adapter i `class-c-adapter-drive.ts`: forelder (`get_metadata`), readback av den opprettede filen; rollback = `drive.trash`." },
  "drive.create_folder": { status: "deferred", category: "sibling_of_covered", reason: "Samme form som `drive.create_file` (readback via `get_metadata` på returnert ID, mappetype, forelder): første AUTH2b-tillegg; ikke tatt med pga. taket på åtte handlinger i AUTH2a." },
  "drive.move": { status: "covered", reason: "Adapter i `class-c-adapter-drive.ts`: målmappen er en mappe; `parents` er nøyaktig målmappen; rollback = `drive.move` tilbake (kun én forelder)." },
  "drive.rename": { status: "covered", reason: "Adapter i `class-c-adapter-drive.ts`: navn endret, papirkurv/foreldre uendret; rollback = `drive.rename` tilbake." },
  "drive.trash": { status: "covered", reason: "Adapter i `class-c-adapter-drive.ts`: `trashed` sann, navn/foreldre uendret; rollback manuell (ingen registrert gjenopprettingshandling)." },
  "drive.update_content": { status: "covered", reason: "Adapter i `class-c-adapter-drive.ts`: revisjons-ID endret og lik transportens svar; uten revisjons-ID er effekten `unobservable` (unverified); rollback manuell (revisjonshistorikk)." },
  "executive.freeze_connector": { status: "owner_override", reason: "Eierens stopp-/kontrollhandling (pause, frys, tilbakekall): skal ALDRI kunne blokkeres eller forsinkes av en preflight/etterkontroll. Utelukket strukturelt (`class_c_adapter_forbidden`, `begin()` gir ingen kjøring); handlingen kjører som før." },
  "executive.pause_domain": { status: "owner_override", reason: "Eierens stopp-/kontrollhandling (pause, frys, tilbakekall): skal ALDRI kunne blokkeres eller forsinkes av en preflight/etterkontroll. Utelukket strukturelt (`class_c_adapter_forbidden`, `begin()` gir ingen kjøring); handlingen kjører som før." },
  "executive.record_evolution_decision": { status: "deferred", category: "internal_registration", reason: "Registrerer kun eierens avgjørelse i revisjonssporet (ingen virkning på endringsregisteret); revisjonen ER readback. Step-up håndheves." },
  "executive.restore_credential": { status: "owner_override", reason: "Eierens stopp-/kontrollhandling (pause, frys, tilbakekall): skal ALDRI kunne blokkeres eller forsinkes av en preflight/etterkontroll. Utelukket strukturelt (`class_c_adapter_forbidden`, `begin()` gir ingen kjøring); handlingen kjører som før." },
  "executive.resume_domain": { status: "owner_override", reason: "Eierens stopp-/kontrollhandling (pause, frys, tilbakekall): skal ALDRI kunne blokkeres eller forsinkes av en preflight/etterkontroll. Utelukket strukturelt (`class_c_adapter_forbidden`, `begin()` gir ingen kjøring); handlingen kjører som før." },
  "executive.revoke_autonomy_binding": { status: "owner_override", reason: "Eierens stopp-/kontrollhandling (pause, frys, tilbakekall): skal ALDRI kunne blokkeres eller forsinkes av en preflight/etterkontroll. Utelukket strukturelt (`class_c_adapter_forbidden`, `begin()` gir ingen kjøring); handlingen kjører som før." },
  "executive.revoke_credential": { status: "owner_override", reason: "Eierens stopp-/kontrollhandling (pause, frys, tilbakekall): skal ALDRI kunne blokkeres eller forsinkes av en preflight/etterkontroll. Utelukket strukturelt (`class_c_adapter_forbidden`, `begin()` gir ingen kjøring); handlingen kjører som før." },
  "executive.revoke_device": { status: "owner_override", reason: "Eierens stopp-/kontrollhandling (pause, frys, tilbakekall): skal ALDRI kunne blokkeres eller forsinkes av en preflight/etterkontroll. Utelukket strukturelt (`class_c_adapter_forbidden`, `begin()` gir ingen kjøring); handlingen kjører som før." },
  "executive.unfreeze_connector": { status: "owner_override", reason: "Eierens stopp-/kontrollhandling (pause, frys, tilbakekall): skal ALDRI kunne blokkeres eller forsinkes av en preflight/etterkontroll. Utelukket strukturelt (`class_c_adapter_forbidden`, `begin()` gir ingen kjøring); handlingen kjører som før." },
  "finance_neonomics.revoke_consent": { status: "deferred", category: "finance_owner_gated", reason: "Tilbakekall av banksamtykke (eier-/step-up-port); `get_consent` finnes, men leverandørens tilstand etter tilbakekall er uverifisert mot dokumentasjon. AUTH2b sammen med finanskjeden." },
  "finance_vipps.cancel_payment": { status: "deferred", category: "finance_owner_gated", reason: "Pengehandling bak eier-/step-up-port; leverandørtilstanden leses via finansmodulen (`get_capture`/`refresh_payment_state`), men semantikken (hva en avbrutt betaling viser) er uverifisert mot dokumentasjon. Dekkes sammen med finansens egen kjede i AUTH2b." },
  "finance_wallester.activate_card": { status: "deferred", category: "finance_owner_gated", reason: "Kortaktivering: `get_card` finnes; tilstandsnavn er uverifisert mot dokumentasjon. AUTH2b." },
  "finance_wallester.close_card": { status: "deferred", category: "finance_owner_gated", reason: "Kortlukking (`reversible: false`): `get_card` finnes; irreversibel; AUTH2b sammen med finanskjeden." },
  "finance_wallester.submit_card": { status: "deferred", category: "finance_owner_gated", reason: "Kortbestilling (betaling, `reversible: false`): readback via `get_card` finnes, men leverandørens tilstandsforløp er uverifisert. AUTH2b sammen med finanskjeden." },
  "finance_wallester.unfreeze_card": { status: "deferred", category: "finance_owner_gated", reason: "Opphev kortfrys: `get_card` finnes; tilstandsnavn er uverifisert. AUTH2b." },
  "finance_wallester.update_spend_policy": { status: "deferred", category: "finance_owner_gated", reason: "Endrer forbruksgrenser: `get_spend_policy` finnes og er det naturlige readback; felttolkningen er uverifisert mot dokumentasjon. AUTH2b." },
  "github.cancel_workflow_run": { status: "deferred", category: "async_effect", reason: "Asynkron avbrytelse (`get_workflow_run` viser fortsatt `in_progress` en stund). Krever pollestrategi med frist eller akseptert `unverified`-semantikk." },
  "github.comment_on_issue": { status: "deferred", category: "no_readback_action", reason: "Ingen lese-handling returnerer kommentarer (`get_pull_request`/`read_issues` har ikke kommentarlisten). Krever en ny lesehandling (GET issues/{n}/comments) og at kommentar-ID-en brukes som readback." },
  "github.create_pr": { status: "covered", reason: "Adapter i `class-c-adapter-github.ts`: head/base-branch (`get_branch`), åpne PR-er (`list_pull_requests`), readback `get_pull_request`; rollback = lukk PR (`github.update_pr`)." },
  "github.dispatch_workflow": { status: "deferred", category: "async_effect", reason: "Gir ingen kjøre-ID: den nye kjøringen kan ikke identifiseres umiddelbart (kun listing av kjøringer, racy). Krever en identifiserende korrelasjon (egen designbeslutning)." },
  "github.rerun_workflow_run": { status: "deferred", category: "async_effect", reason: "Effekten er asynkron: kjøringen starter etter at kallet returnerer, så en umiddelbar readback (`get_workflow_run`) viser ikke sluttilstanden. Krever en vente-/pollestrategi med frist (egen designbeslutning)." },
  "google_veo.generate_video": { status: "deferred", category: "async_effect", reason: "Betalt, asynkron videogenerering uten eksisterende lesing av jobbstatus." },
  "growth.conclude_experiment": { status: "deferred", category: "sibling_of_covered", reason: "Registrerer utfall og avslutter eksperimentet; `growth.get_experiment`/`get_experiment_report` kan brukes som readback. AUTH2b." },
  "growth.set_campaign_status": { status: "covered", reason: "Domene-adapter i `modules/growth/src/class-c-adapter.ts`: bruker den ekte tilstandsmaskinen (`canTransitionCampaign`) og `growth.get_campaign`; rollback = forrige status når tilstandsmaskinen tillater det." },
  "growth.set_experiment_status": { status: "deferred", category: "sibling_of_covered", reason: "Samme form som `growth.set_campaign_status` (`growth.get_experiment` + tilstandsmaskinen `EXPERIMENT_TRANSITIONS`). Første AUTH2b-tillegg i vekstmodulen." },
  "growth_ga4.create_key_event": { status: "existing_chain", reason: "WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`): fersk tilstandslesing (`preflight_action`), målvalidering, `preflight_validator`, `postcondition_predicate`, step-up og skrivejournal; transporten verifiserer og gir `outcome_unknown` ved avvik. Ikke berørt av AUTH2a." },
  "growth_gbp.update_location_hours": { status: "existing_chain", reason: "WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`): fersk tilstandslesing (`preflight_action`), målvalidering, `preflight_validator`, `postcondition_predicate`, step-up og skrivejournal; transporten verifiserer og gir `outcome_unknown` ved avvik. Ikke berørt av AUTH2a." },
  "growth_googleads.add_keywords": { status: "existing_chain", reason: "WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`): fersk tilstandslesing (`preflight_action`), målvalidering, `preflight_validator`, `postcondition_predicate`, step-up og skrivejournal; transporten verifiserer og gir `outcome_unknown` ved avvik. Ikke berørt av AUTH2a." },
  "growth_googleads.create_responsive_search_ad": { status: "existing_chain", reason: "WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`): fersk tilstandslesing (`preflight_action`), målvalidering, `preflight_validator`, `postcondition_predicate`, step-up og skrivejournal; transporten verifiserer og gir `outcome_unknown` ved avvik. Ikke berørt av AUTH2a." },
  "growth_googleads.enable_keyword": { status: "existing_chain", reason: "WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`): fersk tilstandslesing (`preflight_action`), målvalidering, `preflight_validator`, `postcondition_predicate`, step-up og skrivejournal; transporten verifiserer og gir `outcome_unknown` ved avvik. Ikke berørt av AUTH2a." },
  "growth_googleads.pause_ad": { status: "existing_chain", reason: "WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`): fersk tilstandslesing (`preflight_action`), målvalidering, `preflight_validator`, `postcondition_predicate`, step-up og skrivejournal; transporten verifiserer og gir `outcome_unknown` ved avvik. Ikke berørt av AUTH2a." },
  "growth_googleads.pause_ad_group": { status: "existing_chain", reason: "WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`): fersk tilstandslesing (`preflight_action`), målvalidering, `preflight_validator`, `postcondition_predicate`, step-up og skrivejournal; transporten verifiserer og gir `outcome_unknown` ved avvik. Ikke berørt av AUTH2a." },
  "growth_googleads.pause_campaign": { status: "existing_chain", reason: "WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`): fersk tilstandslesing (`preflight_action`), målvalidering, `preflight_validator`, `postcondition_predicate`, step-up og skrivejournal; transporten verifiserer og gir `outcome_unknown` ved avvik. Ikke berørt av AUTH2a." },
  "growth_googleads.pause_keyword": { status: "existing_chain", reason: "WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`): fersk tilstandslesing (`preflight_action`), målvalidering, `preflight_validator`, `postcondition_predicate`, step-up og skrivejournal; transporten verifiserer og gir `outcome_unknown` ved avvik. Ikke berørt av AUTH2a." },
  "growth_linkedin.pause_campaign": { status: "existing_chain", reason: "WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`): fersk tilstandslesing (`preflight_action`), målvalidering, `preflight_validator`, `postcondition_predicate`, step-up og skrivejournal; transporten verifiserer og gir `outcome_unknown` ved avvik. Ikke berørt av AUTH2a." },
  "growth_metaads.create_ad": { status: "existing_chain", reason: "WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`): fersk tilstandslesing (`preflight_action`), målvalidering, `preflight_validator`, `postcondition_predicate`, step-up og skrivejournal; transporten verifiserer og gir `outcome_unknown` ved avvik. Ikke berørt av AUTH2a." },
  "growth_metaads.pause_ad": { status: "existing_chain", reason: "WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`): fersk tilstandslesing (`preflight_action`), målvalidering, `preflight_validator`, `postcondition_predicate`, step-up og skrivejournal; transporten verifiserer og gir `outcome_unknown` ved avvik. Ikke berørt av AUTH2a." },
  "growth_metaads.pause_ad_set": { status: "existing_chain", reason: "WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`): fersk tilstandslesing (`preflight_action`), målvalidering, `preflight_validator`, `postcondition_predicate`, step-up og skrivejournal; transporten verifiserer og gir `outcome_unknown` ved avvik. Ikke berørt av AUTH2a." },
  "growth_metaads.pause_campaign": { status: "existing_chain", reason: "WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`): fersk tilstandslesing (`preflight_action`), målvalidering, `preflight_validator`, `postcondition_predicate`, step-up og skrivejournal; transporten verifiserer og gir `outcome_unknown` ved avvik. Ikke berørt av AUTH2a." },
  "growth_searchconsole.register_sitemap": { status: "existing_chain", reason: "WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`): fersk tilstandslesing (`preflight_action`), målvalidering, `preflight_validator`, `postcondition_predicate`, step-up og skrivejournal; transporten verifiserer og gir `outcome_unknown` ved avvik. Ikke berørt av AUTH2a." },
  "growth_tiktok.pause_campaign": { status: "existing_chain", reason: "WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`): fersk tilstandslesing (`preflight_action`), målvalidering, `preflight_validator`, `postcondition_predicate`, step-up og skrivejournal; transporten verifiserer og gir `outcome_unknown` ved avvik. Ikke berørt av AUTH2a." },
  "higgsfield.generate_video": { status: "deferred", category: "async_effect", reason: "Betalt, asynkron videogenerering uten eksisterende lesing av jobbstatus." },
  "kling.generate_video": { status: "deferred", category: "async_effect", reason: "Betalt, asynkron videogenerering uten eksisterende lesing av jobbstatus." },
  "make.run_scenario": { status: "deferred", category: "async_effect", reason: "Starter en kjøring hos leverandøren (asynkron, ikke-idempotent); ingen eksisterende lesing av kjøringsstatus." },
  "n8n.activate_workflow": { status: "deferred", category: "no_readback_action", reason: "Eneste lesing er `list_workflows`, som returnerer leverandørens rå kropp (ikke normalisert i repoet): en adapter ville bygge på en uverifisert responsform. Krever en normalisert `get_workflow`." },
  "n8n.deactivate_workflow": { status: "deferred", category: "no_readback_action", reason: "Som `n8n.activate_workflow`: kun `list_workflows` med rå leverandørform finnes som lesing, ingen normalisert `get_workflow`." },
  "openai_images.generate_image": { status: "deferred", category: "async_effect", reason: "Betalt generering; resultatet er en leverandørjobb uten eksisterende lesing av status. Pengeeffekt: avgjøres sammen med AUTH2b og økonomikjeden." },
  "operations.escalate_task": { status: "deferred", category: "sibling_of_covered", reason: "`operations.get_task` finnes som readback; eskalering er ikke reverserbar (`reversible: false`), så rollback blir manuell. AUTH2b." },
  "operations.set_status": { status: "deferred", category: "sibling_of_covered", reason: "Samme form som `growth.set_campaign_status` med `operations.get_task`/`get_vendor` som readback. AUTH2b." },
  "owner_controls.freeze_connector": { status: "owner_override", reason: "Eierens stopp-/kontrollhandling (pause, frys, tilbakekall): skal ALDRI kunne blokkeres eller forsinkes av en preflight/etterkontroll. Utelukket strukturelt (`class_c_adapter_forbidden`, `begin()` gir ingen kjøring); handlingen kjører som før." },
  "owner_controls.restore_credential": { status: "owner_override", reason: "Eierens stopp-/kontrollhandling (pause, frys, tilbakekall): skal ALDRI kunne blokkeres eller forsinkes av en preflight/etterkontroll. Utelukket strukturelt (`class_c_adapter_forbidden`, `begin()` gir ingen kjøring); handlingen kjører som før." },
  "owner_controls.revoke_credential": { status: "owner_override", reason: "Eierens stopp-/kontrollhandling (pause, frys, tilbakekall): skal ALDRI kunne blokkeres eller forsinkes av en preflight/etterkontroll. Utelukket strukturelt (`class_c_adapter_forbidden`, `begin()` gir ingen kjøring); handlingen kjører som før." },
  "owner_controls.revoke_device": { status: "owner_override", reason: "Eierens stopp-/kontrollhandling (pause, frys, tilbakekall): skal ALDRI kunne blokkeres eller forsinkes av en preflight/etterkontroll. Utelukket strukturelt (`class_c_adapter_forbidden`, `begin()` gir ingen kjøring); handlingen kjører som før." },
  "owner_controls.set_connector_credential": { status: "owner_override", reason: "Eierens stopp-/kontrollhandling (pause, frys, tilbakekall): skal ALDRI kunne blokkeres eller forsinkes av en preflight/etterkontroll. Utelukket strukturelt (`class_c_adapter_forbidden`, `begin()` gir ingen kjøring); handlingen kjører som før." },
  "owner_controls.unfreeze_connector": { status: "owner_override", reason: "Eierens stopp-/kontrollhandling (pause, frys, tilbakekall): skal ALDRI kunne blokkeres eller forsinkes av en preflight/etterkontroll. Utelukket strukturelt (`class_c_adapter_forbidden`, `begin()` gir ingen kjøring); handlingen kjører som før." },
  "product.set_status": { status: "deferred", category: "sibling_of_covered", reason: "Samme form som `growth.set_campaign_status` med `product.get_item` som readback. AUTH2b." },
  "runway.generate_video": { status: "deferred", category: "async_effect", reason: "Betalt, asynkron videogenerering uten eksisterende lesing av jobbstatus." },
  "situations.clear_autonomy_policy": { status: "deferred", category: "internal_registration", reason: "Fjerner eierens autonomi-binding (egen tilstand og revisjon); en innstramming, ingen ekstern effekt." },
  "situations.pause_all": { status: "owner_override", reason: "Eierens stopp-/kontrollhandling (pause, frys, tilbakekall): skal ALDRI kunne blokkeres eller forsinkes av en preflight/etterkontroll. Utelukket strukturelt (`class_c_adapter_forbidden`, `begin()` gir ingen kjøring); handlingen kjører som før." },
  "situations.pause_domain": { status: "owner_override", reason: "Eierens stopp-/kontrollhandling (pause, frys, tilbakekall): skal ALDRI kunne blokkeres eller forsinkes av en preflight/etterkontroll. Utelukket strukturelt (`class_c_adapter_forbidden`, `begin()` gir ingen kjøring); handlingen kjører som før." },
  "situations.release_stuck_act_claim": { status: "deferred", category: "internal_registration", reason: "Frigir en hengende ACT-reservasjon i Jarvis' egen situasjonsmotor; ingen ekstern effekt." },
  "situations.remove_subscription": { status: "deferred", category: "internal_registration", reason: "Jarvis' eget abonnementsregister med revisjon; ingen ekstern effekt." },
  "situations.reset_rule_tuning": { status: "deferred", category: "internal_registration", reason: "Jarvis' egen regelterskel (JARVIS_CANONICAL) med revisjon i tjenesten; `get_rule_tuning` leser." },
  "situations.set_autonomy_policy": { status: "deferred", category: "internal_registration", reason: "Eierens autonomi-binding (Jarvis' egen tilstand, egen vakt og revisjon: WP-G4b); ingen ekstern effekt." },
  "situations.set_critical_quiet_bypass": { status: "deferred", category: "internal_registration", reason: "Jarvis' egen varslingspolicy med revisjon; ingen ekstern effekt." },
  "situations.set_notification_policy": { status: "deferred", category: "internal_registration", reason: "Jarvis' egen varslingspolicy med revisjon; ingen ekstern effekt." },
  "situations.set_subscription_enabled": { status: "deferred", category: "internal_registration", reason: "Jarvis' eget abonnementsregister med revisjon; ingen ekstern effekt." },
  "situations.subscribe": { status: "deferred", category: "internal_registration", reason: "Jarvis' eget abonnementsregister med revisjon; ingen ekstern effekt." },
  "situations.unpause_all": { status: "owner_override", reason: "Eierens stopp-/kontrollhandling (pause, frys, tilbakekall): skal ALDRI kunne blokkeres eller forsinkes av en preflight/etterkontroll. Utelukket strukturelt (`class_c_adapter_forbidden`, `begin()` gir ingen kjøring); handlingen kjører som før." },
  "situations.unpause_domain": { status: "owner_override", reason: "Eierens stopp-/kontrollhandling (pause, frys, tilbakekall): skal ALDRI kunne blokkeres eller forsinkes av en preflight/etterkontroll. Utelukket strukturelt (`class_c_adapter_forbidden`, `begin()` gir ingen kjøring); handlingen kjører som før." },
  "slack.notify": { status: "deferred", category: "no_readback_action", reason: "Utgående melding: ingen eksisterende lesing av levert melding (`comms.get_message` finnes bare i comms-flaten). Mottaker-/avmeldingsvakt finnes (`guardLegacyNotifyTransport`). Krever lesehandling mot meldings-ID." },
  "support.reply": { status: "deferred", category: "no_readback_action", reason: "Svaret sendes via nøstet `email.send` (klasse D `outbound_message` med egen kjede og varsling); `support.get_ticket` viser ikke sendt melding. Dekkes av klasse D-kjeden for selve utsendelsen." },
  "telnyx.notify": { status: "deferred", category: "no_readback_action", reason: "Utgående, betalt SMS uten lesing av levert melding (som `twilio.notify`)." },
  "twilio.notify": { status: "deferred", category: "no_readback_action", reason: "Utgående, betalt SMS uten lesing av levert melding; mottaker valideres i transporten (E.164). Krever lesehandling mot meldings-SID." },
  "vercel.promote_deployment": { status: "deferred", category: "effect_not_observable", reason: "Ingen eksisterende lesing viser hvilken deployment som er produksjon (`read_deployment` gir deploymentens `target`, ikke alias-/produksjonspekeren). Å påstå verifisering ville vært en udokumentert leverandørantakelse. Krever en ny lesehandling for produksjonspekeren (offisiell Vercel-dokumentasjon)." },
  "vercel.rollback_deployment": { status: "deferred", category: "effect_not_observable", reason: "Som `vercel.promote_deployment`: produksjonspekeren kan ikke leses med eksisterende handlinger, så det som skal bekreftes (hvilken deployment som nå er produksjon) er uobserverbart. Krever ny lesehandling." },
  "vercel.upsert_env": { status: "deferred", category: "effect_not_observable", reason: "`list_env` viser nøkkel, mål og type, aldri verdi: selve endringen kan ikke leses tilbake. En delvis verifisering (nøkkel + mål) er teknisk mulig via `unobservable`-mekanismen, men eieren må avgjøre om delvis dekning er akseptabel (ellers misvisende «verifisert»)." },
  "whatsapp.notify": { status: "deferred", category: "no_readback_action", reason: "Utgående melding uten lesing av levert melding (som `twilio.notify`)." }
};

/** Har handlingen en egen, full kjede som gjør klasse C-pipelinen overflødig (WP-D3-mønsteret: fersk lesing + validator + etterbetingelse + step-up)? */
export function hasOwnFullChain(def: Pick<ToolDefinition, "preflight_action" | "preflight_requires_target" | "preflight_validator" | "postcondition_predicate" | "postcondition_target_absent" | "step_up_required" | "owner_only">): boolean {
  return def.preflight_action !== undefined && def.preflight_requires_target === true && typeof def.preflight_validator === "function"
    && (typeof def.postcondition_predicate === "function" || def.postcondition_target_absent === true) && def.step_up_required === true && def.owner_only === true;
}

const REASON_MIN_CHARS = 40;

/**
 * Deterministisk vurdering av dekningstabellen mot de FAKTISKE definisjonene og adapterne. Tom liste = konsistent. Brukes av vakten (og er selv mutasjonstestet der).
 * `adapterKeys` = nøklene (`tool_id.action`) til alle registrerte adaptere (tool-gateway + domenemodulene).
 */
export function assessClassCCoverage(
  definitions: ReadonlyArray<ToolDefinition>,
  adapterKeys: ReadonlyArray<string>,
  coverage: Readonly<Record<string, ClassCCoverageEntry>> = CLASS_C_COVERAGE
): string[] {
  const violations: string[] = [];
  const classC = definitions.filter((d) => d.capability_class === "C");
  const known = new Map(classC.map((d) => [`${d.tool_id}.${d.action}`, d]));
  const adapters = new Set(adapterKeys);
  for (const [key, def] of known) {
    const entry = coverage[key];
    if (entry === undefined) {
      violations.push(`${key}: ny klasse C-handling uten dekningsstilling (legg den til i CLASS_C_COVERAGE: covered/existing_chain/owner_override/deferred)`);
      continue;
    }
    const hasAdapter = adapters.has(key);
    if (entry.status === "covered" && !hasAdapter) violations.push(`${key}: erklært covered uten registrert adapter`);
    if (entry.status !== "covered" && hasAdapter) violations.push(`${key}: har en registrert adapter men står som ${entry.status}`);
    if (entry.status === "owner_override" && !isClassCOwnerOverride(def)) violations.push(`${key}: erklært owner_override, men pipelinen behandler den ikke som eierens kontrollhandling (CLASS_C_OWNER_OVERRIDE_ACTIONS)`);
    if (entry.status !== "owner_override" && isClassCOwnerOverride(def)) violations.push(`${key}: er eierens kontrollhandling i pipelinen, men står som ${entry.status} (må være owner_override)`);
    if (entry.status === "existing_chain" && !hasOwnFullChain(def)) violations.push(`${key}: erklært existing_chain, men definisjonen har ikke lenger hele kjeden (preflight_action, krav om mål, validator, etterbetingelse, step-up, eier-kun)`);
    if (entry.status === "deferred" && entry.category === undefined) violations.push(`${key}: deferred uten kategori`);
    if (entry.status !== "deferred" && entry.category !== undefined) violations.push(`${key}: kategori er kun tillatt for deferred`);
    if (entry.reason.trim().length < REASON_MIN_CHARS) violations.push(`${key}: begrunnelsen er for kort (minst ${REASON_MIN_CHARS} tegn)`);
  }
  for (const key of Object.keys(coverage)) if (!known.has(key)) violations.push(`${key}: står i CLASS_C_COVERAGE, men finnes ikke som klasse C-handling i produksjonsregisteret (foreldet oppføring)`);
  for (const key of adapterKeys) if (!known.has(key)) violations.push(`${key}: adapter for en handling som ikke er klasse C i produksjonsregisteret`);
  return violations;
}
