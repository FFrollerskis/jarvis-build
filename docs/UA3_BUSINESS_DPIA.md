# UA-3 — DPIA / data-governance-notat (Business Domain Foundation + Open-Loop Detection + Business-Event-Linkage + Profiling/Scoring)

**Status:** UA-3 P0 «Business Domain Foundation» = VERIFIED/COMPLETE (D-52, host-bevist run_id
`ca2d9248`). UA-3 «Open-Loop Detection + Daily/Weekly Business Brief» = VERIFIED/COMPLETE (2026-08-17,
host-bevist run_id `de01ca07`, se D-53/D-54/D-55/D-56 i DECISIONS_AND_ASSUMPTIONS.md). UA-3
«Business-Event-Linkage (Gmail/Calendar → Business OS)» = VERIFIED/COMPLETE (2026-08-17, host-bevist
run_id `6c6a4948`, `hard_fail=false`, se D-57/D-58/D-59/D-60). Personvernsgarantiene under (ingen
Gmail-body/emne/deltakerinnhold i `business_activities`, kun kilde-peker) er nå bekreftet LIVE via
`ua3_events_no_body_content_stored=PASS` og `ua3_events_audit_safe=PASS` på ekte host, ikke kun
suite-bevist. UA-3 «Profiling/Scoring» (akseptansekriterium 4) = FIXED_SUITE / READY_FOR_HOST_VERIFY
(2026-08-17, IKKE host-verifisert ennå, se D-61).
Dette notatet dekker den strukturerte tredjeparts-persondata-kategorien UA-3 introduserer (kunde-/
kontakt-/selskapsdata i `business_*`-tabellene, inkl. NÅ `business_open_loops`) - utfyller, erstatter
ikke, `docs/security/DPIA_DRAFT.md` sin generelle "Bedriftsdata (kunder, e-post)"-rad.

## Business-Event-Linkage (NY, UA-3 D-57)

Gmail/Calendar-hendelser (allerede eier-autoriserte UA-0/UA-7-P0-connectorer - INGEN ny leverandør-
tilgang gitt i dette sliceet) leses forbigående via `BusinessEventSyncService` for å utlede EN kort,
strukturert `business_activities`-rad PER matchet melding/møte. **Kritisk arkitekturprinsipp uendret
fra P0/§15:** selve e-post-body-teksten/møtebeskrivelsen flyter ALDRI inn i `business_activities` -
kun emne/tittel (allerede korte, strukturerte felt fra Gmail/Calendar sine egne metadata) lagres som
`summary`, og `canonical_uri` er en peker TILBAKE til kilden (Gmail sin egen weblenke, Calendar sin
egen `html_link`) - ALDRI en kopi. Strukturelt bevist i `business-event-sync.test.ts` (test C/K: en
syntetisk "HEMMELIG-KROPP"-body-tekst i test-fixturen verifiseres ALDRI å havne i noen lagret rad).

**Entitetsgjenkjenning er deterministisk, ikke AI-basert profiling:** en Gmail-melding/Calendar-
deltaker kobles til en `business_contact` KUN ved eksakt e-postadresse-match (case-insensitiv) - aldri
et LLM-avgjort gjettet navn/identitet-treff. Ved 0 treff (ukjent avsender/deltaker) opprettes INGEN
aktivitet (aldri støy fra ukjente tredjeparter i innboksen); ved >1 distinkt selskaps-treff (tvetydig)
opprettes INGEN aktivitet (aldri en gjettet feilkobling til feil kunde/selskap). Dette er samme
"deterministisk-først, fail-safe-ved-tvetydighet"-prinsipp som `OpenLoopService` sin egen deteksjon
(D-53) - INGEN sensitive kategorier (helse/etnisitet/religion/politikk osv.) utledes noensinne.

**Kildekonto-omfang (kjent, dokumentert forenkling):** alle bedrifts-tenants synkroniseres i dag mot
SAMME ene tilkoblede Google-konto (`JARVIS_GOOGLE_ACCOUNT`) - deterministisk kontakt-e-post-matching
sikrer likevel at en aktivitet KUN registreres for tenanten hvis kontakt faktisk matcher, aldri på
tvers. Ingen ny persondata-kategori utover det P0 allerede etablerte (`business_contacts`) - Gmail/
Calendar-hendelser produserer KUN `business_activities`-rader (samme OPERATIONAL METADATA-kategori
som øvrige aktiviteter, se tabellen under), aldri nye kontakt-/personopplysningsfelt.

## business_open_loops (NY, UA-3 NEXT SLICE / D-53)

`business_open_loops` er en AUTOMATISK DERIVERT tabell - hver rad er et system-generert resultat av en
deterministisk regel kjørt over EKSISTERENDE `business_followups`/`business_opportunities`-data, ikke en
ny persondata-INNTAKSVEI. Ingen nytt personopplysningsfelt introduseres: `reason`/`next_action` er
korte, systemgenererte setninger som refererer et EKSISTERENDE followup/opportunity-tittelfelt (samme
tekst som allerede ligger i P0-tabellene) - klassifisert som **OPERATIONAL METADATA**, samme kategori
som `business_followups`/`business_opportunities`/`business_activities` selv (se tabellen under).
`owner_person_id` refererer en EKSISTERENDE `people`-rad (samme mønster som resten av Business OS).
Ingen AI Mesh-basert profiling/scoring brukt til å utlede `priority` (deterministisk fra forfalt-
/stagnert-varighet) - se D-53 §11/§12 for full begrunnelse. RLS/tenant-/memory-space-isolasjon: SAMME
FORCE RLS-mønster som alle andre business-tabeller (`020_business_open_loops.sql`).

## Hvilke data lagres

