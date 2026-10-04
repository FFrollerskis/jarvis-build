# Jarvis – minnearkitektur

**Status:** v2.0 (D-386, 2026-10-04). Ved motstrid gjelder [CANONICAL_SPEC.md](CANONICAL_SPEC.md). Implementasjonen bor i
`modules/memory/`; skjema i `modules/core/src/db/migrations/008_memory.sql` + `068_memory_v2.sql`. Det som står her som
«implementert» er bevist av tester i `modules/memory/test/` (ekte embedded Postgres uten pgvector); drift på NAS med pgvector og
ekte Ollama-embedding er egen verifikasjon (se D-386).

## 1. Prinsipper

1. **Hybrid, ikke enkeltteknologi.** Ren pgvector er eksplisitt forkastet som eneste løsning. Minnet
   kombinerer strukturert SQL, fulltekst, embeddings, relasjoner og sammendrag – med reranking på topp.
2. **Databasen er autoritativ.** Mappeeksporten er en generert visning for mennesker og backup.
3. **Ingenting slettes stille.** Motstrid versjoneres og markeres; råkilden bevares ved komprimering.
4. **Alt minne er merket.** Eier, tenant, memory space, kilde, tid, sensitivitet, tillit, konfidens, versjon,
   relasjoner og retensjonsregel er obligatoriske felt – ikke valgfrie.
5. **Karantene før tillit.** Ubetrodd innhold (e-post, web, verktøyoutput) blir aldri autoritativt minne uten
   å passere skriveflytens kontroller.
6. **Verbatim først (D-386).** Eierens egne ord lagres og indekseres ordrett (episoder); uttrukne fakta er struktur *oppå*
   verbatim tekst, aldri en erstatning, og peker tilbake på ytringen de kom fra.
7. **Ett lokalt vektorrom (D-386).** Embedding-modellen for minnet er alltid lokal (Ollama på eierens utstyr); sky-embedding
   er avvist fordi helse-/finansminne aldri skal dit og fordi to usammenlignbare vektorrom er ubrukelige.

## 2. Minnelagene

| # | Lag | Teknologi | Formål | Status v2 |
|---|---|---|---|---|
| 1 | Rå hendelseslogg | `events` (append-only) + **`memory_episodes`** (verbatim eierytringer, tsvector + vektor) | Original sannhet: meldinger, møter, dokumenter, verktøyoutput | episoder implementert for samtale |
| 2 | Strukturert sannhet | Postgres-tabeller | Personer, organisasjoner, prosjekter, beslutninger, oppgaver, frister | `decisions/commitments/deadlines` finnes, skrives ennå ikke fra uttrekket (flatet til `memory_items` med type) |
| 3 | Fulltekstsøk | `tsvector`/GIN (norsk) + **`keywords_fts`** (eksakte navn/steder) | Eksakte navn, uttrykk, datoer | ELLER-spørring over innholdsord (`queryTerms`), ikke OG |
| 4 | Vektorsøk | **`memory_vectors`** (modellbevisst; pgvector HNSW per dimensjon 64/768/1024) | Semantisk likhet på items, episoder og sammendrag | `OllamaEmbedding` (bge-m3) anbefalt; `LocalHashEmbedding` kun fallback |
| 5 | Relasjonslag | `entities` + `relations` + **`memory_links`** | Kanter mellom personer, prosjekter, avtaler; 1 hopp i SQL | uttrekket emitterer entiteter; `memory_links` har skjema, fylles i senere slice |
| 6 | Sammendragslag | `summaries` (fts + vektor + `evidence_item_ids`) | Komprimert kontekst for lange tidsrom | LLM-generert dagssammendrag, lesbart i retrieveren |
| 7 | Reranking | Kode | RRF-fusjon → viktighet × ferskhet (sist brukt) → tillit → tid | implementert |
| 8 | Profil (D-386) | **`memory_profiles`** | Alltid-tilstede, deterministisk kompilert eierprofil per space | implementert |

Egen grafdatabase (Neo4j o.l.) innføres **kun** hvis minne-evalen viser at flerhoppspørringer ikke løses
godt nok i Postgres (Q-10). Dette er et målepunkt, ikke en antakelse.

## 3. Minnetyper

