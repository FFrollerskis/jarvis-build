# WP-K: gjenstående ledger-gjeld (JARVIS-018/053/054/056/068, D-471)

## Sammendrag
Lukker de gjenstående ledger-postene fra HF1/HF2: avbrytbare verktøykall med ærlig «ukjent utfall», varig policy-journal, sporbarhet i planlagte syncer, vault-først for Google-credentials og avstemming av JARVIS-068 mot D-461.

## Hva som er med
- `ToolTransport` får abort-signal (nødutgang `JARVIS_TOOL_CALL_ABORT=off`). Gateway-tidsavbrudd, uavklarte transportfeil og leverandørsvar transporten ikke godtok på ikke-idempotente klasse C/D gir `unverified` (aldri samme-nøkkel-replay; klasse D-eieren varsles). Delt hjelper `afterAcceptedMutation` → `outcome_unknown:<kode>` (`infisical.rotate_secrets` rettet; GitHub-bokføring best-effort; GCE/Docker kun sentinel). Revisjonen av 32 produksjonsaktiverte ikke-idempotente klasse C/D-verktøy står i runbook §3 #5.
- Varig `policy_decisions`-journal (migrasjon 108; AV som standard bak eget flagg; kø-tak per tenant, retensjon 90 d med gulv 30 d). `audit_events` forblir autoritativ.
- Planlagte system-syncer bærer `task_id`/`trace_id`; `decision_id` i hver audit-rad.
- Google client id/secret leses fra vault først; `.env` er en logget, utfaset fallback.
- JARVIS-068 avstemt mot D-461.
- UTENFOR opprinnelig scope (egen commit som kan reverteres alene): `support.reply` sendte nøstet `email.send` uten `idempotency_key` og ble nektet under håndhevet klasse D (`class_d_idempotency_key_required`, 0 utsendelser; funnet av reviewer, finnes på main). Nå avledet nøkkel `support-reply:<ticket_id>:<kallernøkkel>`. Bivirkning: under `enforce:true` sender hver `support.reply` et klasse D-varsel.

## Status (ærlig)
- `BUILT`, `DORMANT`/AV bak egne flagg og `NOT VERIFIED`: ingenting er `VERIFIED` før det finnes en kjøring på NAS (se runbook for delen).
- Alle gjennomganger er gjort av SEPARATE Claude-agenter som var uavhengige av byggeren; de er IKKE den eksterne arkitektens review. **Arkitektens uavhengige review (mot faktisk diff, tester, CI og sikkerhet) gjenstår før merge**, og denne PR-en er derfor draft.
- Lokal integrasjonsverifisering (`integration/post-merge-test-2` = alle ni deler + docs, ikke pushet): `typecheck`, `lint`, `check:containment` og gitleaks (330 commits) exit 0; én samlet full suite: 16 649 av 16 654 tester grønne (975 filer). De fem røde er kjente sandkasse-feil (wpc3-review1-hardening F10a/b/c, break-glass-guard, nas-ua0-gate «friskt system»), ikke knyttet til denne delen.
- Per-gren CI på GitHub er ikke kjørt (GitHub har vært utilgjengelig fra sesjonen siden 2026-11-15).

## Gjennomgang
Fem uavhengige gjennomganger: første review fant 1 HØY (nøstet klasse D-varsling droppet etter ytre tidsavbrudd) + 4 MEDIUM + 7 LOW, alt rettet; re-review, delta-review og delta-2: MERGE.

## Åpne punkter og kjente begrensninger
- Ikke dekket (dokumentert): HTTP 5xx, klasse B, transporter som omskriver nettverksfeil uten cause/code (`postgres_ops`), vanlig Error/TypeError etter 2xx (Slack `ok:false`), finans-transporter (egen 20 s-grense), preflight/re-arm uten frist. `unverified`-rader utløper aldri (JARVIS-103).
- Erasure dekker IKKE `policy_decisions`; `person_id` står i klartekst til oppbevaringsrydden.
- Ingen legacy-fallback for gamle `reply:<key>`-hendelser; ukjent klasse D-infra-handling åpner en `normal` hendelse (bør være `high`, JARVIS-105); Docker-journalen mapper akseptert-men-uverifisert til FAILED; svar på manuelt opprettet ticket havner på nytt ticket (JARVIS-104).

## Rekkefølge og avhengigheter
Ingen avhengighet av de andre delene (kan merges først). Migrasjon 108.

Full beslutning: D-471 i `docs/DECISIONS_AND_ASSUMPTIONS.md` (ligger på docs-grenen `claude/d471-d474-konsolidering`, ikke i denne grenen). Branch: `claude/wp-k-ledger-rester`. Draft inntil arkitektens review er gjort; ingen merge før reglene i CLAUDE.md er oppfylt (CI grønn, ingen åpne tråder, eksakt head-/base-guard, to-forelder-merge).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DjaWBW7BCa7u4mUsiHFwH4