| Tabell | Datakategori | Eksempel på innhold |
|---|---|---|
| `business_companies` | Selskapsnavn, domene, status, kilde, eier | "Acme AS", "acme.no", "prospect" |
| `business_contacts` | **Tredjeparts persondata:** navn, e-post, telefon, tittel, tilhørende selskap | "Kari Nordmann", "kari@acme.no", "+47..." - EKTE personopplysninger om personer HOS kunden/selskapet, ikke Tobias selv |
| `business_leads` | Lead-tittel, status, kilde-referanse (source_type/source_instance_id/external_id) | "Interessert i tjeneste X", "new" |
| `business_opportunities` | Deal-tittel, pipeline-stadium, beløp (øre), valuta, forventet lukkedato | "Acme - tjeneste X", "qualified", 500000 |
| `business_activities` | Aktivitetstype, KORT strukturert sammendrag, kilde-peker (`canonical_uri` - ALDRI kopi av fullt innhold) | "E-post mottatt", peker til Knowledge-dokument/ekstern kilde |
| `business_followups` | Oppgave-tittel, frist, prioritet, status, eier, årsak, neste handling | "Send tilbud", forfallsdato, "open" |
| `business_open_loops` (NY, D-53) | **AUTOMATISK DERIVERT** - deteksjonstype, kort systemgenerert begrunnelse (refererer eksisterende followup-/opportunity-tittel), deterministisk prioritet, status, eier | "overdue_followup", "Oppfoelging 'Send tilbud' er forfalt", "high", "open" |
| `business_scores` (NY, D-61) | **AUTOMATISK DERIVERT** - score-type, tall (0-100), versjonert faktor-forklaring (kode+label+vekt), kilde-ID-referanser, valgfri eier-overstyring | "lead_priority", 45, `[{"code":"status_qualified","label":"Lead-status: qualified","weight":30,"contribution":30}]` |

**Kritisk arkitekturprinsipp (§15 i byggeordren):** `business_activities.canonical_uri` er en LØS PEKER
til Knowledge/eksterne kilder - UA-3 P0 kopierer ALDRI fulle e-post-kropper, dokumentinnhold eller
samtaleutskrifter inn i egne tabeller. Selve innholdet forblir i Knowledge (UA-2) eller hos den
eksterne kilden; Business OS lagrer kun strukturert state + en peker.

## Datakategoriklassifisering (§26/§27 i byggeordren)

| Kategori | Tabeller | Retensjon/sletting |
|---|---|---|
| **CONTENT** (tredjeparts persondata Tobias/selskapet er behandlingsansvarlig for) | `business_contacts` (navn/e-post/telefon) | Slettes ved eksplisitt forespørsel (fremtidig D-klasse-operasjon, IKKE bygget i P0 - se Q-25). Ingen automatisk retensjonsgrense satt i P0 - operasjonell forretningsdata, ikke midlertidig cache |
| **OPERATIONAL METADATA** (relasjonens tilstand, ikke selve kildeinnholdet) | `business_companies`/`business_leads`/`business_opportunities`/`business_activities`/`business_followups`/`business_open_loops` (NY, D-53 - automatisk derivert, ikke en ny inntaksvei) | Retained ved Q-20-sletting av et REFERERT Knowledge-dokument (ingen FK - se under). Slettes/anonymiseres KUN sammen med hele tenanten (samme mønster som øvrige tenant-scopede tabeller) |
| **DERIVED / OPERATIONAL METADATA** (systemberegnet prioriteringsverdi, ikke en ny persondata-kilde) | `business_scores` (NY, D-61 - automatisk derivert fra EKSISTERENDE lead-/opportunity-/aktivitets-/oppfoelgings-/open-loop-data) | Samme retensjon som `business_open_loops`. `evidence`-feltet er en løs referanse (ingen FK) - overlever en referert kildes fjerning uten cascade-feil |
| **AUDIT-EVENT** | `audit_events`-rader for `tool_id='business'` | Append-only (uendret fra eksisterende audit-arkitektur), inneholder ALDRI navn/e-post/telefon (kun `credential_ref`/`external_id`/`scopes`/`rollback` - verifisert i `business-transport-wiring.test.ts` §N) |

## Q-20-interaksjon (§26 i byggeordren)

`business_activities.canonical_uri` har INGEN fremmednøkkel (FK) til `knowledge_documents` - kun en løs
tekst-peker (strukturelt bevist i `business-service.test.ts` §S/T). Konsekvens: en fremtidig Q-20-hard-
sletting av et Knowledge-dokument en aktivitet peker til gjør pekeren ganske enkelt ustabil/ikke-
oppløsbar - ALDRI en cascade-feil, ALDRI en database-konstraint-krasj, og ALDRI en vei til å
"gjenopplive" det slettede innholdet (aktiviteten selv inneholder kun det korte, allerede lagrede
sammendraget - ikke kildens fulle tekst). Ingen kompleks cascade-slette-logikk er bygget, siden ingen
FK-relasjon finnes å cascade fra - dette er en BEVISST designbeslutning (D-49), ikke et overset gap.
`business_open_loops` (D-53) har SAMME egenskap - `canonical_uri`-feltet er også en løs peker uten FK
til `knowledge_documents`, strukturelt bevist i `open-loop-service.test.ts` §M.

## Tenant-/RLS-isolasjon

Alle 6 tabeller er `FORCE ROW LEVEL SECURITY` med BÅDE tenant- og memory-space-policyer
(`019_business.sql`, samme mønster som `knowledge_documents`/`memory_items`) - databasenivå, ikke kun
applikasjonskode. Multi-selskap (flere bedrifts-tenants) krever INGEN skjemaendring (D-21/
`docs/security/TENANT_MODEL.md` §3) - hver nye bedrift er en egen tenant-rad med egen RLS-isolasjon,
akkurat som Kundeoppfølging AS i dag.

## Rettslig ramme (foreløpig, uendret vurderingsprinsipp fra DPIA_DRAFT.md §2)

`business_contacts` inneholder EKTE tredjeparts persondata (personer hos kunder/prospekter, ikke
Tobias selv) - dette er kjernen i det eksisterende "bedriftsdata gjør Tobias/selskapet
behandlingsansvarlig med fullt GDPR-ansvar"-prinsippet fra `DPIA_DRAFT.md`. UA-3 P0 bygger INGEN ny
juridisk vurdering utover det som allerede er dokumentert der - kun den strukturerte datamodellen
prinsippet nå faktisk gjelder for. Databehandleravtaler/region-/retensjonsmatrise for eksterne
tredjeparter (f.eks. et fremtidig CRM-eksport-mål) er IKKE vurdert i P0, siden ingen ekstern
tredjepartsoverføring er bygget denne runden.

