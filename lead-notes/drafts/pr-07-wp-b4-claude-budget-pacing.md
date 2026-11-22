# WP-B4: månedlig Claude-kreditt (100 USD) brukes fornuftig over måneden (D-476)

## Sammendrag
Eierens ordre 2026-11-16: de 100 USD gratis Claude-API per måned skal brukes fornuftig over måneden. Ren tempomotor, håndhevet i kode i `ModelGateway`, AV som standard.

## Hva som er med
- Perioden fornyes den 15. (Europe/Oslo, 28–31 døgn, ikke kalendermåned); `JARVIS_CLAUDE_BUDGET_USD` (AV = identisk med main). Kurve med 15 % reserve kun for ESSENSIELL og 5 % startmargin; nivåene gir allow, nedgrader, utsett eller stopp per tier (ESSENSIELL = eierens egne turer, VIKTIG = attesterte bestilte jobber og kritikk, BAKGRUNN = resten).
- Q-67 (eierens svar: «15 hver måned og nr 2 gjør det du tenker er best»): hard stopp av Anthropic ved 100 % med LOKAL fallback; `JARVIS_CLAUDE_BUDGET_HARD_STOP=off` er eierens override (fortsetter og varsler).
- `BudgetGuard` for alle leverandører og dagstakene for verktøyturer er uendret ytre vern. Forbruket er et anslag; varsler (50/75/90/100 % og tempo over 1,3) er minst-én-gang og forutsetter én worker.
- Eneste skjemaendring: migrasjon 115 (dekkende indeks, gjelder uavhengig av flagget). Anbefalt innstilling ved aktivering: `JARVIS_CLAUDE_BUDGET_USD=95` til tellingen er kalibrert mot konsollen.

## Status (ærlig)
- `BUILT`, `DORMANT`/AV bak egne flagg og `NOT VERIFIED`: ingenting er `VERIFIED` før det finnes en kjøring på NAS (se runbook for delen).
- Alle gjennomganger er gjort av SEPARATE Claude-agenter som var uavhengige av byggeren; de er IKKE den eksterne arkitektens review. **Arkitektens uavhengige review (mot faktisk diff, tester, CI og sikkerhet) gjenstår før merge**, og denne PR-en er derfor draft.
- Lokal integrasjonsverifisering (`integration/post-merge-test-2` = alle ni deler + docs, ikke pushet): `typecheck`, `lint`, `check:containment` og gitleaks (330 commits) exit 0; én samlet full suite: 16 649 av 16 654 tester grønne (975 filer). De fem røde er kjente sandkasse-feil (wpc3-review1-hardening F10a/b/c, break-glass-guard, nas-ua0-gate «friskt system»), ikke knyttet til denne delen.
- Per-gren CI på GitHub er ikke kjørt ennå: delene ble bygget mens GitHub var utilgjengelig fra sesjonen (2026-11-15 til 2026-11-22), og arbeidet ligger nå i den nye forken `FFrollerskis/jarvis-build` (kontobytte, eierens ordre 2026-11-22; Actions må slås på i forken). Sandkassekjøringene (embedded Postgres, falske kilder) står over.

## Gjennomgang
Uavhengig review (3 MEDIUM, 7 LOW), fiks, re-review: MERGE og lead-sjekket oppfølger. Test på denne grenens stabel: full suite 14 487 av 14 492 (5 kjente sandkasse-feil) før oppfølgeren.

## Åpne punkter og kjente begrensninger
- Claude Code-jobber (D-96) er `DEFERRED`; rest-overskridelse mellom prosesser opptil 3 s; spesialist-delegering med eksplisitt liste kan gå til openai/gemini når Anthropic er stengt (Q-70 pkt 1). JARVIS-110, Q-70. Runbook `docs/runbooks/WPB4_CLAUDE_BUDGET_PACING.md`.

## Rekkefølge og avhengigheter
Stablet på K + H1 + H2 + I: merges ETTER disse. (Historikken har en omskrevet variant; hjelperefene `wp-b4-backup-before-history-fix` og `wp-b4-rewrite` skal IKKE pushes.)

Full beslutning: D-476 i `docs/DECISIONS_AND_ASSUMPTIONS.md` (ligger på docs-grenen `claude/d471-d474-konsolidering`, ikke i denne grenen). Branch: `claude/wp-b4-claude-budget-pacing`. Draft inntil arkitektens review er gjort; ingen merge før reglene i CLAUDE.md er oppfylt (CI grønn, ingen åpne tråder, eksakt head-/base-guard, to-forelder-merge).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DjaWBW7BCa7u4mUsiHFwH4
