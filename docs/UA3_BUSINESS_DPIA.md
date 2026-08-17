# UA-3 P0 — DPIA / data-governance-notat (Business Domain Foundation)

**Status:** UA-3 P0 «Business Domain Foundation» = FIXED_SUITE / READY_FOR_HOST_VERIFY (2026-08-17, se
D-49 i DECISIONS_AND_ASSUMPTIONS.md). Dette notatet dekker den NYE, strukturerte tredjeparts-
persondata-kategorien UA-3 P0 introduserer (kunde-/kontakt-/selskapsdata i `business_*`-tabellene) -
utfyller, erstatter ikke, `docs/security/DPIA_DRAFT.md` sin generelle "Bedriftsdata (kunder, e-post)"-
rad (som forble ufullstendig detaljert siden ingen strukturert forretningsmodell fantes før nå).

## Hvilke data lagres

| Tabell | Datakategori | Eksempel på innhold |
|---|---|---|
| `business_companies` | Selskapsnavn, domene, status, kilde, eier | "Acme AS", "acme.no", "prospect" |
| `business_contacts` | **Tredjeparts persondata:** navn, e-post, telefon, tittel, tilhørende selskap | "Kari Nordmann", "kari@acme.no", "+47..." - EKTE personopplysninger om personer HOS kunden/selskapet, ikke Tobias selv |
| `business_leads` | Lead-tittel, status, kilde-referanse (source_type/source_instance_id/external_id) | "Interessert i tjeneste X", "new" |
| `business_opportunities` | Deal-tittel, pipeline-stadium, beløp (øre), valuta, forventet lukkedato | "Acme - tjeneste X", "qualified", 500000 |
| `business_activities` | Aktivitetstype, KORT strukturert sammendrag, kilde-peker (`canonical_uri` - ALDRI kopi av fullt innhold) | "E-post mottatt", peker til Knowledge-dokument/ekstern kilde |
| `business_followups` | Oppgave-tittel, frist, prioritet, status, eier, årsak, neste handling | "Send tilbud", forfallsdato, "open" |

**Kritisk arkitekturprinsipp (§15 i byggeordren):** `business_activities.canonical_uri` er en LØS PEKER
til Knowledge/eksterne kilder - UA-3 P0 kopierer ALDRI fulle e-post-kropper, dokumentinnhold eller
samtaleutskrifter inn i egne tabeller. Selve innholdet forblir i Knowledge (UA-2) eller hos den
eksterne kilden; Business OS lagrer kun strukturert state + en peker.

## Datakategoriklassifisering (§26/§27 i byggeordren)

| Kategori | Tabeller | Retensjon/sletting |
|---|---|---|
| **CONTENT** (tredjeparts persondata Tobias/selskapet er behandlingsansvarlig for) | `business_contacts` (navn/e-post/telefon) | Slettes ved eksplisitt forespørsel (fremtidig D-klasse-operasjon, IKKE bygget i P0 - se Q-25). Ingen automatisk retensjonsgrense satt i P0 - operasjonell forretningsdata, ikke midlertidig cache |
| **OPERATIONAL METADATA** (relasjonens tilstand, ikke selve kildeinnholdet) | `business_companies`/`business_leads`/`business_opportunities`/`business_activities`/`business_followups` | Retained ved Q-20-sletting av et REFERERT Knowledge-dokument (ingen FK - se under). Slettes/anonymiseres KUN sammen med hele tenanten (samme mønster som øvrige tenant-scopede tabeller) |
| **AUDIT-EVENT** | `audit_events`-rader for `tool_id='business'` | Append-only (uendret fra eksisterende audit-arkitektur), inneholder ALDRI navn/e-post/telefon (kun `credential_ref`/`external_id`/`scopes`/`rollback` - verifisert i `business-transport-wiring.test.ts` §N) |

## Q-20-interaksjon (§26 i byggeordren)

`business_activities.canonical_uri` har INGEN fremmednøkkel (FK) til `knowledge_documents` - kun en løs
tekst-peker (strukturelt bevist i `business-service.test.ts` §S/T). Konsekvens: en fremtidig Q-20-hard-
sletting av et Knowledge-dokument en aktivitet peker til gjør pekeren ganske enkelt ustabil/ikke-
oppløsbar - ALDRI en cascade-feil, ALDRI en database-konstraint-krasj, og ALDRI en vei til å
"gjenopplive" det slettede innholdet (aktiviteten selv inneholder kun det korte, allerede lagrede
sammendraget - ikke kildens fulle tekst). Ingen kompleks cascade-slette-logikk er bygget, siden ingen
FK-relasjon finnes å cascade fra - dette er en BEVISST designbeslutning (D-49), ikke et overset gap.

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

## Ikke i scope for P0 (se Q-25 for full liste)

Ingen AI Mesh-basert profiling/scoring er bygget i P0 - masterplanens fjerde UA-3-akseptansekriterium
("Profiling/scoring used with documented legal/human controls where required") er derfor IKKE
relevant for denne DPIA-en ennå; når scoring faktisk bygges (fremtidig UA-3-slice) må denne seksjonen
oppdateres med de juridiske/menneskelige kontrollene kriteriet krever.