## Profiling/Scoring (NY, UA-3 D-61) - akseptansekriterium 4

`business_scores` (`022_business_scoring.sql`) er en AUTOMATISK DERIVERT tabell - hver rad er et
system-beregnet resultat av en deterministisk regel kjørt over EKSISTERENDE
`business_leads`/`business_opportunities`/`business_activities`/`business_followups`/
`business_open_loops`-data, ikke en ny persondata-INNTAKSVEI. Klassifisert som **DERIVED /
OPERATIONAL METADATA** (samme kategori som `business_open_loops`) - se oppdatert tabell under.

**Formålsbegrensning (purpose limitation):** scoren brukes UTELUKKENDE til intern forretnings-
prioritering (hvilke leads/opportunities trenger oppmerksomhet først) - ALDRI til å avgjøre noe om en
person (kreditt, ansettelse, forsikring eller lignende regulert automatisert beslutning). Se §10 under.

**Tillatte faktorer (allowed factors):** KUN forretnings-tilstandssignaler fra data Business OS allerede
eier - lead-status, opportunity-pipeline-stadium, aktivitets-nylighet, oppfoelgings-status (aapen/
forfalt), EKSISTERENDE `OpenLoopService`-stagnert-flagg. Den fullstendige whitelisten er kodifisert
(`ALLOWED_LEAD_FACTOR_CODES`/`ALLOWED_OPPORTUNITY_FACTOR_CODES` i `scoring-rules.ts`), ikke bare
dokumentert i prosa.

**Forbudte faktorer (prohibited factors):** rase/etnisitet, religion, politisk oppfatning, seksuell
orientering, helsestatus, funksjonsnedsettelse, genetiske/biometriske trekk, fagforeningsmedlemskap,
personlighet/psykologisk profil, formue/inntekt/sosioøkonomisk status, kjønn, sivilstatus - HÅNDHEVET
strukturelt (`assertNoProhibitedFactorCodes()` kaster for enhver kode som matcher, kjørt ved modul-load
OG på hver faktisk beregnet faktor-liste), ikke bare som en policy-tekst. Scoring-motoren leser ALDRI
`business_contacts`/`people`-tabellene utover en eksisterende `owner_person_id`-identitetsreferanse -
kontakt-/person-nivå-scoring er derfor arkitektonisk umulig, ikke bare en utsatt funksjon.

**Kilde-proveniens (source provenance):** hver score har `evidence` (strukturerte `{type,id}`-
referanser til aktivitet-/oppfoelgings-/open-loop-ID-er) - ALDRI kopiert kildeinnhold, samme
løs-peker-prinsipp som `business_activities.canonical_uri`.

**Forklarbarhet (explainability):** hver score returneres ALLTID sammen med `factor_summary` (kode +
menneskelesbar label + vekt + bidrag per faktor) og `rule_version` - aldri et opakt tall alene. Jarvis
kan alltid svare "hvorfor er denne leaden scoret X" med en deterministisk, kilde-forankret begrunnelse.

**Menneskelig/juridisk kontroll:** `set_manual_override`/`clear_manual_override` gir eieren en
eksplisitt, auditert mulighet til å overstyre en beregnet score (uten å forfalske selve de underliggende
faktorene/kildedataene) - auditert via den EKSISTERENDE `ToolGateway`-audit-veien (`audit_events`,
`tool_id='business'`, ALDRI overstyrings-begrunnelsen i klartekst utover det som allerede er tillatt i
audit-payloaden).

**AI-bruksgrenser:** v1 (`lead_priority_v1`/`opportunity_risk_v1`) er 100% deterministisk - INGEN
AI Mesh-/ModelGateway-kall brukes til å beregne scoren (strukturelt bevist: `scoring-rules.ts` importerer
aldri `@jarvis/model-gateway`). En fremtidig versjon som bruker AI Mesh til semantisk tolkning (der ekte
tvetydighet krever det) MÅ fortsatt aldri utlede beskyttede trekk, og MÅ gå gjennom Model Gateway som
resten av kjernen - ingen direkte provider-SDK-bruk.

**Forbud mot autonom hoy-konsekvens-personbeslutning (§10):** en score kan ALDRI autonomt avvise en
person, nekte en tjeneste, avslutte et forhold, eller avgjøre kreditt/ansettelse/forsikring - ingen
slik kobling finnes strukturelt (`business_scores`-skjemaet har ingen slik kolonne, `ScoringService`
kaller aldri en ekstern handling/ToolGateway-transport). Forretnings-PRIORITERING (rangering for
intern oppmerksomhet) er eksplisitt tillatt og er alt denne sliceen gjør.

**Retensjon:** samme mønster som `business_open_loops` - scoren slettes/anonymiseres sammen med hele
tenanten (ingen separat retensjonsgrense denne runden), og en Q-20-sletting av en referert kilde
(f.eks. en aktivitet) etterlater KUN en løs, ikke-oppløsbar `evidence`-referanse - aldri en cascade-feil
eller en vei til å "gjenopplive" slettet innhold (bevist i test V i `scoring-service.test.ts`).

