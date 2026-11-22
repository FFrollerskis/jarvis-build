# WP-D3: Growth-skriving (UA-4) – Google Ads, Meta, GA4, Search Console, GBP, YouTube, LinkedIn, TikTok + eksperimentregister (D-459)

## Sammendrag
Skriving mot åtte vekstplattformer gjennom én motor med eierens mål-allowlist, step-up, klasse D-kjede og Jarvis' egen før/etter-journal, pluss et eksperimentregister. Alt AV som standard.

## Hva som er med
- 19 lese- og 43 skrivehandlinger (16 klasse C og 27 klasse D; sletting og publisering/eksponering er klasse D): eier-eksklusive `growth_*`-navnerom, mål-allowlist (`JARVIS_GROWTH_WRITE_TARGETS`), step-up på alle skrivinger, `growth_write_journal` (migrasjon 113) med idempotensnøkkel og readback.
- Transportfeil etter sendt mutasjon er alltid UKJENT utfall (`outcome_unknown`/`unverified`); kun bevist før-sending-feil er FAILED; idempotensnøkkelen kan ikke gjenbrukes på tvers av verktøy; kommando-bundet utførelse kan kun REDUSERE et levende budsjett.
- Pengeøkende handlinger nektes når finans-nødbryteren er på eller ukjent. Eierens frys av googleads/metaads stanser også skrivingen (kun API).
- Eksperimentregister (hypotese, variant, tidsvindu, metrikk, utfall) og kreativ-intelligens som rene beslutningsfunksjoner over data Jarvis allerede har.
- Migrasjon 112–114 (114 endret på stedet FØR første anvendelse i en vedvarende DB). Flagg (alle AV = identisk med main): `JARVIS_GROWTH_WRITE_PLATFORMS`, `JARVIS_GROWTH_WRITE_TARGETS`, `JARVIS_GROWTH_CREATIVE_URL_HOSTS`, `JARVIS_GROWTH_EXPERIMENTS`.

## Status (ærlig)
- `BUILT`, `DORMANT`/AV bak egne flagg og `NOT VERIFIED`: ingenting er `VERIFIED` før det finnes en kjøring på NAS (se runbook for delen).
- Alle gjennomganger er gjort av SEPARATE Claude-agenter som var uavhengige av byggeren; de er IKKE den eksterne arkitektens review. **Arkitektens uavhengige review (mot faktisk diff, tester, CI og sikkerhet) gjenstår før merge**, og denne PR-en er derfor draft.
- Lokal integrasjonsverifisering (`integration/post-merge-test-2` = alle ni deler + docs, ikke pushet): `typecheck`, `lint`, `check:containment` og gitleaks (330 commits) exit 0; én samlet full suite: 16 649 av 16 654 tester grønne (975 filer). De fem røde er kjente sandkasse-feil (wpc3-review1-hardening F10a/b/c, break-glass-guard, nas-ua0-gate «friskt system»), ikke knyttet til denne delen.
- Per-gren CI på GitHub er ikke kjørt ennå: delene ble bygget mens GitHub var utilgjengelig fra sesjonen (2026-11-15 til 2026-11-22), og arbeidet ligger nå i den nye forken `FFrollerskis/jarvis-build` (kontobytte, eierens ordre 2026-11-22; Actions må slås på i forken). Sandkassekjøringene (embedded Postgres, falske kilder) står over.

## Gjennomgang
Uavhengig review (1 HIGH, 6 MEDIUM, 8 LOW), to fiks-runder, to re-reviewer og én delta-re-review; siste verdikt MERGE.

## Åpne punkter og kjente begrensninger
- Live er `BLOCKED_EXTERNAL` per plattform (Google Ads developer token og tilgangsnivå, Meta-verifisering, GBP API-godkjenning, LinkedIn MDP, TikTok-godkjenning; D-108).
- Leverandørfakta (sidestørrelser, enum-lister, YouTube-normalisering, Meta-valutaoffset) er UVERIFISERT mot primærkilder (utilgjengelige i byggemiljøet). Attribusjon spend/klikk/lead/kunde: koblingspunktene er bygget, resten er `DEFERRED`. JARVIS-106..108, Q-68.

## Rekkefølge og avhengigheter
Stablet på K + H1 + H2 + I: merges ETTER disse.

Full beslutning: D-459 i `docs/DECISIONS_AND_ASSUMPTIONS.md` (ligger på docs-grenen `claude/d471-d474-konsolidering`, ikke i denne grenen). Branch: `claude/wp-d3-growth-writes`. Draft inntil arkitektens review er gjort; ingen merge før reglene i CLAUDE.md er oppfylt (CI grønn, ingen åpne tråder, eksakt head-/base-guard, to-forelder-merge).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DjaWBW7BCa7u4mUsiHFwH4
