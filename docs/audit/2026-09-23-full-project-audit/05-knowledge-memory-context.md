# Audit report — `modules/knowledge`, `modules/memory`, `modules/context`

Files read: **53 / 53** (knowledge 35: src 14, test 15, scripts 4, package/tsconfig 2; memory 11; context 7). Also read for verification: `MEMORY_ARCHITECTURE.md`, `UA2_KNOWLEDGE_DPIA.md`, migrations `008/014/017/018/049`, `erasure/src/plan.ts` (excerpts), `apps/api/src/main.ts`/`worker-main.ts` (excerpts), `tool-gateway/src/integrations.ts:2768-2783`. `tsc --noEmit` passes for all three packages. DB-backed tests could not be run here (sandbox `initdb` limitation); claims below are from code reading, marked "unverified" where I could not confirm.

---

## A. Bugs / holes

### modules/memory/src/memory-writer.ts
- **P1** `:64-69` + `008_memory.sql:36` — After `invalidate()` (status=`invalidated`), re-adding the same `(tenant,space,type,subject)` hits `!row` → INSERT → violates `UNIQUE (tenant_id, space, type, subject)` (the invalidated row still occupies the key) → `apply()` throws. A fact can never be re-learned once invalidated. Fix: include `invalidated`/`superseded` in the SELECT and branch (re-activate + version), or make the UNIQUE partial (`WHERE status IN ('active','quarantined')`).
- **P1** `:110-129` — A **trusted** candidate against an existing **quarantined** row (found via `status IN ('active','quarantined')`) skips the line-93 guard and takes the UPDATE path: `trust_level` becomes `internal` but `status` stays `quarantined`, so a trusted fact becomes permanently invisible. Fix: in the UPDATE path set `status='active'` when `source.trust !== 'untrusted'` (and audit it), or branch explicitly on `row.status`.
- **P2** `:93-107` — `QUARANTINED_CONFLICT` inserts with subject `#quarantined-&lt;randomUUID&gt;`; re-ingesting the same untrusted text (e.g. same email processed twice) creates a new row every time — unbounded, non-idempotent growth. Fix: derive the suffix from `sha256(content)` and `ON CONFLICT DO NOTHING`.
- **P3** `:117-122` — UPDATE sets `valid_from = now()` regardless of `candidate.observed_at`; an out-of-order older observation silently supersedes a newer fact (spec §6.5 "aldri stille overskriving"). Fix: compare `observed_at` with `row.observed_at` and NOOP/version-only when older.
- **P3** `:198-203` — `ensureSource` `ON CONFLICT DO NOTHING` freezes the first `trust_level` seen for a `(tenant,kind,ref)`; later calls with different trust leave `memory_sources.trust_level` stale (item-level trust is correct, source-level label lies). Fix: include trust in the id or `DO UPDATE SET trust_level = LEAST(...)`.
- **P3** `:176-192` — `promoteFromQuarantine` writes the embedding but never calls `linkEntities`; promoted items never join the relation graph. Fix: call `linkEntities` with the row's entities (requires storing them).

### modules/memory/src/retriever.ts
- **P1 (latent)** `:181-206` — Timeref branch selects from `memory_versions` with no join to `memory_items.status` and fabricates `trust_level: "internal"`, `type: "semantic"`, `space: options.spaces[0]`. Because the writer's UPDATE path (`memory-writer.ts:110-115`) also runs for untrusted→untrusted updates of a **quarantined** row, quarantined content can be returned labelled "internal" whenever a caller passes `timeref`. No production caller passes `timeref` today (`tool-gateway/src/memory-transport.ts` exposes none), so it is latent. Fix: `JOIN memory_items m ON m.memory_item_id = v.memory_item_id AND m.status='active'` and carry real `space/type/trust_level`.
- **P3** `:142-155` — Relation expansion has `LIMIT 5` with no `ORDER BY` → nondeterministic results (and see B: `relations` is never written).

