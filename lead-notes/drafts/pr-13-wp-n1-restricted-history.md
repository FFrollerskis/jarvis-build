# WP-N1: begrenset-merking av samtalehistorikken, utførelseslås for finance/finance_* og tilbakeholdte jobbresultater (JARVIS-101/N1; D-477)

## Sammendrag
Hvilende, flagg-styrt kode (`JARVIS_RESTRICTED_CONTEXT_GUARD`, AV som standard, kun eksakt `on`) som lukker JARVIS-101 (N1, funnet i H1/H2-re-reviewen): et lokalt svar fra en SECRET_RESTRICTED-låst tur (finans/helse, D-378/D-381) skal aldri kunne følge samtalehistorikken til en senere tur mot en skymodell (Q-66 alternativ A, anbefalt). I tillegg får `finance`/`finance_*` en utførelseslås mot skymodeller (Q-64 pkt 3), og resultatet av en låst bakgrunnsjobb holdes tilbake fra skymodeller. Ingen ny leverandør; ingen endring i nøkkelordlistene for klassifisering.

## Hva som er med
- **Migrasjon 140:** `messages.restricted boolean NOT NULL DEFAULT false` (ingen omskriving av tabellen), kolonne-GRANT `UPDATE` kun på kolonnen, enveis-trigger (en begrenset melding kan ikke bli ubegrenset), RLS uendret. `MessageStore.save(..., opts?)` er bakoverkompatibel og fail-closed; `markRestricted` er idempotent og gjelder kun egen tenant og sesjon.
- **Motoren merker låste turer FØR modellkallet:** brukermeldingen merkes via `markRestricted`, alle assistent-, feil-, avbrudds- og budsjettstopp-svar lagres begrenset (én inngang). Kan merkingen ikke skje, feiler turen før modellkallet. En tur som er låst kun p.g.a. et arvet merke merker også (smitte, målt: alternativet lekker).
- **Klassifisering leser merket:** en merket rad er SECRET_RESTRICTED uansett tekst; en merket rad i konteksten løfter turen til lokal modell; skyvarianten (Q-51 D) holder merkede rader ute; lokal reserve får hele historikken. Par-regel, hale og `protect` er uendret.
- **Hurtigbanen:** `cost_report`, `value_report`, `slo_report`, `self_diagnosis` og `system_status` låser turen (strengeste regel, én bryter per intensjon); `jobbstatus` og `delegate_background` låser når jobben er låst eller opprinnelsen er uleselig.
- **Utførelseslås for `finance`/`finance_*`:** nektes tidlig i `ToolGateway.execute()` for sky og ukjent modell (fail-closed), uendret for lokal modell og for eierens egne ruter (uten `servingModel`). Nøstede kall (`executive.get_control_surface_status`/`get_delegation_board` → `finance.get_kill_switch`) holder nødbryteren tilbake for sky (funnet i review: HIGH).
- **Jobber:** `restricted_origin` bæres gjennom jobbkontrakten, leveringen lagres begrenset (også failed/cancelled, også via bekreftelsesbanen), resultatet holdes tilbake ved lesing for sky (`withheld`), og en lokal ulåst verktøytur som leser en låst jobb låses selv.
- **Runbook** `docs/runbooks/WPN1_RESTRICTED_HISTORY.md` (hva, aktivering, `messages.save`-tabell, NAS-steg 1-8 og 7b-7f, begrensninger).

