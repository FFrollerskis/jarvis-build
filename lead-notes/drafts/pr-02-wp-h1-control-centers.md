# WP-H1: kontrollsentre Finans, Minne og Agenter + proveniens på styringsjournalen (UA-11, JARVIS-087 del 2, D-473)

## Sammendrag
Tre av kontrollsentrene kobles inn som rene lese-composere bak egne flagg (alle AV), og styringsjournalen får nullbar proveniens.

## Hva som er med
- `JARVIS_CONTROL_CENTER_FINANCE/_MEMORY/_AGENT` (alle AV, kun eksakt `on`): lese-composere over eksisterende tabeller; ingen nye eksterne kall, skriveveier eller innhold.
- `executive.get_<senter>_center` (klasse A, kun eier fra signert enhetsøkt, fail-closed) registreres KUN for sentre med flagget på: flagg AV er identisk med main (95 fraser × begge flater mot en baseline fra ren `origin/main`; reviewer gjentok på 137 egne fraser/2192 utvalg: 0 forskjeller).
- Finansdata (SECRET_RESTRICTED, D-378) holdes tilbake fra skymodeller VED UTFØRELSE i executive-transporten; lokal modell og `/control` får hele rapporten.
- Agent-senteret måler artefaktmengde med `octet_length` (ikke `length`) og viser opptil 200 jobber.
- Styringsjournalen får nullbar proveniens (migrasjon 102, `JARVIS_GOVERNANCE_PROVENANCE=on`, AV som standard): kanal, sesjon, jobb og opphav (opphav kun fra betrodd kontekst).

## Status (ærlig)
- `BUILT`, `DORMANT`/AV bak egne flagg og `NOT VERIFIED`: ingenting er `VERIFIED` før det finnes en kjøring på NAS (se runbook for delen).
- Alle gjennomganger er gjort av SEPARATE Claude-agenter som var uavhengige av byggeren; de er IKKE den eksterne arkitektens review. **Arkitektens uavhengige review (mot faktisk diff, tester, CI og sikkerhet) gjenstår før merge**, og denne PR-en er derfor draft.
- Lokal integrasjonsverifisering (`integration/post-merge-test-2` = alle ni deler + docs, ikke pushet): `typecheck`, `lint`, `check:containment` og gitleaks (330 commits) exit 0; én samlet full suite: 16 649 av 16 654 tester grønne (975 filer). De fem røde er kjente sandkasse-feil (wpc3-review1-hardening F10a/b/c, break-glass-guard, nas-ua0-gate «friskt system»), ikke knyttet til denne delen.
- Per-gren CI på GitHub er ikke kjørt ennå: delene ble bygget mens GitHub var utilgjengelig fra sesjonen (2026-11-15 til 2026-11-22), og arbeidet ligger nå i den nye forken `FFrollerskis/jarvis-build` (kontobytte, eierens ordre 2026-11-22; Actions må slås på i forken). Sandkassekjøringene (embedded Postgres, falske kilder) står over.

## Gjennomgang
To uavhengige gjennomganger: ingen BLOCKER/HIGH; M1 (flagg AV ≠ main), M2 (finans til sky ulåst), M3 (`length()`-last), L3 og L5 rettet; re-review: MERGE.

## Åpne punkter og kjente begrensninger
- **N1 (MEDIUM, ikke rettet, JARVIS-101):** et tidligere LOKALT svar om finansstatus ligger i samtalehistorikken uten begrenset-merking og kan følge med til en senere skytur (samme hull finnes for `finance_*` på main). `JARVIS_CONTROL_CENTER_FINANCE` (og `_VALUE` i H2) slås IKKE på før N1 er lukket (Q-66).
- DEFERRED: manuell disposisjon av ukjent utfall og avstemming på forespørsel, minne-sletting/eksport (JARVIS-060), worker-hjerteslag, tenant-indeks på `artifacts`.

## Rekkefølge og avhengigheter
Ingen avhengighet av de andre delene. Migrasjon 102.

Full beslutning: D-473 i `docs/DECISIONS_AND_ASSUMPTIONS.md` (ligger på docs-grenen `claude/d471-d474-konsolidering`, ikke i denne grenen). Branch: `claude/wp-h1-control-centers`. Draft inntil arkitektens review er gjort; ingen merge før reglene i CLAUDE.md er oppfylt (CI grønn, ingen åpne tråder, eksakt head-/base-guard, to-forelder-merge).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DjaWBW7BCa7u4mUsiHFwH4
