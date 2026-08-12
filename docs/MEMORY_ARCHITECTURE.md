# Jarvis – minnearkitektur

**Status:** Utkast v1.0. Ved motstrid gjelder [CANONICAL_SPEC.md](CANONICAL_SPEC.md).

## 1. Prinsipper

1. **Hybrid, ikke enkeltteknologi.** Ren pgvector er eksplisitt forkastet som eneste løsning. Minnet
   kombinerer strukturert SQL, fulltekst, embeddings, relasjoner og sammendrag – med reranking på topp.
2. **Databasen er autoritativ.** Mappeeksporten er en generert visning for mennesker og backup.
3. **Ingenting slettes stille.** Motstrid versjoneres og markeres; råkilden bevares ved komprimering.
4. **Alt minne er merket.** Eier, tenant, memory space, kilde, tid, sensitivitet, tillit, konfidens, versjon,
   relasjoner og retensjonsregel er obligatoriske felt – ikke valgfrie.
5. **Karantene før tillit.** Ubetrodd innhold (e-post, web, verktøyoutput) blir aldri autoritativt minne uten
   å passere skriveflytens kontroller.

## 2. Minnelagene

| # | Lag | Teknologi | Formål |
|---|---|---|---|
| 1 | Rå hendelseslogg | Postgres (append-only `events`) + objektlagring for store vedlegg | Original sannhet: meldinger, møter, dokumenter, verktøyoutput |
| 2 | Strukturert sannhet | Postgres-tabeller | Personer, organisasjoner, prosjekter, beslutninger, oppgaver, frister |
| 3 | Fulltekstsøk | Postgres `tsvector`/GIN (norsk + engelsk konfigurasjon) | Eksakte navn, uttrykk, datoer, dokumentinnhold |
| 4 | Vektorsøk | pgvector (HNSW-indeks) | Semantisk likhet på minner og samtaler |
| 5 | Relasjonslag | Postgres `entities` + `relations` | Kanter mellom personer, prosjekter, avtaler, hendelser; flerhoppspørringer med rekursiv SQL |
| 6 | Sammendragslag | Genererte `summaries` (dag/uke/prosjekt/langtid) | Komprimert kontekst for lange tidsrom |
| 7 | Reranking | Kode + ev. liten modell | Kombinerer tekst-, vektor-, relasjons-, tids-, kilde- og autoritetssignal |

Egen grafdatabase (Neo4j o.l.) innføres **kun** hvis minne-evalen viser at flerhoppspørringer ikke løses
godt nok i Postgres. Dette er et målepunkt, ikke en antakelse.

## 3. Minnetyper

| Type | Innhold | Eksempel |
|---|---|---|
| Working | Aktiv samtaletilstand | «Vi snakker om hyttebudsjettet» |
| Episodisk | Tidfestede hendelser | «12. aug 2026 godkjente Tobias fase 1» |
| Semantisk | Tidløse fakta | «Dennis er kunde hos Kundeoppfølging AS» |
| Prosedyre | Hvordan ting gjøres | «Deploy av nettsiden krever X» |
| Preferanse | Stil og valg | «Tobias vil ha korte svar om morgenen» |
| Relasjon | Mellom mennesker/ting | «Person A er leverandør for prosjekt B» |
| Prosjekt | Kontekst per prosjekt | Krav, beslutninger, status |
| Operativt | Systemtilstand | Enheter, integrasjonsstatus |
| Beslutning/forpliktelse | Hva som er lovet/vedtatt, med frist | `decisions`, `commitments`, `deadlines` |
| Arkiv | Komprimert historikk | Eldre samtaler med peker til råkilde |

## 4. Memory spaces og tilgang

`personal`, `business`, `project`, `health`, `home`, `guest`, `shared`.

- Hvert space har egne tilgangsregler; `business` har i tillegg egne nøkler og revisjonslogg per tenant.
- Context Builder må ha eksplisitt space-tillatelse per forespørsel; standard er minst mulig.
- `health`: behandles lokalt eller sterkt minimert; aldri i generelle agentjobber; aldri til eksterne modeller
  uten pseudonymisering og dokumentert grunnlag.
