TS: 2026-11-26T10:55:01.549Z
FIX-A til FIX-E er ferdige: alt er committet og pushet, og ny tipp er `5db0ce83` (= origin), med rent tre. FIX-C er løst med valg (b); sveip-utvidelsen (a) er DEFERRED.

**Rød-først**
- Mot kilden fra `766ac671` feilet 7 av 38 tester i `fin2-vipps-ack-and-locks.test.ts`: FIX-A 2 og FIX-B 5.
- FIX-B-stressen ga brudd i 54 av 60 runder før fiksen og 0 etter.
- FIX-C og FIX-D er pin-tester. De er grønne før og etter og dreper mutanter.

**Per FIX**
- **FIX-A (`7182ec76`):** i `service.ts` bruker stale-CREATED-sveipet nå `COALESCE(provider_status,'CREATED')` og `COALESCE(provider_status_updated_at, submitted_at)`. Klokka er innsendingen, ikke utkastets `created_at`.
  - Test med ekte Postgres og ekte `VippsTransport` mot stubbet `fetch`, i dokumentert form `{reference, redirectUrl}`. Ikke flagget ved 0 t og 23 t, flagget ved 25 t uten observasjon. En lagret observasjon har forrang.
- **FIX-B (`07530081`):** `submitVippsCapture.prepare` krever også lokal tilstand `provider_acknowledged`. Ellers kastes `PaymentIntentNotAuthorizedError`, som nå bærer den lokale tilstanden i meldingen, før reservasjon, credential og leverandørkall.
  - `FOR SHARE`-låsen og leverandørkall utenfor transaksjon er uendret. Testene dekker cancel -> refresh-AUTHORIZED -> capture avvist, tilstandene cancelled/failed/settled, uendret flyt og 60 runder stress.
  - Reviewerens egen kappløpsprobe kjørt 4 ganger (4×60 runder): 0 brudd, 0 deadlock.
- **FIX-D (`be7eb776`):** testene dreper D25 (én hendelse pr. (intensjon, årsak)) og D49 (draft-vern i attention-køen). D25 og D49 er også kjørt med reviewerens egen `mutants.py`, med `W`/`OUT` pekt mot denne worktreen.
- **FIX-C (`9ad3d15e`), valg (b):** kommentaren i `card-service.ts` og runbooken (§11.1 (7), §11.4, §11.6, §11.7) sier nå at `close` med tom 2xx ikke rettes av sveipet og må bekreftes med `sync_card_state`, og at `unconfirmed` ikke gir flagg. Fire pin-tester i `fin2-wallester-lifecycle-ack.test.ts`.
  - **Hvorfor ikke (a):** den krever at Wallester serverer lukkede kort, og `Closing` avbildes til `frozen`. Det gir falsk `CARD_PROVIDER_STATE_CONFLICT` på et lokalt lukket kort. Begge er `unverified` (D-41). Lagt som Q-forslag i §11.4.
- **FIX-E (`e446e408`, `5db0ce83`):** §11.5 merker Vipps og Stripe `unverified`. Neonomics-karantenen og `rejected` er skrevet inn (§11.4), og I1/I4 er skrevet inn (§11.5, §5). Testtall er oppdatert (vipps-ack 38, lifecycle 39, attention 7), og det er ny rad i §0 og ny §11.7.
  - Jeg merket også Stripe-punktet i §11.5 `unverified`, siden det bruker samme etikett. Det var ikke bedt om.

**Mutanter:** 24 egne, alle drept, 0 overlevende (A1–A8, B1–B7, C1–C4, D25/D25b/D25c, D49/D49b).

**Kontroller**
- `modules/finance/test` + `business/fin2-*`: 51 filer / 1632 grønne.
- Gateway `wpk/wpf1/d392/part3/fin2` + `erasure/wpf1` + `api/wpf1`: 27 / 398 grønne.
- Guardene (wph1, wph2, d398, d420, wpj, env-drift, remediation-2, d388, wpn1-lock): 9 / 141 grønne, og connector-sdk 11 / 368.
- `pnpm -r typecheck` (35 pakker) rc=0, `pnpm lint` rc=0, `check:containment` exit 0.
- gitleaks over `origin/main..HEAD`: no leaks.
- `gateway.ts`, `.gitleaksignore`, migrasjoner, pakker og delte docs er urørt.

**Funn du bør vite om (ikke endret)**
- Den daglige `syncPendingVippsPayments` kjører før avviksdeteksjonen i samme sveip og setter `provider_status_updated_at` til nå. Probe: `expired-before-sync=true`, `expired-after-sync=false`.
- `EXPIRED_PAYMENT_WITH_ACTIVE_INTENT` fanger derfor i praksis bare betalinger som ikke lar seg oppfriske, ikke «CREATED i over 24 t hos Vipps». FIX-A hjelper kun når det ikke går en oppfrisking først, for eksempel via `vipps-tool-transport.ts`. Dokumentert i §11.7 rad A.

**Nye antakelser til D-486 (fra nr. 18)**
- 18: klokka for stale-CREATED er `submitted_at`.
- 19: NULL-status regnes som `CREATED` til første observasjon.
- 20: capture kun fra lokal tilstand `provider_acknowledged`.
- 21: sveipet måler tid siden siste observasjon, ikke siden opprettelsen (forhåndseksisterende). Beslutning trengs.
- 22: `close` med tom 2xx bekreftes kun manuelt; sveip-utvidelsen er DEFERRED.
- 23: `VERIFIED_SEARCH_SNIPPET` betyr «sett i et søkeutdrag», ikke primærkilde.

**Q-forslag:** sveip for lukkede `unconfirmed`-kort, semantikken for stale-CREATED (fra observasjon eller fra opprettelse), og modellering av Neonomics `rejected` (og `quarantined` i sveipresultatet).

**NOT VERIFIED:** alle leverandørfakta (Vipps, Stripe, Wallester, Neonomics, Fiken) er `unverified`, og ingenting er kjørt mot ekte nettverk eller produksjonslast. Deadlock og kappløp er kun vist med testdobler.

Arbeidsnotater ligger i `/tmp/pg-home/fin2-fix2-notes/NOTES.md`.
