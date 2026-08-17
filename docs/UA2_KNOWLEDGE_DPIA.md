# UA-2 P0/P1A/P1B-A — DPIA / data-governance-notat (kunnskaps-ingestion)

**Status:** UA-2 «Universal Knowledge Layer» HELE FASEN = VERIFIED/COMPLETE (2026-08-17,
masterplan-closeout-audit → D-48) - P0 (GitHub + filesystem/NAS) + P1A (Google Drive + Obsidian/lokal
vault) + P1B-A (e-post-vedlegg + OCR/vision-ingestion) alle egne, uendrede delfase-lukkinger
(D-39/D-42/D-47). Denne DPIA-en dekker det fjerde av masterplanens fire akseptansekriterier
("DPIA/processing inventory oppdatert for nye datakategorier") - se tabellen under for alle fem
kildetyper. **UA-2 P1B-A (2026-08-17, host-bevist run_id `0f43f39d`)** - MATERIELT NY dataflyt
lagt til denne runden: e-post-KROPP og -VEDLEGG (inkl. bilde-BYTES for sider uten native tekst-lag)
sendes til en EKSTERN modell-leverandør (kun Anthropic denne runden, via `ModelGateway`,
`purpose:"VISION"`) for OCR/beskrivelse - se ny seksjon "OCR/vision-dataflyt (P1B-A)" under. Kort og
teknisk, ikke juridisk teater — oppdateres ved hver ny kildetype (møtetranskripsjon: utsatt til UA-7
Communications Hub finnes; Pieces utsatt, se Q-22 i OPEN_QUESTIONS.md — ingen konkret
integrasjonsflate funnet).

## Hvilke data ingestes

| Kilde | Datakategori | Eksempel på innhold |
|---|---|---|
| GitHub (`GithubKnowledgeSource`) | Repo-metadata (navn, beskrivelse, standard-branch) + åpne issues (tittel, tidsstempel) | Prosjektdokumentasjon, oppgavetekst — **untrusted ingestion** (samme klassifisering som `read_issues` alt hadde i Tool Gateway) |
| Filesystem/NAS (`FilesystemKnowledgeSource`) | Tekstbaserte filer i eksplisitt allowlistede roots (`.md`, `.txt`, `.json`, `.yaml/yml`, `.ts/js/tsx/jsx`, `.py`, `.sql`, `.html`, `.css`) | Notater, kode, konfigurasjon — kan inneholde persondata Tobias selv har lagret i disse filene |
| Google Drive (`GoogleDriveKnowledgeSource`, P1A) | Google Docs (eksportert til text/plain) + tekstlige MIME-typer i en EKSPLISITT konfigurert mappe (rekursivt) eller hele driven (bevisst valgt scope, aldri default) | Dokumenter, notater — **untrusted ingestion**. Sheets/Slides/Forms/bilder/PDF/binærformater IKKE lest (§14 P1A — bevisst utsatt, hoppes trygt over). **Ingestion-KILDEN er READ ONLY by design** (sync skal aldri mutere kilden den leser fra) - dette er separat fra Drive-VERKTØYET (`GoogleDriveTransport`), som siden 2026-08-16 (D-41 scope-endring) har full read/write/permissions for generell verktøybruk utenfor ingestion-pipelinen |
| Obsidian/lokal vault (`ObsidianVaultKnowledgeSource`, P1A) | `.md`-notater i en eksplisitt vault-rot (samme allowlist/traversal-forsvar som filesystem-kilden), inkl. frontmatter (flat parset til metadata) og wiki-lenke-navn | Personlige notater — kan inneholde persondata Tobias selv har skrevet. `.obsidian/`-katalogen (verktøykonfig, ikke notat-innhold) er EKSKLUDERT som default |
| E-post-vedlegg (`EmailAttachmentKnowledgeSource`, P1B-A, NY) | Gmail-innboks (via `JARVIS_EMAIL_TOKEN`, EGEN credential fra Drive/Calendar sin `JARVIS_GOOGLE_TOKEN` - se D-35): e-postkropp (`text/plain`) + vedlegg (tekst/native-PDF/bilder/skannet-PDF). Arkiver (zip/rar/7z/gzip/tar) og docx/xlsx/pptx hoppes EKSPLISITT over (UNSUPPORTED_CONTENT), ALDRI åpnet/utpakket | E-postinnhold og VEDLEGGSINNHOLD (fakturaer, skjermbilder, skannede dokumenter) — **untrusted ingestion**, kan inneholde tredjeparts persondata (avsender/mottaker-navn, kontonummer på fakturaer, osv.) avhengig av hva som faktisk mottas på kontoen. Fail-closed grenser: maks 25 MB/vedlegg, maks 50 sider/PDF, 60s ekstraksjons-timeout (`extraction-safety.ts`) |

