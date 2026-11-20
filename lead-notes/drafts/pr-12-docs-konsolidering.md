# docs: byggeprogrammet etter D-470 – beslutninger, åpne spørsmål, funn, lukkingsmatrise, status og WP-S1-forslag

## Sammendrag
Konsoliderer dokumentasjonen for de ti delene som er bygget etter at byggepausen ble opphevet (D-470): ingen kode.

## Hva som er med
- `DECISIONS_AND_ASSUMPTIONS.md`: D-459 (D3), D-463..D-466 (G1..G4), D-470 (byggepausen opphevet) og D-471..D-476 (K, I, H1, H2, B3, B4). Beslutningsloggen for hele programmet ligger kun i denne grenen.
- `OPEN_QUESTIONS.md`: Q-63..Q-75 med anbefalinger (Q-71 peker til WP-S1-forslaget; Q-73/74/75 er eierspørsmål fra G2/G3/G4).
- `remediation/FINDINGS_LEDGER.md`: JARVIS-101..115 (bl.a. JARVIS-111 step-up-kanal, JARVIS-112 comms-utgående, JARVIS-113..115 oppfølginger for G2..G4).
- `CLOSURE_MATRIX_HF1_HF2.md`: EV-18, EV-22/23, UA-0, UA-4, UA-7..UA-11. `PROJECT_STATUS.md`: nytt toppavsnitt «AKTIV STATUS – byggeprogrammet etter D-470». `OWNER_ACTIONS_HF1_HF2.md`: nytt §7 med eierens handlinger N1–N8.
- NY `remediation/WPS1_STEPUP_KANALBINDING_FORSLAG.md`: FORSLAG (ingen kode) om server-side kanalbinding for step-up (lukket enhetstype → tillatte kanaler, observe→enforce, alternativer A–D, beslutninger du må ta). WP-S1 starter først etter en navngitt D-beslutning.

## Status (ærlig)
- `BUILT`, `DORMANT`/AV bak egne flagg og `NOT VERIFIED`: ingenting er `VERIFIED` før det finnes en kjøring på NAS (se runbook for delen).
- Alle gjennomganger er gjort av SEPARATE Claude-agenter som var uavhengige av byggeren; de er IKKE den eksterne arkitektens review. **Arkitektens uavhengige review (mot faktisk diff, tester, CI og sikkerhet) gjenstår før merge**, og denne PR-en er derfor draft.
- Lokal integrasjonsverifisering (`integration/post-merge-test-2` = alle ni deler + docs, ikke pushet): `typecheck`, `lint`, `check:containment` og gitleaks (330 commits) exit 0; én samlet full suite: 16 649 av 16 654 tester grønne (975 filer). De fem røde er kjente sandkasse-feil (wpc3-review1-hardening F10a/b/c, break-glass-guard, nas-ua0-gate «friskt system»), ikke knyttet til denne delen.
- Per-gren CI på GitHub er ikke kjørt (GitHub har vært utilgjengelig fra sesjonen siden 2026-11-15).

## Gjennomgang
Docs-vakter (lukkingsmatrisen, D-420, connector-sdk m.fl.): 18 filer/292 tester grønne på `integration/post-merge-test-2` @95380285.

## Åpne punkter og kjente begrensninger
- D-470-commiten (`776f0ae8`) ligger også på `origin/claude/d470-byggepause-opphevet` (PR #336 – ikke verifisert, GitHub utilgjengelig); merge den først, eller la denne PR-en erstatte den.

## Rekkefølge og avhengigheter
Docs-PR: merges sist (etter at delenes PR-er er inne), eller tidligere hvis arkitekten ønsker beslutningsloggen først.

Full beslutning: D-464..D-476 i `docs/DECISIONS_AND_ASSUMPTIONS.md` (ligger på docs-grenen `claude/d471-d474-konsolidering`, ikke i denne grenen). Branch: `claude/d471-d474-konsolidering`. Draft inntil arkitektens review er gjort; ingen merge før reglene i CLAUDE.md er oppfylt (CI grønn, ingen åpne tråder, eksakt head-/base-guard, to-forelder-merge).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DjaWBW7BCa7u4mUsiHFwH4
