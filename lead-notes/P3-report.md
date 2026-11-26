TS: 2026-11-26T13:27:19.534Z
Ferdig: K1–K7 er levert og pushet til `claude/wp-p3-small-fixes`; alle tester og statiske kontroller er grønne, og K6 er bare `PARTIAL`.

**Status**
- Ingen `CORE_DEPENDENCY_DECISION_REQUIRED` og ingen `HARD_EXTERNAL_BLOCKER`.
- Gren `claude/wp-p3-small-fixes`, HEAD `cdf7b46a`, pushet (lik `origin/claude/wp-p3-small-fixes`). Treet er rent.
- Ingen migrasjon, ingen flagg, ingen ekte nettverkskall.
- `origin/main` er uendret (`71a31d8b`), så ingen konflikt nå.
- Commits (`git log --oneline origin/main..HEAD`):
  - `516712e0` K1
  - `43a1b14d` K2
  - `77b6f092` K2 (ekstra test)
  - `9e070e81` K3
  - `00174b95` K5
  - `d08e388c` K4
  - `e362f4db` K6
  - `75567b47` K7 (runbook)
  - `cdf7b46a` K7 (skygge-ticket-sjekk i runbooken)
- Omfang: 15 filer, +1246/−26. Produksjonskode er 9 filer, +127/−20.
- Notater for videre arbeid ligger i `/tmp/pg-home/p3-notes/NOTES.md`.

**Krav K1–K7** (rød-først-bevis fra kjørte tester)
- **K1 JARVIS-106: ferdig.**
  - Uleselig `ads`-kant gir `truncated:true` og `ads_unreadable:true`; `create_ad` nektes `ad_list_truncated` før POST (`meta-ads-write.ts:226-238`).
  - 5xx kastes fortsatt. Lesbar tom liste gir fortsatt opprettelse.
  - Test: `wpd3-write-engine.test.ts` «WP-P3 K1» l.1220. Rød: «expected false to be true».
- **K2 JARVIS-107: ferdig.**
  - Ny vakt i `executor.ts:141-146`, konstant `REPLAY_LEDGER_UNPROVEN` på l.71, delt `healCommand` på l.139-140.
  - (a1) og (a2) lukket FØR (koden var riktig, testene manglet): tabell over `reserved`/`unverified`/`succeeded`, begge rekkefølger, `failed` som kontroll, og heling av kommando.
  - (b) N2d lukket HER: replay av `outcome_unknown` med ledger fraværende eller `failed` gir `UNKNOWN growth_write_replay_ledger_unproven` uten `gateway.execute`. Journalraden står uendret.
  - Rød: alle 8 (b)-tilfeller feilet med «length 1 but got 2», altså en andre leverandørmutasjon.
  - Tester: `wpd3-write-chain-db.test.ts` V4 (13 tester), appendet etter l.1349.
- **K3 JARVIS-104: ferdig.**
  - Internt `ticket_id` på `IngestMessageInput` (`types.ts:117`). `ingestMessage` slår opp på (tenant, id) (`service.ts:292-298`), kaster `support_ticket_not_found` og oppretter aldri. `reply()` sender alltid `ticket_id` (`email-ingress.ts:220`).
  - `ticket_id` leses ikke fra `parameters`; testet både på transporten og gjennom `ToolGateway`.
  - Test: `wpp3-104-manual-ticket-reply.test.ts` (15). Rød: 10 av 15, f.eks. «expected 2 to be 1» på antall tickets.
  - Hele `modules/support/test` er grønn: 121 tester.
- **K4 JARVIS-094: ferdig.**
  - `/infra/status` (`server.ts:2531-2559`) gir sortert `frozen_connectors` fra det varige registeret, pluss `frozen_connectors_readable` og `connector_health_scope:"api_process"`.
  - Egen commit, +15/−1 i `server.ts`.
  - Test: `remediation-2-control-plane-auth.test.ts` blokk H2 (5 tester). Rød: 4 av 4 nye.
- **K5 JARVIS-054: ferdig.**
  - `createPushCorrelator` (`follow-up-push.ts:36-56`). `task_id` er `sched:v2-push:<UTC-dato>`, `trace_id` er `sched-v2-push-<dato>-a<n>` og unik per tikk, også etter omstart samme dag.
  - Getter inn i ledger og notifier, videre til `gateway.execute`. Porten og `reduceLedger` er uendret.
  - Test: `wpp3-054-follow-up-push-correlation-db.test.ts` (10, ekte gateway). Rød: 5 av 6 DB-tester, `task_id` var NULL.
  - `wpc4-follow-up-push-db` og `-gateway` (71 tester) er grønne.
