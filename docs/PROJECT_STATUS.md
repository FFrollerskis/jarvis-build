# PROJECT STATUS

**Oppdatert:** 2026-09-03 (branch `claude/ua7-conversation-graph`, base `main=db0bf1c575ded615b93bca4367681e3f458853da`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser, ikke her.

## Aktiv fase/oppgave

UA-6 (D-116/D-117/D-118) er FERDIG og merget - PR #66 merget som `db0bf1c` etter Tobias sin
eksplisitte godkjenning, post-merge CI grønt, lokal `main` synket. UA-7 Communications Hub er nå
startet: **D-119, første slice - Conversation Graph + confidence-basert, reversibel
identitetsopploesning**, gjenbruker eksisterende Gmail/Telegram-kanaler, ZERO nye credentials
(D-108 uendret utsatt).

## Sammendrag av D-119-sliceen

- **Reuse-audit** (to parallelle Explore-agenter): Gmail/Calendar/Telegram/Voice/Business/
  Identity/Memory/ToolGateway kartlagt mot hele UA-7 "Bygges"-listen. Eneste kapabilitet som er
  100% `JARVIS_CANONICAL`, credential-uavhengig OG et hardt forutsetning for akseptansekriterium
  1+3: Conversation Graph/identitetsopploesning (null eksisterende kode).
- **D-64-gate:** `SYSTEM_OF_RECORD=JARVIS_CANONICAL`, `CORE_DEPENDENCY_DECISION_REQUIRED=false`.
- **Migrasjon `046_conversation_graph.sql`:** `conversation_identities` (tombstone-basert merge,
  ALDRI DELETE), `conversation_channel_links` (confidence-scoret, delvis unik indeks),
  `conversation_identity_merges` (append-only reversibel revisjonslogg med presis
  `affected_link_ids`-snapshot).
- **Ny pakke `@jarvis/conversation-graph`:** `ConversationGraphService` (link/resolve/merge/
  split/cross-channel commitments/timeline), `ConversationGraphSyncService` (gjenbruker
  `email.list_messages`+`extractCounterpartEmails()` fra D-57, INGEN nye leverandører), ny
  `conversation_graph.*` ToolGateway-namespace (8 handlinger), ny `conversation-graph-sync`
  DailyScheduler-jobb.
- **Strukturell "aldri LLM-alene permanent merge":** `MergePerformedBy`-typen utelater
  `'ai_assisted'`, DB `CHECK`-constraint håndhever det samme uavhengig av kalllag - bevist via
  full `ToolGateway.execute()`-vei.
- **Q-20:** alle tre tabeller registrert i `modules/erasure/src/plan.ts`, korrekt FK-rekkefølge.
- Full detalj: D-119 i DECISIONS_AND_ASSUMPTIONS.md.

## Kvalitetsporter (D-119)

- `pnpm -r typecheck`: 21/21 pakker rent (ny `@jarvis/conversation-graph`).
- `pnpm lint` (`eslint .`): rent.
- Målrettet: `modules/conversation-graph/test/*.test.ts` - 33/33 grønt (26 service + 7 security).
- Full workspace-suite: **182/182 filer, 2893/2893 tester grønt** (opp fra 179/2858 - +3 filer/
  +35 tester, INGEN regresjon, INGEN skips).
- gitleaks (git-historikk OG working tree): `no leaks found`.
- 12-spørsmåls adversarial selvgjennomgang: ingen ekte upatchede funn (to dokumenterte,
  ikke-sikkerhetskritiske forenklinger - se D-119).

## Flagg-status

`UA7_CONVERSATION_GRAPH_IMPLEMENTATION_COMPLETE=true`,
`UA7_CONVERSATION_GRAPH_SUITE_VERIFIED=true`,
`UA7_CONVERSATION_GRAPH_HOST_VERIFIED=NOT_REQUIRED`, `UA7_COMPLETE=false` (kun første slice),
`UA7_MEETING_TRANSCRIPTION=DEFERRED_WITHIN_PHASE`. Uendret: `D108_COMPLETE=false`,
`UA6_LIVE_PROVIDER_VERIFICATION_COMPLETE=false`, `UA6_CREDENTIAL_PHASE_COMPLETE=false`,
`UA6_COMPLETE=false`, `Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false`,
`WALLESTER_LIVE_VERIFIED=false`, `WALLESTER_LIVE_GATE=PENDING_CREDENTIALS`.

UA-7 akseptansekriterier: **1 (commitments across channels): PASS** for identiteter med lenket
kontakt, NOT_STARTED for kanaler utover Gmail/Telegram. **2 (untrusted messages cannot
exfiltrate): PASS** for Gmail-innhøstingsstien, PARTIAL for UA-7 som helhet. **3 (identity
merges reversible+confidence-tracked): PASS.** **4 (transcription retention): NOT_STARTED.**

## PR-status

PR #66 (UA-6/D-116-118) er `merged=true` (`db0bf1c`) - historisk, lukket. Ny PR for D-119
opprettes som draft fra branch `claude/ua7-conversation-graph` - INGEN merge uten Tobias sin
eksplisitte godkjenning.

## Blokkeringer

Ingen tekniske.

## Neste oppgave

D-119-sliceen (Conversation Graph, foerste UA-7-slice) er implementasjons-/testbevist. Venter på
Tobias sin gjennomgang av draft-PR-en. Neste UA-7-slice (utover denne) krever enten en ny
kanal-/leverandørbeslutning (D-108-sperret for credentials) eller videre reuse-audit - IKKE
startet. INGEN D-108. INGEN UA-8.
