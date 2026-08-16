# Q-20 — Data Erasure Foundation

**Status: VERIFIED/CLOSED (2026-08-16) → D-40.** Host-bevist av Tobias på ekte Windows/Docker-host,
run_id `eaabe2b1` — alle `q20_*`-felt PASS, `hard_fail=false`, `q21_runtime_role_safe=PASS` uendret.
Full evidens: docs/RUNTIME_GATES.md ("Q-20 FINAL CLOSURE"), docs/DECISIONS_AND_ASSUMPTIONS.md (D-40).

**Dette er en teknisk data-erasure-foundation — IKKE en juridisk GDPR-compliance-sertifisering.**
Bygget for å redusere persondata-eksponeringsrisikoen FØR UA-2 P1 (flere kunnskapskilder: Drive,
e-post, møter, Obsidian) øker mengden ingestert persondata betydelig (se Q-20 i OPEN_QUESTIONS.md).

## 1. Mål

Etter en utført purge skal målrettet innhold være fysisk fjernet fra aktive Jarvis-datalagre og ikke
kunne hentes via vanlig SQL, FTS, vector, hybrid, memory-retrieval eller knowledge-retrieval — og skal
ikke automatisk gjenoppstå ved neste source-sync.

Dette er IKKE bare soft delete (som allerede finnes for knowledge-tombstones, Q-20s opprinnelige gap).

## 2. Persistent-data inventory

Kartlagt ved lesing av faktisk skjema (`modules/core/src/db/migrations/*.sql`), ikke antatt.

### A. CONTENT (må hard-slettes)

| Tabell.kolonne | Innhold |
|---|---|
| `messages.content` | Meldingstekst (samtale) |
| `memory_items.subject`, `memory_items.content` | Minneinnhold |
| `memory_versions.subject`, `memory_versions.content` | Historiske versjoner av minneinnhold |
| `summaries.content` | Genererte oppsummeringer |
| `decisions.content` | Beslutningstekst |
| `commitments.content` | Forpliktelsestekst |
| `deadlines.title` | Fristtittel |
| `knowledge_documents.title`, `knowledge_documents.content` | Ingestert dokumentinnhold (UA-2 P0) |
| `artifacts.content` | Jobb-genererte artefakter (tekst/kode/filinnhold) |

### B. DERIVED CONTENT (må slettes sammen med originalen)

| Tabell | Avledet fra |
|---|---|
| `embeddings.embedding`/`.vec` | `memory_items` (PK = `memory_item_id`, samme rad) |
| `knowledge_embeddings.embedding`/`.vec` | `knowledge_documents` (PK = `knowledge_document_id`, samme rad) |
| `memory_items.fts`, `knowledge_documents.fts` | GENERATED-kolonner — forsvinner automatisk med raden, ingen egen sletting nødvendig |
| `entities`, `relations`, `memory_item_entities` | Utledet minnegraf, space-skopet |
| `memory_versions` | Historiske snapshots av en `memory_item` |

### C. OPERATIONAL METADATA (beholdes — inneholder ikke slettet innhold)

`tenants`, `people`, `person_tenants`, `organizations`, `projects`, `sites`, `rooms`, `devices`,
`memory_spaces` (identitet/topologi), `sessions` (kanal/enhet/status — selve innholdet ligger i
`messages`, slettes separat), `capabilities` (globalt verktøyregister, ikke tenant-data), `approvals`
(forbrukte nonce/utløp, ingen brukerinnhold), `cost_events` (kun beløp/metrikker),
`scheduler_state`/`brief_seen` (operasjonell schedulertilstand), `memory_sources` (kind/ref/trust_level
— en peker, ikke selve innholdet).

**Residual-eksponeringsnotat (ikke skjult, se §6):** `tasks.contract`/`tasks.result`/`tasks.goal` og
`tool_executions.before_state`/`after_state` er `jsonb`/fritekst-felt som TEORETISK kan inneholde
brukerinnhold (f.eks. en jobbs mål-tekst, eller et verktøykalls faktiske parametre/respons). Ingen av
disse har en stabil, strukturert kobling til et konkret `memory_item`/`knowledge_document`/`session_id`
som denne foundation-versjonen kan bruke til å målrettet slette KUN det relevante innholdet uten å
risikere å slette urelatert operasjonell historikk. **Ikke dekket av hard-delete i v1** — reelt residual
gap, dokumentert eksplisitt fremfor skjult. Eneste unntak: full `tenant`-skopet purge sletter
`artifacts` (som HAR en direkte `tenant_id`-kolonne og et rendyrket `content`-felt, se §3).

### D. SECURITY/AUDIT (append-only — strukturelt BLOKKERT for hard-delete i v1)