- `guest`: kortvarig, isolert; ingen lesetilgang til Tobias sitt private minne.
- Row Level Security i Postgres håndhever tenant- og space-grenser i databasen – ikke bare i applikasjonskoden.

## 5. Datamodell (kjernetabeller)

```
Identitet:  people, organizations, tenants, projects, devices, sites, rooms
Samtale:    sessions, messages, events (append-only)
Minne:      memory_spaces, memory_items, memory_versions, memory_sources,
            entities, relations, summaries, embeddings
Forplikt.:  decisions, commitments, deadlines
Jobber:     tasks, task_runs, agent_runs, tool_calls, artifacts
Sikkerhet:  capabilities, approvals, audit_events, security_incidents
Økonomi:    cost_events
```

Obligatoriske felt på `memory_items`: `owner_person_id`, `tenant_id`, `memory_space_id`, `source_id`,
`observed_at`, `valid_from`/`valid_to` (bitemporalitet: når det var sant, ikke bare når det ble lagret),
`sensitivity`, `trust_level`, `confidence`, `version`, `retention_rule`.

## 6. Skriveflyt (Memory Writer)

1. Rådata lagres i `events` med kilde og tillitsklasse.
2. Ubetrodd verktøy-/weboutput merkes `quarantined` – synlig for søk med tydelig merking, men uten autoritet.
3. Memory Writer foreslår `ADD` / `UPDATE` / `INVALIDATE` / `NOOP`.
4. Kandidat sammenlignes med eksisterende fakta og relasjoner (dedup + konfliktdeteksjon).
5. Motstrid markeres og versjoneres – aldri stille overskriving.
6. Sensitivitet og memory space fastsettes **før** lagring.
7. Embedding og søkeindekser oppdateres.
8. Fakta over konfigurert viktighetsterskel krever sterkere kilde eller menneskelig godkjenning.
9. Komprimering av gamle hendelser bevarer alltid peker til råkilden.

## 7. Lesesti (Context Builder)

1. Autorisasjon: hvilke memory spaces har denne forespørselen lov til å lese?
2. Parallelle søk: strukturert oppslag + fulltekst + vektor + relasjonsutvidelse (1–2 hopp).
3. Tidsfilter: `valid_from`/`valid_to` mot spørsmålets tidsreferanse.
4. Reranking: tekstscore, vektorscore, relasjonsnærhet, ferskhet, kildeautoritet, tillitsnivå.
5. Tokenbudsjett: viktigste elementer først; sammendrag der detaljene ikke får plass.
6. Resultatet merkes med kilder, slik at Jarvis kan oppgi hvor et faktum kommer fra.

## 8. Menneskelesbar eksport

Generert fra databasen (enveis):

```
memory/people/tobias/{profile,personal,health,business/<company_id>,
                      projects/<project_id>,decisions,commitments}/
memory/sites/<site_id>/
memory/conversations/<year>/<month>/
memory/archive/
```

Eksporten kjøres periodisk og ved behov; den inngår i backupplanen, men er aldri skrivekilde.

## 9. Evaluering (port før høy autoritet)

Eget eval-sett med 50–100 spørsmål fra Tobias sin faktiske historikk, som måler:

- korrekthet og kildeangivelse
- tidsforståelse («hva var sant i mars?»)
- tilgangsgrenser (space-/tenant-nekt skal skje)
- gjenfinning av motstrid (begge versjoner synlige)
- **null kryss-tenant-lekkasje** (absolutt krav)

Evalen kjøres som automatisert testsuite og gjentas ved endringer i retrieval eller skriveflyt.

## 10. Retensjon og sletting

- Retensjonsregel er obligatorisk per minne; standardregler per space og sensitivitet.
- Sletting (GDPR/innsyn/retting) implementeres som kryptografisk sletting eller hard delete i alle lag
  (rådata, indekser, embeddings, sammendrag, eksport) med audit-spor av at slettingen skjedde.
- Rå romlyd lagres aldri kontinuerlig; midlertidige lydbuffere har kort, dokumentert levetid.
