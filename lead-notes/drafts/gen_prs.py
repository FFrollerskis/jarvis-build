# Genererer PR-utkast (norsk) fra fakta i DECISIONS_AND_ASSUMPTIONS.md (D-459, D-463..D-466, D-471..D-476).
# Kun filer utenfor repoet. Ingen hemmeligheter.
import os, textwrap

OUT = "/tmp/lead/drafts"
SESSION = "https://claude.ai/code/session_01DjaWBW7BCa7u4mUsiHFwH4"
FOOTER = f"\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n{SESSION}\n"

STATUS = """## Status (ærlig)
- `BUILT`, `DORMANT`/AV bak egne flagg og `NOT VERIFIED`: ingenting er `VERIFIED` før det finnes en kjøring på NAS (se runbook for delen).
- Alle gjennomganger er gjort av SEPARATE Claude-agenter som var uavhengige av byggeren; de er IKKE den eksterne arkitektens review. **Arkitektens uavhengige review (mot faktisk diff, tester, CI og sikkerhet) gjenstår før merge**, og denne PR-en er derfor draft.
- Lokal integrasjonsverifisering (`integration/post-merge-test-2` = alle ni deler + docs, ikke pushet): `typecheck`, `lint`, `check:containment` og gitleaks (330 commits) exit 0; én samlet full suite: 16 649 av 16 654 tester grønne (975 filer). De fem røde er kjente sandkasse-feil (wpc3-review1-hardening F10a/b/c, break-glass-guard, nas-ua0-gate «friskt system»), ikke knyttet til denne delen.
- Per-gren CI på GitHub er ikke kjørt ennå: delene ble bygget mens GitHub var utilgjengelig fra sesjonen (2026-11-15 til 2026-11-22), og arbeidet ligger nå i den nye forken `FFrollerskis/jarvis-build` (kontobytte, eierens ordre 2026-11-22; Actions må slås på i forken). Sandkassekjøringene (embedded Postgres, falske kilder) står over.
"""