`events` og `audit_events` har en ubetinget `forbid_mutation()`-trigger
(`BEFORE UPDATE OR DELETE ... RAISE EXCEPTION`, `002_sessions_events.sql`/`004_audit_cost.sql`) som
gjelder for **enhver rolle, inkludert superbruker** — den kan ikke omgås uten å endre/droppe selve
triggeren, noe som ville svekket et eksisterende, bevisst tamper-evidence-fundament (bl.a. Q-18-bevis,
D-pipeline-revisjon) langt utover Q-20 sitt scope. `events.payload` og `audit_events.payload` er
`jsonb`-felt som strukturelt KAN inneholde persondata (spesielt `events.payload` — rå ingestion-nyttelast
fra Ingestion Zone). **BLOKKERT, ikke fake COMPLETE:** disse to feltene inngår IKKE i noen hard-delete-
sti i denne versjonen. Dokumentert som en eksplisitt, kjent begrensning (se §6/§9 nedenfor og
`docs/OPEN_QUESTIONS.md` for videre oppfølging — en fremtidig løsning krever en bevisst
arkitekturbeslutning om selektiv payload-redaksjon uten å svekke append-only-garantien for selve raden).

### Observability (§11 i BO-en)

- **Langfuse-traces / lokal JSONL-fallback (`var/traces.jsonl`)**: `ModelGateway` sender prompt/
  completion-tekst til trace-sinken (BO-09/D-27). Dette er en EKSTERN sink (Langfuse) eller en lokal
  fil utenfor Postgres-RLS-modellen. **Ikke dekket av denne foundationen** — ingen automatisert purge-
  vei bygget mot Langfuse sitt API eller `var/traces.jsonl` i v1. Dokumentert BLOKKERT/utsatt, ikke
  skjult.
- **Applikasjonslogger**: gjennomgått — eksisterende praksis (D-30 sin `JARVIS_STREAM_DEBUG`-
  diagnostikk, `pool.ts` sin feillogging) logger eksplisitt kun type/timing/trunkerte feilmeldinger,
  aldri fullt innhold. Ingen aktiv logger identifisert som skriver fullt melding-/minneinnhold. Dette er
  **"ikke identifisert", ikke "bevist fraværende"** — ærlig formulert, ikke en garanti.

## 3. Scope-modell

Ett sentralt, typed scope-uttrykk (`modules/erasure/src/scope.ts`), tenant_id ALLTID eksplisitt påkrevd:

```ts
type ErasureScope =
  | { type: "tenant"; tenant_id: string }
  | { type: "person"; tenant_id: string; person_id: string }
  | { type: "memory_space"; tenant_id: string; memory_space_id: MemorySpace }
  | { type: "knowledge_source"; tenant_id: string; source_type: string; source_instance_id: string }
  | { type: "knowledge_document"; tenant_id: string; knowledge_document_id: string }
  | { type: "conversation"; tenant_id: string; session_id: string };
```

Ingen cross-tenant purge er mulig: enhver spørring kjøres med `SET LOCAL jarvis.tenant_id`
(+ `jarvis.memory_spaces` der relevant) satt til NØYAKTIG scopets egen tenant/space — identisk RLS-
håndhevelse som resten av systemet (Q-21), ALDRI en superbruker/BYPASSRLS-tilkobling.

| Scope | Dekker |
|---|---|
| `knowledge_document` | Én `knowledge_documents`-rad + tilhørende `knowledge_embeddings`-rad |
| `knowledge_source` | Alle `knowledge_documents`/`knowledge_embeddings` for én (tenant, source_type, source_instance_id) |
| `memory_space` | Alt minneinnhold (`memory_items`+avledet) OG alle knowledge-dokumenter i det spacet (samme tenant) |
| `conversation` | `messages` + `sessions`-raden for én session |
| `person` | `memory_items` eid av personen (alle spaces) + alle personens conversations (sessions+messages) |
| `tenant` | Union av alt over for hele tenanten + `artifacts` (se residual-notat §2) |

**Kjent gap:** `knowledge_documents` har ingen person-/subject-kolonne i dagens skjema — `person`-scope
kan derfor IKKE målrettet slette en gitt persons knowledge-dokumenter (kun kilde-/dokument-/space-nivå).
Dokumentert som residual gap, foreslått løst ved UA-2 P1 hvis behov oppstår (egen post i
OPEN_QUESTIONS.md).

## 4. Erasure service

`modules/erasure` (`@jarvis/erasure`), avhengig av `@jarvis/core` + `@jarvis/contracts`. Rå SQL på
tvers av tabeller — samme etablerte mønster som `modules/watchdog/src/backup.ts` (BackupService), ikke
en ny arkitektur-stil.

- `previewErasure(pool, scope)`: read-only, deterministisk, returnerer KUN identifiers/counts/safe
  metadata (aldri payload). Ingen skriving.
