import type { ValueMetricDef } from "./types.ts";

/**
 * WP-C4: Value Center-katalogen. HVER metrikk har en fast id, en norsk etikett, en enhet og en NAVNGITT kilde (tabell). Kilden er enten en lesbar tabell eller `never_measurable_reason_no`: det som Jarvis ikke har
 * noe grunnlag for å måle står i rapporten med årsak - aldri som 0. Rekkefølgen er visningsrekkefølgen. Definisjonene (`note_no`) sier hva tallet faktisk teller, så «dager», «turer» og «levert» ikke kan misforstås.
 * Ingen metrikk leser innhold (meldingstekst, titler, mål, årsaker): kun antall, tidsstempler og aggregater.
 */
export const VALUE_METRIC_CATALOG: readonly ValueMetricDef[] = [
  // ---- V1 Daily Executive Brief -------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    id: "v1.briefs_generated", group: "V1", label_no: "Daily Brief generert", unit: "count", shape: "window", source: "cost_events (kind=brief:generation)",
    note_no: "Hver generering (planlagt morgenlevering og på forespørsel) gir én rad."
  },
  {
    id: "v1.briefs_delivered", group: "V1", label_no: "Daily Brief levert på Telegram", unit: "count", shape: "window", source: "tool_executions (telegram.notify, nøkkel brief-…-0, status=succeeded)",
    note_no: "Levert = første del er sendt og bekreftet av Telegram; en flerdelt brief telles én gang. Brief hentet på forespørsel i chat teller ikke."
  },
  {
    id: "v1.days_with_brief", group: "V1", label_no: "Døgn med Daily Brief generert", unit: "days", shape: "window", source: "cost_events (kind=brief:generation)",
    note_no: "Lokale døgn (Europe/Oslo) med minst én generering."
  },
  {
    id: "v1.runner_days_completed", group: "V1", label_no: "Daglig løper: døgn fullført", unit: "days", shape: "window", source: "scheduler_state (job daily-brief)",
    note_no: "Den daglige løperen er én delt tabell uten tenant-RLS (én løper for eieren)."
  },
  {
    id: "v1.runner_days_lost", group: "V1", label_no: "Daglig løper: døgn tapt (aldri fullført)", unit: "days", shape: "window", source: "scheduler_state (job daily-brief)",
    note_no: "Påbegynt men ikke fullført for en tidligere dato (ga opp eller krasjet). I dag telles ikke."
  },
  {
    id: "v1.runner_retry_days", group: "V1", label_no: "Daglig løper: døgn som trengte nytt forsøk", unit: "days", shape: "window", source: "scheduler_state (job daily-brief)",
    note_no: "Døgn der første forsøk feilet og et nytt ble gjort (forsøk > 1)."
  },
  {
    id: "v1.opened_or_answered", group: "V1", label_no: "Daily Brief åpnet eller besvart", unit: "count", shape: "window", source: "-",
    never_measurable_reason_no: "Telegram gir ingen lesekvittering, og ingen åpnet-/besvart-sporing er bygget"
  },

  // ---- V2 Unified Follow-up -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { id: "v2.followups_open_now", group: "V2", label_no: "Åpne oppfølginger", unit: "count", shape: "snapshot", source: "business_followups (status=open)", note_no: "Alle rom unntatt helse og gjest." },
  { id: "v2.followups_overdue_now", group: "V2", label_no: "Åpne oppfølginger som er forfalt", unit: "count", shape: "snapshot", source: "business_followups (status=open, due_at passert)" },
  {
    id: "v2.followups_avg_open_age_days", group: "V2", label_no: "Gjennomsnittlig alder på åpne oppfølginger (døgn)", unit: "days", shape: "snapshot", source: "business_followups (created_at)",
    note_no: "Uten åpne oppfølginger er det ingen grunnlag (ikke 0)."
  },
  {
    id: "v2.followups_max_overdue_days", group: "V2", label_no: "Lengst forfalte oppfølging (døgn)", unit: "days", shape: "snapshot", source: "business_followups (due_at)",
    note_no: "Uten forfalte oppfølginger er det ingen grunnlag (ikke 0)."
  },
  { id: "v2.followups_created", group: "V2", label_no: "Oppfølginger opprettet", unit: "count", shape: "window", source: "business_followups (created_at)" },
  { id: "v2.followups_closed", group: "V2", label_no: "Oppfølginger fullført", unit: "count", shape: "window", source: "business_followups (status=completed, completed_at)" },
  { id: "v2.followups_cancelled", group: "V2", label_no: "Oppfølginger avbrutt", unit: "count", shape: "window", source: "business_followups (status=cancelled, cancelled_at)" },
  { id: "v2.open_loops_open_now", group: "V2", label_no: "Åpne løkker (automatisk oppdaget)", unit: "count", shape: "snapshot", source: "business_open_loops (status=open)" },
  { id: "v2.open_loops_overdue_now", group: "V2", label_no: "Åpne løkker som er forfalt", unit: "count", shape: "snapshot", source: "business_open_loops (status=open, due_at passert)" },
  { id: "v2.open_loops_resolved", group: "V2", label_no: "Løkker løst", unit: "count", shape: "window", source: "business_open_loops (status=resolved, resolved_at)" },
  {
    id: "v2.reminders_sent", group: "V2", label_no: "Påminnelser sendt (push)", unit: "count", shape: "window", source: "audit_events (type=followup.push_sent)",
    note_no: "Antall oppfølginger det er varslet om. Push er av som standard, så 0 er da forventet - kilden er lesbar, tallet er sant."
  },
  { id: "v2.reminder_messages_sent", group: "V2", label_no: "Påminnelsesmeldinger sendt (push)", unit: "count", shape: "window", source: "audit_events (type=followup.push_sent)" },

  // ---- Jobber -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { id: "tasks.created", group: "tasks", label_no: "Jobber opprettet", unit: "count", shape: "window", source: "tasks (created_at)" },
  { id: "tasks.completed", group: "tasks", label_no: "Jobber fullført", unit: "count", shape: "window", source: "tasks (status=completed, finished_at)" },
  { id: "tasks.failed", group: "tasks", label_no: "Jobber feilet", unit: "count", shape: "window", source: "tasks (status=failed, finished_at)" },
  {
    id: "tasks.completion_rate", group: "tasks", label_no: "Andel fullført av avsluttede jobber", unit: "ratio", shape: "window", source: "avledet av tasks.completed og tasks.failed",
    derive: { num: "tasks.completed", den: ["tasks.completed", "tasks.failed"] }
  },
  { id: "tasks.open_now", group: "tasks", label_no: "Jobber åpne nå (opprettet, kjører eller pauset)", unit: "count", shape: "snapshot", source: "tasks (status)" },
  {
    id: "tasks.cost_ore", group: "tasks", label_no: "Modellkost for jobber", unit: "ore", shape: "window", source: "cost_events (task_id satt)",
    note_no: "Kun modellkost. Connector-/API-kostnader er ikke i cost_events."
  },
  {
    id: "tasks.time_saved", group: "tasks", label_no: "Spart tid", unit: "seconds", shape: "window", source: "-",
    never_measurable_reason_no: "ingen tidsestimat registreres per jobb eller svar"
  },

  // ---- Samtaler -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    id: "chat.user_messages", group: "chat", label_no: "Meldinger fra deg (turer)", unit: "count", shape: "window", source: "messages (role=user)",
    note_no: "Alle kanaler (chat, tale, Telegram). Hurtigbane-kommandoer uten modell telles også."
  },
  { id: "chat.sessions", group: "chat", label_no: "Samtaler (økter) med minst én melding fra deg", unit: "count", shape: "window", source: "messages (distinkte session_id)" },
  { id: "chat.active_days", group: "chat", label_no: "Døgn med bruk (minst én melding fra deg)", unit: "days", shape: "window", source: "messages (role=user, lokale døgn Europe/Oslo)" },
  {
    id: "chat.model_calls", group: "chat", label_no: "Chat-modellkall (vellykkede)", unit: "count", shape: "window", source: "cost_events (purpose=CHAT, success)",
    note_no: "Én tur kan gi flere kall (verktøyrunder). Hurtigbane-kommandoer bruker ingen modell og er ikke med."
  },
  { id: "chat.tool_requesting_calls", group: "chat", label_no: "Chat-modellkall som ba om verktøy", unit: "count", shape: "window", source: "cost_events (purpose=CHAT, tool_calls > 0)" },
  {
    id: "chat.tool_call_share", group: "chat", label_no: "Andel chat-kall som ba om verktøy", unit: "ratio", shape: "window", source: "avledet av chat.tool_requesting_calls og chat.model_calls",
    note_no: "Kall-nivå, ikke tur-nivå: en verktøytur består av flere modellkall.",
    derive: { num: "chat.tool_requesting_calls", den: ["chat.model_calls"] }
  },
  {
    id: "chat.owner_corrections", group: "chat", label_no: "Korrigeringer fra deg", unit: "count", shape: "window", source: "-",
    never_measurable_reason_no: "korrigeringer registreres ikke som egen hendelse"
  },

  // ---- Godkjenninger og bekreftelser --------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { id: "approvals.confirmations_requested", group: "approvals", label_no: "Bekreftelser forespurt", unit: "count", shape: "window", source: "action_confirmations (created_at)" },
  { id: "approvals.confirmations_approved", group: "approvals", label_no: "Bekreftelser godkjent", unit: "count", shape: "window", source: "action_confirmations (status approved/consumed, decided_at)" },
  { id: "approvals.confirmations_rejected", group: "approvals", label_no: "Bekreftelser avvist", unit: "count", shape: "window", source: "action_confirmations (status=rejected, decided_at)" },
  {
    id: "approvals.confirmations_expired", group: "approvals", label_no: "Bekreftelser utløpt uten svar", unit: "count", shape: "window", source: "action_confirmations (expired, eller pending etter utløp)",
    note_no: "Forespurt i vinduet og ikke avgjort innen utløpstiden (5 minutter)."
  },
  {
    id: "approvals.approval_rate", group: "approvals", label_no: "Andel godkjent av avgjorte bekreftelser", unit: "ratio", shape: "window", source: "avledet av godkjent og avvist",
    derive: { num: "approvals.confirmations_approved", den: ["approvals.confirmations_approved", "approvals.confirmations_rejected"] }
  },
  {
    id: "approvals.avg_response_seconds", group: "approvals", label_no: "Gjennomsnittlig svartid på bekreftelser", unit: "seconds", shape: "window", source: "action_confirmations (decided_at - created_at)",
    note_no: "Kun avgjorte bekreftelser. Uten avgjorte er det ingen grunnlag (ikke 0)."
  },
  { id: "approvals.signed_used", group: "approvals", label_no: "Signerte godkjenninger brukt (klasse D)", unit: "count", shape: "window", source: "approvals (consumed_at)" },

  // ---- Kost ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    id: "cost.model_total_ore", group: "cost", label_no: "Modellkost totalt", unit: "ore", shape: "window", source: "cost_events (amount_ore)",
    note_no: "STT/TTS og connector-/API-kostnader er ikke i cost_events (se run-rate-rapporten)."
  },
  {
    id: "cost.per_completed_task_ore", group: "cost", label_no: "Modellkost per fullført jobb", unit: "ore", shape: "window", source: "avledet av tasks.cost_ore og tasks.completed",
    derive: { num: "tasks.cost_ore", den: ["tasks.completed"] }
  },

  // ---- Drift (øyeblikksbilder som også styrer V3/V5) ----------------------------------------------------------------------------------------------------------------------------------------------------
  { id: "ops.incidents_open_now", group: "ops", label_no: "Åpne hendelser", unit: "count", shape: "snapshot", source: "incidents (ikke løst)", note_no: "Alle rom unntatt helse og gjest." },
  {
    id: "ops.tasks_waiting_over_15m_now", group: "ops", label_no: "Jobber som har ventet over 15 min i kø", unit: "count", shape: "snapshot", source: "tasks (status=created, klar til å hentes)",
    note_no: "Kø-stau: opprettet for over 15 min siden og ikke utsatt av en venteregel."
  }
];

/** Faste punkter som alltid står i `not_measured` (uavhengig av om kildene svarer). */
export const VALUE_NOT_MEASURED_STATIC: readonly string[] = [
  "Spart tid er ikke målt: ingen tidsestimat registreres per jobb eller svar",
  "Eierens korrigeringer av svar er ikke registrert som egen hendelse",
  "Om Daily Brief ble åpnet eller besvart er ikke målt (Telegram gir ingen lesekvittering)",
  "Hurtigbane-kommandoer (uten modell) telles som meldinger, ikke som egne modellkall; andelen verktøykall er på modellkall-nivå, ikke tur-nivå",
  "Stemmekostnad (STT/TTS) og connector-/API-kostnader er ikke i kostnadstallene (jf. run-rate-rapporten)",
  "V4 Business Operating Loop har ingen metrikk ennå (venter Business-tenant, Q-48)"
];
