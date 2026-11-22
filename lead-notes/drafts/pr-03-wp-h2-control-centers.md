# WP-H2: kontrollsentre Drift, Verdi, Personvern og Sikkerhet + golden-suite-knapp + tilbakekall av autonomi (UA-11, D-474)

## Sammendrag
De fire gjenværende kontrollsentrene bak egne flagg (alle AV), en deterministisk golden-suite-kjører og eierens tilbakekall av en autonomi-binding.

## Hva som er med
- `JARVIS_CONTROL_CENTER_OPERATIONS/_VALUE/_PRIVACY/_SECURITY` (alle AV).
- `executive.run_golden_suite` (`JARVIS_CONTROL_GOLDEN_SUITE`): deterministisk kjører (to digester; ingen I/O, modell, DB eller nett, bevist under strace; resultat kun i minnet).
- `executive.revoke_autonomy_binding` (`JARVIS_CONTROL_AUTONOMY_REVOKE`): gjennomslag til `situations.clear_autonomy_policy`, klasse C, kun eier, `step_up_required: true`, idempotent, kun egen tenant og økta sitt rom; SLETTER bindingen (PARTIAL); en før-bilde-revisjonsrad committes FØR slettingen (fail-closed). Går via eksisterende `/executive/mutate`, som kjenner navnene KUN når verktøyet er registrert (flagg AV gir samme 400 `action_not_allowed` som main).
- Datalåser ved utførelse: Verdi-senteret (AI-kostnad i øre) holdes HELT tilbake fra skymodeller (strengeste regel til eieren svarer, Q-64).
- Personvern: herdet `DocReader` (ingen symlenke i stien, cache, single-flight og backoff, DPIA-etikettfilter).
- Ingen ny migrasjon, ingen ny rute.

## Status (ærlig)
- `BUILT`, `DORMANT`/AV bak egne flagg og `NOT VERIFIED`: ingenting er `VERIFIED` før det finnes en kjøring på NAS (se runbook for delen).
- Alle gjennomganger er gjort av SEPARATE Claude-agenter som var uavhengige av byggeren; de er IKKE den eksterne arkitektens review. **Arkitektens uavhengige review (mot faktisk diff, tester, CI og sikkerhet) gjenstår før merge**, og denne PR-en er derfor draft.
- Lokal integrasjonsverifisering (`integration/post-merge-test-2` = alle ni deler + docs, ikke pushet): `typecheck`, `lint`, `check:containment` og gitleaks (330 commits) exit 0; én samlet full suite: 16 649 av 16 654 tester grønne (975 filer). De fem røde er kjente sandkasse-feil (wpc3-review1-hardening F10a/b/c, break-glass-guard, nas-ua0-gate «friskt system»), ikke knyttet til denne delen.
- Per-gren CI på GitHub er ikke kjørt ennå: delene ble bygget mens GitHub var utilgjengelig fra sesjonen (2026-11-15 til 2026-11-22), og arbeidet ligger nå i den nye forken `FFrollerskis/jarvis-build` (kontobytte, eierens ordre 2026-11-22; Actions må slås på i forken). Sandkassekjøringene (embedded Postgres, falske kilder) står over.

## Gjennomgang
To uavhengige gjennomganger: ingen BLOCKER/HIGH; M1, M2, M3 og L1–L5 rettet; re-review: MERGE etter H1.

## Åpne punkter og kjente begrensninger
- N1 (samtalehistorikk, se H1) betinger `JARVIS_CONTROL_CENTER_VALUE`; N2 (Sikkerhet-`restrictFinance` ufullstendig), N3–N6 (DPIA-sti/tak/svarteliste, før-bildets atomisitet) er dokumentert i runbooken og ikke rettet.
- PARTIAL (uendret fra main): AI-senteret, Autoritet, Integrasjoner og `get_value_report` viser fortsatt finansavledet tilstand til skymodeller.
- Baseline-fixturene er festet til main `ec3e684e`; legitime tillegg i senere deler gjør dem røde til de regenereres etter overskriften i testen.

## Rekkefølge og avhengigheter
Inneholder H1 (to-forelder-merge): merges ETTER H1.

Full beslutning: D-474 i `docs/DECISIONS_AND_ASSUMPTIONS.md` (ligger på docs-grenen `claude/d471-d474-konsolidering`, ikke i denne grenen). Branch: `claude/wp-h2-control-centers`. Draft inntil arkitektens review er gjort; ingen merge før reglene i CLAUDE.md er oppfylt (CI grønn, ingen åpne tråder, eksakt head-/base-guard, to-forelder-merge).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DjaWBW7BCa7u4mUsiHFwH4