PRS = [
 dict(n=1, slug="wp-k-ledger-rester", branch="claude/wp-k-ledger-rester",
  title="WP-K: gjenstående ledger-gjeld (JARVIS-018/053/054/056/068, D-471)",
  summary="Lukker de gjenstående ledger-postene fra HF1/HF2: avbrytbare verktøykall med ærlig «ukjent utfall», varig policy-journal, sporbarhet i planlagte syncer, vault-først for Google-credentials og avstemming av JARVIS-068 mot D-461.",
  bullets=[
   "`ToolTransport` får abort-signal (nødutgang `JARVIS_TOOL_CALL_ABORT=off`). Gateway-tidsavbrudd, uavklarte transportfeil og leverandørsvar transporten ikke godtok på ikke-idempotente klasse C/D gir `unverified` (aldri samme-nøkkel-replay; klasse D-eieren varsles). Delt hjelper `afterAcceptedMutation` → `outcome_unknown:<kode>` (`infisical.rotate_secrets` rettet; GitHub-bokføring best-effort; GCE/Docker kun sentinel). Revisjonen av 32 produksjonsaktiverte ikke-idempotente klasse C/D-verktøy står i runbook §3 #5.",
   "Varig `policy_decisions`-journal (migrasjon 108; AV som standard bak eget flagg; kø-tak per tenant, retensjon 90 d med gulv 30 d). `audit_events` forblir autoritativ.",
   "Planlagte system-syncer bærer `task_id`/`trace_id`; `decision_id` i hver audit-rad.",
   "Google client id/secret leses fra vault først; `.env` er en logget, utfaset fallback.",
   "JARVIS-068 avstemt mot D-461.",
   "UTENFOR opprinnelig scope (egen commit som kan reverteres alene): `support.reply` sendte nøstet `email.send` uten `idempotency_key` og ble nektet under håndhevet klasse D (`class_d_idempotency_key_required`, 0 utsendelser; funnet av reviewer, finnes på main). Nå avledet nøkkel `support-reply:<ticket_id>:<kallernøkkel>`. Bivirkning: under `enforce:true` sender hver `support.reply` et klasse D-varsel.",
  ],
  open=[
   "Ikke dekket (dokumentert): HTTP 5xx, klasse B, transporter som omskriver nettverksfeil uten cause/code (`postgres_ops`), vanlig Error/TypeError etter 2xx (Slack `ok:false`), finans-transporter (egen 20 s-grense), preflight/re-arm uten frist. `unverified`-rader utløper aldri (JARVIS-103).",
   "Erasure dekker IKKE `policy_decisions`; `person_id` står i klartekst til oppbevaringsrydden.",
   "Ingen legacy-fallback for gamle `reply:<key>`-hendelser; ukjent klasse D-infra-handling åpner en `normal` hendelse (bør være `high`, JARVIS-105); Docker-journalen mapper akseptert-men-uverifisert til FAILED; svar på manuelt opprettet ticket havner på nytt ticket (JARVIS-104).",
  ],
  review="Fem uavhengige gjennomganger: første review fant 1 HØY (nøstet klasse D-varsling droppet etter ytre tidsavbrudd) + 4 MEDIUM + 7 LOW, alt rettet; re-review, delta-review og delta-2: MERGE.",
  stack="Ingen avhengighet av de andre delene (kan merges først). Migrasjon 108.",
  decision="D-471"),
 dict(n=2, slug="wp-h1-control-centers", branch="claude/wp-h1-control-centers",
  title="WP-H1: kontrollsentre Finans, Minne og Agenter + proveniens på styringsjournalen (UA-11, JARVIS-087 del 2, D-473)",
  summary="Tre av kontrollsentrene kobles inn som rene lese-composere bak egne flagg (alle AV), og styringsjournalen får nullbar proveniens.",
  bullets=[
   "`JARVIS_CONTROL_CENTER_FINANCE/_MEMORY/_AGENT` (alle AV, kun eksakt `on`): lese-composere over eksisterende tabeller; ingen nye eksterne kall, skriveveier eller innhold.",
   "`executive.get_<senter>_center` (klasse A, kun eier fra signert enhetsøkt, fail-closed) registreres KUN for sentre med flagget på: flagg AV er identisk med main (95 fraser × begge flater mot en baseline fra ren `origin/main`; reviewer gjentok på 137 egne fraser/2192 utvalg: 0 forskjeller).",
   "Finansdata (SECRET_RESTRICTED, D-378) holdes tilbake fra skymodeller VED UTFØRELSE i executive-transporten; lokal modell og `/control` får hele rapporten.",
   "Agent-senteret måler artefaktmengde med `octet_length` (ikke `length`) og viser opptil 200 jobber.",
   "Styringsjournalen får nullbar proveniens (migrasjon 102, `JARVIS_GOVERNANCE_PROVENANCE=on`, AV som standard): kanal, sesjon, jobb og opphav (opphav kun fra betrodd kontekst).",
  ],
  open=[
   "**N1 (MEDIUM, ikke rettet, JARVIS-101):** et tidligere LOKALT svar om finansstatus ligger i samtalehistorikken uten begrenset-merking og kan følge med til en senere skytur (samme hull finnes for `finance_*` på main). `JARVIS_CONTROL_CENTER_FINANCE` (og `_VALUE` i H2) slås IKKE på før N1 er lukket (Q-66).",
   "DEFERRED: manuell disposisjon av ukjent utfall og avstemming på forespørsel, minne-sletting/eksport (JARVIS-060), worker-hjerteslag, tenant-indeks på `artifacts`.",
  ],
  review="To uavhengige gjennomganger: ingen BLOCKER/HIGH; M1 (flagg AV ≠ main), M2 (finans til sky ulåst), M3 (`length()`-last), L3 og L5 rettet; re-review: MERGE.",
  stack="Ingen avhengighet av de andre delene. Migrasjon 102.",
  decision="D-473"),
 dict(n=3, slug="wp-h2-control-centers", branch="claude/wp-h2-control-centers",
  title="WP-H2: kontrollsentre Drift, Verdi, Personvern og Sikkerhet + golden-suite-knapp + tilbakekall av autonomi (UA-11, D-474)",
  summary="De fire gjenværende kontrollsentrene bak egne flagg (alle AV), en deterministisk golden-suite-kjører og eierens tilbakekall av en autonomi-binding.",
  bullets=[
   "`JARVIS_CONTROL_CENTER_OPERATIONS/_VALUE/_PRIVACY/_SECURITY` (alle AV).",
   "`executive.run_golden_suite` (`JARVIS_CONTROL_GOLDEN_SUITE`): deterministisk kjører (to digester; ingen I/O, modell, DB eller nett, bevist under strace; resultat kun i minnet).",
   "`executive.revoke_autonomy_binding` (`JARVIS_CONTROL_AUTONOMY_REVOKE`): gjennomslag til `situations.clear_autonomy_policy`, klasse C, kun eier, `step_up_required: true`, idempotent, kun egen tenant og økta sitt rom; SLETTER bindingen (PARTIAL); en før-bilde-revisjonsrad committes FØR slettingen (fail-closed). Går via eksisterende `/executive/mutate`, som kjenner navnene KUN når verktøyet er registrert (flagg AV gir samme 400 `action_not_allowed` som main).",
   "Datalåser ved utførelse: Verdi-senteret (AI-kostnad i øre) holdes HELT tilbake fra skymodeller (strengeste regel til eieren svarer, Q-64).",
   "Personvern: herdet `DocReader` (ingen symlenke i stien, cache, single-flight og backoff, DPIA-etikettfilter).",
   "Ingen ny migrasjon, ingen ny rute.",
  ],
  open=[
   "N1 (samtalehistorikk, se H1) betinger `JARVIS_CONTROL_CENTER_VALUE`; N2 (Sikkerhet-`restrictFinance` ufullstendig), N3–N6 (DPIA-sti/tak/svarteliste, før-bildets atomisitet) er dokumentert i runbooken og ikke rettet.",
   "PARTIAL (uendret fra main): AI-senteret, Autoritet, Integrasjoner og `get_value_report` viser fortsatt finansavledet tilstand til skymodeller.",
   "Baseline-fixturene er festet til main `ec3e684e`; legitime tillegg i senere deler gjør dem røde til de regenereres etter overskriften i testen.",
  ],
  review="To uavhengige gjennomganger: ingen BLOCKER/HIGH; M1, M2, M3 og L1–L5 rettet; re-review: MERGE etter H1.",
  stack="Inneholder H1 (to-forelder-merge): merges ETTER H1.",
  decision="D-474"),
 dict(n=4, slug="wp-i-connector-sdk", branch="claude/wp-i-connector-sdk",
  title="WP-I: Connector SDK/fabrikk (UA-0, masterplan kap. 10 + Appendiks B, D-472)",
  summary="Ny pakke `@jarvis/connector-sdk` som gjør «bygg en ny connector» repeterbart og målbart. `BUILT_UNWIRED`: ingen kjøretidseffekt (ingen flagg, migrasjon, verktøy, rute eller side).",
  bullets=[
   "`ConnectorManifest` (zod; kap. 10-seksjonene + `d41_audit` + `core_boundary.system_of_record`) med redaksjonssikker validator; skeleton-avledning for alle 58 registeroppføringer (`Unknown` der noe ikke kan avledes; D-64-svaret er aldri en stille standard); tre håndskrevne fulle referansemanifester (GitHub D-94, Cloudflare D-461, Stripe D-109).",
   "Kontraktstest-kit: 27 sjekker, 31 mutanter med eksakte sett, virtuell klokke, Appendiks B-scoring. Bevis mot en fake er `modelled`, aldri `proven`.",
   "CI-vakt med 18 regler og en committet skeleton-baseline (48 id-er); connector-gjeld som ren lesemodell; scaffold-generator `ops/connector/new-connector.mjs`; rapport-CLI.",
  ],
  open=[
   "Ærlige grenser: skanneren har blindsoner (nullbredde, tokens delt over felt, Basic-auth, AWS-nøkler, hex/base64) og kan gi falsk positiv; `modelled` er STRENGERE enn ToolGateway-ledgeren (JARVIS-102); `production-definitions.ts` er et håndført speil av `main.ts`.",
   "DEFERRED: gjeldskobling til Integrasjonssenteret, transport-bro (`real_transport`), frosset legacy-liste, full manifest for de 48 andre bygde connectorene, utvidelse av delt `scanForSecrets` (Q-65). Live smoke mot GitHub/Cloudflare/Stripe er `BLOCKED_EXTERNAL`.",
   "Leverandørfakta er sjekket kun via WebSearch-sammendrag (dokumentasjonsvertene var ikke hentbare); de uverifiserte står som `unverified`. EV-18 forblir `DORMANT`.",
  ],
  review="To uavhengige gjennomganger og én smal re-review: ingen BLOCKER/HIGH; 5 MEDIUM (første) og 2 MEDIUM + 5 LOW (re-review), alle rettet. Lead-verifisert: 14 testfiler/423 tester og repo-brede vakter grønne; full suite ikke kjørt på siste head (forrige head: 13 354 av 13 359, resten sandkasse-miljøfeil).",
  stack="Ingen avhengighet av de andre delene. Ingen migrasjon.",
  decision="D-472"),
 dict(n=5, slug="wp-b3-evolution-centers", branch="claude/wp-b3-evolution-centers",
  title="WP-B3: Evolusjon-senteret (EV-22) og eierens avgjørelse om endringsforslag (EV-23, D-475)",
  summary="Evolusjon som tilleggssenter (kun lesing) og en registrering uten virkning av eierens avgjørelse om et endringsforslag.",
  bullets=[
   "EV-22: tilleggssenter (`EXTENSION_CONTROL_CENTER_IDS`) utenfor masterplanens ti, kun lesing av eksisterende kilder bak `JARVIS_CONTROL_CENTER_EVOLUTION`; kost i øre holdes HELT tilbake fra sky ved utførelse (strengeste regel, Q-64).",
   "Forslagslisten viser de nyeste forslagene uten registrert avgjørelse (numerisk ledger-seq); kosttrenden er ukjent når kildene ikke stemmer overens; kjede-/konstitusjonsraden er et oppstartsresultat (ikke målt nå).",
   "EV-23: registrering uten virkning: klasse C, `JARVIS_CONTROL_EVOLUTION_APPROVAL`, kun eier, signert enhet og step-up, aldri modell; bundet til forslagets siste ledger-rad. Lagres i `audit_events` (`evolution.owner_decision`), ikke i endringsregisteret. `activation_decision` er alltid false.",
   "Selvendring forblir frosset (D-397). Et avslag åpner aldri en hendelse (`executive` er `configured:false` for incident-produsenten).",
  ],
  open=[
   "Knappene har ingenting å vise før en forslagsprodusent finnes; å bruke avgjørelsen til noe krever en ny navngitt D-beslutning. JARVIS-109, Q-69. Runbook `docs/runbooks/WPB3_EVOLUTION_CENTERS.md`.",
  ],
  review="Uavhengig review (1 HIGH, 1 MEDIUM, 5 LOW), re-review: MERGE, og lead-sjekket oppfølger. Test på denne grenens stabel: full suite 14 511 av 14 516 (5 kjente sandkasse-feil), 14 536 tester i 855 filer.",
  stack="Stablet på K + H1 + H2 + I (integrasjonsmerger): merges ETTER disse. Ingen migrasjon.",
  decision="D-475"),
 dict(n=6, slug="wp-d3-growth-writes", branch="claude/wp-d3-growth-writes",
  title="WP-D3: Growth-skriving (UA-4) – Google Ads, Meta, GA4, Search Console, GBP, YouTube, LinkedIn, TikTok + eksperimentregister (D-459)",
  summary="Skriving mot åtte vekstplattformer gjennom én motor med eierens mål-allowlist, step-up, klasse D-kjede og Jarvis' egen før/etter-journal, pluss et eksperimentregister. Alt AV som standard.",
  bullets=[
   "19 lese- og 43 skrivehandlinger (16 klasse C og 27 klasse D; sletting og publisering/eksponering er klasse D): eier-eksklusive `growth_*`-navnerom, mål-allowlist (`JARVIS_GROWTH_WRITE_TARGETS`), step-up på alle skrivinger, `growth_write_journal` (migrasjon 113) med idempotensnøkkel og readback.",
   "Transportfeil etter sendt mutasjon er alltid UKJENT utfall (`outcome_unknown`/`unverified`); kun bevist før-sending-feil er FAILED; idempotensnøkkelen kan ikke gjenbrukes på tvers av verktøy; kommando-bundet utførelse kan kun REDUSERE et levende budsjett.",
   "Pengeøkende handlinger nektes når finans-nødbryteren er på eller ukjent. Eierens frys av googleads/metaads stanser også skrivingen (kun API).",
   "Eksperimentregister (hypotese, variant, tidsvindu, metrikk, utfall) og kreativ-intelligens som rene beslutningsfunksjoner over data Jarvis allerede har.",
   "Migrasjon 112–114 (114 endret på stedet FØR første anvendelse i en vedvarende DB). Flagg (alle AV = identisk med main): `JARVIS_GROWTH_WRITE_PLATFORMS`, `JARVIS_GROWTH_WRITE_TARGETS`, `JARVIS_GROWTH_CREATIVE_URL_HOSTS`, `JARVIS_GROWTH_EXPERIMENTS`.",
  ],
  open=[
   "Live er `BLOCKED_EXTERNAL` per plattform (Google Ads developer token og tilgangsnivå, Meta-verifisering, GBP API-godkjenning, LinkedIn MDP, TikTok-godkjenning; D-108).",
   "Leverandørfakta (sidestørrelser, enum-lister, YouTube-normalisering, Meta-valutaoffset) er UVERIFISERT mot primærkilder (utilgjengelige i byggemiljøet). Attribusjon spend/klikk/lead/kunde: koblingspunktene er bygget, resten er `DEFERRED`. JARVIS-106..108, Q-68.",
  ],
  review="Uavhengig review (1 HIGH, 6 MEDIUM, 8 LOW), to fiks-runder, to re-reviewer og én delta-re-review; siste verdikt MERGE.",
  stack="Stablet på K + H1 + H2 + I: merges ETTER disse.",
  decision="D-459"),
 dict(n=7, slug="wp-b4-claude-budget-pacing", branch="claude/wp-b4-claude-budget-pacing",
  title="WP-B4: månedlig Claude-kreditt (100 USD) brukes fornuftig over måneden (D-476)",
  summary="Eierens ordre 2026-11-16: de 100 USD gratis Claude-API per måned skal brukes fornuftig over måneden. Ren tempomotor, håndhevet i kode i `ModelGateway`, AV som standard.",
  bullets=[
   "Perioden fornyes den 15. (Europe/Oslo, 28–31 døgn, ikke kalendermåned); `JARVIS_CLAUDE_BUDGET_USD` (AV = identisk med main). Kurve med 15 % reserve kun for ESSENSIELL og 5 % startmargin; nivåene gir allow, nedgrader, utsett eller stopp per tier (ESSENSIELL = eierens egne turer, VIKTIG = attesterte bestilte jobber og kritikk, BAKGRUNN = resten).",
   "Q-67 (eierens svar: «15 hver måned og nr 2 gjør det du tenker er best»): hard stopp av Anthropic ved 100 % med LOKAL fallback; `JARVIS_CLAUDE_BUDGET_HARD_STOP=off` er eierens override (fortsetter og varsler).",
   "`BudgetGuard` for alle leverandører og dagstakene for verktøyturer er uendret ytre vern. Forbruket er et anslag; varsler (50/75/90/100 % og tempo over 1,3) er minst-én-gang og forutsetter én worker.",
   "Eneste skjemaendring: migrasjon 115 (dekkende indeks, gjelder uavhengig av flagget). Anbefalt innstilling ved aktivering: `JARVIS_CLAUDE_BUDGET_USD=95` til tellingen er kalibrert mot konsollen.",
  ],
  open=[
   "Claude Code-jobber (D-96) er `DEFERRED`; rest-overskridelse mellom prosesser opptil 3 s; spesialist-delegering med eksplisitt liste kan gå til openai/gemini når Anthropic er stengt (Q-70 pkt 1). JARVIS-110, Q-70. Runbook `docs/runbooks/WPB4_CLAUDE_BUDGET_PACING.md`.",
  ],
  review="Uavhengig review (3 MEDIUM, 7 LOW), fiks, re-review: MERGE og lead-sjekket oppfølger. Test på denne grenens stabel: full suite 14 487 av 14 492 (5 kjente sandkasse-feil) før oppfølgeren.",
  stack="Stablet på K + H1 + H2 + I: merges ETTER disse. (Historikken har en omskrevet variant; hjelperefene `wp-b4-backup-before-history-fix` og `wp-b4-rewrite` skal IKKE pushes.)",
  decision="D-476"),
 dict(n=8, slug="wp-g1-comms", branch="claude/wp-g1-comms",
  title="WP-G1: Communications Hub – resten av UA-7 (kanaler, kontakter, møtetranskripsjon, utgående regler og AI-ringing, push-oppfølging; D-463)",
  summary="Resten av UA-7 som hvilende, flagg-styrt kode (`JARVIS_COMMS_*`, alle AV). Jarvis eier modellen, policyen og journalen; leverandørene er adaptere.",
  bullets=[
   "Conversation Graph dekker alle UA-7-kanaler (slack, discord, whatsapp, sms, teams, messenger, instagram, phone; migrasjon 117).",
   "Felles deterministisk utgående policy (`modules/comms`) foran hver NY `comms.*`-utsendelse: konto-allowlist, mottakervalidering, stille timer, rate-limit, plattformvinduer, AI-opplysning lagt til i kode, markedsføring feiler lukket, revisjonsjournal (hash og lengde, aldri teksten). Utsendelse er klasse D `outbound_message` med idempotensnøkkel og `outcome_unknown`.",
   "Mottakerens avmelding (STOP) er tenant-bred per normalisert identifikator. Signerte innkommende webhooks (Slack, Meta, Twilio, Telnyx; rå bytes med 256 KB-tak før signatur, replay-vern, idempotent inntak) lagres som ubetrodd data (regel 7).",
   "Eier-eksklusive `comms.*`-verktøy (35 handlinger, ingen på modellflate) og ruter `/comms/preview` og `/comms/action` (grant, suveren eier, step-up, gateway).",
   "Google Contacts (les/opprett/endre/slett som klasse D), Teams (kun delegert), Messenger/Instagram (kun RESPONSE), møtetranskripsjon-pipeline (rettsgrunnlag attestert av eier med DB-CHECK; transkripsjonsteksten lagres aldri), utgående AI-ringing på Twilio kun mot falsk transport, og et svar-oppfølgingssveip.",
   "Migrasjon 117–119. `CORE_DEPENDENCY_DECISION_REQUIRED=false` (ingen leverandør ble kjerne).",
  ],
  open=[
   "**JARVIS-112 (a) MÅ rettes før `JARVIS_COMMS_OUTBOUND` slås på.** Q-72.",
   "De eldre `twilio`/`telnyx`/`whatsapp`/`slack`/`discord` `notify`-verktøyene omgår den nye policyen (`DEFERRED`). Reservasjonsregisteret og samtykkeregister er `BLOCKED_EXTERNAL`.",
  ],
  review="To uavhengige gjennomganger, to fiks-runder og tre delta-re-reviewer; siste verdikt MERGE (dvalende).",
  stack="Stablet på K + H1 + H2 + I: merges ETTER disse.",
  decision="D-463"),
 dict(n=9, slug="wp-g2-personal", branch="claude/wp-g2-personal",
  title="WP-G2: Personal Digital Twin – resten av UA-8 (kritiske hjem- og bilhandlinger, familie/delte rom, helse-inntak, Apple DAV, økonomi-lesing; D-464)",
  summary="Resten av UA-8 som hvilende, flagg-styrt kode (`JARVIS_PERSONAL_*`, alle AV). Ingen ny connector i `CONNECTOR_REGISTRY`; `CORE_DEPENDENCY_DECISION_REQUIRED=false`.",
  bullets=[
   "Kritiske hjemmehandlinger: 8 verktøy `home-assistant.critical_{lock,alarm,cover,valve,switch,scene,script,climate_mode}` + `read_critical_state` er klasse D med eierens mål-allowlist, preflight, readback av faktisk sluttilstand (SUCCESS/MISMATCH/UNKNOWN), journal (migrasjon 125), umiddelbart varsel og eierens step-up (strengeste standard, Q-55/D-468). En autonomi-binding til dem avvises ved bind-tid; de gamle `lock_set`/`alarm_set` fjernes når flagget er på.",
   "Målets lås er prosess-lokal og ikke-blokkerende per (domene, mål); ingen databaseforbindelse holdes (ingen pool-dødlås).",
   "Bil via leverandørnøytral `CarAdapter` (falsk adapter og kontraktskit; live `BLOCKED_EXTERNAL`; uten adapter feiler alt lukket).",
   "Familie og delte rom: eget autoritetslag i en dedikert sirkel-tenant (Q-15-hullet); deling kan kun gis av subjektet selv (DB-CHECK); barn deler og ser aldri helse; fjerning/forlating tilbakekaller enheter og grants og forbruker åpne billetter i samme transaksjon.",
   "Helse-inntak (`POST /personal/health/ingest`, 10 lukkede metrikker, idempotent på HealthKit-uuid, fail-closed retensjon, migrasjon 128). Apple Kalender/Påminnelser/Kontakter bygget mot en FALSK server (6 eier-kun-ruter `/personal/dav/*`).",
   "Migrasjon 125–128.",
  ],
  open=[
   "**Tverr-prosess-serialisering av mållåsen er `DEFERRED`** og må løses før mer enn én API-prosess kjører personal-handlinger (`createPersonalWiring` kalles i dag kun fra `main.ts`).",
   "**JARVIS-111 / Q-71:** step-up-kanalen er klient-påstått (`/session/authorize`); forslag WP-S1 (`docs/remediation/WPS1_STEPUP_KANALBINDING_FORSLAG.md`) venter på en navngitt D-beslutning. Ikke slå på `JARVIS_PERSONAL_*` på en maskin med en lavtillits-enhet innrullert. JARVIS-113, Q-73.",
  ],
  review="To uavhengige gjennomganger, to fiks-runder og to delta-re-reviewer; siste verdikt MERGE (dvalende). Funn som ble rettet: pool-dødlås (HIGH) og innrullings-race ved fjerning av medlem.",
  stack="Endelige tips for K, H1, H2, I, B3 og D3 er forfedre til denne grenen (verifisert med `git merge-base --is-ancestor`); den mangler 4 av B4s endelige commits og inneholder ikke G1. Merges ETTER disse, med `origin/main` merget inn først. **Test-tilpasning som må med når G1 er i main:** `apps/api/test/wpg1-comms-routes.test.ts` (comms-kildevakten tåler `personal.filterTools`/`personal.tools` i register-løkken; se commit `ca13dace` på `integration/post-merge-test-2`). Migrasjon 125–128.",
  decision="D-464"),
 dict(n=10, slug="wp-g3-vision", branch="claude/wp-g3-vision",
  title="WP-G3: Vision & Physical World – resten av UA-9 (kamerahendelser, inventar, lokal visjonsmodell, iPhone på forespørsel; D-465)",
  summary="UA-9 som hvilende, flagg-styrt kode (tolv `JARVIS_VISION_*`-flagg, alle AV, kun eksakt `on`). Jarvis eier kamera-, hendelses-, inventar- og retensjonsdomenet (`JARVIS_CANONICAL`, D-64); Home Assistant og iPhone er KILDER.",
  bullets=[
   "HA: kun GET mot `/api/states` og `/api/camera_proxy`, ett bilde per hendelse. iPhone: kun serverkontrakt for forespørsel og signert engangsopplasting (appen er `BLOCKED_EXTERNAL`). Lokal visjonsmodell er en utskiftbar adapter bak `ModelGateway` (`local_vision`), registrert kun når adapteren er på.",
   "Kamerabilder er BEGRENSET data og går aldri til sky: tre uavhengige lag (sensitivitetsrute, utførelseslås i gatewayen og adaptergrense); lokal URL validert ved oppstart (offentlige og link-lokale adresser avvises; Tailscale kun med `JARVIS_VISION_ALLOW_TAILSCALE`), ingen redirect.",
   "Kun hendelses-øyeblikksbilder lagres, aldri video: retensjon bilder 7 døgn og hendelser 30, tak 2 GiB per space (advisory-lås); reaper tåler samtidige kjøringer og skriverester.",
   "Etikett-CHECK i migrasjon 133/135 er locale-uavhengig (bevist mot alle Unicode-kodepunkt i C og C.UTF-8); inventar skrives i et savepoint slik at en etikett uten inventarform aldri taper basishendelsen.",
   "Modellsvar er ubetrodd data (regel 7): lukket hendelsessett, ukjent forkastes. Migrasjon 133–137.",
  ],
  open=[
   "Migrasjon 133–136 ble endret på stedet før første utgivelse (ingenting er utgitt): en sandkasse-DB som kjørte en tidligere variant feiler med `migration_checksum_mismatch` og må gjenskapes.",
   "Per-kall DNS-pinning er `DEFERRED`. N1 (JARVIS-101) må lukkes før modellvendte vision-verktøy. JARVIS-114, Q-74.",
   "Reviewer B sin siste mini-sjekk (delta 3) ble avbrutt av en tillatelsesforespørsel og er kun foreløpig (MERGE).",
  ],
  review="To uavhengige gjennomganger, én fiks-runde, en mini-fiks-runde og delta-re-reviewer; siste verdikt MERGE (dvalende). Funn som ble rettet: locale-regresjon i etikett-CHECK som ville tapt hele kamerahendelsen (MEDIUM).",
  stack="Endelige tips for K, H1, H2, I, B3 og D3 er forfedre til denne grenen (verifisert); den mangler 4 av B4s endelige commits og inneholder ikke G1. Merges ETTER disse, med `origin/main` merget inn først. Migrasjon 133–137.",
  decision="D-465"),
 dict(n=11, slug="wp-g4-situation-bridges", branch="claude/wp-g4-situation-bridges",
  title="WP-G4: Proactive Situation Engine – resten av UA-10 (sanntids-abonnement, hjem-/kamera-/helse-broer, modellassistert vurdering, simulering og tilbakemelding; D-466)",
  summary="UA-10 som hvilende, flagg-styrt kode (`JARVIS_SITUATION_*`, alle AV, kun eksakt `on`). Situation Engine er `JARVIS_CANONICAL` (D-64); hendelseskildene er kilder; ingen ny leverandør.",
  bullets=[
   "Samlet hendelsesabonnement (abonnementsregister, inntaksbuss og hendelsesløper, migrasjon 139) leser HA-hendelser (ÉN gateway-lesing per tikk), kamerahendelser (G3, kun rommet `home`), helseavvik (G2) og incidents; kommunikasjons-/forpliktelsessignal (G1) når motoren via det daglige sveipet.",
   "Rene broer med lukkede hendelsessett: hjem, kamera (aldri ansiktsidentifikasjon) og helse (avvik fra eierens egen baseline; INFORM og SUGGEST til eieren kun; helsevarselen til Telegram er NØYTRAL).",
   "Modellassistert vurdering via `ModelGateway` kan kun foreslå kategori, prioritet og forklaring innenfor regelens tak, aldri ACT alene; kamera kun mot lokal modell. Kontrafaktisk simulering er en ren funksjon; tilbakemeldingslæring justerer terskler per regel innenfor harde grenser, revisjonsmerket og tilbakestillbart (ingen selvmodifikasjon, D-397).",
   "**Autonom ACT** krever deterministisk regel og en gyldig, ikke utløpt eier-bundet binding (D-160), håndhevet i kode. Fysiske og kritiske handlinger (lås, alarm, lys, klima, bil, `critical_*`, ukjent) kan ALDRI bindes til eller utføres av autonom ACT: én delt fail-closed allowlist-regel i `modules/situations/src/autonomy-guard.ts`, ved bind-tid, før claim i `autoActPending`/`actOn` og i simuleringen (funnet i review: de gamle `lock_set`/`alarm_set` var bindbare).",
   "Stille timer sluker aldri et signal; retensjonssveip; eierflate `POST /situations/signals/*` (404 uten flagg; step-up på endring; typet bekreftelse på fjerning). Migrasjon 139 (ureleaset; rettet på stedet).",
  ],
  open=[
   "JARVIS-115, Q-75 (bl.a. pkt 11: Make/n8n kan bindes til hjemmedomenet). JARVIS-111/Q-71: step-up-kanalen er klient-påstått (se G2).",
   "G4-grenen inneholder tidligere versjoner av G1, G2 og G3 (via integrasjonsmerger), men ikke deres endelige fiks-commits (mangler 9, 23 og 26 commits). Merges derfor etter G1–G3, med `origin/main` merget inn først. Kildebroene mot G2/G3-tabeller er integrasjonstestet på `integration/post-merge-test-2` (alle ni deler), ikke på denne grenen alene.",
  ],
  review="To uavhengige gjennomganger, én fiks-runde, delta-re-reviewer og en mikrofiks-runde; siste verdikt MERGE (dvalende). Funn som ble rettet: autonom ACT kunne låse opp/avarmere via de gamle klasse D-verktøyene (HIGH), stille timer sluket signaler permanent (HIGH), helsekilden var død mot ekte DB (numeric som streng, HIGH).",
  stack="Endelige tips for K, H1, H2, I, B3, D3 og B4 er forfedre til denne grenen (verifisert): merges som SISTE kode-PR (etter G2 og G3). **Test-tilpasning som må med når G2 er i main:** `modules/situations/test/wpg2-autonomy-step-up.test.ts` (godtar begge bind-tid-feil og beviser at `gateway.execute` på `critical_lock` gir `step_up_required:signed_device_session`; se commit `87b49a65` på `integration/post-merge-test-2`). Migrasjon 139.",
  decision="D-466"),
 dict(n=12, slug="docs-konsolidering", branch="claude/d471-d474-konsolidering",
  title="docs: byggeprogrammet etter D-470 – beslutninger, åpne spørsmål, funn, lukkingsmatrise, status og WP-S1-forslag",
  summary="Konsoliderer dokumentasjonen for de ti delene som er bygget etter at byggepausen ble opphevet (D-470): ingen kode.",
  bullets=[
   "`DECISIONS_AND_ASSUMPTIONS.md`: D-459 (D3), D-463..D-466 (G1..G4), D-470 (byggepausen opphevet) og D-471..D-476 (K, I, H1, H2, B3, B4). Beslutningsloggen for hele programmet ligger kun i denne grenen.",
   "`OPEN_QUESTIONS.md`: Q-63..Q-75 med anbefalinger (Q-71 peker til WP-S1-forslaget; Q-73/74/75 er eierspørsmål fra G2/G3/G4).",
   "`remediation/FINDINGS_LEDGER.md`: JARVIS-101..115 (bl.a. JARVIS-111 step-up-kanal, JARVIS-112 comms-utgående, JARVIS-113..115 oppfølginger for G2..G4).",
   "`CLOSURE_MATRIX_HF1_HF2.md`: EV-18, EV-22/23, UA-0, UA-4, UA-7..UA-11. `PROJECT_STATUS.md`: nytt toppavsnitt «AKTIV STATUS – byggeprogrammet etter D-470». `OWNER_ACTIONS_HF1_HF2.md`: nytt §7 med eierens handlinger N1–N8.",
   "NY `remediation/WPS1_STEPUP_KANALBINDING_FORSLAG.md`: FORSLAG (ingen kode) om server-side kanalbinding for step-up (lukket enhetstype → tillatte kanaler, observe→enforce, alternativer A–D, beslutninger du må ta). WP-S1 starter først etter en navngitt D-beslutning.",
  ],
  open=[
   "D-470-commiten (`776f0ae8`) følger med denne grenen. Den lå på den gamle kontoen som PR #336 (`claude/d470-byggepause-opphevet`), som ikke finnes i forken; denne PR-en erstatter den.",
  ],
  review="Docs-vakter (lukkingsmatrisen, D-420, connector-sdk m.fl.): 18 filer/292 tester grønne på `integration/post-merge-test-2` @95380285.",
  stack="Docs-PR: merges sist (etter at delenes PR-er er inne), eller tidligere hvis arkitekten ønsker beslutningsloggen først.",
  decision="D-464..D-476"),
]

