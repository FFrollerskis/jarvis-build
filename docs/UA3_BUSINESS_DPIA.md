# UA-3 — DPIA / data-governance-notat (Business Domain Foundation + Open-Loop Detection + Business-Event-Linkage)

**Status:** UA-3 P0 «Business Domain Foundation» = VERIFIED/COMPLETE (D-52, host-bevist run_id
`ca2d9248`). UA-3 «Open-Loop Detection + Daily/Weekly Business Brief» = VERIFIED/COMPLETE (2026-08-17,
host-bevist run_id `de01ca07`, se D-53/D-54/D-55/D-56 i DECISIONS_AND_ASSUMPTIONS.md). UA-3
«Business-Event-Linkage (Gmail/Calendar → Business OS)» = VERIFIED/COMPLETE (2026-08-17, host-bevist
run_id `6c6a4948`, `hard_fail=false`, se D-57/D-58/D-59/D-60). Personvernsgarantiene under (ingen
Gmail-body/emne/deltakerinnhold i `business_activities`, kun kilde-peker) er nå bekreftet LIVE via
`ua3_events_no_body_content_stored=PASS` og `ua3_events_audit_safe=PASS` på ekte host, ikke kun
suite-bevist.
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

**Kritisk arkitekturprinsipp (§15 i byggeordren):** `business_activities.canonical_uri` er en LØS PEKER
til Knowledge/eksterne kilder - UA-3 P0 kopierer ALDRI fulle e-post-kropper, dokumentinnhold eller
samtaleutskrifter inn i egne tabeller. Selve innholdet forblir i Knowledge (UA-2) eller hos den
eksterne kilden; Business OS lagrer kun strukturert state + en peker.

## Datakategoriklassifisering (§26/§27 i byggeordren)

| Kategori | Tabeller | Retensjon/sletting |
|---|---|---|
| **CONTENT** (tredjeparts persondata Tobias/selskapet er behandlingsansvarlig for) | `business_contacts` (navn/e-post/telefon) | Slettes ved eksplisitt forespørsel (fremtidig D-klasse-operasjon, IKKE bygget i P0 - se Q-25). Ingen automatisk retensjonsgrense satt i P0 - operasjonell forretningsdata, ikke midlertidig cache |
| **OPERATIONAL METADATA** (relasjonens tilstand, ikke selve kildeinnholdet) | `business_companies`/`business_leads`/`business_opportunities`/`business_activities`/`business_followups`/`business_open_loops` (NY, D-53 - automatisk derivert, ikke en ny inntaksvei) | Retained ved Q-20-sletting av et REFERERT Knowledge-dokument (ingen FK - se under). Slettes/anonymiseres KUN sammen med hele tenanten (samme mønster som øvrige tenant-scopede tabeller) |
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

## Ikke i scope for P0 eller NEXT SLICE (se Q-25 for full liste)

Ingen AI Mesh-basert profiling/scoring er bygget i P0 ELLER i UA-3 NEXT SLICE (D-53) -
masterplanens fjerde UA-3-akseptansekriterium ("Profiling/scoring used with documented legal/human
controls where required") er derfor FORTSATT IKKE relevant for denne DPIA-en; D-53s `priority`-felt
(low/normal/high på open loops) er en enkel, deterministisk, dokumentert regel basert på forfalt-/
stagnert-varighet - IKKE kunde-/persontrekk-scoring, og utleder ALDRI sensitive kategorier
(helse/etnisitet/religion/politikk osv.) om noen person. Når faktisk scoring bygges (fremtidig
UA-3-slice) må denne seksjonen oppdateres med de juridiske/menneskelige kontrollene kriteriet krever.
