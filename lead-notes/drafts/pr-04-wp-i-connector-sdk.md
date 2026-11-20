# WP-I: Connector SDK/fabrikk (UA-0, masterplan kap. 10 + Appendiks B, D-472)

## Sammendrag
Ny pakke `@jarvis/connector-sdk` som gjør «bygg en ny connector» repeterbart og målbart. `BUILT_UNWIRED`: ingen kjøretidseffekt (ingen flagg, migrasjon, verktøy, rute eller side).

## Hva som er med
- `ConnectorManifest` (zod; kap. 10-seksjonene + `d41_audit` + `core_boundary.system_of_record`) med redaksjonssikker validator; skeleton-avledning for alle 58 registeroppføringer (`Unknown` der noe ikke kan avledes; D-64-svaret er aldri en stille standard); tre håndskrevne fulle referansemanifester (GitHub D-94, Cloudflare D-461, Stripe D-109).
- Kontraktstest-kit: 27 sjekker, 31 mutanter med eksakte sett, virtuell klokke, Appendiks B-scoring. Bevis mot en fake er `modelled`, aldri `proven`.
- CI-vakt med 18 regler og en committet skeleton-baseline (48 id-er); connector-gjeld som ren lesemodell; scaffold-generator `ops/connector/new-connector.mjs`; rapport-CLI.

## Status (ærlig)
- `BUILT`, `DORMANT`/AV bak egne flagg og `NOT VERIFIED`: ingenting er `VERIFIED` før det finnes en kjøring på NAS (se runbook for delen).
- Alle gjennomganger er gjort av SEPARATE Claude-agenter som var uavhengige av byggeren; de er IKKE den eksterne arkitektens review. **Arkitektens uavhengige review (mot faktisk diff, tester, CI og sikkerhet) gjenstår før merge**, og denne PR-en er derfor draft.
- Lokal integrasjonsverifisering (`integration/post-merge-test-2` = alle ni deler + docs, ikke pushet): `typecheck`, `lint`, `check:containment` og gitleaks (330 commits) exit 0; én samlet full suite: 16 649 av 16 654 tester grønne (975 filer). De fem røde er kjente sandkasse-feil (wpc3-review1-hardening F10a/b/c, break-glass-guard, nas-ua0-gate «friskt system»), ikke knyttet til denne delen.
- Per-gren CI på GitHub er ikke kjørt (GitHub har vært utilgjengelig fra sesjonen siden 2026-11-15).

## Gjennomgang
To uavhengige gjennomganger og én smal re-review: ingen BLOCKER/HIGH; 5 MEDIUM (første) og 2 MEDIUM + 5 LOW (re-review), alle rettet. Lead-verifisert: 14 testfiler/423 tester og repo-brede vakter grønne; full suite ikke kjørt på siste head (forrige head: 13 354 av 13 359, resten sandkasse-miljøfeil).

## Åpne punkter og kjente begrensninger
- Ærlige grenser: skanneren har blindsoner (nullbredde, tokens delt over felt, Basic-auth, AWS-nøkler, hex/base64) og kan gi falsk positiv; `modelled` er STRENGERE enn ToolGateway-ledgeren (JARVIS-102); `production-definitions.ts` er et håndført speil av `main.ts`.
- DEFERRED: gjeldskobling til Integrasjonssenteret, transport-bro (`real_transport`), frosset legacy-liste, full manifest for de 48 andre bygde connectorene, utvidelse av delt `scanForSecrets` (Q-65). Live smoke mot GitHub/Cloudflare/Stripe er `BLOCKED_EXTERNAL`.
- Leverandørfakta er sjekket kun via WebSearch-sammendrag (dokumentasjonsvertene var ikke hentbare); de uverifiserte står som `unverified`. EV-18 forblir `DORMANT`.

## Rekkefølge og avhengigheter
Ingen avhengighet av de andre delene. Ingen migrasjon.

Full beslutning: D-472 i `docs/DECISIONS_AND_ASSUMPTIONS.md` (ligger på docs-grenen `claude/d471-d474-konsolidering`, ikke i denne grenen). Branch: `claude/wp-i-connector-sdk`. Draft inntil arkitektens review er gjort; ingen merge før reglene i CLAUDE.md er oppfylt (CI grønn, ingen åpne tråder, eksakt head-/base-guard, to-forelder-merge).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DjaWBW7BCa7u4mUsiHFwH4