### modules/memory/src/embedding.ts
- **P2** `:35-61` — `OpenAiEmbedding` (dim 1536) is incompatible with the HNSW expression index `(vec::vector(64))` in `014_embeddings_pgvector.sql:17` / `017_knowledge.sql:78`; inserting a 1536-d vector would fail on the index cast. Also `:59` returns `[]` on a malformed response (stored as a zero-length `real[]` with `dim=1536`), and `fetch` has no timeout. Fix: parameterise index dim from the configured provider (migration), throw on empty `data`, add `AbortSignal.timeout`.

### modules/memory/src/export.ts
- **P3** `:40-56` — Conversation export runs under `withTenantTransaction` and dumps **all** tenant `messages` (every person/guest session) into `memory/conversations/`, not the requested person's. Fix: add `WHERE person_id = $1` via `sessions`.

### modules/knowledge/src/sync.ts
- **P1** `:83-108` — All records are upserted inside **one** transaction with a per-record `try/catch` and no `SAVEPOINT`. A DB error in any record (unique violation, tsvector overflow, CHECK failure) leaves the transaction in aborted state (`25P02`): every subsequent `client.query` fails, each is counted as `failed`, and the final tombstone UPDATE throws → `ROLLBACK` → the whole sync run is lost and `sync()` rejects. The comment at `:30-31` only holds for JS-side errors (embedding). Fix: `SAVEPOINT rec; … RELEASE/ROLLBACK TO SAVEPOINT rec` around `upsertOne`, or one transaction per record.
- **P1** `:120-123` + `017_knowledge.sql:30` + `registry.ts:19-21` — Existing-row lookup omits `memory_space_id`, and the DB UNIQUE is `(tenant_id, source_type, source_instance_id, external_id)` without space. `KnowledgeSourceRegistry` explicitly permits the same `source_instance_id` under two spaces for one tenant (`registry.test.ts:28-30`). Syncing the second space cannot see the first space's rows (RLS) → INSERT → unique violation → silent `failed` for every record, plus the transaction-abort cascade above. Fix: add `memory_space_id` to the UNIQUE key (migration) and to the lookup, or reject duplicate `source_instance_id` per tenant in the registry.
- **P1** `:139-149` (+ `filesystem-source.ts:115`, `drive-source.ts:89-129`) — No cap on `content` size. `knowledge_documents.fts` is `GENERATED … to_tsvector(title||' '||content)`; Postgres tsvector is limited to 1 MB, so a single multi-MB text file/Drive doc makes the INSERT/UPDATE raise "string is too long for tsvector" → the cascade above kills the entire sync run. (tsvector limit is a documented Postgres limit, not tested here.) Fix: enforce a documented max content size per source (Drive has `size_bytes` in metadata but never uses it) and emit a `SkippedRecord` instead.
- **P2** `:214-219` — `embeddings.embed()` (network with a real provider) executes while a DB transaction is open across the whole sync; with hundreds of docs this holds locks/connection for minutes. Fix: embed before `withMemoryTransaction`, or per-record transactions.

### modules/knowledge/src/email-attachment-source.ts
- **P1** `:135` (`max ?? 15`) vs `source.ts:110-118` contract — The Gmail listing is a **window** (newest 15, or `query`-filtered), yet `KnowledgeSyncService` tombstones everything for the instance that is not in the listing (`sync.ts:100-107`). Every sync therefore tombstones all previously ingested emails/attachments older than the window; older knowledge disappears from retrieval on a rolling basis. Neither DPIA "Hvordan re-sync fungerer" nor the class JSDoc acknowledges this (D-43 not read — unverified whether it does). Fix: either make `list()` return the full mailbox state (paginate all, or a `history`-based incremental protocol with explicit deletions), or add a `partial: true` flag to `KnowledgeListResult` that disables tombstoning.
- **P2** `:167` + `:200-204` — Size guard uses the **listing header** `size_bytes`; the decoded `bytes.length` after `read_attachment` is never re-checked. If the transport omits/zeroes `size_bytes` (`undefined &gt; MAX` is `false`) the 25 MB fail-closed limit is bypassed. Fix: `assertWithinSizeLimit(bytes.length, …)` after decode.
- **P3** `:42-52` — `withTimeout` races but does not cancel: pdf-parse/vision work continues after timeout, and `extractor.destroy()` (`:290-291`) only runs when the inner promise settles. Fix: thread an `AbortSignal` into `PdfExtractor`/`callVision` and destroy on timeout.
- **P3** `:129` — Canonical URI hard-codes `/mail/u/0/`; wrong for a non-primary Google account index.

