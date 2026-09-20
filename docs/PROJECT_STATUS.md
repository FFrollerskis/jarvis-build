# PROJECT STATUS

**Oppdatert:** 2026-09-20 (branch `claude/charlie-self-awareness`, merger nå `origin/main` HEAD
`ae9c332` = PR #117 (personlighet, D-208) MERGET inn). **"Charlie"-linjen (D-208/D-209/D-210) - del 1
FERDIG OG MERGET. Del 2 (selv-bevissthet, D-209) PR #118 ÅPEN, fersk CI-kjøring pågår etter en liten
D-208→D-209-kommentarfiks. Del 7 (minneverifisering, D-210) PR #119 ÅPEN (draft, stacket på #118 sin
branch-spiss - diffen krymper automatisk til KUN D-210 når #118 merges).**

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## ARBEIDSFORM-ENDRING (D-192, 2026-09-19) - GJELDENDE VIDERE

Tobias har DIREKTE (i interaktiv chat, ikke via issue #68 `ARCHITECT_TASK`) bedt om å bygge resten av
planen sammen med Claude uten ChatGPT-arkitekten som mellomledd, helt til punktet der videre fremgang
faktisk krever credentials/kontoer/MCP-koblinger - IKKE start ny scope utover masterplanen. issue #68
BEHOLDES som logg. Claude har STÅENDE FULLMAKT til å merge rutinemessige PR-er når CI er grønt/tester
består/ingen åpne funn. D-201 presiserer sluttmålet: hele masterplanen bygget/fungerende, ALLE eksterne
integrasjoner unntatt `Fiken`/`Walley` (permanent ekskludert), en helt autonom agent, drift på
UGREEN-NAS-en + Tobias sin PC (`gemma_local`) som tilleggskraft inntil dedikert maskin. Se
D-192/D-201 i DECISIONS_AND_ASSUMPTIONS.md og `CLAUDE.md` §Merge-autoritet.

**VIKTIG PRESEDENS (D-208, 2026-09-20):** D-192s delegering er IKKE ubegrenset - den gjelder rutine-
implementasjonsvalg INNENFOR eksisterende arkitektur/CLAUDE.md sine Ufravikelige regler, ALDRI en
fullmakt til å fjerne selve håndhevingsmekanismen en ufravikelig regel krever skal eksistere, selv når
eieren eksplisitt og informert ber om det (Tobias ba to ganger om full, ugjennomgått live-selvpatching
av sikkerhetskritisk kode - AVSLÅTT SOM SPESIFISERT, erstattet med en trygg to-lags modell, se D-208).

## Hvor `main` står nå

- **PR #106-#117 MERGET.** Gemma-first-sagaen, UA-11 Executive Mode "K2" (D-207),
  "Charlie"-personlighet (D-208) - se git-historikk/DECISIONS_AND_ASSUMPTIONS.md, ikke gjentatt her.
- **"Charlie"-linjen (D-208/D-209/D-210) - Tobias sin syv-punkts ønskeliste for samtale-personaen,
  splittet i 6 tasks (app-liste + mye av stemme-motoren fantes allerede):**
  1. **Personlighet (D-208) - PR #117 MERGET (`ae9c332`).** `apps/api/src/conversation.ts` sin
     `SYSTEM_PROMPT` fikk navnet "Charlie" + humor + en skjerpet ærlighets-klausul om egne evner.
     Full, ugjennomgått selvpatching av sikkerhetskode EKSPLISITT AVSLÅTT (ville fjernet CLAUDE.md
     regel #2 sin håndhevingsmekanisme) - se D-208 for full begrunnelse.
  2. **Chat-vendt selv-bevissthet (D-209) - PR #118 ÅPEN.** Rotårsak funnet: `mesh-bridge.ts` sin
     `MESH_TOOLS` (den TRUSTED listen som FAKTISK avgjør hva chat-modellen kan kalle) hadde KUN 3
     verktøy - Charlie hadde ALDRI noe verktøy å faktisk sjekke egne tilganger med. Ny
     `executive.get_capability_status` (klasse A, RENT avledet av `meshToolDefinitions()` +
     `ToolGateway.health` - ALDRI egen kopi) + ny `check_my_capabilities`-oppføring i `MESH_TOOLS`
     selv. 8 nye DB-uavhengige tester grønne. Denne branchen slår NÅ sammen `origin/main` (etter at
     #117 merget forbi #118 sin base) - kun konflikt i `docs/DECISIONS_AND_ASSUMPTIONS.md`/
     `docs/PROJECT_STATUS.md` (begge tekstlige, løst ved å beholde begge sine D-ID-poster i riktig
     rekkefølge). Følges opp: merges når CI er ferdig grønt.
  7. **Minneverifisering (D-210) - PR #119 ÅPEN (draft), stacket på PR #118 sin branch-spiss.**
     `MemoryRetriever.search()` fantes allerede (kildebelagt hybrid fulltekst+vektor), men var KUN
     koblet til stille bakgrunnskontekst - Charlie hadde ingen eksplisitt "hva vet du om X"-flate. Ny
     `modules/tool-gateway/src/memory-transport.ts` (`MemorySearchTransport`, klasse A) + ny
     `search_my_memory`-oppføring i `MESH_TOOLS` (FØRSTE mesh-mapping der `query` kommer fra modellen
     selv, trygt fordi `strict()`-Zod validerer FØR databasekall). Skopet til KUN
     `identity.memory_space_id` (ingen cross-space i P0, dokumentert grense). `memoryRetriever` heist
     til ÉN delt instans i `apps/api/src/main.ts`. 9 + 4 nye DB-uavhengige tester grønne.
     `pnpm -w typecheck` (31 pakker) + `npx eslint .` (hele workspace) rene. PR #119 sin diff viser
     FORELØPIG også #118 sine commits (siden branchen er kuttet fra #118 sin spiss, ikke `main`) -
     krymper automatisk til KUN D-210 idet #118 merges (GitHub regner PR-diff dynamisk mot gjeldende
     `main`).
  3-6. Infisical+dashboard, stemme koblet til daglig bruk, trygg to-lags selvendring - IKKE startet.

## Blokkeringer

Ingen kjente kode-blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET,
dekker resten av masterplanen: Growth-stack live-evidens, reelle Finance-transaksjoner (Stripe),
iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR.

## Neste oppgave

1. **Følg PR #118 til grønn CI og merge** (selv-bevissthet, D-209) under stående D-192-fullmakt -
   ingen åpne review-tråder ved siste sjekk.
2. **Bekreft PR #119 sin diff krymper til kun D-210** etter at #118 merges, og følg DEN til grønn CI
   og merge.
3. **Neste task:** hent Infisical frem fra fase 7, bygg integrasjons-dashboard med
   "lim inn nøkkel → auto-test → vis status"-flyt.
4. **Deretter:** koble den allerede-bygde `apps/voice-gateway` til noe Tobias faktisk kan bruke daglig.
5. **Deretter:** design + bygg den trygge to-lags selvendrings-modellen - IKKE full ugjennomgått
   selvpatching, se D-208.
6. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer.
