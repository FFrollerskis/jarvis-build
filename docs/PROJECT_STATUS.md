# PROJECT STATUS

**Oppdatert:** 2026-09-20 (branch `claude/charlie-self-awareness`, fra fersk `origin/main` HEAD `3d61483`
= K2 fullstendig lukket). **"Charlie"-linjen (D-208/D-209) pågår - del 2 av 6 (chat-vendt selv-
bevissthet) FERDIG IMPLEMENTERT lokalt, IKKE ennå committet/pushet/PR-opprettet.** Del 1 (personlighet,
D-208) er PUSHET som PR #117, IKKE ennå merget.

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

- **PR #106-#116 MERGET.** Gemma-first-sagaen, UA-11 Executive Mode "K2" (D-207) - se git-historikk/
  DECISIONS_AND_ASSUMPTIONS.md, ikke gjentatt her.
- **"Charlie"-linjen (D-208/D-209) - Tobias sin syv-punkts ønskeliste for samtale-personaen, splittet i
  6 tasks (app-liste + mye av stemme-motoren fantes allerede):**
  1. **Personlighet (D-208) - PR #117 ÅPEN, IKKE MERGET.** `apps/api/src/conversation.ts` sin
     `SYSTEM_PROMPT` fikk navnet "Charlie" + humor + en skjerpet ærlighets-klausul om egne evner.
     Samme post: full, ugjennomgått selvpatching av sikkerhetskode EKSPLISITT AVSLÅTT (ville fjernet
     CLAUDE.md regel #2 sin håndhevingsmekanisme) - se D-208 for full begrunnelse.
  2. **Chat-vendt selv-bevissthet (D-209) - FERDIG lokalt, IKKE ennå committet.** Rotårsak funnet:
     `modules/tool-gateway/src/mesh-bridge.ts` sin `MESH_TOOLS` (den TRUSTED listen som FAKTISK
     avgjør hva chat-modellen kan kalle) hadde KUN 3 verktøy - Charlie hadde ALDRI noe verktøy å
     faktisk sjekke egne tilganger med, uansett hva `@jarvis/executive` allerede eksponerte til
     EIEREN via HTTP. Ny `executive.get_capability_status` (klasse A, RENT avledet av
     `meshToolDefinitions()` + `ToolGateway.health` - ALDRI egen kopi) + ny `check_my_capabilities`-
     oppføring i `MESH_TOOLS` selv, slik at verktøyet FAKTISK er nåbart fra samtalen. 8 nye DB-
     uavhengige tester (`modules/executive/test/capability-status.test.ts`), inkl. en ende-til-ende-
     test via `MeshToolExecutor` som beviser ruting til riktig tool_id/action. BEVISST AVGRENSET:
     `connector_health` er REAKTIV (kun kall-etter-kall), IKKE proaktiv polling - det ville krevd en
     egen "ping"-primitiv per adapter, egen fremtidig oppgave.
     `pnpm --filter @jarvis/executive typecheck`/`pnpm --filter @jarvis/tool-gateway typecheck`/
     `pnpm --filter @jarvis/api typecheck` og `npx eslint` rene.
  3-6. Task #118 (minne-verifisering), #119 (Infisical+dashboard), #120 (stemme koblet til daglig
     bruk), #121 (trygg to-lags selvendring) - IKKE startet.

## Blokkeringer

Ingen kjente kode-blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET,
dekker resten av masterplanen: Growth-stack live-evidens, reelle Finance-transaksjoner (Stripe),
iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR.

## Neste oppgave

1. **Fullfør selv-bevissthet-sliceen (denne økten):** `pnpm -w typecheck`/full `npx eslint .`/diff-check/
   secret-scan, commit, push, draft PR, abonner. MERK: D-209 er BEVISST valgt (ikke D-208, allerede
   brukt av PR #117) for å unngå ID-kollisjon når begge merges.
2. **Task #118:** eier-vendt minne-verifiseringsflate ("hva vet Jarvis om meg akkurat nå").
3. **Task #119:** hent Infisical frem fra fase 7, bygg integrasjons-dashboard med
   "lim inn nøkkel → auto-test → vis status"-flyt.
4. **Task #120:** koble den allerede-bygde `apps/voice-gateway` til noe Tobias faktisk kan bruke daglig.
5. **Task #121:** design + bygg den trygge to-lags selvendrings-modellen - IKKE full ugjennomgått
   selvpatching, se D-208.
6. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer.