### modules/knowledge/src/extraction-safety.ts
- **P2** `:33-42` — Classification trusts the sender-supplied MIME header (the comment claims "aldri filendelse alene" as if MIME were trustworthy; it is equally attacker-controlled). A zip labelled `text/plain` is `toString("utf8")`'d and stored; a binary labelled `image/png` is shipped to the vision provider. No magic-byte sniffing. Fix: sniff the first bytes (`%PDF-`, PNG/JPEG/GIF/WEBP/TIFF/BMP signatures, zip `PK\x03\x04`, OLE/OOXML) and fail-closed on mismatch.
- **P3** `:37` — `startsWith("image/")` admits `image/svg+xml` (XML, potentially huge) and other non-raster types the provider rejects; every such attachment costs a failed model call per sync. Fix: allowlist only raster types.

### modules/knowledge/src/filesystem-source.ts
- **P2** `:82-130` — `walk()` has no visited-set. A directory symlink inside the root pointing to an ancestor inside the root (`root/a/link -&gt; root`, allowed by `assertWithinRoot` since `rel === ""` or non-`..`) causes unbounded recursion (stack overflow / hang) — DoS by a single symlink in an ingested tree. Fix: track resolved real directory paths in a `Set` and skip repeats.
- **P3** `:10-13, :111-115` — `.json/.yaml/.yml` allowlisted with no exclusion of `node_modules/`, `.git/`, `.env.*.json`-style config; pointing a root at a repo ingests dependency trees and config files that commonly hold credentials into `content`. Fix: default exclusion list and an optional secret-pattern guard.

### modules/knowledge/src/obsidian-source.ts
- **P3** `:96` — Only `.obsidian/` is excluded; Obsidian's `.trash/` (deleted notes) is ingested. Fix: exclude `.trash/` by default.

### modules/knowledge/src/ocr-provider.ts
- **P3** `:83` — `max_tokens: 4000` silently truncates dense pages; nothing marks the stored content as truncated. `:61` exact-match on `(ingen tekst funnet)` fails on trivial variations (trailing period) and stores the marker as content. Fix: detect `stop_reason`/length and record `metadata.truncated`; regex-match the marker.

### modules/knowledge/src/email-ingest-handler.ts
- **P3** `:44` — `memory_space_id` from job input is cast, not validated with `MemorySpaceSchema`; garbage reaches `withMemoryTransaction`/RLS `set_config` before failing on the CHECK constraint. Registry lookup does prevent an unconfigured space. Fix: `MemorySpaceSchema.parse(...)`.

### Erasure vs append-only (cross-cutting, verified in-slice)
- **P1** `008_memory.sql:55-57` + `018_erasure.sql:45-48` + `erasure/src/plan.ts:46` + `memory/test/memory.test.ts:139-143` — `memory_versions` keeps the `forbid_mutation` BEFORE DELETE trigger (never dropped in any migration; the memory test proves DELETE throws even for `jarvis_app`), yet 018 grants DELETE and `planMemorySpaceInContext` hard-deletes from it. Erasure tests never seed a non-empty `memory_versions` (no double `apply()`/`invalidate()` in `erasure/test/*`), so the path is untested. Any GDPR erasure of a person/space whose items were ever updated or invalidated will raise `append_only_table` and roll back. Fix: drop/replace the trigger with one that permits DELETE under an erasure session flag, and add an erasure test that seeds versions.

---

## B. Placeholders / stubs / dead code