**P0/P1A:** ingen binærdata/OCR/bilder/PDF ingestes (§14 i begge BO-er — bevisst utsatt der).
**P1B-A endrer dette EKSPLISITT** for e-post-vedlegg — se OCR/vision-dataflyt-seksjonen under.
**Ingestion-siden** (`GoogleDriveKnowledgeSource`, `ObsidianVaultKnowledgeSource`) er og forblir READ
ONLY mot kilden by design uansett Drive-verktøyets kapabilitet - en sync-kilde skal aldri mutere det den
leser fra. **Drive-VERKTØYET** (`GoogleDriveTransport`, brukt av Jarvis generelt via ToolGateway,
UAVHENGIG av ingestion-pipelinen) har siden 2026-08-16 (Owner Connector Capability Invariant, D-41) full
read/write/permissions - se DECISIONS_AND_ASSUMPTIONS.md D-41 og RUNTIME_GATES.md for full
persondata-/policy-vurdering av det. Skriveoperasjoner mot Drive er ALDRI koblet til
knowledge-ingestion-syncen (§5 i D-41-scope-endringen: `drive/trash` rører aldri `knowledge_documents`,
og en Q-20-erasure kaller aldri ut til Drive - bevist i `drive-full-access.test.ts`).

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

En fullstendig hard-slette-vei (for GDPR-slettekrav på persondata funnet i ingestet innhold) **er
bygget** (Q-20, VERIFIED/CLOSED, D-40) — `@jarvis/erasure` sin `ErasureService` hard-sletter
`knowledge_documents`/`knowledge_embeddings` for scope `knowledge_document`/`knowledge_source`/
`memory_space`/`person`/`tenant`, med en `erasure_fingerprints`-suppresjonsledger som hindrer
`KnowledgeSyncService` i å gjenopplive et slettet dokument ved neste sync (bevist for ALLE P1A-kildene
også — se `drive-source.test.ts`/`obsidian-source.test.ts`/`ua2-p1a-live.ts` §3-4). **Teknisk
foundation, ikke en juridisk GDPR-compliance-sertifisering** — se docs/DATA_ERASURE.md for full
avgrensning (hva som IKKE dekkes: events/audit_events-payload, tasks/tool_executions-innhold,
Langfuse/trace-fil).

## Hvordan source credentials håndteres

GitHub-kilden bruker **eksisterende** `ToolGateway`-vei (samme `SecretProvider`/`JARVIS_GITHUB_TOKEN`
som `read_issues` alt brukte) — ingen ny credential-type, ingen nytt OAuth-scope. Filesystem- og
Obsidian-kildene krever ingen credential i det hele tatt (lokal filsystemtilgang, begrenset av
OS-brukerens egne rettigheter + den eksplisitte allowlistede roten). Google Drive-kilden (P1A) bruker
SAMME OAuth-mønster som Gmail/Calendar (`googleAccessToken()` gjenbrukt, `JARVIS_GOOGLE_CLIENT_ID/
SECRET` + `JARVIS_GOOGLE_TOKEN`-refresh-token via `SecretProvider`) — ingen nytt scope-konsept, ingen
parallell credential-vei. `KnowledgeRecord.metadata` er strukturelt umulig å legge credentials i uten
et bevisst brudd på kontrakten — feltet fylles kun med trusted provenance (f.eks. `default_branch`,
`is_pr`, Drive sin `mime_type`/`drive_file_id`, Obsidian sin `frontmatter`/`wiki_links`), aldri fra
credential-verdier. Ingen secrets logges (verifisert: GithubTransport/GoogleDriveTransport logger
aldri `credential`-parameteret; `ua2-p1a-live.ts` §6/§7 scanner eksplisitt `audit_events` og
`knowledge_documents.metadata` etter en live Drive-sync og beviser at OAuth-tokenet aldri lekker inn
i noen av dem).

