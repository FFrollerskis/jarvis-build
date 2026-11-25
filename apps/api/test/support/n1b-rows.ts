import { FIN, IDENTITY_ID, KEEP, LOOP_IDS, TENANT } from "./n1b-finance-world.ts";

/**
 * WP-N1b (K2): KARTLEGGINGSTABELLEN - hver sti en modell kan kalle der finansavledet innhold kan bæres uten å være et `finance*`-verktøy. Samlet her (uten testbeskrivelser) slik at både tabelltesten
 * (`wpn1b-finance-derived-table.test.ts`, som kjører hver rad mot den ekte koden) og struktur-/klassifiseringstesten (`wpn1b-structure.test.ts`, som sjekker at hver håndterte handling HAR en rad) leser den ene kilden.
 */
export interface Row {
  id: string;
  path: string;
  tool: string;
  action: string;
  params?: Record<string, unknown>;
  /** Markører som finnes i det FULLE svaret og aldri skal nå en sky-/ukjent modell. */
  finance: string[];
  /** Markører (vanlig innhold) som skal være der for ALLE. */
  keep?: string[];
  /** Svaret til sky/ukjent har det nøytrale merket (`finance_withheld: true` eller `withheld: true`). */
  marker?: "finance_withheld" | "withheld";
}

const FIN_LOOP_TYPES = ["finance_spend_unexpected", "payment_intent_anomaly", "bank_consent_attention", "marketing_spend_anomaly"];
const LOOP_FINANCE = [FIN.spendCategory, FIN.spendId, FIN.purpose, FIN.vendor, FIN.amount, FIN.bankConsent, FIN.campaign, ...FIN_LOOP_TYPES, LOOP_IDS.fin1, LOOP_IDS.fin2, LOOP_IDS.fin3, LOOP_IDS.fin4];
const LOOP_KEEP = [KEEP.followup, KEEP.ticket, LOOP_IDS.ok1, LOOP_IDS.ok2];