- **P1** `modules/memory/src/embedding.ts:13-32` — `LocalHashEmbedding` (64-d char-trigram feature hash, no semantics) is documented as "dev/test/fallback" (`:3`) but is the **production** provider: `apps/api/src/main.ts:473` (`MemoryRetriever`) and `apps/api/src/worker-main.ts:503` (`emailIngestHandler`). There is no env switch selecting `OpenAiEmbedding`; the vector half of every hybrid ranking (`retriever.ts:95 sim&gt;=0.6`, `knowledge/retriever.ts:79 sim&gt;=0.4`) and the HNSW index are sized around this stand-in. Fix: factory keyed on env (`JARVIS_EMBEDDING_PROVIDER`), migration for dim, and mark the hash provider `model="local-hash-v1"` as non-semantic in docs/RUNTIME_GATES.
- **P2** `modules/memory/src/retriever.ts:139-178` — Relation expansion (1-hop over `relations`) is dead: no code anywhere inserts into `relations` (grep `INSERT INTO relations` → none). Layer 5 of the memory spec exists only as schema.
- **P2** `modules/memory/src/extraction.ts:32-52` — `RuleBasedExtractor` is a stated test fallback (`:19-22`); the only production write path (`IngestionService`, `tool-gateway/src/integrations.ts:2774-2782`) depends on whatever extractor the `MemoryWriter` is built with — and **no** `MemoryWriter` is constructed anywhere in `apps/` (grep). See C.
- **P3** `modules/memory/src/summaries.ts` — `SummaryService.generateDaily` writes `summaries` that nothing reads (retriever/contextFor never query `summaries`); layer 6 is write-only.
- **P3** `modules/memory/src/memory-writer.ts:226` + `008_memory.sql:32` — `retention_rule` is always the column default `'default'`; no code sets or enforces it (grep: only the migration).
- **P3** `modules/context/src/types.ts:101` / `049_context_engine.sql` — `confidence` stored, never used (documented as such — fine, listed for completeness).
- **P3** `modules/knowledge/scripts/ua2-p0-live.ts:113-115` — Comment "jarvis_app har bevisst INGEN DELETE-grant noe sted" is stale since `018_erasure.sql`.

---

## C. Gaps (spec promises unkept, untested logic, vacuous tests, undocumented env)

