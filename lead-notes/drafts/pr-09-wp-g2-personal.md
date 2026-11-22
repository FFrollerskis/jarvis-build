# WP-G2: Personal Digital Twin – resten av UA-8 (kritiske hjem- og bilhandlinger, familie/delte rom, helse-inntak, Apple DAV, økonomi-lesing; D-464)

## Sammendrag
Resten av UA-8 som hvilende, flagg-styrt kode (`JARVIS_PERSONAL_*`, alle AV). Ingen ny connector i `CONNECTOR_REGISTRY`; `CORE_DEPENDENCY_DECISION_REQUIRED=false`.

## Hva som er med
- Kritiske hjemmehandlinger: 8 verktøy `home-assistant.critical_{lock,alarm,cover,valve,switch,scene,script,climate_mode}` + `read_critical_state` er klasse D med eierens mål-allowlist, preflight, readback av faktisk sluttilstand (SUCCESS/MISMATCH/UNKNOWN), journal (migrasjon 125), umiddelbart varsel og eierens step-up (strengeste standard, Q-55/D-468). En autonomi-binding til dem avvises ved bind-tid; de gamle `lock_set`/`alarm_set` fjernes når flagget er på.
- Målets lås er prosess-lokal og ikke-blokkerende per (domene, mål); ingen databaseforbindelse holdes (ingen pool-dødlås).
- Bil via leverandørnøytral `CarAdapter` (falsk adapter og kontraktskit; live `BLOCKED_EXTERNAL`; uten adapter feiler alt lukket).
- Familie og delte rom: eget autoritetslag i en dedikert sirkel-tenant (Q-15-hullet); deling kan kun gis av subjektet selv (DB-CHECK); barn deler og ser aldri helse; fjerning/forlating tilbakekaller enheter og grants og forbruker åpne billetter i samme transaksjon.
- Helse-inntak (`POST /personal/health/ingest`, 10 lukkede metrikker, idempotent på HealthKit-uuid, fail-closed retensjon, migrasjon 128). Apple Kalender/Påminnelser/Kontakter bygget mot en FALSK server (6 eier-kun-ruter `/personal/dav/*`).
- Migrasjon 125–128.

## Status (ærlig)
- `BUILT`, `DORMANT`/AV bak egne flagg og `NOT VERIFIED`: ingenting er `VERIFIED` før det finnes en kjøring på NAS (se runbook for delen).
- Alle gjennomganger er gjort av SEPARATE Claude-agenter som var uavhengige av byggeren; de er IKKE den eksterne arkitektens review. **Arkitektens uavhengige review (mot faktisk diff, tester, CI og sikkerhet) gjenstår før merge**, og denne PR-en er derfor draft.
- Lokal integrasjonsverifisering (`integration/post-merge-test-2` = alle ni deler + docs, ikke pushet): `typecheck`, `lint`, `check:containment` og gitleaks (330 commits) exit 0; én samlet full suite: 16 649 av 16 654 tester grønne (975 filer). De fem røde er kjente sandkasse-feil (wpc3-review1-hardening F10a/b/c, break-glass-guard, nas-ua0-gate «friskt system»), ikke knyttet til denne delen.
- Per-gren CI på GitHub er ikke kjørt ennå: delene ble bygget mens GitHub var utilgjengelig fra sesjonen (2026-11-15 til 2026-11-22), og arbeidet ligger nå i den nye forken `FFrollerskis/jarvis-build` (kontobytte, eierens ordre 2026-11-22; Actions må slås på i forken). Sandkassekjøringene (embedded Postgres, falske kilder) står over.

## Gjennomgang
To uavhengige gjennomganger, to fiks-runder og to delta-re-reviewer; siste verdikt MERGE (dvalende). Funn som ble rettet: pool-dødlås (HIGH) og innrullings-race ved fjerning av medlem.

## Åpne punkter og kjente begrensninger
- **Tverr-prosess-serialisering av mållåsen er `DEFERRED`** og må løses før mer enn én API-prosess kjører personal-handlinger (`createPersonalWiring` kalles i dag kun fra `main.ts`).
- **JARVIS-111 / Q-71:** step-up-kanalen er klient-påstått (`/session/authorize`); forslag WP-S1 (`docs/remediation/WPS1_STEPUP_KANALBINDING_FORSLAG.md`) venter på en navngitt D-beslutning. Ikke slå på `JARVIS_PERSONAL_*` på en maskin med en lavtillits-enhet innrullert. JARVIS-113, Q-73.

## Rekkefølge og avhengigheter
Endelige tips for K, H1, H2, I, B3 og D3 er forfedre til denne grenen (verifisert med `git merge-base --is-ancestor`); den mangler 4 av B4s endelige commits og inneholder ikke G1. Merges ETTER disse, med `origin/main` merget inn først. **Test-tilpasning som må med når G1 er i main:** `apps/api/test/wpg1-comms-routes.test.ts` (comms-kildevakten tåler `personal.filterTools`/`personal.tools` i register-løkken; se commit `ca13dace` på `integration/post-merge-test-2`). Migrasjon 125–128.

Full beslutning: D-464 i `docs/DECISIONS_AND_ASSUMPTIONS.md` (ligger på docs-grenen `claude/d471-d474-konsolidering`, ikke i denne grenen). Branch: `claude/wp-g2-personal`. Draft inntil arkitektens review er gjort; ingen merge før reglene i CLAUDE.md er oppfylt (CI grønn, ingen åpne tråder, eksakt head-/base-guard, to-forelder-merge).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DjaWBW7BCa7u4mUsiHFwH4
