# WP-N1: felles regler for de to uavhengige reviewerne (lead -> reviewer)

Du er REVIEWER (A eller B, se ditt eget brief). Du har IKKE bygget dette og skal ikke stole på byggerens rapport, tester eller kommentarer: alt du påstår skal være bevist av en kjørt probe, en kjørt mutant eller en nøyaktig kodelesing (fil:linje). Jobb mot grenen, ikke mot hukommelsen din fra tidligere WP-er.

## 0. Hva WP-N1 er (kort)
Jarvis-funn JARVIS-101/N1 (H1/H2-re-review): et LOKALT svar fra en tur som er låst til SECRET_RESTRICTED (finans/helse, D-378/D-381) kunne ligge i samtalehistorikken uten stikkord som utløser tekstklassifisereren og følge med til en senere tur mot en SKYmodell; `finance`/`finance_*`-verktøy hadde bare utvalgslås, ikke utførelseslås (Q-64 pkt 3). Løsning (Q-66 alternativ A): kolonnen `messages.restricted` (migrasjon 140), engine-merking av låste turer, partisjonsfunksjoner som leser merket, skyvarianten (Q-51 D) holder merkede rader ute, lokal reserve beholder full historikk, og en utførelseslås for `finance`/`finance_*` ved sky-/ukjent modell. ALT bak flagget `JARVIS_RESTRICTED_CONTEXT_GUARD` (kun eksakt `on`; AV = byte-identisk med main).
Krav K1-K9, grenser og infrastruktur-regler står i `/tmp/lead/briefs/N1-build.md` (LES DEN FØRST: det er byggerens ordre, og du skal måle grenen mot den). Byggerens sluttrapport: `/tmp/lead/N1-report.md` (les den ETTER at du har dannet deg et eget bilde av koden, ikke før).

## 1. Oppsett
- Din worktree er opprettet av lead (se tallene i oppdraget: sti, gren-tips = HEAD, base). Arbeid KUN der. Ikke `cd` til repo-roten, ikke push, ikke rør grener/refs, ikke endre `claude/wp-n1-restricted-history`. Kildefilene i worktreen skal være URØRTE når du er ferdig (`git checkout -- <fil>` etter hver mutant; verifiser med `git status --short` tomt unntatt dine prober som du legger i `zz-n1-review-<a|b>-*.test.ts` og sletter/flytter ut til slutt).
- Lagre probe-filer, skript og mutantlister i `/tmp/lead/N1-review-<A|B>-probes/` (opprett mappen). Skriv aldri hemmeligheter.
- Infrastruktur (hardt vunnet; følg dem): `export HOME=/tmp/pg-home npm_config_manage_package_manager_versions=false PATH=/opt/node22/bin:$PATH NODE_OPTIONS=--max-old-space-size=2048`. DB-tester kan IKKE kjøre som root: `su postgres -s /bin/bash -c 'export HOME=/tmp/pg-home npm_config_manage_package_manager_versions=false PATH=/opt/node22/bin:$PATH NODE_OPTIONS=--max-old-space-size=2048; cd <din worktree> && timeout -k 5 600 pnpm exec vitest run --maxWorkers=2 --bail=1 <filer>'`. Maks 2 vitest-arbeidere, alltid `timeout -k 5`, `--bail=1` for mutantkjøringer. Aldri hele suiten (lead kjører den). Drep kun egne prosesser (aldri `pkill vitest`); sjekk `free -m` hvis noe henger; kun ÉN tung jobb om gangen (den andre reviewer kjører parallelt: maskinen har 4 CPU / 15 GB).
- `chmod o+w <worktree> <worktree>/node_modules` er gjort av lead. Mangler `@embedded-postgres/linux-x64` symlinks (initdb feiler med `libicuuc.so.60`): kjør `node scripts/hydrate-symlinks.js` i pakkemappen (kun symlinks).
- Ingen `rm -rf`, ingen `git reset --hard`/force/rebase/stash. Nettverk er ikke nødvendig; ingen modellkall mot ekte nett.

## 2. Slik skal du jobbe (kvalitetsmønster som har fungert)
1. Les ordren (N1-build.md), CLAUDE.md-reglene 1-12 og `git diff <base>..<HEAD> --stat` for å se hele endringen. Les hele diffen til produksjonskode (ikke bare testene).
2. Skriv EGNE prober mot koden for hvert krav i ditt fokusområde (ikke bare kjør byggerens tester). Prober som feiler = funn. Reproduser alle HIGH/MEDIUM med en kjørende probe.
3. Mutasjonssjekk: lag minst 25 egne mutanter (eksakte tekstbytter, ett per mutant, gjenopprett etter hver) mot produksjonskoden i ditt fokus og kjør byggerens tester (de relevante filene, `--bail=1`). Mutanter som OVERLEVER = testhull (rapporter hvilke, og om det er ekvivalente mutanter).
4. Sjekk at flagg AV virkelig er byte-identisk med main: kjør differensialtesten, MEN vurder også om den er solid (kan den bli grønn selv om oppførselen endres? mutér flagg-parseren/guard-grenene). Se også etter nye felter i API-svar/serialisert historikk/revisjonsrader som dukker opp selv med flagget AV.
5. Ærlighet: skill mellom BEKREFTET (egen probe/mutant) / DELVIS / IKKE VERIFISERT. Ikke skriv «verifisert» om noe som krever NAS/ekte sky/ekte modell: det er `NOT VERIFIED`.
6. Ikke fiks selv. Foreslå minimal fiks (diff eller presis tekst) for hvert HIGH/MEDIUM.

## 3. Sluttrapport (SISTE melding; norsk; maks ca. 170 linjer)
Første linje: `VERDICT: MERGE | MERGE ETTER FIKSER | BLOKKERT` + én setning (antall HIGH/MEDIUM). Deretter:
- «Funn (rangert; fil:linje mot HEAD)»: HIGH/MEDIUM/LOW/INFO med reproduksjon (probe-navn) og foreslått fiks.
- «Byggerens påstander -> dom»: tabell (påstand | BEKREFTET/DELVIS/FEIL | bevis). Dekk K1-K9 for ditt fokus.
- «Mutasjoner»: antall kjørt/drept/overlevd, liste over overlevende med vurdering.
- «Ikke verifisert av meg».
- Sti til probe-mappen. Rapporten returneres som siste melding (kan ikke skrives utenfor worktreen).
Rapporter aldri bare «grønt»: vis kommando + tall.