**Rettslig grunnlag (legal basis, Appendiks D-gate "Legal basis/processing inventory; human/legal
control where automated decisions have regulated effect"):** behandlingsgrunnlaget for
`business_scores` er berettiget interesse (GDPR art. 6(1)(f)) - intern forretningsprioritering av
allerede lovlig innsamlet CRM-/aktivitetsdata, ingen ny persondata-kategori innhentet for scoring-
formålet. **GDPR art. 22 (automatiserte enkeltavgjørelser) er IKKE relevant for denne sliceen** - en
score verken "produces legal effects" eller "similarly significantly affects" en person: den avviser
aldri en person, nekter aldri en tjeneste, og avgjør aldri kreditt/ansettelse/forsikring (§10 over) -
den er UTELUKKENDE et internt prioriterings-/rangeringssignal for Tobias/teamet, alltid med eier-
tilgjengelig manuell overstyring og full forklarbarhet selv om art. 22 sitt strengere krav ikke
utløses. Databehandleravtaler/tredjelandsoverføring er IKKE relevant - `business_scores` beregnes og
lagres utelukkende i egen Postgres, ingen ekstern prosessor mottar scoringsdata denne runden.
**Menneskelig/juridisk kontroll er derfor dokumentert TILSTEDE (manuell overstyring + audit + full
forklarbarhet) SELV OM den strengt tatt ikke var juridisk påkrevd** for denne uregulerte,
lav-konsekvens bruken - Appendiks D-gaten er dermed oppfylt både i bokstav (kontroll finnes) og ånd
(ingen regulert-effekt-beslutning å kontrollere for).

**Ikke i scope denne runden (se Q-25):** kontakt-/person-nivå-scoring (arkitektonisk umulig); AI Mesh-
basert scoring-forbedring; finere per-tenant/policy-nivå av/på-bryter utover deployment-wiring;
kontrakt-/faktura-verdi-baserte faktorer.

## Native Jarvis Support Core (UA-3 D-66/D-67/D-68/D-69, VERIFIED/COMPLETE - host-bevist run_id `da7e0c1b`, `hard_fail=false`)

**Formål:** gi Jarvis et eget, kanonisk (`JARVIS_CANONICAL`, D-64) support/ticket-domene - løser
"Hva skjer med kunde X?"-akseptansekriterium 1 sitt Support/tickets-gap UTEN å gjøre en ekstern
leverandør (Zendesk/Intercom/Freshdesk) til domeneeier. ZERO ekstern support-leverandør-avhengighet
(bevist mekanisk i tester og host-akseptanse - `JARVIS_ZENDESK_*` kan stå helt uten verdi).

**Ticket-metadata som lagres (`support_tickets`):** ticket-nummer, tenant/memory-space, valgfri
selskap-/kontaktkobling (FK til `business_companies`/`business_contacts`), emne, status (deterministisk
lifecycle - se state-machine.ts), prioritet, ansvarlig (`assignee_person_id`, FK til `people`), kanal,
generiske kilde-pekere (`source_type`/`source_instance_id`/`source_thread_id`/`source_message_id`/
`canonical_uri`), entitetsresolusjons-tilstand (matched/unmatched/ambiguous), neste-svar-/neste-
handling-frist, tidsstempler.

**Kundekommunikasjon (`support_ticket_events`):** hver kunde-melding/agent-svar lagres KUN som et kort,
strukturert `summary`-felt + kilde-pekere (§11 pointer-not-payload) - ALDRI en kopi av det fulle
e-postinnholdet. Full meldingstekst forblir i den autoritative Gmail-kilden/Knowledge-laget, aldri
duplisert inn i operasjonelle support-tabeller.

**Interne notater:** `internal_note`-events er ALDRI kunde-synlige, sender ALDRI e-post, er tenant-/
memory-space-isolert på SAMME måte som resten av ticket-historikken, og er auditerbare via den normale
`support_ticket_events`-tidslinjen (IKKE `audit_events` - kundehistorikk og systemrevisjon er
eksplisitt to separate konsepter, se §12 i byggeordren).

**Kildepekere:** identisk prinsipp som `business_activities.canonical_uri` - en peker til Gmail-
meldingen (dyplenke), aldri en kopi. Full e-postinnhold forblir i Knowledge/kilde-laget.

**Retensjon/Q-20-erasure:** `support_tickets`/`support_ticket_events` er registrert i
`modules/erasure/src/plan.ts` sin `planMemorySpaceInContext()` (§21 i byggeordren) - KLASSIFISERT SOM
KUNDEDATA (samme klasse som `memory_items`/`knowledge_documents`), IKKE append-only systemrevisjon som
`audit_events` - `jarvis_app` har derfor fått en eksplisitt, begrenset `GRANT DELETE` KUN for disse to
tabellene (`024_support.sql`, samme presedens/begrunnelse som `018_erasure.sql` sin allerede
eksisterende DELETE-allowliste). Bevist mekanisk (unit- og host-test): en slettet ticket kan ALDRI
"gjenoppstå" av re-ingestion av samme kilde-melding - re-ingestion etter sletting oppretter en HELT NY
ticket, aldri en gjenoppvekket kopi av den slettede raden. **Kjent, dokumentert begrensning (ikke
stille utelatt):** de øvrige `business_*`-tabellene (companies/contacts/leads/opportunities/
activities/followups/open_loops) er FORTSATT ikke registrert i erasure-planen i det hele tatt - dette
er en PRE-EKSISTERENDE gap fra P0 (uendret av denne sliceen, se Q-25 punkt 9), IKKE noe Native Support
Core introduserer eller utvider.

**Ansvarlig-data (assignee):** `assignee_person_id` er en FK til den EKSISTERENDE `people`-tabellen -
ingen ny bruker-/identitetsmodell bygges. Tildeling er operasjonell state, auditert som et
`assigned`/`unassigned`-event på ticket-tidslinjen.

**E-post-transport:** Gmail-ingress/kunde-svar gjenbruker den EKSISTERENDE `GmailTransport`
(ToolGateway) - INGEN egen SMTP/Gmail-klient. Kunde-svar (`support.reply`) ruter GJENNOM den
allerede-eksisterende `email.send`-handlingen (klasse D, krever signert godkjenning, uendret av denne
sliceen) - ingen ny, svakere utsendelsesvei innføres.

**Open-loop-integrasjon:** gjenbruker `OpenLoopService`/`business_open_loops` UENDRET mekanisme (§17) -
fire nye `loop_type`-verdier + en nullable `ticket_id`-pekerkolonne, ingen ny motor, ingen ny
datakategori utover det `business_open_loops` allerede dekker.

**Auditering:** `support.reply` sin sensitive svartekst (`body`) sendes ALDRI inn i selve
`ToolGateway`-audit-payloaden for `support.reply`-handlingen - kun status/idempotency-nøkkel - bevist
mekanisk i tester og host-akseptanse (`ua3_support_audit_safe`).

**Rettslig grunnlag:** samme berettiget-interesse-vurdering (GDPR art. 6(1)(f)) som resten av Business
OS - support-ticket-håndtering er en ordinær, forventet del av et kundeforhold, ingen ny
persondata-kategori utover det som allerede samles via Gmail/CRM. **GDPR art. 22 er IKKE relevant** -
en ticket avgjør aldri autonomt noe med rettslig/tilsvarende betydelig effekt for en person; status/
prioritet/tildeling er ordinær operasjonell saksbehandling, alltid med eier-/agent-tilgjengelig manuell
kontroll (state-machine + manuelle handlinger), aldri en algoritmisk "avgjørelse om" kunden selv.

**Data-minimering:** prioritet er BEVISST begrenset til `low`/`normal`/`high`/`urgent` og kan settes
manuelt eller senere avledes fra deterministiske operasjonelle signaler (samme `assertNoProhibitedFactorCodes()`-
prinsipp som D-61-scoring) - ALDRI fra beskyttede/sensitive kjennetegn (helse/rase/religion/politikk/
seksuell orientering/kjønn/sivilstatus/funksjonsnedsettelse/formue/sosioøkonomisk status). Ingen slik
avledning er bygget i denne sliceen (kun manuell setting).

**Ikke i scope denne runden:** Contracts/e-sign (Q-28, uendret); en ekstern support-leverandør-adapter
(Zendesk/Intercom/Freshdesk som VALGFRI fremtidig kanal-adapter, ALDRI domeneeier - D-64); AI Mesh-
basert klassifisering av support-vs-ikke-support-e-post (routing er BEVISST deterministisk: konfigurert
innboks-adresse ELLER kjent tråd-id, § 7 i byggeordren); flerkanal utover e-post (portal/chat/SMS -
domenemodellen er designet for det, men ingen ekstra kanal er koblet inn denne runden).

## Native Jarvis Contracts Core (UA-3 D-71/D-72/D-73, VERIFIED/COMPLETE - host-bevist run_id `5ca4765b`, `hard_fail=false`)

**Formål:** gi Jarvis et eget, kanonisk (`JARVIS_CANONICAL`, D-64/Q-28) kontraktdomene - CONTRACT
CORE-halvparten av "Hva skjer med kunde X?"-akseptansekriterium 1 sitt Contracts/e-sign-gap, UTEN å
gjøre en ekstern e-sign-leverandør (DocuSign/PandaDoc/Signicat/Adobe Sign) til domeneeier. ZERO
ekstern e-sign-leverandør-avhengighet i denne sliceen (bevist mekanisk - ingen provider-credential-
parameter finnes i `AgreementsService`/`AgreementsTransport`, ingen provider-env-variabel leses noe
sted i `modules/agreements`).

**Kontrakt-metadata som lagres (`contracts`):** kontraktnummer, tenant/memory-space, valgfri
selskap-/kontaktkobling (FK til `business_companies`/`business_contacts` - samme motpart-entiteter
som Support, ingen ny motpart-tabell), tittel, type (fritekst, ikke juridisk klassifisert), status
(deterministisk lifecycle - se `state-machine.ts`), effektiv-/start-/sluttdato, oppsigelsesfrist,
fornyelsesdato, auto-fornyelse-flagg, eier (`owner_person_id`, FK til `people`), generiske
kilde-pekere (`source_type`/`source_instance_id`/`source_thread_id`/`source_message_id`/
`canonical_uri`), tidsstempler.

**Kontraktversjoner (`contract_versions`):** EKSPLISITTE og IMMUTABLE - hver versjon er en ny,
append-only rad (aldri en `UPDATE` av en eksisterende versjon), med et kort strukturert
`summary`-felt av HVA som endret seg + en `canonical_uri`-peker til det faktiske dokumentet (Drive/
Gmail/annen kilde). ALDRI en kopi av selve dokumentinnholdet - strukturelt umulig å lagre feil, siden
skjemaet ikke har noen `body`/`content`/`document_text`-kolonne i det hele tatt.

**Forpliktelser (`contract_obligations`):** beskrivelse, eier, frist, status (`open`/`completed`/
`waived`) - besvarer "hva må vi gjøre under denne kontrakten"/"hva forfaller neste" deterministisk,
ingen AI-tolkning av forpliktelsesinnhold.

**Kontrakt-tidslinje (`contract_events`):** FØRSTEKLASSES og SEPARAT fra `audit_events` (systemets
egen operasjonelle revisjonslogg) - dette ER kontrakt-historikken (opprettelse/versjon lagt til/
statusendring/forpliktelse lagt til-fullført-frafalt/fornyelses-/oppsigelsesfrist endret/motpart
koblet/eier endret), ikke en duplisert audit-mekanisme. Samme prinsipp som
`support_ticket_events`.

**Retensjon/Q-20-erasure:** `contracts`/`contract_versions`/`contract_obligations`/`contract_events`
er registrert i `modules/erasure/src/plan.ts` sin `planMemorySpaceInContext()` - KLASSIFISERT SOM
KUNDEDATA (samme klasse som `support_tickets`/`memory_items`/`knowledge_documents`), IKKE append-only
systemrevisjon som `audit_events` - `jarvis_app` har fått en eksplisitt, begrenset `GRANT DELETE` for
alle fire tabeller (`026_contracts.sql`, samme presedens/begrunnelse som `024_support.sql`/
`018_erasure.sql`). Kontrakt-tilknyttede `business_open_loops`-rader slettes FØRST (samme FK-lærdom
som HOST FIX #1/D-67 for Support - denne gangen løst FØR noen host-runde, ikke reaktivt). Bevist
mekanisk (unit-test, `modules/erasure/test/contracts-erasure.test.ts`): en slettet kontrakt kan
ALDRI "gjenoppstå" - en ny kontrakt opprettet etter erasure får en HELT NY `contract_id`, aldri en
gjenoppvekket kopi av den slettede raden. **Kjent, dokumentert begrensning (ikke stille utelatt):**
samme pre-eksisterende `business_*`-tabell-gap som Support-seksjonen over (companies/contacts/leads/
opportunities/activities/followups/open_loops fortsatt ikke registrert i erasure-planen - se Q-25
punkt 9), uendret av denne sliceen.

**Q-26-grense:** kontraktdokumenter (det peker-refererte innholdet bak `canonical_uri`) er
KILDEDATA, IKKE automatisk "verifisert kunnskap" - ingen inferert kontraktsmening utover eksplisitt
lagrede/utpekte data, ingen juridisk rådgivning gitt av systemet noe sted.

**Ikke i scope denne sliceen:** signaturleverandøren selv (Q-28 SIGNATURE EXECUTION ADAPTER-
halvparten - identitetsverifisering, juridisk-anerkjent signatur, signaturbevis, signaturlevering -
krever en eksplisitt Tobias-leverandørbeslutning FØR noe kan bygges der, forblir ÅPEN); UA-4.
**Ekte host-verifisering FULLFØRT (D-73, 2026-08-18):** Tobias sin tredje, rene host-kjøring
(`ua3-native-contracts-host-run.ts`, run_id `5ca4765b`) ga `hard_fail=false`, ALLE 26 markører PASS
- status er nå VERIFIED/COMPLETE, ikke lenger FIXED_SUITE.

## Native Jarvis Growth Core (UA-4 D-74, FIXED_SUITE / IKKE HOST VERIFIED)

**Formål:** gi Jarvis et eget, kanonisk (`JARVIS_CANONICAL`/`HYBRID_WITH_CLEAR_AUTHORITY`, D-64)
vekst-/markedsføringsdomene - kampanjeregister, utgiftsledger, attribusjon mot EKSISTERENDE CRM,
CAC/ROAS, eksperimentregister, deterministisk utgifts-avviksdeteksjon. ZERO ekstern
annonseplattform-avhengighet i denne sliceen (ingen provider-credential-parameter finnes i
`GrowthService`/`GrowthTransport`, ingen provider-env-variabel leses noe sted i `modules/growth`).

**Kampanje-metadata som lagres (`marketing_campaigns`):** kanal (enum), navn, status, budsjett,
valgfri ekstern kampanje-ID/peker (pointer-not-payload - ALDRI kopiert kampanjeinnhold fra en
leverandørkonsoll), eier, start-/sluttdato. **BEVISST INGEN selskaps-FK** - en kampanje sikter mot
fremtidige/ukjente leads, ikke én eksisterende kunde (i motsetning til Support/Contracts).

**Utgiftsdata (`marketing_spend_events`):** kampanje-ID, dato, beløp/valuta, klikk/visninger
(valgfritt), kildetype (manual/csv_import/provider_sync - ALDRI en gjettet klassifisering). Kun
aggregerte, deterministiske tall - INGEN personopplysninger om enkeltpersoner som klikket på en
annonse lagres noe sted i denne sliceen (ingen brukersporing/cookie-ID/IP-adresse - se "Ikke i scope"
under).

**Attribusjonsdata (`marketing_attributions`):** polymorf kobling (`entity_type`/`entity_id`) til
EKSISTERENDE `business_leads`/`business_opportunities` - INGEN nye personopplysninger, kun en
peker mellom to allerede eksisterende, allerede DPIA-vurderte entiteter (se Business-Event-Linkage-
seksjonen over for den underliggende lead-/opportunity-personopplysningsvurderingen). Attribusjon
er EKSPLISITT opprettet av kaller (agent/eier) - ALDRI AI-utledet fra fritekst/atferdsdata.

**Eksperimentdata (`marketing_experiments`):** navn/hypotese/status/resultatoppsummering - fritekst
skrevet av eier/agent, IKKE personopplysninger om sluttbrukere/kunder. `result_summary` er
strukturert/menneske-registrert, ALDRI en AI-generert kausal påstand (Q-26-grensen).

**Datakategoriklassifisering:** vekst-/markedsføringsdata (kampanje/utgift/attribusjon/eksperiment)
er FORRETNINGSDATA (samme kategori som `business_open_loops`/`contracts`), IKKE personopplysninger
om identifiserbare fysiske personer utover de allerede eksisterende `business_leads`/
`business_opportunities`-radene attribusjonen PEKER til (uendret databehandlingsgrunnlag der).

**Q-20-interaksjon:** `marketing_campaigns`/`marketing_spend_events`/`marketing_attributions`/
`marketing_experiments`/`marketing_campaign_events` + kampanje-tilknyttede `business_open_loops`-
rader registrert i `modules/erasure/src/plan.ts` FØR noen host-runde (proaktivt anvendt FK-lærdom
fra HOST FIX #1/D-67). Ingen resurrection mulig - en ny kampanje etter erasure får en helt ny
`campaign_id`, strukturelt bevist i `growth-erasure.test.ts`.

**Q-21/RLS:** `FORCE ROW LEVEL SECURITY` + tenant+memory-space-RESTRICTIVE-policy, SAMME mønster som
`business_open_loops`/`contracts` - `jarvis_runtime` UENDRET NOSUPERUSER/NOBYPASSRLS.

**Q-26-grense:** kampanje-/attribusjon-/eksperimentdata er deterministisk beregnet eller eksplisitt
menneske-registrert, ALDRI automatisk "verifisert kunnskap" - CAC/ROAS er ren SQL-aggregering mot
ekte CRM-data, ingen inferert markedsføringsstrategi/kreativ-anbefaling gitt av systemet noe sted i
denne sliceen.

**Ikke i scope denne sliceen (eksplisitt, ikke stille utelatt - se Q-29):** noen live
annonseplattform-connector (Google Ads/Meta Ads/GA4/Search Console/GBP/LinkedIn/YouTube/TikTok);
NOEN form for sluttbruker-/besøkende-sporing (cookies, tracking-piksler, IP-adresser, enhets-ID-er,
retargeting-lister) - dette er en RENT INTERN kampanje-/utgifts-/attribusjonsledger, IKKE en
tracking-infrastruktur; samtykke-/cookie-/databehandlingsdokumentasjon for produksjonssporing
(UA-4 akseptansekriterium 4 - blir relevant FØRST når en faktisk sporingsmekanisme bygges); autonome
budsjett-/bud-endringer; kreativ intelligens/markedsføringsminne; UA-5/UA-6. **Ekte host-
verifisering IKKE fullført i denne økten** (Docker/Windows-host ikke tilgjengelig her) - status
forblir FIXED_SUITE til `ua4-growth-core-host-run.ts` faktisk er kjørt av Tobias.

## Lead-/mulighetsoppdatering og endringslogg (WP-D2, migrasjon 089, FIXED_SUITE / IKKE HOST VERIFIED)

**Formål:** lukke JARVIS-049 (ingen oppdaterings-/produsentverktøy for leads/opportunities) uten å svekke noen sikkerhetsinvariant: opprett, oppdater, flytt mellom
stadier/statuser, sett neste handling, lukk med utfall og slett - alt som TJENESTE (`BusinessPipelineService`) med før/etter-registrering i samme transaksjon.

**Hva som lagres (`business_change_log`):** for HVER faktisk endring én rad med full før- og etter-tilstand (kopier av lead-/opportunity-raden: tittel, selskaps-/kontakt-id,
kilde, beløp, neste handling, lukkegrunn), endrede felt, aktørens person-id (fra den autentiserte identiteten - aldri noe modellen kan oppgi), valgfri `idempotency_key` og en
hash av forespørselen. Raden er en KOPI av kundedata og klassifiseres derfor som kundedata (ikke som append-only systemrevisjon): den følger memory-space-slettingen
(Q-20, `modules/erasure/src/plan.ts`), og `jarvis_app` har DELETE kun for det formålet (ingen UPDATE - raden er uforanderlig for runtime). `audit_events` (append-only, kan ikke
slettes) får derimot ALDRI fritekst: klasse C-handlingene logger en saneret før/etter-snapshot (id-er, status, beløp, datoer og en kort hash av tittelen - aldri tittel,
neste-handling-tekst eller lukkegrunn).

**Hvem kan skrive:** KUN i en bedrifts-tenant (`tenants.kind = 'business'`) og memory space `business`. Handlingene står i chattens HANDLINGSNIVÅ (utføres først etter eierens
bundne bekreftelse), aldri på `MODEL_SURFACE_ALLOWLIST`, og tale/Telegram/bakgrunn/kode har dem ikke. Klasse B: opprett/oppdater/sett neste handling. Klasse C: lukk og slett
(`class_c_no_mandate` for alle andre enn en suveren eier). Sletting detacher avhengige rader (oppfølginger/aktiviteter/muligheter beholdes uten pekeren) og fjerner kun
deriverte rader (open loops, score); polymorfe løse pekere berøres ikke.

**Datakategori/grunnlag/retensjon:** uendret fra Business Graph (kunde-/lead-data, DPIA over); endringsloggen følger kundeforholdet og slettes sammen med memory space.
**Ikke i scope:** ingen automatisk endring - ingenting her kjører uten at eieren har bekreftet handlingen.

## Produktbruk og churn (WP-D2, migrasjon 090, FIXED_SUITE / IKKE HOST VERIFIED)

**Formål:** gi eieren et deterministisk, forklarbart forslag/en opplysning om kundekontoer som risikerer å forlate produktet (churn): inaktivitet, fall i bruk, åpne
supportsaker og forfalte fakturaer. Vurderingen gjelder en KUNDEKONTO (konto -> selskap), aldri en person. Det finnes ingen modellkall, ingen ekstern tjeneste og ingen
automatisk handling: resultatet er en open loop `customer_churn_risk` som situasjonsbroen viser som INFORM (SUGGEST kun ved høy prioritet og confidence >= 0.75). ACT kan bare
komme fra en autonomi-policy EIEREN selv har bundet til domenet `retention` (fravær av policy = ingen auto-ACT).

**Hva som lagres:**
- `product_usage_events`: avsenderens hendelses-id, kilde (`webhook` eller `import:<etikett>`), type (`usage`/`billing_status`), `account_ref`, valgfri `user_ref`, funksjonsnøkkel
  (f.eks. `chat.send`), antall og tidspunkt. `billing_status` bærer antall FORFALTE fakturaer på kontoen (0 = ingen) - ingen beløp, ingen fakturadata.
- `product_usage_accounts`: konto-referanse -> (valgfritt) kundeselskap. Koblingen er eierens valg; en ukoblet konto får ingen vurdering og ingen loop.
- `business_churn_assessments`: siste beregnede vurdering per konto (score 0-100, nivå, signalene som ga den med vekt og begrunnelse, rå aggregerte mål).

**Personvern (dataminimering):** `account_ref` og `user_ref` er PSEUDONYMER avsenderen selv hasher (anbefalt: HMAC-SHA256 med eget salt) - Jarvis kan ikke reversere dem og har
ingen tabell som kobler dem til navn/e-post. Ingen navn, e-post, telefon, IP eller fritekst kan lagres: ukjente felt/kolonner avvises (hele CSV-filen avvises ved en ukjent kolonne),
referanser som ser ut som e-post/telefon-/fødselsnummer/IPv4 avvises i appkoden OG av CHECK-er i databasen (forsvar i dybden). `user_ref` leses av INGEN churn-regel (kun lagret for
«glem bruker» og fremtidig ikke-personlig bruksstatistikk). Faktorkodene er hvitelistet og passerer samme forbudsvakt som lead-/opportunity-scoring (ingen beskyttet trekk-kategori kan
refereres). Churn-vurderingen er kundenivå-prioritering for eieren, ikke automatisert beslutning med rettsvirkning for enkeltpersoner (GDPR art. 22 er ikke utløst); den kan ikke
brukes til å nekte eller endre en tjeneste uten at eieren selv handler.

**Rettslig grunnlag (utkast, IKKE juridisk vurdert):** berettiget interesse (kundeoppfølging/forebygge frafall) for B2B-kontoer; for én-manns-foretak der kontoen i praksis er en
person bør eieren vurdere informasjon til kunden. `PROCESSING_INVENTORY.md` fører raden.

**Retensjon:** rå hendelser slettes automatisk etter 400 dager (`ProductUsageService.purgeExpired`, kjørt i churn-sveipet; eldre hendelser avvises uansett ved innhenting, så
sletting åpner ikke for gjeninnlegging). Vurderingene overskrives ved hver kjøring og slettes når kontoen kobles fra. «Glem bruker» (`forgetUserRef`) nuller `user_ref` på alle
hendelser (volum per konto beholdes). Revisjonsraden (`audit_events`, append-only) bærer kun tellere og en kort hash av konto-pseudonymet - aldri pseudonymet selv - slik at en
sletting av kontoen ikke etterlater pseudonymet i uforanderlig revisjon.

**Innhenting (autentisert, dormant):** (a) `POST /webhooks/product-usage` - HMAC-SHA256-signatur (`X-Jarvis-Signature: t=<unix>,v1=<hex>` over `<t>.<rå kropp>`), ±300 s replay-vindu,
konstant-tid-sammenligning, kropp maks 512 KiB lest FØR signaturen, strengere per-IP-grense, tenant er eier-konfigurert (`JARVIS_PRODUCT_USAGE_TENANT_ID`, må være en bedrifts-tenant) og
aldri avledet fra innholdet; ruten finnes ikke (404) uten tenant-konfigurasjon og svarer 503 uten hemmelighet (minst 32 tegn). (b) CSV/JSONL via `ops/nas/product-usage.sh`
(eierens egen vertshandling, filen på stdin, dry-run som standard). Idempotens: avsenderens hendelses-id er unik per tenant uavhengig av kilde - replay og overlappende import
dobbelttelles aldri; samme id med annet innhold telles som konflikt og anvendes ikke.

**Q-20-interaksjon:** `product_usage_events`, `product_usage_accounts`, `business_churn_assessments` og churn-loops (`loop_type = 'customer_churn_risk'`) er registrert i erasure-planen
(etter `situations`, som peker på loopen). **Q-21/RLS:** FORCE RLS + tenant- og memory-space-RESTRICTIVE-policy; fremmednøkler er tenant-skopede komposittnøkler. **Ikke i scope:**
person-nivå atferdsanalyse, profilering av sluttbrukere, kobling av pseudonymer til personer, automatiske kundehandlinger. **Kalibrering:** terskler og vekter (`churn_risk_v1`) er
FORSLAG (NEEDS_TOBIAS); kalibreringsrapporten (JARVIS-045) sammenligner forutsagt mot utfall og er grunnlaget for en v2.

## Confidence-kalibrering og svarfrist (WP-D2, migrasjon 091, JARVIS-045/082, FIXED_SUITE / IKKE HOST VERIFIED)

**Formål:** (1) gjøre `business_open_loops.confidence` evidensbasert i stedet for en konstant per regeltype, og gi eieren en kalibreringsrapport som sammenligner forutsagt
mot faktisk utfall (JARVIS-045); (2) koble regelen `support_ticket_overdue` til faktiske support-data (JARVIS-082). Ingen modellkall, ingen ekstern tjeneste, ingen automatisk handling.

**Hva som lagres (nye kolonner på `business_open_loops`, ingen ny tabell):** `resolution_outcome` (`acted`/`dismissed` satt av eieren/operatøren ved manuell lukking, `condition_cleared` satt av
sveipet), `confidence_basis` (hvorfor tallet ble som det ble: grunnverdi, hver justering med kode/delta/begrunnelse, tak, kalibrering) og `closure_history` (tidligere MERKEDE lukkinger
av en loop som siden er gjenåpnet: utfall, confidence ved lukking og tidspunkt, maks 100). Kolonnene bærer ingen persondata - kun kategorier, tall og tidspunkt - og følger raden (FORCE
RLS, tenant + memory space) og memory space-slettingen (Q-20). `closure_history` finnes bevisst: uten den ville et merket utfall forsvunnet da samme vilkår gjenåpnet loopen, og kun
lukkinger som faktisk løste saken ville overlevd som kalibreringsgrunnlag (survivorship - «avvist, men vilkåret holder» ville blitt usynlig og treffraten overvurdert).

**Hvordan confidence beregnes (`loop_confidence_v1`, forslag - NEEDS_TOBIAS):** grunnverdi (0.9 hardt faktum / 0.7 heuristikk) + kun tillegg for persistens, forfallsstørrelse, uavhengig
bekreftelse fra ANDRE domener hos samme kunde og flere uavhengige signalfamilier i regelen selv. En heuristikk kan IKKE nå situasjonsmotorens SUGGEST-terskel (0.75) på tilleggene alene
(tak 0.74) - retten til å foreslå må fortjenes av data (minst 20 merkede utfall og observert treffrate >= 0.75). Kalibreringen kan også SENKE confidence (observert treffrate lavere enn
forutsagt). Utfall er eierens egen merking; en loop lukket uten utfall, eller som forsvant av seg selv, teller verken som treff eller bom. Rapporten endrer ingenting av seg selv.

**Automatiserte beslutninger (GDPR art. 22):** ikke utløst - tallene prioriterer oppmerksomhet for eieren; SUGGEST/INFORM er forslag, og auto-ACT finnes kun via en autonomi-policy EIEREN selv har bundet.

**Svarfrist («SLA») for supportsaker:** `support_ticket_overdue` utleder fristen fra siste UBESVARTE kundemelding i `support_ticket_events` (ingen `agent_reply` etter den; et internt notat
besvarer ikke kunden; `waiting_customer` har ingen klokke) + et vindu per prioritet (kalenderstimer; forslag urgent 4 t, high 8 t, normal 24 t, low 72 t; `JARVIS_SUPPORT_SLA_HOURS`
overstyrer, `off` slår av utledningen). Regelen leser data den allerede behandler (supportsaker) og lagrer ingenting nytt; den utledede fristen blir loopens `due_at`. Ingen ny
behandling, ingen ny mottaker.