def render(p):
    lines = [f"# {p['title']}", "", "## Sammendrag", p["summary"], "", "## Hva som er med"]
    lines += [f"- {b}" for b in p["bullets"]]
    lines += ["", STATUS.rstrip(), "", "## Gjennomgang", p["review"], "", "## Åpne punkter og kjente begrensninger"]
    lines += [f"- {o}" for o in p["open"]]
    lines += ["", "## Rekkefølge og avhengigheter", p["stack"], "",
              f"Full beslutning: {p['decision']} i `docs/DECISIONS_AND_ASSUMPTIONS.md` (ligger på docs-grenen `claude/d471-d474-konsolidering`, ikke i denne grenen). Branch: `{p['branch']}`. Draft inntil arkitektens review er gjort; ingen merge før reglene i CLAUDE.md er oppfylt (CI grønn, ingen åpne tråder, eksakt head-/base-guard, to-forelder-merge).",
              FOOTER]
    return "\n".join(lines)

index = []
for p in PRS:
    name = f"pr-{p['n']:02d}-{p['slug']}.md"
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
        f.write(render(p))
    index.append((p["n"], p["branch"], p["title"], name))
with open(os.path.join(OUT, "INDEX.tsv"), "w", encoding="utf-8") as f:
    for n, b, t, name in index:
        f.write(f"{n}\t{b}\t{name}\t{t}\n")
print("OK", len(index), "PR-utkast skrevet")