| Type | Innhold | Eksempel |
|---|---|---|
| Working | Aktiv samtaletilstand | «Vi snakker om hyttebudsjettet» |
| Episodisk | Tidfestede hendelser (ryddes/konsolideres etter 60 dager) | «12. aug 2026 godkjente Tobias fase 1» |
| Semantisk | Tidløse fakta | «Dennis er kunde hos Kundeoppfølging AS» |
| Prosedyre | Hvordan ting gjøres | «Deploy av nettsiden krever X» |
| Preferanse | Stil og valg | «Tobias vil ha korte svar om morgenen» |
| Relasjon | Mellom mennesker/ting | «Person A er leverandør for prosjekt B» |
| Prosjekt | Kontekst per prosjekt | Krav, beslutninger, status |
| Operativt | Systemtilstand | Enheter, integrasjonsstatus |
| Beslutning/forpliktelse | Hva som er lovet/vedtatt, med frist (`valid_from` = hendelsestid) | «Tannlege fredag 9. okt» |
| Arkiv | Komprimert historikk | Eldre samtaler med peker til råkilde |

Hvert item har i tillegg (D-386): `importance` 1–10, `keywords[]`, `last_accessed_at`/`access_count`, `event_time_raw`,
`evidence_episode_id`.

## 4. Memory spaces og tilgang

`personal`, `business`, `project`, `health`, `home`, `guest`, `shared`.

- Hvert space har egne tilgangsregler; `business` har i tillegg egne nøkler og revisjonslogg per tenant.
- Context Builder må ha eksplisitt space-tillatelse per forespørsel; standard er minst mulig. (I dag: identitetens ene space.)
- `health`: behandles lokalt eller sterkt minimert; aldri i generelle agentjobber; aldri til eksterne modeller
  uten pseudonymisering og dokumentert grunnlag. **Sensitivitet avgjøres av innholdet før lagring** (D-386): helse-/finans-/
  hemmelighetssignaler gir `special` uansett space; `special` tas kun med i kontekst ved direkte treff (D-384), er aldri i profilen
  og konsolideres aldri inn i sammendrag.
- `guest`: kortvarig, isolert; ingen lesetilgang til Tobias sitt private minne.
- Row Level Security i Postgres håndhever tenant- og space-grenser i databasen – ikke bare i applikasjonskoden
  (også for `memory_vectors`, `memory_episodes`, `memory_profiles`, `memory_links`).

## 5. Datamodell (kjernetabeller)

```
Identitet:  people, organizations, tenants, projects, devices, sites, rooms
Samtale:    sessions, messages, events (append-only)
Minne:      memory_spaces, memory_items, memory_versions, memory_sources, memory_episodes,
            memory_vectors, memory_profiles, memory_links, entities, relations, summaries
            (embeddings = frosset v1-tabell, kun historikk)
Forplikt.:  decisions, commitments, deadlines
Jobber:     tasks, task_runs, agent_runs, tool_calls, artifacts
Sikkerhet:  capabilities, approvals, audit_events, security_incidents
Økonomi:    cost_events
```

Obligatoriske felt på `memory_items`: `owner_person_id`, `tenant_id`, `space`, `source_id`, `observed_at`,
`valid_from`/`valid_to` (bitemporalitet: når det var sant, ikke bare når det ble lagret), `sensitivity`, `trust_level`,
`confidence`, `version`, `retention_rule`, `importance`.

`memory_vectors` har én rad per (ref_kind, ref_id, **model**); søk filtrerer alltid på gjeldende modell og dimensjon.
`runMemoryReembedSweep` fyller etter modellbytte eller nedetid i embedding-tjenesten.

## 6. Skriveflyt (Memory Writer)

1. Trivielle ytringer (hilsen/bekreftelse/for kort) og rask-bane-kommandoer går aldri til uttrekk.
2. Eierens betrodde ytring lagres verbatim som episode (dedupe per sesjon) – med vektor.
3. Ubetrodd verktøy-/weboutput og innlimt tekst merkes `quarantined` – synlig for eieren, uten autoritet.
4. Uttrekket (LLM, strukturert svar) får observasjonsdato, de siste turene (DATA) og relevante eksisterende minner (DATA; semantiske
   naboer først), og foreslår per kandidat: type, normalisert `subject`, innhold, konfidens, nøkkelord, viktighet, hendelsestid
   (absolutt), `op` (`ADD`/`INVALIDATE`), `contradicts`, entiteter.
