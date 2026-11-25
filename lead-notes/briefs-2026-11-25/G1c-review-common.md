# WP-G1c: felles regler for de to uavhengige reviewerne (lead -> reviewer). JARVIS-112 (b), (c), (d), (f), (g), (h)

Du er REVIEWER (A eller B, se ditt eget brief). Du har IKKE bygget dette og har ikke sett bygge-samtalen. Din oppgave er å FINNE FEIL, ikke å bekrefte. Anta at byggeren har oversett noe. Alt du påstår skal være bevist av en kjørt probe, en kjørt mutant eller en nøyaktig kodelesing (fil:linje). Ikke stol på byggerens rapport, kommentarer eller tester: jobb mot koden på grenen.

## 0. Hva WP-G1c er (kort)
Resten av JARVIS-112 (comms, WP-G1) etter WP-G1b, merget til `main` (`71a31d8b`) i `https://github.com/FFrollerskis/jarvis-build`. Byggerens ordre med alle krav K1-K9, grenser og infrastrukturregler: `/tmp/lead/briefs/G1c-build.md` (LES DEN FØRST; mål grenen mot den). Kort:
- K1 (b) samlemigrasjon 141-143: trigger `comms_recipient_opt_outs_guard` sjekker `source` (en `owner_recorded`-avmelding kan bare løftes av eier-angre-veien; en `recipient_request`-rad bare av mottakerens egen START); DELETE-grant fjernet der det ikke finnes lovlig bruk; rom-CHECK strammet inn; saltet innholds-hash (HMAC med pepper fra den eksisterende hemmelighetsmekanismen, fail-lukket, overgang for gamle rader).
- K2 (c) deterministisk STOP/START-rekkefølge: serialisering per (tenant, mottaker, kanal), plattformens mottakssekvens avgjør, STOP vinner, forsinket START løfter aldri en nyere STOP.
- K3 (d) webhook-grenser: 100-taket hevet etter Metas dokumenterte batch-størrelse, STOP-lignende hendelser først, over taket = feilstatus som tvinger retry (aldri 200 med droppede hendelser), lange id-er via kryptografisk hash (aldri forkast/avkort).
- K4 (f1) kontaktkonflikter som FORSLAG til eier; `contact_sync` teller ikke som relasjonsbevis (kald-regelen pinnes av test).
- K5 (f2) eier-angre `lift_owner_opt_out` (kun `owner_recorded`, step-up, begrunnelse, audit, idempotens).
- K6 (g1-g5) kontotak på tvers av rom; norske helligdager/søndager i ringevindu; Slack `fatal_error` = `outcome_unknown`; `policy_denied` i connector-helse (delt kode `modules/tool-gateway/src/gateway.ts`); smalest mulige STOP-vakt for de eldre `*.notify`-verktøyene (eller `DEFERRED`).
- K7 (h) permanente tester (best-lenke-valget m.m.) og K8 flagg AV = identisk med main, K9 runbook/DPIA.
- BEVISST IKKE med (rapporter ikke som feil): JARVIS-084 (samtykke-/markedsføringsregister), Reservasjonsregisteret, møte-bot, Telnyx-kall, autonom Jarvis-initiert utsendelse (Q-72 pkt 1-4), Q-78 pkt 1/3/4, pepper for G1b-avtrykket (Q-78 pkt 2: bare «velg en løsning som kan gjenbrukes»), endring av den delte ToolGateway-ledgeren (bortsett fra g4), UI, nye leverandører, ekte nettverkskall. Ting merket `DEFERRED`/`PARTIAL` med begrunnelse er lov; STILLE utelatelse er et funn.

