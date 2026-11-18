/**
 * WP-G2 (D-464, UA-8 Personal Twin): ÆRLIG STATUS per kapabilitet, i kode (ikke bare i runbooken). `docs/runbooks/WPG2_PERSONAL.md` har samme id-er (en test låser at de henger sammen), slik at et flagg aldri kan stå på uten en
 * synlig status, og en utsatt del aldri kan forsvinne stille. INGENTING er `VERIFIED`: alt er bygget og testet mot fake/embedded Postgres, ingenting er kjørt mot en ekte enhet, bil, iCloud-konto eller sirkel.
 *  - DORMANT: bygget og koblet inn, men AV bak sitt flagg (uten flagget er alt identisk med main).
 *  - BUILT_UNWIRED: bygget og testet, men ikke koblet til noen rute/verktøy/sveip.
 *  - DEFERRED: ikke bygget i dette arbeidspakke-omfanget; `next_step` sier nøyaktig hva som må til.
 *  - BLOCKED_EXTERNAL: avhenger av noe bare eieren kan skaffe (enhet, konto, leverandørvalg).
 */
export type PersonalStatusWord = "DORMANT" | "BUILT_UNWIRED" | "PARTIAL" | "DEFERRED" | "BLOCKED_EXTERNAL" | "EXISTING_UNCHANGED";

export interface PersonalCapabilityStatus {
  id: string;
  priority: "P1a" | "P1b" | "P1c" | "P1d" | "P2e" | "P2f" | "P2g" | "Q-60";
  status: readonly PersonalStatusWord[];
  /** Flagget som slår kapabiliteten på (finnes alltid i `PERSONAL_FLAG_NAMES`), ellers ingen. */
  flag?: string;
  note: string;
  /** Kun for DEFERRED/BLOCKED_EXTERNAL/PARTIAL: hva som må til for å gå videre. */
  next_step?: string;
}

export const PERSONAL_CAPABILITY_STATUS: readonly PersonalCapabilityStatus[] = [
  { id: "p1a_home_critical", priority: "P1a", status: ["DORMANT"], flag: "JARVIS_PERSONAL_HOME_CRITICAL", note: "Åtte kritiske Home Assistant-handlinger som klasse D med mål-allowlist, readback av faktisk sluttilstand og handlingsjournal." },
  { id: "p1b_car", priority: "P1b", status: ["DORMANT", "BLOCKED_EXTERNAL"], flag: "JARVIS_PERSONAL_CAR", note: "Leverandørnøytral `CarAdapter` med falsk adapter, kontraktskit og samme D-kjede; INGEN leverandør er valgt (D-64).", next_step: "Eieren velger leverandør; et aggregat-API er CORE_DEPENDENCY_DECISION_REQUIRED." },
  { id: "p1c_family", priority: "P1c", status: ["DORMANT", "PARTIAL"], flag: "JARVIS_PERSONAL_FAMILY", note: "Roller, invitasjon, deling kun fra subjektet selv, «på vegne av» med prinsipalens delegasjon, delte lister og kalender.", next_step: "Provisjonering av sirkel-tenant/innrullering (CLI) og verge-tilgang for barn er ikke bygget." },
  { id: "p1d_health_ingest", priority: "P1d", status: ["DORMANT", "BLOCKED_EXTERNAL"], flag: "JARVIS_PERSONAL_HEALTH_INGEST", note: "Enhetssignert inntak av ti lukkede helsemetrikker, idempotent på HealthKit-uuid; kun en rute, aldri et verktøy.", next_step: "iPhone/Watch-appen krever Mac + Apple Developer-konto; transportveien fra telefonen er eierens valg." },
  { id: "p2e_apple_dav", priority: "P2e", status: ["DEFERRED", "BLOCKED_EXTERNAL"], flag: "JARVIS_PERSONAL_APPLE_DAV", note: "Apple Calendar/Reminders/Contacts via CalDAV/CardDAV er IKKE bygget i dette omfanget; flagget er reservert og har ingen effekt.", next_step: "Eieren oppretter app-spesifikt passord (D-108) og velger kalendere; deretter: iCalendar/vCard-kodek + DAV-klient bak transportgrensesnitt, falsk transport, eier-kun-verktøy med D-41-revisjon og full connector-manifest (aldri stille inn i SKELETON_BASELINE)." },
  { id: "p2e_eventkit", priority: "P2e", status: ["DEFERRED", "BLOCKED_EXTERNAL"], note: "EventKit (lokal Apple-API) krever native app på Mac/iPhone.", next_step: "Utsatt til iPhone/Mac-appen finnes." },
  { id: "p2f_finance_read", priority: "P2f", status: ["DEFERRED"], flag: "JARVIS_PERSONAL_FINANCE_READ", note: "Personlig økonomi-LESING er ikke bygget; eksisterende `finance_neonomics` (D-111) er uendret, og ingen betaling bygges. Flagget er reservert og har ingen effekt.", next_step: "Eierbeslutning om tenant/samtykke for en personlig bankkobling, og en generell utførelseslås for begrensede verktøy (H1 aksepterte kun valg-lås for finance_*)." },
  { id: "p2g_context", priority: "P2g", status: ["BUILT_UNWIRED"], flag: "JARVIS_PERSONAL_CONTEXT", note: "Rene funksjoner for tid på døgnet og reisedeteksjon (kalender deterministisk, reiseord som gjetning, e-post kun som signal); ikke koblet til rute/sveip. Flagget er reservert og har ingen effekt." },
  { id: "p2g_session_continuity", priority: "P2g", status: ["EXISTING_UNCHANGED"], note: "Kravet dekkes av eksisterende SessionService/SessionGrantService (D-131): én server-eid sesjon gjenopptas på tvers av kanaler, autoritet i separate enhetsbundne grants. Ingenting bygget." },
  { id: "local_agent_q60", priority: "Q-60", status: ["DEFERRED"], note: "Lokalagent med filtilgang (Mac/Windows) bygges IKKE (Q-60); ingen kontrakt for filtilgang er laget.", next_step: "Eieren svarer på Q-60." }
];