5. Kandidat sammenlignes med eksisterende fakta på `(type, subject)` og eksakt innhold (dedup + konfliktdeteksjon).
6. Motstrid markeres og versjoneres – aldri stille overskriving. `has_conflict` kun ved reell motstrid.
7. Sensitivitet (innholdsbasert) og memory space fastsettes **før** lagring.
8. Embedding (lokal) og søkeindekser oppdateres; en embedding-feil velter aldri lagringen.
9. Konfidens under 0,5 fra betrodd kilde ⇒ karantene (eieren godkjenner i dashbordet). Eierens betrodde ord overstyrer en
   karantenert rad for samme emne.
10. Negasjon (`INVALIDATE`) invaliderer det eksisterende minnet (versjonert), aldri sletting.
11. Komprimering (60 dagers episodisk konsolidering) bevarer peker til råkilden og rører aldri `special`.
12. Profilen rekompileres etter relevante skrivinger.

## 7. Lesesti (Context Builder)

1. Autorisasjon: hvilke memory spaces har denne forespørselen lov til å lese?
2. Spørringsforberedelse: innholdsord (stoppord ut) → ELLER-tsquery; spørringsvektor fra samme lokale modell.
3. Parallelle legg: fulltekst + nøkkelord + vektor over items, episoder og sammendrag.
4. Fusjon: reciprocal rank fusion (k = 60) → score = 0,6·relevans + 0,2·ferskhet (eksp. forfall, 90 d fra sist brukt) +
   0,2·viktighet/10 (+0,05 betrodd).
5. Relasjons-/lenkeutvidelse (1 hopp), tidsfilter (`valid_from`/`valid_to` mot spørsmålets tidsreferanse, versjoner med ekte
   proveniens), versjoner ved motstrid.
6. Tokenbudsjett (1200 chat / 500 tale): profil først (maks 400 tokens), så kommende forpliktelser, så treff i rangert rekkefølge.
7. Strengt minne (helse/`special`) kun ved direkte treff; svake treff holdes helt utenfor (D-384).
8. Items som returneres får `last_accessed_at`/`access_count` – ting eieren vender tilbake til holder seg varme.
9. Resultatet merkes med type, dato og kilde, slik at Jarvis kan oppgi hvor et faktum kommer fra.

## 8. Menneskelesbar eksport

Generert fra databasen (enveis):

```
memory/people/tobias/{profile,personal,health,business/<company_id>,
                      projects/<project_id>,decisions,commitments}/
memory/sites/<site_id>/
memory/conversations/<year>/<month>/
memory/archive/
```

Eksporten kjøres periodisk og ved behov; den inngår i backupplanen, men er aldri skrivekilde. (`MemoryExporter` er bygget,
ikke koblet til en jobb – JARVIS-060.)

## 9. Evaluering (port før høy autoritet)

- `ops/memory/embedding-eval-live.ts` (D-386): 40 norske fakta/parafrase-par mot den konfigurerte embedding-provideren;
  rapporterer recall@1/@3 og latens, PASS ved recall@3 ≥ 0,85. Kjøres på NAS mot ekte Ollama; resultatet limes inn i D-loggen.
- Eget eval-sett med 50–100 spørsmål fra Tobias sin faktiske historikk (ikke bygget – krever eksport av reell historikk), som måler
  korrekthet og kildeangivelse, tidsforståelse («hva var sant i mars?»), tilgangsgrenser, gjenfinning av motstrid og
  **null kryss-tenant-lekkasje** (absolutt krav; testet i `memory.test.ts`).

Evalen gjentas ved endringer i retrieval eller skriveflyt.

## 10. Retensjon og sletting

- Retensjonsregel er obligatorisk per minne; standardregler per space og sensitivitet (kolonnen finnes; regelmotoren er ikke bygget).
- Sletting (GDPR/innsyn/retting) implementeres som hard delete i alle lag (rådata, episoder, vektorer, profil, lenker, indekser,
  sammendrag, eksport) med audit-spor av at slettingen skjedde (`modules/erasure/src/plan.ts` dekker alle minnetabellene).
- Rå romlyd lagres aldri kontinuerlig; midlertidige lydbuffere har kort, dokumentert levetid.
