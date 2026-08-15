# UA-2 P0 — DPIA / data-governance-notat (kunnskaps-ingestion)

**Status:** UA-2 P0 (GitHub + filesystem/NAS-kilder). Kort og teknisk, ikke juridisk teater — oppdateres
ved hver ny kildetype (P1: Obsidian/Pieces/Drive/e-post/møtetranskripsjon får hver sitt tillegg her).

## Hvilke data ingestes

| Kilde | Datakategori | Eksempel på innhold |
|---|---|---|
| GitHub (`GithubKnowledgeSource`) | Repo-metadata (navn, beskrivelse, standard-branch) + åpne issues (tittel, tidsstempel) | Prosjektdokumentasjon, oppgavetekst — **untrusted ingestion** (samme klassifisering som `read_issues` alt hadde i Tool Gateway) |
| Filesystem/NAS (`FilesystemKnowledgeSource`) | Tekstbaserte filer i eksplisitt allowlistede roots (`.md`, `.txt`, `.json`, `.yaml/yml`, `.ts/js/tsx/jsx`, `.py`, `.sql`, `.html`, `.css`) | Notater, kode, konfigurasjon — kan inneholde persondata Tobias selv har lagret i disse filene |

**Ingen** binærdata/OCR/bilder/PDF ingestes i P0 (§14 i BO — bevisst utsatt).

## Hvor de lagres

Postgres, samme database/instans som resten av Jarvis (`knowledge_documents` + `knowledge_embeddings`,
migrasjon `017_knowledge.sql`) — **ingen ny database introdusert**. Full tekst + en embedding-vektor
per dokument. Rå filinnhold fra NAS/GitHub kopieres inn i `content`-kolonnen (nødvendig for FTS/vector-
retrieval); dette er en KOPI, ikke en peker — kilden forblir "sannheten" (`canonical_uri`), Jarvis sin
kopi oppdateres/tombstones ved sync.

## Hvilket tenant/memory-space de tilhører

Hver ingestion kjøres eksplisitt for én `tenant_id` + ett `memory_space_id` (samme
`personal/business/project/health/home/guest/shared`-enum som resten av minnesystemet). Database-RLS
(samme mønster som `memory_items`, `008_memory.sql`) håndhever isolasjon i databasen — ikke bare i
applikasjonskoden. Testbevist (`knowledge-fundament.test.ts`, §7.G/§7.H): tenant A kan aldri hente
tenant B sitt innhold; søk i `personal` finner aldri `business`-space-innhold og omvendt.

## Hvordan sletting/tombstones fungerer

Forsvinner et dokument fra kilden ved neste sync (fil slettet, issue lukket/forsvunnet fra listingen):
raden markeres `deleted=true, deleted_at=<tidspunkt>` — **aldri hard-slettet**. Tombstonede dokumenter
filtreres bort fra all normal retrieval (`KnowledgeRetriever.search()` har `WHERE deleted = false`
hardkodet i begge spørringene). Dukker samme eksterne dokument opp igjen senere (samme `external_id`),
reaktiveres raden deterministisk (samme `knowledge_document_id`, `deleted=false`) — historikken
(opprinnelig opprettelsestidspunkt, tidligere versjoner via `version`-telleren) er ikke tapt.

En fullstendig hard-slette-vei (for GDPR-slettekrav på persondata funnet i ingestet innhold) er **ikke
bygget i P0** — dette er dokumentert som gap, ikke løst stille: se Q-20 i OPEN_QUESTIONS.md.

## Hvordan source credentials håndteres

GitHub-kilden bruker **eksisterende** `ToolGateway`-vei (samme `SecretProvider`/`JARVIS_GITHUB_TOKEN`
som `read_issues` alt brukte) — ingen ny credential-type, ingen nytt OAuth-scope. Filesystem-kilden
krever ingen credential i det hele tatt (lokal filsystemtilgang, begrenset av OS-brukerens egne
rettigheter + den eksplisitte allowlistede roten). `KnowledgeRecord.metadata` er strukturelt umulig å
legge credentials i uten et bevisst brudd på kontrakten — feltet fylles kun med trusted provenance
(f.eks. `default_branch`, `is_pr`), aldri fra credential-verdier. Ingen secrets logges (verifisert:
GithubTransport logger aldri `credential`-parameteret; sync/retrieval-koden rører aldri credentials).

## Hvordan en kilde kan kobles fra

Ingen aktiv sync = ingen nye/oppdaterte dokumenter. Eksisterende ingestede dokumenter for den kilden
forblir søkbare til enten (a) en ny sync-kjøring naturlig tombstoner dem (fordi de ikke lenger finnes i
en fersk listing), eller (b) en fremtidig eksplisitt "koble fra kilde"-operasjon masse-tombstoner alt
fra en `source_instance_id` (ikke bygget i P0 — enkel å legge til: `UPDATE knowledge_documents SET
deleted=true, deleted_at=now() WHERE tenant_id=$1 AND source_instance_id=$2`, samme mønster som den
eksisterende tombstone-logikken i `sync.ts`).

## Hvordan re-sync fungerer

Idempotent (§9 i BO): `KnowledgeSyncService.sync()` kan kjøres vilkårlig mange ganger. Uendret kilde →
ingen duplikater, ingen re-embedding (testbevist: `embedding.calls` uendret ved uendret resync). Endret
dokument → samme canonical rad oppdateres in-place (`version` økes), ny embedding beregnes. Kilde-
kredittering skjer PER SYNC-KJØRING (`source.list()` er et øyeblikksbilde) — det finnes ingen
kontinuerlig/webhook-drevet sync i P0 (dokumentert P1-utvidelse).

## Regresjon/isolasjon verifisert

`modules/knowledge/test/knowledge-fundament.test.ts` og `filesystem-source.test.ts` beviser (ekte
embedded Postgres, ekte filsystem-I/O): canonical identity/dedupe, tombstone/reaktivering,
tenant-isolasjon, memory-space-isolasjon, filsystem-allowlist, path-traversal-DENY, symlink-escape-DENY.