## Status (ærlig)
- `BUILT` og `DORMANT` bak flagget; **`NOT VERIFIED`**: ingenting er kjørt mot NAS, ekte Ollama/Anthropic eller ekte data (runbook-steg 1-8 og 7b-7f er ikke kjørt). Ingenting i denne PR-en er `VERIFIED`.
- **Flagg AV er identisk med main** (127 scenarier x 2 flater x 2 AV-varianter = 508 sammenligninger mot en baseline fra ren `ec3e684e`, 0 forskjeller; reviewer A: 28 000 uavhengige observasjoner, 0 avvik; reviewer B: overlegg av ekte main-filer, byte-like), med to dokumenterte detaljer: `history()` leser kolonnen alltid (api-imaget krever migrasjon 140 også med AV; compose har `depends_on: migrate`), og én ny oppstartslogglinje.
- **Lokal verifisering (sandkasse, embedded Postgres):** N1-testene 226 i 17 filer; 122 mutanter (121 drept, 1 ekvivalent) pluss reviewernes ca. 320 egne; `typecheck`, `lint`, `check:containment` exit 0; full suite `b60bceb6` 16 861 av 16 866 (992 filer) og endelig HEAD `f1aa33e8` 16 876 av 16 881 (992 filer); de fem røde er hver gang de kjente sandkasse-feilene (wpc3-review1-hardening F10a/b/c, break-glass-guard, nas-ua0-gate «friskt system»).
- **gitleaks:** `ec3e684e..<tipp>` skannet lokalt (368 commits): «no leaks found» etter at én verifisert falsk positiv (en norsk teststreng i testkonstanten `SECRET_TEXT`, commit `e498cdf5`) er lagt i `.gitleaksignore` med begrunnelse og konstantene er omdøpt bort fra `SECRET_*`; fingeravtrykket oppdateres med ny commit-hash ved cherry-pick (se `.gitleaksignore`).
- Per-gren CI på GitHub er ikke kjørt ennå: delene ble bygget mens GitHub var utilgjengelig fra sesjonen (2026-11-15 til 2026-11-22), og arbeidet ligger nå i den nye forken `FFrollerskis/jarvis-build` (kontobytte, eierens ordre 2026-11-22; Actions må slås på i forken). Sandkassekjøringene (embedded Postgres, falske kilder) står over.

## Gjennomgang
To uavhengige gjennomganger av SEPARATE Claude-agenter (A: motor/klassifisering/flagg-AV-identitet; B: DB/migrasjon/MessageStore/utførelseslås/mutanter). De er IKKE den eksterne arkitektens review: **arkitektens uavhengige review (mot faktisk diff, tester, CI og sikkerhet) gjenstår før merge**, og denne PR-en er derfor draft.
- Runde 1: A 0 HIGH og 2 MEDIUM, B 1 HIGH og 1 MEDIUM (+ LOW/INFO), alt rettet. Funn: utførelseslåsen kunne omgås av nøstede kall (HIGH), lås-predikatet i produksjon var ikke kjørbart testet, jobb-levering fra en låst tur ble lagret umerket.
- Delta 1: begge «merge etter fikser» med hvert ett nytt MEDIUM (bekreftelsesbanen mistet `restricted_origin`; resultatet av en låst jobb var lesbart for skymodeller), rettet i runde 2.
- Delta 2: A «merge», B «merge» (ett nytt LOW: lokal ulåst verktøytur), rettet i runde 3; B bekreftet «merge» på `f1aa33e8`.

## Åpne punkter og kjente begrensninger
JARVIS-116 (bl.a. avledet finansmetadata utenfor `finance*`-låsen, `servingModel` ikke gjennom nøstede kall, jobber/kort opprettet før aktivering, ingen backfill, ingen worker-lås, smitten uten utløpstid) og eierspørsmål Q-76 (D-/Q-/JARVIS-radene ligger i denne PR-ens egen docs-commit). Eieren kan nedlegge veto mot hele N1 (Q-66 alternativ B).

## Rekkefølge og avhengigheter
- **PR 13, etter at PR 1-12 er merget.** Grenen `claude/wp-n1-restricted-history` er bygget oppå den lokale integrasjonsrefen `refs/rehearsal/12-docs` (alle ni deler + docs), ikke oppå `main`; PR-grenen lages derfor ved at N1-commitene (`git rev-list --reverse 7de8924f..<tipp>`) cherry-picks oppå oppdatert `main` (identisk basetre, skal gå uten konflikter). Migrasjon 140 følger 139 (G4): kontroller at `origin/main` ikke har fått en annen migrasjon 140.
- **Aktivering:** `JARVIS_RESTRICTED_CONTEXT_GUARD` slås ikke på før NAS-verifiseringen (runbook), og skal stå på før eller sammen med `JARVIS_CONTROL_CENTER_FINANCE` og `_VALUE` (betingelsen i D-473/D-474).

Full beslutning: D-477 i `docs/DECISIONS_AND_ASSUMPTIONS.md` (i denne PR-ens docs-commit). Draft inntil arkitektens review er gjort; ingen merge før reglene i CLAUDE.md er oppfylt (CI grønn, ingen åpne tråder, eksakt head-/base-guard, to-forelder-merge).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DjaWBW7BCa7u4mUsiHFwH4