- **K6 JARVIS-108: `PARTIAL`.**
  - Paginering med `pageToken`/`nextPageToken`, maks 10 sider og 200 innlegg, `pageSize` holdt på 20 (`gbp-write.ts:50-58,203-236`). Alt uverifisert ligger i én konstant, `POSTS_PAGINATION_UNVERIFIED`.
  - Fail-lukket ved: token ved taket, gjentatt token, ugyldig token (ikke ikke-tom streng ≤2048), over 200, side som forsvinner. 5xx midt i listen kastes.
  - N6-testen er endret bevisst: en full side uten token er nå komplett.
  - Live er `NOT VERIFIED` og `BLOCKED_EXTERNAL` (Googles godkjenning). Øvrige 108-punkter er `DEFERRED`.
- **K7: ferdig.** Ny `docs/runbooks/WPP3_SMALL_FIXES.md`. `DEFERRED`-punktene er 025, 067, 029, 109, 102/103/105 og øvrige 108.

**Mutanter: 51 drepte, 0 overlevende til slutt**
- K1: 5. K2: 14. K3: 6. K4: 6. K5: 8. K6: 12.
- To mutanter overlevde underveis:
  - K4 «uten sortering» overlevde fordi DB sorterer allerede; drept etter ny test med usortert fake-kilde.
  - K1 «regex-varianten» var ineffektiv (matchet aldri); erstattet med «svelg alle leverandørfeil», som er drept.
- Mot de gamle testene overlevde «`reserved` som `failed`» og «dropp heling». Det bekrefter ledger-påstanden i 107(a). De nye testene dreper begge.
- K3-mutanten «oppslag uten `tenant_id`» er bare synlig mot en tjeneste uten RLS (admin-pool); under RLS er den ekvivalent.

**Tester og kontroller (alle exit 0)**
- `modules/growth/test`: 16 filer, 465 tester.
- `modules/support/test`: 12 filer, 121 tester.
- Hele `apps/api/test`, kjørt etter siste kodeendring: 229 filer, 3414 tester.
- Guards: `d398-doc-banners`, `wpj-closure-matrix`, `d420`, `env-drift`, `wph1`, `wph2`, manifest og `wpk-*`: 17 filer, 180 tester.
- `pnpm -r typecheck`, `pnpm lint`, `pnpm check:containment` og gitleaks (8 commits, «no leaks found») er alle OK.
- De fem kjente sandkasse-feilene ble ikke observert.

**Security surfaces som trenger uavhengig gjennomgang**
- `modules/growth/src/write/executor.ts:87-176`, særlig vakten l.141-146 og `mayHaveMutated` l.137.
- `modules/support/src/email-ingress.ts:178-231` og `modules/support/src/service.ts:288-372`. Tenant-filteret er eksplisitt og ikke bare RLS.
- `apps/api/src/server.ts:2531-2559`.
- `apps/api/src/follow-up-push.ts:36-56,135-166,170-190,272-300`.
- `modules/growth/src/write/gbp-write.ts:203-236`.

**§3 Motsigelser**
- **Ledger 104 «eier avgjør».** `reply()`s egen doc er riktig og koden var feil. Manuelle tickets fikk et skygge-ticket via `service.ts` tråd-oppslag og `insertTicket`. Low6- og d396-testene bruker kun tråd-forankrede tickets (`newTicket` l.106-114). Eieren kan veto.
- **Ledger 107(a).** Mutanten «ignorer `reserved`» lar seg ikke gjenskape ordrett, fordi gatewayen selv svarer `execution_in_flight_or_outcome_unknown` (`gateway.ts:1116-1131`). Mutantene er definert ved atferd. Av de ledger-påstandene overlevde bare «`reserved` som `failed`» og «dropp heling» de gamle testene; å fjerne hele `prior.status`-leddet var allerede drept av eksisterende V(e).
- **Ledger 107(b).** Ledgeren foreslo `collide()`. Jeg valgte UNKNOWN uten sending, fordi `collide()` skriver terminal `failed` (`journal.ts:13`) over en rad som kan være utført. `gateway.reconcile` kun leser og gjør aldri en ledger-rad til `failed`, så `outcome_unknown` med `failed` ledger er alltid et avvik.
- **Ledger 094** = `server.ts:2543` (gammel linje).
- **Ledger 054.** Det er `apps/api/src/follow-up-push.ts` som skriver. `modules/executive/src/value/follow-up-push.ts` finnes, men er kun planleggeren og porten.
- **Ledger 108 `executor.ts ~:237`** er tidslinjens status-allowlist (`TIMELINE_STATUS_VALUES`), fail-safe: ukjent verdi utelates.
- **`WPD3_GROWTH_WRITES.md`, avsnittet om avkortede lister** sier fortsatt «én side på 20» og «paginering DEFERRED». Det er foreldet etter K6. Jeg har ikke rørt filen.
- **Lead-tall.** «676 produksjonsfiler» er reprodusert (`.ts` i `src`-mapper). «Ca. 172 testfiler» er reprodusert som antall testfiler med `readFileSync` (163 med `toMatch`/`toContain`, 91 refererer main/worker-main/server). Jeg har ikke verifisert påstanden «uttrekk går til lokal modell» (jf. runbook §8, JARVIS-067).

