/**
 * UA-7 Communications Hub - foerste slice (D-119): Conversation Graph +
 * confidence-basert, reversibel identitetsopploesning. Se
 * `046_conversation_graph.sql` for full arkitekturbegrunnelse
 * (D-64 Core-vs-Adapter, reuse-audit).
 */

// D-121: `AttentionBucket` er GJENBRUKT uendret fra `@jarvis/business` -
// prioriterings-taksonomien har ETT hjem (open-loop-types.ts), aldri en
// nesten-lik kopi her.
import type { AttentionBucket } from "@jarvis/business";

export type ConversationIdentityStatus = "active" | "merged";
/**
 * WP-G1 (D-463, migrasjon 117): kanalene er utvidet fra `email`/`telegram` til alle UA-7-kanalene. Hver kanal har SIN egen eksakte normalisering (se `normalize.ts`) - aldri fuzzy-matching,
 * aldri et gjettet landnummer. `CONVERSATION_CHANNELS` er den ENE listen (speilet av CHECK-en i 117; låst av test), slik at en ny kanal aldri kan legges til i bare ett av stedene.
 */
export const CONVERSATION_CHANNELS = ["email", "telegram", "slack", "discord", "whatsapp", "sms", "teams", "messenger", "instagram", "phone"] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];
/** Kanaler der identifikatoren ER et telefonnummer (E.164): eksakt treff på tvers av disse gir samme person (`resolveIdentityByPhone`). */
export const PHONE_CHANNELS = ["phone", "sms", "whatsapp"] as const satisfies readonly ConversationChannel[];
export type ChannelLinkStatus = "active" | "revoked";
/**
 * `exact_phone_e164` = nøyaktig samme E.164-nummer; `exact_handle` = nøyaktig samme kanal-spesifikke bruker-id (Slack/Discord/Teams/Messenger/Instagram);
 * `contact_sync` = lenken kommer fra en kontaktsynk (Google People) der leverandøren selv knytter nummeret/e-posten til kontakten. Alle tre er deterministiske kilder -
 * en modell kan aldri velge en av dem (verktøyflaten er skrivebeskyttet, D-119).
 */
export type ChannelLinkMatchMethod = "exact_email" | "owner_configured" | "manual" | "exact_phone_e164" | "exact_handle" | "contact_sync";
export type MergeAction = "merge" | "split";
export type MergePerformedBy = "owner" | "deterministic_rule";