- `executeErasure(pool, ledgerPool, policy, identity, scope, requestId, approval?)`: policy-sjekk FØRST
  (se §7), deretter faktisk `DELETE` i riktig FK-trygg rekkefølge i én transaksjon per scope-del,
  fail-closed (se §5). Skriver `erasure_requests`-ledger-rad (se §6) og
  `erasure_fingerprints`-suppresjonsrader (se §5) for berørte knowledge-dokumenter.
- `verifyErasure(pool, scope, verification)`: kjører de faktiske retrieval-veiene (FTS/vector/hybrid/
  memory/knowledge) mot en gitt "sentinel"-streng og bekrefter 0 treff — brukes av
  `q20-erasure-live.ts` og suite-testene, ikke en egen separat sti.

## 5. Hard delete + rekkefølge

Transaksjonell, FK-trygg rekkefølge per scope (barn før foreldre):

- **memory_space**: `memory_versions` → `memory_item_entities` → `embeddings` → `relations` →
  `entities` → `summaries`/`decisions`/`commitments`/`deadlines` → `memory_items` →
  `knowledge_embeddings` → `knowledge_documents`.
- **conversation**: `messages` → `sessions`.
- **knowledge_document**/**knowledge_source**: `knowledge_embeddings` → `knowledge_documents`.

Feiler ett steg: HELE transaksjonen rulles tilbake (ingen delvis sletting), request markeres `failed`
med en TRYGG (ikke-payload) feilmelding, og resultatet rapporteres ALDRI som `COMPLETE`.

### Resurrection protection (§5 i BO-en)

`erasure_fingerprints` (migrasjon `018_erasure.sql`) er en generell suppresjons-ledger. Den lagrer
**ALDRI** slettet `body`/`title`/`content` — kun:

- `tenant_id`
- `source_type`, `source_instance_id` (kilde-identitet, ikke innhold)
- `fingerprint` — `sha256(tenant_id | source_type | source_instance_id | external_id)`, IKKE selve
  `external_id` i klartekst (ekstra lag: selv en identifikator som kunne indikere hva som ble slettet,
  hashes)
- `erasure_request_id`, `created_at`

`KnowledgeSyncService.sync()` (`modules/knowledge/src/sync.ts`) sjekker fingerprint-ledgeren FØR den
oppretter et NYTT canonical document (samme sjekk som allerede finnes for dedupe via
`(tenant_id, source_type, source_instance_id, external_id)`) — finnes en matchende fingerprint,
hoppes dokumentet over (`report.suppressed += 1`), ALDRI re-insertet. Dette er strengt begrenset til
knowledge-sync (den eneste automatiske re-ingestion-løkken i systemet i dag) — `memory_items`/
`messages` har ingen tilsvarende automatisk gjenoppstår-vei, så ingen suppresjon er nødvendig der
(dokumentert bevisst avgrensning, ikke et hull).

## 6. Erasure receipt / ledger

`erasure_requests` (migrasjon `018_erasure.sql`):

```
request_id, tenant_id, scope_type, scope_summary (jsonb - KUN identifiers, se under),
status ('pending'|'completed'|'failed'), record_counts (jsonb - per tabell antall),
started_at, completed_at, actor_person_id, actor_device_id, error (text, trygg/trunkert)
```

`scope_summary` inneholder samme felt som selve `ErasureScope`-objektet (tenant_id/space/document_id/
session_id/source_type/source_instance_id/person_id) — dette er IDENTIFIKATORER som allerede var kjent
FØR sletting (adressen til hva som skulle slettes), ALDRI selve innholdet. Testet eksplisitt
(`receipt-safety.test.ts`): en sentinel-streng plantet i `content` finnes ALDRI i noen kolonne på
`erasure_requests`- eller `erasure_fingerprints`-radene etter en purge.

ALDRI lagret i ledger/receipt: slettet tekst, prompt-innhold, e-postinnhold, samtale-body, rå
persondata-nyttelast.

## 7. Policy / risk-integrasjon

**Ingen ny separat auth-modell.** `executeErasure()` bygger et `ToolCall`
(`{ tool_id: "data-erasure", action: "purge", capability_class: "D", parameters: <scope> }`) og kaller
DIREKTE inn i den eksisterende `PolicyGateway.authorize()` (`@jarvis/policy`) — nøyaktig samme
sovereign-/approval-/nonce-replay-mekanisme som ALLE andre klasse-D-handlinger i systemet
(`modules/policy/src/policy-gateway.ts`). Owner sovereign-modus kjører uten approval (som andre D-kall);
delegerte/scoped identiteter må sende en gyldig signert `approval` (samme `verifyApproval`/
`PgApprovalStore`-nonce-lager som resten av D-pipeline). `previewErasure()` er alltid tillatt (read-
only, ingen policy-sjekk nødvendig — speiler `capability_class: "A"`-semantikk).

### §9-unntak: INGEN recovery-snapshot av innholdet som slettes

Normal D-pipeline i `ToolGateway` (`gateway.ts`) leser før/etter-tilstand via `preflight_action` og
lagrer et `before_state`-recovery-snapshot i `tool_executions` — designet for EKSTERNE, reversible
handlinger (f.eks. HA lås/alarm, `rollback_procedure`). **Bevisst IKKE brukt her:** å kjøre en ekte
hard-delete gjennom den generiske D-pipelinen ville lagret en KOPI av akkurat det innholdet som skal
slettes i `before_state` — det ville strukturelt UNDERGRAVE erasure. Derfor kaller `executeErasure()`
`PolicyGateway.authorize()` DIREKTE (kun ALLOW/DENY-avgjørelsen, samme sovereign/approval/nonce-logikk),
og skriver sin EGEN trygge `erasure_requests`-ledger-rad (§6, kun identifiers/counts) i stedet for å gå
via `ToolGateway.execute()`. Dette er en eksplisitt, dokumentert sikkerhetsunntak for irreversibel data
erasure — ikke en omgåelse av policy-håndhevelsen (ALLOW/DENY-beslutningen er identisk streng), kun av
det spesifikke recovery-snapshot-steget som ville vært kontraproduktivt for nettopp denne handlingen.

## 8. Backup / restore-kontrakt

`modules/watchdog/src/backup.ts` (`BackupService`) sin `TIER1_TABLES`-liste er utvidet med
`knowledge_documents`, `knowledge_embeddings` (manglet helt fra UA-2 P0 — reell pre-eksisterende gap,
fikset her), samt `erasure_requests`/`erasure_fingerprints` (ledgeren MÅ overleve en restore for at
suppresjon skal fortsette å virke).

**Teknisk restore-erasure-kontrakt:** en `pg_dump`/logisk backup tatt FØR en purge inneholder fortsatt
det opprinnelig slettede innholdet. Ren restore fra en slik backup ville gjenopplive slettet data.
Løsning (minimal, ikke overengineert): `reapplyErasuresAfterRestore(pool)`
(`modules/watchdog/src/backup.ts`) leser HELE `erasure_fingerprints`-ledgeren fra den restorede
databasen og kjører `DELETE FROM knowledge_embeddings/knowledge_documents WHERE fingerprint MATCHES`
på nytt FØR systemet regnes som klart til bruk — idempotent (ingen feil om raden allerede mangler).
Dette dekker knowledge-erasure (den eneste kategorien med et gjenoppstår-scenario via sync, §5). For
memory/conversation-scoped purges finnes ingen tilsvarende risiko for automatisk gjenoppliving (ingen
sync-løkke leser dem tilbake fra en ekstern kilde) — en restore fra FØR purgen ville riktignok
midlertidig vise innholdet igjen inntil purgen kjøres på nytt manuelt; dette er en kjent, dokumentert
begrensning av logisk backup/restore generelt (ikke unik for Q-20), og eksplisitt utenfor "ikke bygg et
enormt backup-system nå"-instruksen i BO-en.

## 9. Idempotency

Samme `request_id` kjørt to ganger: `executeErasure()` sjekker `erasure_requests` FØRST — finnes raden
allerede med `status='completed'`, returneres de LAGREDE `record_counts` UTEN å forsøke sletting på
nytt (ingen feil, ingen dobbel destructive side-effect, ingen "resurrection"). Selve SQL-slettingen er
i tillegg naturlig idempotent (DELETE av rader som allerede er borte gir `rowCount=0`, ikke feil) —
dette gjelder også hvis samme SCOPE kjøres med en NY `request_id` etter at innholdet allerede er borte.

## 10. Kjent begrensning / videre arbeid

- `events`/`audit_events`-payload: strukturelt blokkert (append-only trigger), se §2/§10.
- `tasks`/`tool_executions`-innhold: ikke pålitelig adresserbart, se §2 residual-notat.
- Langfuse/lokal trace-fil: ingen purge-integrasjon bygget.
- `person`-scope dekker ikke knowledge-dokumenter (mangler person-kolonne i skjema).
- Full juridisk GDPR-vurdering (dataminimering, lovlig grunnlag, DPIA utover dette tekniske notatet) er
  IKKE gjort — dette er en teknisk foundation, ikke en juridisk sertifisering.

Se `docs/OPEN_QUESTIONS.md` (Q-20) for status og `docs/RUNTIME_GATES.md` for host-akseptansebevis når
Tobias har kjørt `q20-erasure-live.ts`.
