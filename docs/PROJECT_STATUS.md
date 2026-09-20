# PROJECT STATUS

**Oppdatert:** 2026-09-20 (branch `claude/charlie-personality`, fra fersk `origin/main` HEAD `3d61483`
= K2 fullstendig lukket). **Ny økt-linje startet: "Charlie" - eierens syv-punkts ønskeliste for
samtale-personaen** (D-208). Personlighet (punkt 2) er FERDIG IMPLEMENTERT lokalt, IKKE ennå committet/
pushet/PR-opprettet. Fem øvrige punkter er tasks (#117-#121), IKKE startet ennå.

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
implementasjonsvalg INNENFOR den eksisterende arkitekturen/CLAUDE.md sine Ufravikelige regler, ALDRI en
fullmakt til å fjerne selve håndhevingsmekanismen en ufravikelig regel (her: regel #2, klasse D-
handlinger håndheves deterministisk, aldri kun promptregler) krever skal eksistere - selv når eieren
eksplisitt, gjentatte ganger og informert om risikoen ber om det. Se D-208 for full begrunnelse (Charlie
skulle få "se og endre sin egen kode" - eieren valgte to ganger full, ugjennomgått live-selvpatching av
sikkerhetskritisk kode, ble avslått, erstattet med en to-lags trygg modell - se "Neste oppgave" punkt 5).

## Hvor `main` står nå

- **PR #106-#116 MERGET.** Gemma-first-sagaen (D-79/D-80→D-206) OG UA-11 Executive Mode "K2" (D-207,
  `@jarvis/governance` + `executive.get_delegation_board`) er BEGGE fullstendig lukket og merget - se
  git-historikk/DECISIONS_AND_ASSUMPTIONS.md for detaljer, ikke gjentatt her.
- **Denne økten (IKKE ennå committet): "Charlie"-personlighet (D-208, del 1 av 6).** Familien navnga
  samtale-personaen "Charlie" (kjønnsnøytral) i en levende Jarvis-økt (Gemma-basert). Tobias ba samlet om
  syv ting; kartlegging viste at app-listen (`docs/INTEGRATIONS.md`) og mye av stemme-motoren
  (`apps/voice-gateway`) ALLEREDE finnes. Fem gjenstående, ekte nye punkter er splittet ut som egne
  tasks og bygges i separate senere slicer (se "Neste oppgave").
  - **Levert i DENNE (ennå ukommitterte) sliceen:** `apps/api/src/conversation.ts` sin `SYSTEM_PROMPT`
    fikk navnet "Charlie" + varm/tørrvittig personlighet + en eksplisitt skjerpet ærlighets-klausul
    ("ærlighet slår alltid personlighet: gjett eller dikt ALDRI opp evner") - direkte motivert av at
    Tobias observerte den (daværende namnløse) Charlie konfabulere om egne evner ("flere AI-er i én",
    "banktilgang") på introspektive spørsmål. `runCouncil()` UBERØRT (samme presedens som D-203).
  - **AVSLÅTT SOM SPESIFISERT:** full, ugjennomgått live-selvpatching av sikkerhetskritisk kode (Charlie
    skulle "se og endre sin egen kode") - Tobias valgte dette EKSPLISITT to ganger, inkl. etter en
    konkret risikogjennomgang, men det ville fjernet CLAUDE.md regel #2 sin håndhevingsmekanisme
    permanent. Se D-208 for full begrunnelse og den vedtatte to-lags erstatningen (task #121).
  - `pnpm --filter @jarvis/api typecheck`/`npx eslint apps/api/src/conversation.ts` rene,
    `apps/api/test/conversation-d106-overrides.test.ts` (22/22) grønt - ingen regresjon.

## Blokkeringer

Ingen kjente kode-blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET,
dekker resten av masterplanen: Growth-stack live-evidens, reelle Finance-transaksjoner (Stripe),
iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR.

## Neste oppgave

Task-rekkefølge for "Charlie"-linjen (D-208), Tobias sitt eget valg - bygg alt, min vurdering av
rekkefølge:

1. **Fullfør personlighet-sliceen (denne økten):** `pnpm -w typecheck`/full `npx eslint .`/diff-check/
   secret-scan, commit, push til fersk branch, draft PR, abonner.
2. **Task #117:** chat-vendt selv-bevissthet om egne verktøy/tilkoblinger + proaktiv varsling ved feil.
3. **Task #118:** eier-vendt minne-verifiseringsflate ("hva vet Jarvis om meg akkurat nå").
4. **Task #119:** hent Infisical frem fra fase 7, bygg integrasjons-dashboard med
   "lim inn nøkkel → auto-test → vis status"-flyt.
5. **Task #120:** koble den allerede-bygde `apps/voice-gateway` til noe Tobias faktisk kan bruke daglig.
6. **Task #121:** design + bygg den trygge to-lags selvendrings-modellen (lavrisiko nær-øyeblikkelig,
   sikkerhetskritisk via rask push-varsel-godkjenning) - IKKE full ugjennomgått selvpatching, se D-208.
7. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer (Stripe/Neonomics/
   Google Ads gjenstår fortsatt, se tidligere øktnotater).
