# WP-G4: Proactive Situation Engine – resten av UA-10 (sanntids-abonnement, hjem-/kamera-/helse-broer, modellassistert vurdering, simulering og tilbakemelding; D-466)

## Sammendrag
UA-10 som hvilende, flagg-styrt kode (`JARVIS_SITUATION_*`, alle AV, kun eksakt `on`). Situation Engine er `JARVIS_CANONICAL` (D-64); hendelseskildene er kilder; ingen ny leverandør.

## Hva som er med
- Samlet hendelsesabonnement (abonnementsregister, inntaksbuss og hendelsesløper, migrasjon 139) leser HA-hendelser (ÉN gateway-lesing per tikk), kamerahendelser (G3, kun rommet `home`), helseavvik (G2) og incidents; kommunikasjons-/forpliktelsessignal (G1) når motoren via det daglige sveipet.
- Rene broer med lukkede hendelsessett: hjem, kamera (aldri ansiktsidentifikasjon) og helse (avvik fra eierens egen baseline; INFORM og SUGGEST til eieren kun; helsevarselen til Telegram er NØYTRAL).
- Modellassistert vurdering via `ModelGateway` kan kun foreslå kategori, prioritet og forklaring innenfor regelens tak, aldri ACT alene; kamera kun mot lokal modell. Kontrafaktisk simulering er en ren funksjon; tilbakemeldingslæring justerer terskler per regel innenfor harde grenser, revisjonsmerket og tilbakestillbart (ingen selvmodifikasjon, D-397).
- **Autonom ACT** krever deterministisk regel og en gyldig, ikke utløpt eier-bundet binding (D-160), håndhevet i kode. Fysiske og kritiske handlinger (lås, alarm, lys, klima, bil, `critical_*`, ukjent) kan ALDRI bindes til eller utføres av autonom ACT: én delt fail-closed allowlist-regel i `modules/situations/src/autonomy-guard.ts`, ved bind-tid, før claim i `autoActPending`/`actOn` og i simuleringen (funnet i review: de gamle `lock_set`/`alarm_set` var bindbare).
- Stille timer sluker aldri et signal; retensjonssveip; eierflate `POST /situations/signals/*` (404 uten flagg; step-up på endring; typet bekreftelse på fjerning). Migrasjon 139 (ureleaset; rettet på stedet).

## Status (ærlig)
- `BUILT`, `DORMANT`/AV bak egne flagg og `NOT VERIFIED`: ingenting er `VERIFIED` før det finnes en kjøring på NAS (se runbook for delen).
- Alle gjennomganger er gjort av SEPARATE Claude-agenter som var uavhengige av byggeren; de er IKKE den eksterne arkitektens review. **Arkitektens uavhengige review (mot faktisk diff, tester, CI og sikkerhet) gjenstår før merge**, og denne PR-en er derfor draft.
- Lokal integrasjonsverifisering (`integration/post-merge-test-2` = alle ni deler + docs, ikke pushet): `typecheck`, `lint`, `check:containment` og gitleaks (330 commits) exit 0; én samlet full suite: 16 649 av 16 654 tester grønne (975 filer). De fem røde er kjente sandkasse-feil (wpc3-review1-hardening F10a/b/c, break-glass-guard, nas-ua0-gate «friskt system»), ikke knyttet til denne delen.
- Per-gren CI på GitHub er ikke kjørt (GitHub har vært utilgjengelig fra sesjonen siden 2026-11-15).

## Gjennomgang
To uavhengige gjennomganger, én fiks-runde, delta-re-reviewer og en mikrofiks-runde; siste verdikt MERGE (dvalende). Funn som ble rettet: autonom ACT kunne låse opp/avarmere via de gamle klasse D-verktøyene (HIGH), stille timer sluket signaler permanent (HIGH), helsekilden var død mot ekte DB (numeric som streng, HIGH).

## Åpne punkter og kjente begrensninger
- JARVIS-115, Q-75 (bl.a. pkt 11: Make/n8n kan bindes til hjemmedomenet). JARVIS-111/Q-71: step-up-kanalen er klient-påstått (se G2).
- G4-grenen inneholder tidligere versjoner av G1, G2 og G3 (via integrasjonsmerger), men ikke deres endelige fiks-commits (mangler 9, 23 og 26 commits). Merges derfor etter G1–G3, med `origin/main` merget inn først. Kildebroene mot G2/G3-tabeller er integrasjonstestet på `integration/post-merge-test-2` (alle ni deler), ikke på denne grenen alene.

## Rekkefølge og avhengigheter
Endelige tips for K, H1, H2, I, B3, D3 og B4 er forfedre til denne grenen (verifisert): merges som SISTE kode-PR (etter G2 og G3). **Test-tilpasning som må med når G2 er i main:** `modules/situations/test/wpg2-autonomy-step-up.test.ts` (godtar begge bind-tid-feil og beviser at `gateway.execute` på `critical_lock` gir `step_up_required:signed_device_session`; se commit `87b49a65` på `integration/post-merge-test-2`). Migrasjon 139.

Full beslutning: D-466 i `docs/DECISIONS_AND_ASSUMPTIONS.md` (ligger på docs-grenen `claude/d471-d474-konsolidering`, ikke i denne grenen). Branch: `claude/wp-g4-situation-bridges`. Draft inntil arkitektens review er gjort; ingen merge før reglene i CLAUDE.md er oppfylt (CI grønn, ingen åpne tråder, eksakt head-/base-guard, to-forelder-merge).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DjaWBW7BCa7u4mUsiHFwH4
