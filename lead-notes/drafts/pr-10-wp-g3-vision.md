# WP-G3: Vision & Physical World – resten av UA-9 (kamerahendelser, inventar, lokal visjonsmodell, iPhone på forespørsel; D-465)

## Sammendrag
UA-9 som hvilende, flagg-styrt kode (tolv `JARVIS_VISION_*`-flagg, alle AV, kun eksakt `on`). Jarvis eier kamera-, hendelses-, inventar- og retensjonsdomenet (`JARVIS_CANONICAL`, D-64); Home Assistant og iPhone er KILDER.

## Hva som er med
- HA: kun GET mot `/api/states` og `/api/camera_proxy`, ett bilde per hendelse. iPhone: kun serverkontrakt for forespørsel og signert engangsopplasting (appen er `BLOCKED_EXTERNAL`). Lokal visjonsmodell er en utskiftbar adapter bak `ModelGateway` (`local_vision`), registrert kun når adapteren er på.
- Kamerabilder er BEGRENSET data og går aldri til sky: tre uavhengige lag (sensitivitetsrute, utførelseslås i gatewayen og adaptergrense); lokal URL validert ved oppstart (offentlige og link-lokale adresser avvises; Tailscale kun med `JARVIS_VISION_ALLOW_TAILSCALE`), ingen redirect.
- Kun hendelses-øyeblikksbilder lagres, aldri video: retensjon bilder 7 døgn og hendelser 30, tak 2 GiB per space (advisory-lås); reaper tåler samtidige kjøringer og skriverester.
- Etikett-CHECK i migrasjon 133/135 er locale-uavhengig (bevist mot alle Unicode-kodepunkt i C og C.UTF-8); inventar skrives i et savepoint slik at en etikett uten inventarform aldri taper basishendelsen.
- Modellsvar er ubetrodd data (regel 7): lukket hendelsessett, ukjent forkastes. Migrasjon 133–137.

## Status (ærlig)
- `BUILT`, `DORMANT`/AV bak egne flagg og `NOT VERIFIED`: ingenting er `VERIFIED` før det finnes en kjøring på NAS (se runbook for delen).
- Alle gjennomganger er gjort av SEPARATE Claude-agenter som var uavhengige av byggeren; de er IKKE den eksterne arkitektens review. **Arkitektens uavhengige review (mot faktisk diff, tester, CI og sikkerhet) gjenstår før merge**, og denne PR-en er derfor draft.
- Lokal integrasjonsverifisering (`integration/post-merge-test-2` = alle ni deler + docs, ikke pushet): `typecheck`, `lint`, `check:containment` og gitleaks (330 commits) exit 0; én samlet full suite: 16 649 av 16 654 tester grønne (975 filer). De fem røde er kjente sandkasse-feil (wpc3-review1-hardening F10a/b/c, break-glass-guard, nas-ua0-gate «friskt system»), ikke knyttet til denne delen.
- Per-gren CI på GitHub er ikke kjørt (GitHub har vært utilgjengelig fra sesjonen siden 2026-11-15).

## Gjennomgang
To uavhengige gjennomganger, én fiks-runde, en mini-fiks-runde og delta-re-reviewer; siste verdikt MERGE (dvalende). Funn som ble rettet: locale-regresjon i etikett-CHECK som ville tapt hele kamerahendelsen (MEDIUM).

## Åpne punkter og kjente begrensninger
- Migrasjon 133–136 ble endret på stedet før første utgivelse (ingenting er utgitt): en sandkasse-DB som kjørte en tidligere variant feiler med `migration_checksum_mismatch` og må gjenskapes.
- Per-kall DNS-pinning er `DEFERRED`. N1 (JARVIS-101) må lukkes før modellvendte vision-verktøy. JARVIS-114, Q-74.
- Reviewer B sin siste mini-sjekk (delta 3) ble avbrutt av en tillatelsesforespørsel og er kun foreløpig (MERGE).

## Rekkefølge og avhengigheter
Endelige tips for K, H1, H2, I, B3 og D3 er forfedre til denne grenen (verifisert); den mangler 4 av B4s endelige commits og inneholder ikke G1. Merges ETTER disse, med `origin/main` merget inn først. Migrasjon 133–137.

Full beslutning: D-465 i `docs/DECISIONS_AND_ASSUMPTIONS.md` (ligger på docs-grenen `claude/d471-d474-konsolidering`, ikke i denne grenen). Branch: `claude/wp-g3-vision`. Draft inntil arkitektens review er gjort; ingen merge før reglene i CLAUDE.md er oppfylt (CI grønn, ingen åpne tråder, eksakt head-/base-guard, to-forelder-merge).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DjaWBW7BCa7u4mUsiHFwH4