export interface ConversationIdentity {
  identity_id: string;
  tenant_id: string;
  memory_space_id: string;
  display_name: string | null;
  linked_business_contact_id: string | null;
  linked_person_id: string | null;
  status: ConversationIdentityStatus;
  merged_into_identity_id: string | null;
  created_by_person_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationChannelLink {
  link_id: string;
  tenant_id: string;
  memory_space_id: string;
  identity_id: string;
  channel: ConversationChannel;
  channel_identifier: string;
  confidence: number;
  match_method: ChannelLinkMatchMethod;
  source_type: string | null;
  source_instance_id: string | null;
  external_id: string | null;
  status: ChannelLinkStatus;
  created_by_person_id: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export interface ConversationIdentityMerge {
  merge_id: string;
  tenant_id: string;
  memory_space_id: string;
  action: MergeAction;
  source_identity_id: string;
  target_identity_id: string;
  reverses_merge_id: string | null;
  affected_link_ids: string[];
  confidence: number;
  reason: string;
  performed_by: MergePerformedBy;
  created_by_person_id: string | null;
  created_at: string;
}

export interface LinkChannelIdentityInput {
  identity_id?: string;
  channel: ConversationChannel;
  channel_identifier: string;
  confidence: number;
  match_method: ChannelLinkMatchMethod;
  source_type?: string;
  source_instance_id?: string;
  external_id?: string;
  display_name?: string;
  linked_business_contact_id?: string;
  linked_person_id?: string;
  created_by_person_id?: string;
}

/**
 * WP-G1 fiks-runde 2 (B-H1 rest): inndata til `linkExclusiveIdentifiers` - ÉN kilde (f.eks. én Google-kontakt) sine identifikatorer som skal lenkes til ÉN identitet, uten å binde to personer sammen.
 * `phone`/`sms`/`whatsapp` oppløses mot ALLE telefonkanalene (samme nummer = samme identifikator), øvrige kanaler mot seg selv.
 */
export interface LinkExclusiveIdentifiersInput {
  identifiers: ReadonlyArray<{ channel: ConversationChannel; identifier: string }>;
  /** Kilden som EIER lenkene (`source_type` + `external_id`, f.eks. `google_contacts` + `people/c123`). En annen kilde-id på samme identitet er en konflikt. */
  source: { source_type: string; external_id: string };
  confidence: number;
  match_method: ChannelLinkMatchMethod;
  display_name?: string;
  created_by_person_id?: string;
  /**
   * WP-G1c (D-481, JARVIS-112 f1): kilde-id-ene (`external_id` med samme `source_type`) EIEREN uttrykkelig har godtatt at denne kilden deler identitet med (en godtatt kontaktkonflikt). Bare disse unntas fra «en ANNEN kilde eier allerede identiteten»-kontrollen;
   * enhver annen eier er fortsatt en konflikt, og identifikatorer som peker på ULIKE identiteter er alltid en konflikt (en sammenslåing er en egen, reversibel eier-handling). Utelatt/tom = nøyaktig som før.
   */
  allow_shared_with?: readonly string[];
}

export type LinkExclusiveIdentifiersResult =
  | { status: "linked"; identity_id: string; linked: number }
  /** Ingenting er skrevet. `with` = de andre kilde-id-ene som allerede eier identiteten (tom når identifikatorene peker på ULIKE identiteter). */
  | { status: "conflict"; with: string[] };

export interface MergeIdentitiesInput {
  source_identity_id: string;
  target_identity_id: string;
  confidence: number;
  reason: string;
  performed_by: MergePerformedBy;
  created_by_person_id?: string;
}

export interface SplitMergeInput {
  merge_id: string;
  performed_by: MergePerformedBy;
  reason: string;
  created_by_person_id?: string;
}

export interface CrossChannelCommitment {
  followup_id: string;
  title: string;
  reason: string | null;
  next_action: string | null;
  due_at: string;
  priority: "low" | "normal" | "high";
  status: "open" | "completed" | "cancelled";
}

export interface IdentityTimelineEntry {
  activity_id: string;
  activity_type: string;
  summary: string;
  canonical_uri: string | null;
  occurred_at: string;
}

/* -------------------------------------------------------------------------
 * UA-7 slice 2 (D-121): tverr-kanal-forpliktelses-/neste-handlings-visning.
 *
 * Ingen ny tabell, ingen ny forpliktelses-silo: ALT under er en LESE-visning
 * over de to EKSISTERENDE systems-of-record `business_followups` (eksplisitte
 * oppfoelginger) og `business_open_loops` (deterministisk detekterte neste
 * handlinger), forankret paa Conversation Graph-identiteten i stedet for paa
 * EN CRM-kontakt. Se D-121 i DECISIONS_AND_ASSUMPTIONS.md for
 * system-of-record-auditen.
 * ------------------------------------------------------------------------- */

/** Hvilket EKSISTERENDE system-of-record forpliktelsen faktisk kommer fra - aldri en Jarvis-oppfunnet post. */
export type CommitmentSourceKind = "business_followup" | "business_open_loop";

/**
 * Proveniens for HVORDAN forpliktelsen oppstod. `business_followups` har
 * ingen `detection_method`-kolonne - den er per definisjon eksplisitt
 * opprettet ('explicit'). `business_open_loops.detection_method`
 * ('deterministic'|'ai_assisted') gjengis UENDRET, aldri oppgradert: en
 * kaller skal kunne se at en ai_assisted-detektert neste handling IKKE er
 * det samme som en deterministisk bevist en (byggeordrens
 * "LLM extraction = candidate/proposal", aldri stille kanonisert).
 */
export type CommitmentProvenance = "explicit" | "deterministic" | "ai_assisted";

export interface CrossChannelCommitmentEntry {
  source_kind: CommitmentSourceKind;
  /** `business_followups.followup_id` eller `business_open_loops.open_loop_id`. */
  source_id: string;
  title: string;
  reason: string | null;
  next_action: string | null;
  /** `business_open_loops.due_at` er nullbar - en forpliktelse uten frist er gyldig, aldri en fabrikkert dato. */
  due_at: string | null;
  priority: "low" | "normal" | "high";
  provenance: CommitmentProvenance;
  /** Loes peker til kilden (kun open loops har den) - ALDRI en kopi av innhold. */
  canonical_uri: string | null;
  /** SAMME regel som `OpenLoopService.attentionQueue()` (delt `classifyAttentionBucket`). */
  bucket: AttentionBucket;
}

/** En kanal motparten faktisk er naabar paa - kun AKTIVE lenker, med sin confidence-proveniens. */
export interface ChannelReach {
  channel: ConversationChannel;
  channel_identifier: string;
  confidence: number;
  match_method: ChannelLinkMatchMethod;
}

/**
 * Hvorfor visningen ser ut som den gjoer - ALDRI en tom liste uten
 * forklaring (en tom liste kan bety "ingenting aapent" ELLER "vi vet ikke
 * hvem dette er"; de to maa aldri forveksles).
 */
export type CommitmentResolutionState =
  /** Identiteten er (eller ble slaatt sammen til) en aktiv identitet med lenket kontakt - listen er fullstendig. */
  | "resolved"
  /** Identiteten finnes ikke, eller merge-kjeden er brutt - INGEN forpliktelser kan sies noe om. */
  | "identity_not_found"
  /** Identiteten finnes, men har ingen lenket CRM-kontakt - ukjent forblir ukjent (Q-26), aldri gjettet. */
  | "no_linked_contact";

export interface CrossChannelCommitmentView {
  /** Identiteten kalleren spurte om (kan vaere en tombstonet, sammenslaatt identitet). */
  requested_identity_id: string;
  /** Den NAAVAERENDE aktive identiteten etter `merged_into_identity_id`-kjeden - null naar kjeden ikke kan loeses. */
  effective_identity_id: string | null;
  resolution: CommitmentResolutionState;
  display_name: string | null;
  linked_business_contact_id: string | null;
  /** Alle aktive kanaler den EFFEKTIVE identiteten er naabar paa (unionen etter merge). */
  channels: ChannelReach[];
  commitments: CrossChannelCommitmentEntry[];
}

/**
 * EN aktiv identitet som bidrar med kanal-rekkevidde for en kontakt, med
 * NOEYAKTIG de kanalene den identiteten faktisk eier.
 *
 * D-121 REVIEW-FIKS: `046_conversation_graph.sql` har KUN en ikke-unik indeks
 * paa `(tenant_id, linked_business_contact_id)` (linje 94) - FLERE aktive
 * identiteter kan derfor lovlig peke paa SAMME kanoniske kontakt (to
 * uavhengig opprettede kanal-identiteter som begge ble lenket til kontakten
 * uten at noen har kjoert en eksplisitt `mergeIdentities()`). Denne typen
 * finnes for at unionen av kanaler skal kunne rapporteres UTEN aa merke
 * kanaler fra flere identiteter som om de tilhoerte EN vilkaarlig valgt
 * identitet. Attribusjonen er alltid eksakt: hver kanal ligger under
 * identiteten som faktisk eier lenken.
 */
export interface AttentionIdentityReach {
  identity_id: string;
  display_name: string | null;
  /** Kun AKTIVE kanal-lenker for DENNE identiteten. Tom liste = identiteten finnes, men naas ikke. */
  channels: ChannelReach[];
}

/**
 * Tenant-bred "hva er aapent paa tvers av kanaler NAA?". Hver rad baerer sin
 * egen kanal-naabarhet. Tom `identities` + tom `channels` er en EKSPLISITT,
 * aerlig markering av at forpliktelsen IKKE er knyttet til noen
 * kommunikasjonskanal ennaa - aldri stille utelatt, aldri fabrikkert kanal.
 */
export interface CrossChannelAttentionEntry {
  /**
   * ALLE aktive identiteter lenket til `contact_id`, deterministisk sortert
   * (`created_at ASC, identity_id ASC`) - aldri bare den eldste, aldri stille
   * droppet. En identitet UTEN aktive kanaler blir staaende med tom
   * `channels`: at identiteten finnes men ikke er naabar er selv et faktum.
   */
  identities: AttentionIdentityReach[];
  contact_id: string | null;
  /**
   * Unionen av de aktive kanalene over ALLE identitetene i `identities`,
   * deterministisk sortert. Dette er svaret paa "naar vi motparten, og
   * hvordan?" - `identities` svarer paa "via hvilken identitet?".
   */
  channels: ChannelReach[];
  /** Sann hvis MINST EN av identitetene har minst en aktiv kanal - aldri basert paa kun én av dem. */
  channel_reachable: boolean;
  commitment: CrossChannelCommitmentEntry;
}