## OCR/vision-dataflyt (P1B-A, NY)

For e-postvedlegg uten tilstrekkelig native tekst-lag (skannede PDF-sider, bilder) sendes
side-/bilde-BYTES (base64, som en `image`-`ContentPart` i `ModelRequest`) til en modell-leverandør via
`ModelGateway.complete({purpose:"VISION", ...})` - se `ModelGatewayVisionExtractor` i
`modules/knowledge/src/ocr-provider.ts`. Dette er den ENESTE veien (D-43 §1/§3 — adaptergrense-regelen
i CLAUDE.md, ingen modul kaller en vision-leverandør direkte). Praktisk konsekvens: **innholdet i en
skannet faktura/skjermbilde/dokument sendes til Anthropic** (eneste adapter med ekte bildestøtte denne
runden) for transkribering/beskrivelse — samme databehandler-eksponering som ALLEREDE eksisterer for
all annen tekst Jarvis sender til Anthropic/OpenAI/etc. via `ModelGateway` (D-23: skybaserte
frontrunner-modeller er akseptert for ikke-sensitive data), men denne runden er FØRSTE gang BINÆRT
bildeinnhold (ikke bare tekst) forlater Jarvis sin egen infrastruktur som del av selve
ingestion-pipelinen. Budsjett-/kostkontroll gjelder automatisk (samme `BudgetGuard`/`cost_events` som
ethvert modellkall, `purpose="VISION"` synlig i kostlogget) - ingen ny kostmekanisme. Bildebytes lagres
ALDRI selv (verken i `knowledge_documents.content` - kun den TRANSKRIBERTE TEKSTEN lagres der - eller
noe annet sted); `metadata.extraction_method` (`native`/`ocr`/`vision`) er den eneste sporen av at et
modellkall fant sted.

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
kontinuerlig/webhook-drevet sync i P0/P1A (dokumentert P1B-utvidelse). **Drive (P1A):** ingen egen
Changes-API-integrasjon — full deterministisk listing (`trashed=false`) hver sync-runde er det bevisste
valget (dokumentert, ikke en forglemmelse — se RUNTIME_GATES.md). En Drive-omdøpning bevarer canonical
identity (`external_id` = stabil `file.id`); en Obsidian-omdøpning gjør IKKE det (`external_id` =
relativ sti) — behandles som slett+ny, dokumentert bevisst forskjell.

## Regresjon/isolasjon verifisert

`modules/knowledge/test/knowledge-fundament.test.ts` og `filesystem-source.test.ts` beviser (ekte
embedded Postgres, ekte filsystem-I/O): canonical identity/dedupe, tombstone/reaktivering,
tenant-isolasjon, memory-space-isolasjon, filsystem-allowlist, path-traversal-DENY, symlink-escape-DENY.
**P1A (2026-08-16, suite-bevist — se RUNTIME_GATES.md for host-verifikasjonsstatus):**
`drive-source.test.ts` (pagination, rekursiv mappe-scope, rename-stable-identity, transient-feil-uten-
masse-tombstoning, auth-feil-eskalering, ustøttet-innhold-trygg-skip, deletion-tombstone, restore/
reaktivering), `obsidian-source.test.ts` (allowlist, traversal-deny, `.obsidian/`-eksklusjon, full
livssyklus, omdøpning-som-slett+ny, Q-20-no-resurrection), `p1a-cross-cutting.test.ts` (tenant- og
memory-space-isolasjon DIREKTE med de nye kildetypene, retrieval via samme FTS/vector/hybrid-vei, INGEN
dokumentinnhold i `audit_events`, Drive restore), `registry.test.ts` (ingen cross-tenant default),
`chunking-safeguard.test.ts` (full innhold i `content`/FTS, kun `embed()`-input trunkert).