export const ROWS: Row[] = [
  // --- forretnings-OS: åpne løkker (`finance_spend_*`, `payment_intent_*`, bank, kort, markedsutgift) bærer beløp, leverandør, formål og id-er
  { id: "R01", path: "business.list_open_loops", tool: "business", action: "list_open_loops", params: { tenant_id: TENANT }, finance: LOOP_FINANCE, keep: LOOP_KEEP, marker: "finance_withheld" },
  { id: "R02", path: "business.read_open_loop (finansløkke)", tool: "business", action: "read_open_loop", params: { tenant_id: TENANT, open_loop_id: LOOP_IDS.fin2 }, finance: [FIN.purpose, FIN.vendor, FIN.amount, "payment_intent_anomaly"], marker: "finance_withheld" },
  { id: "R03", path: "business.get_attention_queue", tool: "business", action: "get_attention_queue", params: { tenant_id: TENANT }, finance: LOOP_FINANCE, keep: LOOP_KEEP, marker: "finance_withheld" },
  // Dagsbriefen viser kun de tre høyest prioriterte + de med score >= 70 (`DailyBrief`): av finansløkkene er det fin1/fin2 som kommer med i det FULLE svaret; for sky-svaret rykker de vanlige løkkene opp (egen test under).
  { id: "R04", path: "business.get_business_brief (daglig)", tool: "business", action: "get_business_brief", params: { tenant_id: TENANT, period: "daily" }, finance: [FIN.spendCategory, FIN.spendId, FIN.purpose, FIN.vendor, FIN.amount, LOOP_IDS.fin1, LOOP_IDS.fin2], keep: [KEEP.ticket], marker: "finance_withheld" },
  { id: "R05", path: "business.get_business_brief (ukentlig)", tool: "business", action: "get_business_brief", params: { tenant_id: TENANT, period: "weekly" }, finance: [...FIN_LOOP_TYPES, "payment_intent_reconciliation_mismatch"], keep: ["overdue_followup", "support_ticket_overdue"], marker: "finance_withheld" },
  { id: "R06", path: "business.get_calibration_report", tool: "business", action: "get_calibration_report", params: { tenant_id: TENANT }, finance: ["finance_spend_unexpected", "payment_intent_anomaly", "payment_intent_reconciliation_mismatch", "bank_consent_attention", "marketing_spend_anomaly"], keep: ["overdue_followup", "support_ticket_overdue"], marker: "finance_withheld" },
  // --- executive: oppmerksomhetskø (situasjoner i `spend`-domenet bærer løkkens begrunnelse), status, kontrollflate
  { id: "R07", path: "executive.get_attention_queue", tool: "executive", action: "get_attention_queue", params: {}, finance: [FIN.amount, FIN.spendCategory, FIN.spendId, FIN.driftCost, "sit-spend-1", "sit-spend-2"], keep: [KEEP.followup, KEEP.ticket, "sit-pipe-1"], marker: "finance_withheld" },
  { id: "R08", path: "executive.get_attention_item (spend)", tool: "executive", action: "get_attention_item", params: { situation_id: "sit-spend-1" }, finance: [FIN.amount, FIN.spendCategory, FIN.spendId, FIN.vendor, "sit-spend-1"], marker: "finance_withheld" },
  { id: "R09", path: "executive.get_capability_status", tool: "executive", action: "get_capability_status", params: {}, finance: ["finance_stripe", "N1B-HEALTH-DETAIL", "get_balance"], keep: ["business"], marker: "finance_withheld" },
  { id: "R10", path: "executive.get_connector_status", tool: "executive", action: "get_connector_status", params: {}, finance: ["Fiken", "Stripe", "Vipps", "Neonomics", "Wallester", "JARVIS_STRIPE_SECRET_KEY", "JARVIS_NEONOMICS_DEVICE_ID", "JARVIS_VIPPS_MSN"], keep: ["GitHub"], marker: "finance_withheld" },
  { id: "R11", path: "executive.get_control_surface_status (owner_control)", tool: "executive", action: "get_control_surface_status", params: {}, finance: [FIN.killReason, FIN.frozenReason, "stripe", "finance_vipps", "JARVIS_VIPPS_CLIENT_SECRET", "spend"], keep: ["github", "JARVIS_GITHUB_TOKEN", "pipeline"], marker: "finance_withheld" },
  { id: "R12", path: "executive.get_delegation_board", tool: "executive", action: "get_delegation_board", params: {}, finance: [FIN.policyParam, "finance_spend", FIN.killReason, FIN.frozenReason, "stripe", "finance_vipps", "JARVIS_VIPPS_CLIENT_SECRET"], keep: ["create_followup", "github"], marker: "finance_withheld" },
  // --- AI-kost i øre (Q-64 pkt 1: strengeste regel, SECRET_RESTRICTED til eieren har svart)
  { id: "R15", path: "executive.get_value_report", tool: "executive", action: "get_value_report", params: {}, finance: [FIN.costOre, "tasks.cost_ore", "cost.model_total_ore"], marker: "finance_withheld" },
  { id: "R17", path: "executive.get_slo_report (kostnadsdrift)", tool: "executive", action: "get_slo_report", params: {}, finance: [FIN.driftCost, "cost_per_call_ore", "Kostnad per kall"], keep: ["p95-latens økte fra 800 til 1500 ms", "Chat: første token"], marker: "finance_withheld" },
  { id: "R18", path: "executive.get_self_diagnosis", tool: "executive", action: "get_self_diagnosis", params: {}, finance: [FIN.jobFailure, FIN.driftCost, "Stripe er nede"], marker: "finance_withheld" },
  { id: "R19", path: "executive.get_ai_mesh_status", tool: "executive", action: "get_ai_mesh_status", params: {}, finance: [FIN.meshCost, "cost_ore"], marker: "finance_withheld" },
  { id: "R20", path: "executive.get_evolution_report", tool: "executive", action: "get_evolution_report", params: {}, finance: [FIN.evolutionCost, FIN.costOre], marker: "finance_withheld" },
  { id: "R16", path: "run_rate.get_cost_overview", tool: "run_rate", action: "get_cost_overview", params: {}, finance: ["77123", "last_7d_ore", "by_provider"], marker: "finance_withheld" },
  { id: "R22", path: "run_rate.list_connector_maintenance", tool: "run_rate", action: "list_connector_maintenance", params: {}, finance: ["stripe", "N1B-VEDLIKEHOLD-STRIPE", "neonomics"], keep: ["github", "N1B-VEDLIKEHOLD-GITHUB"], marker: "finance_withheld" },
  // --- samtalegrafen: tverr-kanal-lesningene leser `business_open_loops` UTEN typefilter (tenant-bred modus tar med forpliktelser uten motpart, og identitetsvisningen alle kontaktens løkker)
  { id: "R21a", path: "conversation_graph.read_cross_channel_attention", tool: "conversation_graph", action: "read_cross_channel_attention", params: {}, finance: LOOP_FINANCE, keep: LOOP_KEEP, marker: "finance_withheld" },
  { id: "R21b", path: "conversation_graph.read_cross_channel_commitment_view", tool: "conversation_graph", action: "read_cross_channel_commitment_view", params: { identity_id: IDENTITY_ID }, finance: [FIN.spendCategory, FIN.spendId, FIN.purpose, FIN.vendor, FIN.amount, "finance_spend_unexpected", "payment_intent_anomaly", LOOP_IDS.fin1, LOOP_IDS.fin2], keep: [KEEP.followup, LOOP_IDS.ok1, IDENTITY_ID], marker: "finance_withheld" },
];

/** Kontrollsentrene som holdes tilbake HELT fra sky/ukjent kun med vakten på (`GUARDED_CLOUD_WITHHELD_CENTERS`) - via `get_control_center {center}` (R13, R14, R14b; R23 er oversikten). `finance` = markører som ikke skal nå skyen. */
export const CENTER_ROWS: Array<{ id: string; center: string; finance: string[] }> = [
  { id: "R13", center: "authority", finance: ["Finans-nødbryter", "finance_kill_switch"] },
  { id: "R14", center: "integration", finance: ["Stripe", "Neonomics", "Fiken", "Vipps", "Wallester", "stripe-payment-sync"] },
  { id: "R14b", center: "ai", finance: ["77123", "771,23"] }
];
