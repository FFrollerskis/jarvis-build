# WP-G1: Communications Hub – resten av UA-7 (kanaler, kontakter, møtetranskripsjon, utgående regler og AI-ringing, push-oppfølging; D-463)

## Sammendrag
Resten av UA-7 som hvilende, flagg-styrt kode (`JARVIS_COMMS_*`, alle AV). Jarvis eier modellen, policyen og journalen; leverandørene er adaptere.

## Hva som er med
- Conversation Graph dekker alle UA-7-kanaler (slack, discord, whatsapp, sms, teams, messenger, instagram, phone; migrasjon 117).
- Felles deterministisk utgående policy (`modules/comms`) foran hver NY `comms.*`-utsendelse: konto-allowlist, mottakervalidering, stille timer, rate-limit, plattformvinduer, AI-opplysning lagt til i kode, markedsføring feiler lukket, revisjonsjournal (hash og lengde, aldri teksten). Utsendelse er klasse D `outbound_message` med idempotensnøkkel og `outcome_unknown`.
- Mottakerens avmelding (STOP) er tenant-bred per normalisert identifikator. Signerte innkommende webhooks (Slack, Meta, Twilio, Telnyx; rå bytes med 256 KB-tak før signatur, replay-vern, idempotent inntak) lagres som ubetrodd data (regel 7).
- Eier-eksklusive `comms.*`-verktøy (35 handlinger, ingen på modellflate) og ruter `/comms/preview` og `/comms/action` (grant, suveren eier, step-up, gateway).
- Google Contacts (les/opprett/endre/slett som klasse D), Teams (kun delegert), Messenger/Instagram (kun RESPONSE), møtetranskripsjon-pipeline (rettsgrunnlag attestert av eier med DB-CHECK; transkripsjonsteksten lagres aldri), utgående AI-ringing på Twilio kun mot falsk transport, og et svar-oppfølgingssveip.
- Migrasjon 117–119. `CORE_DEPENDENCY_DECISION_REQUIRED=false` (ingen leverandør ble kjerne).

## Status (ærlig)
- `BUILT`, `DORMANT`/AV bak egne flagg og `NOT VERIFIED`: ingenting er `VERIFIED` før det finnes en kjøring på NAS (se runbook for delen).
- Alle gjennomganger er gjort av SEPARATE Claude-agenter som var uavhengige av byggeren; de er IKKE den eksterne arkitektens review. **Arkitektens uavhengige review (mot faktisk diff, tester, CI og sikkerhet) gjenstår før merge**, og denne PR-en er derfor draft.
- Lokal integrasjonsverifisering (`integration/post-merge-test-2` = alle ni deler + docs, ikke pushet): `typecheck`, `lint`, `check:containment` og gitleaks (330 commits) exit 0; én samlet full suite: 16 649 av 16 654 tester grønne (975 filer). De fem røde er kjente sandkasse-feil (wpc3-review1-hardening F10a/b/c, break-glass-guard, nas-ua0-gate «friskt system»), ikke knyttet til denne delen.
- Per-gren CI på GitHub er ikke kjørt ennå: delene ble bygget mens GitHub var utilgjengelig fra sesjonen (2026-11-15 til 2026-11-22), og arbeidet ligger nå i den nye forken `FFrollerskis/jarvis-build` (kontobytte, eierens ordre 2026-11-22; Actions må slås på i forken). Sandkassekjøringene (embedded Postgres, falske kilder) står over.

## Gjennomgang
To uavhengige gjennomganger, to fiks-runder og tre delta-re-reviewer; siste verdikt MERGE (dvalende).

## Åpne punkter og kjente begrensninger
- **JARVIS-112 (a) MÅ rettes før `JARVIS_COMMS_OUTBOUND` slås på.** Q-72.
- De eldre `twilio`/`telnyx`/`whatsapp`/`slack`/`discord` `notify`-verktøyene omgår den nye policyen (`DEFERRED`). Reservasjonsregisteret og samtykkeregister er `BLOCKED_EXTERNAL`.

## Rekkefølge og avhengigheter
Stablet på K + H1 + H2 + I: merges ETTER disse.

Full beslutning: D-463 i `docs/DECISIONS_AND_ASSUMPTIONS.md` (ligger på docs-grenen `claude/d471-d474-konsolidering`, ikke i denne grenen). Branch: `claude/wp-g1-comms`. Draft inntil arkitektens review er gjort; ingen merge før reglene i CLAUDE.md er oppfylt (CI grønn, ingen åpne tråder, eksakt head-/base-guard, to-forelder-merge).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DjaWBW7BCa7u4mUsiHFwH4