- **P1 (wiring)** — `MemoryWriter` is never instantiated in production (`apps/api/src/*.ts` has no `MemoryWriter`; only `tool-gateway/src/integrations.ts:3` type-imports it). Consequently `IngestionService`, quarantine, `promoteFromQuarantine`, versioning and `SummaryService` are only exercised by tests; the running system reads memory it never writes. Fix: wire `MemoryWriter` (+ extractor) in `main.ts` and expose the ingestion/promotion path through the memory tool.
- **P1 (wiring)** — `KnowledgeRetriever` has no consumer outside `modules/erasure` and the acceptance scripts (grep). Ingested knowledge (GitHub/Drive/Obsidian/email) is never reachable from the conversation engine or any tool; `MemorySearchTransport` only calls `MemoryRetriever`. Fix: a `knowledge.search` tool/transport with `output_trust: "untrusted"`.
- **P2 (wiring)** — `ContextEngine` (`modules/context/src/service.ts`) has no consumer outside its tests (grep `new ContextEngine`/`@jarvis/context` → none). The Personal Context Engine is unreachable.
- **P2 (rule 4)** `017_knowledge.sql:9-27` + `sync.ts:139-149` — `knowledge_documents` carries `tenant_id`/`memory_space_id`/source fields but **no** `owner_person_id`, `task_id` or `session_id`, and `KnowledgeSyncService` writes no `audit_events` at all (no `writeAudit` import). The only trace of a sync is the ToolGateway audit of the underlying tool calls; filesystem/Obsidian syncs (no ToolGateway) leave no audit trail. Fix: add columns + one `knowledge.sync` audit event per run with `identity`.
- **P2 (trust label)** `source.ts:12-31`, `knowledge/retriever.ts:6-23` — `KnowledgeRecord`/`KnowledgeSearchResult` carry provenance but no `trust_level`/`output_trust`; the DPIA's "untrusted ingestion" is a doc statement, not a field. When knowledge is eventually surfaced to a prompt there is nothing structural to consult. Fix: add `trust_level text NOT NULL DEFAULT 'untrusted'` and surface it in results.
- **P2 (defence in depth)** `memory/retriever.ts:67-98`, `knowledge/retriever.ts:60-81`, `sync.ts:100-107` — Every read/write relies **solely** on RLS (`jarvis.tenant_id`/`jarvis.memory_spaces`); no query carries `tenant_id`/space predicates. Correct under `assertRuntimeRoleSafe` (`main.ts:107`, `worker-main.ts:67`), but a single superuser/BYPASSRLS connection (scripts use `adminPool`) sees everything — `rls-role-isolation.test.ts:208-244` documents exactly this. Fix: add explicit `tenant_id = $n AND space = ANY($m)` predicates as belt-and-braces.
- **P2 (write authorisation)** `memory-writer.ts:58-60` — `candidate.space` (not `identity.memory_space_id`) selects the RLS context; any caller can write to `health`/`business` by setting `candidate.space`. Space-permission is enforced only by `TaskService`'s accessor, not here. Fix: assert `candidate.space` is in an allowed set derived from identity/contract.
- **P2 (spec §6.1/§6.8/§7.5)** — `MemoryWriter` never records raw input in `events`; no importance threshold requiring stronger source/human approval; `contextFor` has a fixed `limit: 5` and no token budget/summaries fallback. Unimplemented, undocumented as deferred.
- **P2 (tests)** `email-sync-integration.test.ts:166-186` — Test "E: tenant/memory-space-isolasjon" asserts only `rows` is defined and that the row exists under the right tenant via **admin**; it never queries as another tenant/space. Vacuous for isolation.
- **P2 (tests)** — No test covers: same `source_instance_id` in two spaces (A/sync P1), a DB error mid-sync (transaction abort), content &gt; tsvector limit, symlink directory cycle, MIME-spoofed attachment, `size_bytes` mismatch, GitHub pagination (transport's `read_issues` page handling — unverified), `timeref` against quarantined versions, re-add after `invalidate`, trusted update of a quarantined row.
- **P3 (env)** `apps/api/src/worker-main.ts:494-497` — `JARVIS_TENANT_ID` (used for the email registry) is absent from `.env.example` (only mentioned in `RUNTIME_GATES.md:651`); `JARVIS_GOOGLE_ACCOUNT` default `post@tsworkflow.com` is hard-coded in source.
- **P3** `github-source.ts:74` — Issue `content` is the title only (documented as P0 scope, but the DPIA table row implies "oppgavetekst"); repo files not ingested.

---

## D. Improvements

- `memory-writer.ts:117-122` — Every UPDATE sets `has_conflict = true`; a plain newer value is indistinguishable from a real contradiction. Set `has_conflict` only when both are from comparable-trust sources within the same validity window.
- `memory/retriever.ts:224-237` — `contextFor` concatenates raw `item.content` into the system prompt with no delimiter/escaping and no trust tag (`kilde: kind:ref` only). Wrap in a fenced "data" block and include `trust_level`, so a promoted-from-untrusted fact remains visibly provenance-tagged.
- `memory/retriever.ts:134-135` — Recency decays linearly over 365 days regardless of memory type; procedures/preferences shouldn't decay like episodic items.
- `knowledge/retriever.ts:112-118` — FTS score normalised by per-query max (rank-1 always 0.5+sim); use RRF or z-scoring; add freshness weight now that `modified_at` is available.
- `sync.ts:41-45` — Head-only truncation for embedding loses the tail of long docs; document it in `KnowledgeProvenance` (`embedding_truncated: true`) so the client knows vector recall is partial.
- `drive-source.ts:147-168` — Folder BFS re-lists shared subfolders reachable via multiple parents once each (fine) but never handles Drive shortcuts (`application/vnd.google-apps.shortcut`) — they land in `skipped` each run; resolve or filter them explicitly.
- `email-attachment-source.ts:105-124` — Attachments are processed serially; per-message `Promise.allSettled` with a small concurrency cap would keep the 60 s budget realistic for multi-page PDFs (50 pages × 2 vision calls cannot fit in 60 s today; pages after the timeout become `SOURCE_UNAVAILABLE` skips every run).
- `extraction-safety.ts:86-91` — `NATIVE_TEXT_MIN_CHARS = 40` means a scanned page with a 40-char header skips OCR entirely; consider chars-per-page-area or "text covers &lt; N% of page" heuristics.
- `context/service.ts:263-267` — `SELECT … FOR UPDATE` then `INSERT … ON CONFLICT` is correct; consider `ON CONFLICT … WHERE basis &lt;&gt; 'deterministic' OR EXCLUDED.basis = 'deterministic'` to make precedence a single statement.
- `scripts/ua2-p1b-a-host-run.ts:275-279` — SQL assembled with `.replace(/\$1/g, …)`; values are self-generated, but use parameters (three statements) to avoid future footguns.

---

## E. Doc/code drift vs MEMORY_ARCHITECTURE.md / UA2_KNOWLEDGE_DPIA.md

- **P1** MEMORY_ARCHITECTURE §10 "hard delete i alle lag … med audit-spor" vs `008_memory.sql:55-57` append-only trigger on `memory_versions` (see A). Erasure cannot delete versions.
- **P2** MEMORY_ARCHITECTURE §5 mandatory `memory_items` fields — present. But `knowledge_documents` (the second memory store) lacks `owner_person_id`, `sensitivity`, `trust_level`, `confidence`, `retention_rule`, `valid_from/to`; §1.4 "alt minne er merket" is not honoured for knowledge.
- **P2** MEMORY_ARCHITECTURE §6.1-6.2 "Rådata lagres i events … ubetrodd merkes quarantined" — `MemoryWriter` never writes `events`; knowledge sync stores untrusted content directly as `knowledge_documents` with no quarantine/trust column. The DPIA's "untrusted ingestion" label has no runtime representation.
- **P2** DPIA "Fail-closed grenser: maks 25 MB/vedlegg" — enforced on header metadata only (A). DPIA "Idempotent … Uendret kilde → ingen duplikater" — true per source, false across two spaces sharing an instance id (A/sync).
- **P2** DPIA "Hvordan re-sync fungerer": describes `list()` as a full snapshot; for `email_attachment` it is a 15-message window that tombstones the rest (A). Not disclosed.
- **P2** `embedding.ts:3` "LocalHashEmbedding … (dev/test/fallback)" vs production wiring (B). RUNTIME_GATES `:616` describes pgvector HNSW as if semantic search were in place.
- **P3** MEMORY_ARCHITECTURE §2 layers 5 (relations) and 6 (summaries) and §7.5 (token budget) — schema/writer exist, read path doesn't use them (B/C).
- **P3** DPIA "Hvordan en kilde kan kobles fra" — "koble fra kilde" mass-tombstone still not built (documented honestly; listing for completeness).
- **P3** `ua2-p0-live.ts:113-115` stale "no DELETE grant" comment (B).
- **P3** DPIA "Bildebytes lagres ALDRI selv" — true for `knowledge_documents`; `tool_executions.before_state/after_state` (`gateway.ts:616-620`) — unverified whether `read_attachment` base64 ends up there; out of slice, flagged for the tool-gateway auditor.

---

## Health summary

1. Isolation is genuinely DB-enforced (RESTRICTIVE RLS on tenant + space, non-superuser runtime asserted at boot, honest tests) — the strongest part of the slice.
2. The memory *write* path (MemoryWriter/quarantine/promotion) and the knowledge *read* path (KnowledgeRetriever) and ContextEngine are all unwired in production; what runs is MemoryRetriever over a table nothing writes, on a hash "embedding".
3. Two P1 correctness bugs in `sync.ts` (no savepoints → one bad row kills the run; UNIQUE ignores memory space) and one in the email source (windowed listing tombstones history) make the "idempotent, never lose history" claims untrue at the edges.
4. `MemoryWriter` has two P1 state bugs (re-add after invalidate impossible; trusted update stuck in quarantine) and erasure of `memory_versions` is blocked by an undropped append-only trigger — spec §10 is not met.
5. `extraction-safety.ts` limits are real but shallow: sender-controlled MIME, header-only size, non-cancelling timeout; there is no trust column on knowledge, so rule 7 is honoured today only because knowledge is never fed to a prompt.