## 1. Oppsett
- Din worktree er opprettet av lead (se oppdraget: sti, gren-tips = HEAD, base `origin/main` = `71a31d8b`). Den er en løsrevet kopi av grenen `claude/wp-g1c-comms-rest`. Arbeid KUN der. Ikke `cd` til repo-roten, ikke push, ikke rør andre grener/refs/worktrees, ikke endre grenen.
- Diff: `git diff 71a31d8b..HEAD --stat` og så hele diffen til produksjonskode (ikke bare testene). Kildefilene i worktreen skal være URØRTE når du er ferdig: gjør én mutant om gangen, `git checkout -- <fil>` etter hver; `git status --short` skal være tomt unntatt dine prober som du legger i `zz-g1c-review-<a|b>-*.test.ts` og flytter ut til slutt.
- Lagre probe-filer, skript og mutantlister i `/tmp/lead/G1c-review-<A|B>-probes/` (opprett mappen). Skriv aldri hemmeligheter; testfikstur skal ikke ligne ekte nøkler.
- Infrastruktur (hardt vunnet; følg dem): `export HOME=/tmp/pg-home npm_config_manage_package_manager_versions=false PATH=/opt/node22/bin:$PATH NODE_OPTIONS=--max-old-space-size=2048`. DB-tester kan IKKE kjøre som root: `su postgres -s /bin/bash -c 'export HOME=/tmp/pg-home npm_config_manage_package_manager_versions=false PATH=/opt/node22/bin:$PATH NODE_OPTIONS=--max-old-space-size=2048; cd <din worktree> && timeout -k 5 600 pnpm exec vitest run --maxWorkers=2 --bail=1 <filer>'`. Maks 2 vitest-arbeidere, alltid `timeout -k 5`, `--bail=1` for mutantkjøringer. Aldri hele suiten (lead kjører den). Drep kun egne prosesser (aldri `pkill vitest`); sjekk `free -m` hvis noe henger; kun ÉN tung jobb om gangen (den andre reviewer og en bygger kjører parallelt: maskinen har 4 CPU / 15 GB).
- `chmod o+w <worktree> <worktree>/node_modules` er gjort av lead. Mangler `@embedded-postgres/linux-x64` symlinks (initdb feiler med `libicuuc.so.60`): kjør `node scripts/hydrate-symlinks.js` i pakkemappen (kun symlinks).
- Kjente sandkasse-feil som IKKE er dine (5): `wpc3-review1-hardening` F10a/b/c, `break-glass-guard`, `nas-ua0-gate` «friskt system»; `embedded-postgres-port-lease` er belastningsfølsom (kjør alene hvis den feiler).
- Ingen `rm -rf`, ingen `git reset --hard`/force/rebase/stash, ingen sletting av grener, ingen push. Nettverk er ikke nødvendig; ingen modellkall mot ekte nett.

## 2. Arbeidsmåte
1. Les `CLAUDE.md` (regler 1-12; særlig 2, 4, 6, 7, 8, 10, 11), `docs/remediation/FINDINGS_LEDGER.md` (JARVIS-112, JARVIS-102), `docs/OPEN_QUESTIONS.md` (Q-72, Q-78), `docs/runbooks/WPG1_COMMS.md` (på grenen, særlig §10 og det byggeren la til), `docs/DECISIONS_AND_ASSUMPTIONS.md` (D-463, D-480), og de tidligere uavhengige gjennomgangene `/tmp/lead/G1-review-A.md` (L4-L9, N-C) og `/tmp/lead/G1-review-B.md` (L4, linje 69 og 83) som forteller hva som var åpent. Byggerens sluttrapport `/tmp/lead/G1c-report.md` leser du FØRST ETTER at du har dannet deg et eget bilde av koden.
2. Skriv EGNE prober for hvert krav i ditt fokus (ikke bare kjør byggerens tester). Prober som feiler = funn. Reproduser alle HIGH/MEDIUM med en kjørende probe.
3. Mutasjonssjekk: minst 30 egne mutanter (eksakte tekstbytter, ett per mutant, gjenopprett etter hver) mot produksjonskoden i ditt fokus; kjør byggerens tester (relevante filer, `--bail=1`). Overlevende = testhull (rapporter hvilke og om de er ekvivalente). Les også `git diff 71a31d8b..HEAD -- '*.test.*'`: er noen eksisterende assertions svekket, fjernet eller skippet for å få grønt?
4. Flagg AV: bekreft at `JARVIS_COMMS_*` AV gir identisk oppførsel med `main` (differensiale tester; også en kopi av `main` du kjører samme scenarier mot). Se etter nye felter i API-svar/serialisering/revisjonsrader selv med flagget AV, og at migrasjonene ikke endrer atferd for andre moduler.
5. Ærlighet: skill mellom BEKREFTET (egen probe/mutant) / DELVIS / IKKE VERIFISERT. Ikke skriv «verifisert» om noe som krever NAS/ekte leverandør/ekte pepper: det er `NOT VERIFIED`/`BLOCKED_EXTERNAL`.
6. Ikke fiks selv. Foreslå minimal fiks (diff eller presis tekst) for hvert HIGH/MEDIUM.

## 3. Sluttrapport (SISTE melding; norsk; maks ca. 170 linjer)
Første linje: `VERDICT: MERGE | MERGE ETTER FIKSER | BLOKKERT` + én setning (antall HIGH/MEDIUM). Deretter:
- «Funn (rangert; fil:linje mot HEAD)»: HIGH/MEDIUM/LOW/INFO med reproduksjon (probe-navn) og foreslått fiks.
- «Byggerens påstander -> dom»: tabell (påstand | BEKREFTET/DELVIS/FEIL | bevis). Dekk K1-K9 for ditt fokus.
- «Mutasjoner»: antall kjørt/drept/overlevd, liste over overlevende med vurdering.
- «Ikke verifisert av meg».
- Sti til probe-mappen. Du kan ikke skrive filer utenfor din worktree/probe-mappe: rapporten returneres som siste melding.
Rapporter aldri bare «grønt»: vis kommando + tall.