**D-495-forslag (kort)**
- Beslutninger 1–6 tilsvarer K1–K6, og punkt 7 er `DEFERRED`-listen:
  1. Uleselig `ads`-kant er «ukjent», ikke «tom».
  2. Replay av `outcome_unknown` går til gatewayen kun med ledger-bevis; ellers `UNKNOWN` uten sending (ikke `collide()`).
  3. `reply()` registrerer på DENNE ticketen via internt `ticket_id` (eier kan veto, Q-63 pkt 8).
  4. `/infra/status` leser det varige registeret og er ærlig om omfanget.
  5. Tikk-korrelasjon for push.
  6. GBP-paginering `PARTIAL`, alt uverifisert i én konstant.
  7. `DEFERRED`: 025, 067, 029, 109, 102/103/105, øvrige 108.
- Antakelser:
  - A1: `get()` null på `ads`-kanten betyr uleselig.
  - A2: Google-paginering er `pageToken`/`nextPageToken`, fraværende token betyr siste side (uverifisert).
  - A3: ingen legitim vei gir `outcome_unknown` med `failed` ledger.
  - A4: `task_id` bruker UTC-dato, `n` er sekunder siden UTC-midnatt og tvunget økende.
  - A5: `owner_control_state` er sannheten for frysing.

**Q-forslag**
- Skal `collide()` også bli UNKNOWN-uten-sending for en `outcome_unknown` rad med FREMMED ledger-rad? Det er nåbart kun etter ledger-sletting pluss nøkkelgjenbruk; jeg har ikke endret det.
- Skal eksisterende skygge-tickets fra før K3 telles og ryddes (egen eierbeslutning; runbook §9 har SELECT, ingen automatisk sletting)?
- Skal workerens connector-helse eksponeres via delt lagring (JARVIS-025-resten)?
- Verifiser `pageToken`/`nextPageToken` og «fraværende token = slutt» mot Googles dokumentasjon når tilgang er innvilget (`BLOCKED_EXTERNAL`).

**Konfliktrisiko og kjente begrensninger**
- `server.ts` (+15/−1) er en delt fil. I `remediation-2-control-plane-auth.test.ts` er `incidents:`-literalen byttet til variabelen `incidentsDeps` (én linje i `createApiServer`-kallet); det er konfliktrisiko hvis andre WP-er rører samme testfil.
- `gbp-write.ts`: tilstanden og audit vokser med antall innlegg (opptil 200 × 1500 tegn).
- K3 gir også riktigere «trenger svar»-deteksjon for manuelle tickets (ingen skygge-ticket lenger).

**`NOT VERIFIED` / `BLOCKED_EXTERNAL`**
- Alt er ikke deployet og ikke kjørt mot NAS-en.
- Eierens steg er i runbook §9: frys `cloudflare` og les `/infra/status`; GBP med 21+ innlegg (først etter Googles godkjenning); manuelt ticket + svar; push-korrelasjon hvis eieren slår på `JARVIS_V2_PUSH_ENABLED`.
- Ny status: 054 → `CODE_FIXED` (resten er DEFERRED for planlagte jobber utenfor follow-up-push, ikke funnet her), 094 → `CODE_FIXED` (workerhelse DEFERRED via 025), 104 → `CODE_FIXED`, 106 → `CODE_FIXED`, 107 → `CODE_FIXED`, 108 → `PARTIAL`. Ingen er `VERIFIED`.

Alle filer ligger i `/home/user/jarvisbuild/.claude/worktrees/p3`; det ene nye dokumentet er `docs/runbooks/WPP3_SMALL_FIXES.md`.
