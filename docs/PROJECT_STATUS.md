# PROJECT STATUS

**Oppdatert:** 2026-09-20 (branch `claude/charlie-memory-search`, merger nå `origin/main` HEAD
`382b159` = PR #118 (selv-bevissthet, D-209) MERGET inn). **"Charlie"-linjen (D-208/D-209/D-210) - del 1
OG del 2 FERDIG OG MERGET. Del 7 (minneverifisering, D-210) PR #119 ÅPEN - denne mergen løser den
samme klassen tekstlige doc-konflikt PR #118 selv hadde etter at #117 merget forbi dens base.**

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

- **PR #106-#118 MERGET.** Gemma-first-sagaen, UA-11 Executive Mode "K2" (D-207),
  "Charlie"-personlighet (D-208), "Charlie"-selv-bevissthet (D-209) - se git-historikk/
  DECISIONS_AND_ASSUMPTIONS.md, ikke gjentatt her.
- **"Charlie"-linjen (D-208/D-209/D-210) - Tobias sin syv-punkts ønskeliste for samtale-personaen,
  splittet i 6 tasks (app-liste + mye av stemme-motoren fantes allerede):**
  1. **Personlighet (D-208) - PR #117 MERGET (`ae9c332`).** `apps/api/src/conversation.ts` sin
     `SYSTEM_PROMPT` fikk navnet "Charlie" + humor + en skjerpet ærlighets-klausul om egne evner.
     Full, ugjennomgått selvpatching av sikkerhetskode EKSPLISITT AVSLÅTT (ville fjernet CLAUDE.md
     regel #2 sin håndhevingsmekanisme) - se D-208 for full begrunnelse.
  2. **Chat-vendt selv-bevissthet (D-209) - PR #118 MERGET (`382b159`).** Rotårsak funnet:
     `mesh-bridge.ts` sin `MESH_TOOLS` (den TRUSTED listen som FAKTISK avgjør hva chat-modellen kan
     kalle) hadde KUN 3 verktøy - Charlie hadde ALDRI noe verktøy å faktisk sjekke egne tilganger
     med. Ny `executive.get_capability_status` (klasse A, RENT avledet av `meshToolDefinitions()` +
     `ToolGateway.health` - ALDRI egen kopi) + ny `check_my_capabilities`-oppføring i `MESH_TOOLS`
     selv. 8 nye DB-uavhengige tester grønne. Måtte selv merge `origin/main` etter at #117 merget
     forbi sin base - kun tekstlig konflikt i DECISIONS_AND_ASSUMPTIONS.md/PROJECT_STATUS.md.
  7. **Minneverifisering (D-210) - PR #119 ÅPEN, slår NÅ sammen `origin/main`.** `MemoryRetriever.
     search()` fantes allerede (kildebelagt hybrid fulltekst+vektor), men var KUN koblet til stille
     bakgrunnskontekst - Charlie hadde ingen eksplisitt "hva vet du om X"-flate. Ny
     `modules/tool-gateway/src/memory-transport.ts` (`MemorySearchTransport`, klasse A) + ny
     `search_my_memory`-oppføring i `MESH_TOOLS` (FØRSTE mesh-mapping der `query` kommer fra modellen
     selv, trygt fordi `strict()`-Zod validerer FØR databasekall). Skopet til KUN
     `identity.memory_space_id` (ingen cross-space i P0, dokumentert grense). `memoryRetriever` heist
     til ÉN delt instans i `apps/api/src/main.ts`. 9 + 4 nye DB-uavhengige tester grønne. Branchen ble
     kuttet fra PR #118 sin (da umergede) spiss - samme "dirty mergeable_state etter at #118 merget
     forbi basen"-mønster som #118 selv opplevde etter #117; løses her med samme metode (merge
     `origin/main` inn, behold begge sider av rene D-ID-tillegg i DECISIONS_AND_ASSUMPTIONS.md, skriv
     PROJECT_STATUS.md ferskt). Re-verifiseres med full `pnpm -w typecheck`/`npx eslint .`/relevante
     tester FØR push.
  3-6. Infisical+dashboard, stemme koblet til daglig bruk, trygg to-lags selvendring - IKKE startet.

## Blokkeringer

Ingen kjente kode-blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET,
dekker resten av masterplanen: Growth-stack live-evidens, reelle Finance-transaksjoner (Stripe),
iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR.

## Neste oppgave

1. **Fullfør PR #119 sin merge-fra-main (denne økten):** full workspace typecheck/lint/relevante
   tester, commit, push, bekreft CI grønt på nytt, merge under stående D-192-fullmakt.
2. **Neste task:** hent Infisical frem fra fase 7, bygg integrasjons-dashboard med
   "lim inn nøkkel → auto-test → vis status"-flyt.
3. **Deretter:** koble den allerede-bygde `apps/voice-gateway` til noe Tobias faktisk kan bruke daglig.
4. **Deretter:** design + bygg den trygge to-lags selvendrings-modellen - IKKE full ugjennomgått
   selvpatching, se D-208.
5. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer.
