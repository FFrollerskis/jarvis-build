# EV-0: signere Safety Constitution (eier-handling, OFFLINE)

Gjelder D-406 og WP-EV0 (konstitusjonsversjon 2). **Dette gjør kun eieren (Platform Operator), på en maskin Jarvis ikke har tilgang til.** Privatnøkkelen skal aldri inn i repoet, NAS-en, chat eller `.env`.
Repoet er offentlig: skriv aldri personnavn, adresser eller kontaktinfo i manifestet, signaturfilene, PR-en eller commit-meldinger.

## 0. Rekkefølge: IKKE signer før WP-EV0 er merget

Manifestet ble herdet FØR første signering (versjon 2: kategori-tak for kostnad, eier-tid, deploys pr. time, utvidede beskyttede stier og E3-handlinger). Endrer manifestet seg etter at du har signert, må du signere på nytt med en ny versjon.
Signer derfor først når `main` inneholder WP-EV0 og du har gått gjennom punkt 2 under. Ingenting håndheves mot en konsument før en Evolution-tjeneste er konstruert (selvendring er fortsatt frosset, D-397) - signeringen gjør tilstanden *verifiserbar*, den aktiverer ikke noe.

## 1. Lag nøkkelpar (én gang)
```
node ops/security/sign-constitution.mjs keygen ~/jarvis-constitution.key ~/jarvis-constitution.pub.pem
```
Oppbevar `.key` offline (krypert USB / passordmanager). Verktøyet nekter å overskrive eksisterende filer og skriver ut fingeravtrykket. Se `EV0_BREAK_GLASS.md` for to kopier og gjenoppretting.

## 2. Vurder verdiene (UTKAST - du MÅ vurdere dem)

Alle verdier i `config/evolution/constitution.v1.json` -> `budget_caps` er **konservative startverdier, ikke beslutninger**. Kostnad er i øre pr. kalendermåned, eier-tid i minutter pr. uke. Ingen av dem kan heves av Jarvis; å heve en grense senere krever en ny versjon og ny signering. Det finnes også harde tak i koden som selv et signert manifest ikke kan overskride (Evolution totalt 1000 kr/mnd, ADR-001 §2.3 pkt 4).

| Felt | Utkast | Hardt tak i koden | Hva det styrer |
|---|---|---|---|
| `max_evolution_cost_ore_per_month` | 10 000 øre = 100 kr | 100 000 øre = 1000 kr | TOTAL Evolution-kost pr. måned |
| `max_radar_cost_ore_per_month` | 2 000 = 20 kr | 100 000 | radar (endringslogger, API, sikkerhet) |
| `max_eval_cost_ore_per_month` | 3 000 = 30 kr | 100 000 | evalueringer (golden, regresjon, adversarielle) |
| `max_redteam_cost_ore_per_month` | 1 500 = 15 kr | 100 000 | red team |
| `max_shadow_cost_ore_per_month` | 1 500 = 15 kr | 100 000 | shadow/canary (doble modellkall) |
| `max_review_cost_ore_per_month` | 2 000 = 20 kr | 100 000 | uavhengig review (annen modell) |
| `owner_time_budget_minutes_per_week` | 240 = 4 t/uke | 600 | din tid: godkjenninger, merking, review, styring (se HF2 kap. 29 for forutsetningene) |
| `max_owner_minutes_per_autonomous_change` | 15 | 60 | din tid pr. autonom endring (summert over endringens levetid) |
| `max_auto_merges_per_day` | 5 | 20 | automatiske (E1) merger pr. UTC-døgn |
| `max_deploys_per_day` / `max_deploys_per_hour` | 3 / 1 | 10 / 3 | deploys pr. UTC-døgn og pr. hel UTC-time (time kan ikke overstige døgn) |
| `max_owner_proposals_per_day` | 10 | 50 | nye E2-forslag til deg pr. døgn |

Regler kjøretiden håndhever (feil gir avvist manifest): hvert felt er påkrevd; de fem kategoriene summerer til høyst totalen (`constitution_invalid`); intet felt over det harde taket (`constitution_weakened`). Er et tak nådd, skal Evolution stoppe og lage en eier-oppgave i stedet for å overskride (BudgetLock, fail-closed) - dette er bygget som bibliotek, men ikke koblet til noen konsument ennå (`DORMANT`).
Utkastverdiene er ikke målt mot et faktisk Evolution-forbruk (det finnes ikke ennå); vurder dem på nytt etter første måned med målt run-rate (PROJECT_STATUS-blokken, punkt 6).

Andre ting du kan se over (men normalt ikke endrer): `protected_paths` (hvilke stier Evolution aldri kan røre, E3), `e3_actions` (handlinger Evolution aldri kan utføre) og `e1_allowlist`. Fjerner du noe her som kjøretiden krever, avvises manifestet (`constitution_weakened`).

## 3. Fyll inn, kontroller og se hva du signerer

I `config/evolution/constitution.v1.json`:
- sett `issued_by` til en **nøytral rolle-ID** (f.eks. `platform-operator`), aldri et personnavn;
- **fjern** merknaden `notes` (UTKAST) eller skriv den om til din egen tekst uten ordet UTKAST;
- ikke endre `version` for første signering (den er allerede 2); øk den ved senere endringer.

```
node ops/security/sign-constitution.mjs summary    # lesbar oversikt (kr, timer, harde tak, SHA-256 av manifestet) + blokkerende funn
node ops/security/sign-constitution.mjs check      # exit 0 = klart; exit 1 = funn (UTKAST-markører, tak over hardt tak, koherensbrudd)
```
`sign` nekter å signere så lenge det er funn (UTKAST-markører eller verdier kjøretiden ville avvise), så du kan ikke signere et utkast ved en feil.

## 4. Signer
```
node ops/security/sign-constitution.mjs sign ~/jarvis-constitution.key
node ops/security/sign-constitution.mjs verify ~/jarvis-constitution.pub.pem
```
Legg `constitution.v1.sig` og den OFFENTLIGE nøkkelen (`config/evolution/constitution.pub.pem`) i repoet via en eier-PR. Disse stiene er E3 (Jarvis kan ikke endre dem).

## 5. Fest nøkkelen utenfor repoet
```
node ops/security/sign-constitution.mjs fingerprint ~/jarvis-constitution.pub.pem
```
Verdien (64 hex) settes i NAS-`.env` som `JARVIS_CONSTITUTION_PUBKEY_SHA256`. API-et leser den ved oppstart (D-411) og logger `ev0_constitution_boot` (`verified` med versjon, eller `not_verified` med feilkode) - kun observasjon, ingenting blokkeres, og selvendring er fortsatt frosset. Uten festet nøkkel avviser kjøretiden konstitusjonen (`constitution_key_not_pinned`) - et manifest, en signatur og en nøkkel i repoet er ikke nok alene. Sjekk etter bygg: `docker compose ... logs api | grep ev0_`.

## 6. PROJECT_STATUS viser takene (generert visning)

Det signerte manifestet er kilden til takene; `docs/PROJECT_STATUS.md` er en GENERERT visning pluss faktisk forbruk (PC2). Etter signering og bytte av markørblokken:
```
node --experimental-transform-types ops/evolution/project-status-block.ts --pinned <fingeravtrykket> --write docs/PROJECT_STATUS.md
node --experimental-transform-types ops/evolution/project-status-block.ts --check docs/PROJECT_STATUS.md
```
Blokken merkes UTKAST så lenge signaturen ikke kan verifiseres, og viser «ikke målt» (aldri 0) for alt som ikke er målt. Se `WPEV0_AUTHORITY_HARDENING.md`.

## Endre senere, nedgradering og nøkkelbytte
- Heve en grense, endre beskyttede stier m.m.: øk `version`, kjør `check`/`summary`, signer på nytt, eier-PR. Kjøretiden avviser et manifest med lavere versjon enn den den er satt til å kjenne (`constitution_rollback`) - **men oppstartssjekken sender ikke en minimumsversjon ennå** (kjent hull, foreslått tillegg `JARVIS_CONSTITUTION_MIN_VERSION`): regn ikke med vern mot at et eldre, gyldig signert manifest legges tilbake før det er koblet.
- Mistet/kompromittert nøkkel: se `EV0_BREAK_GLASS.md` punkt C.

## Feilkoder
`constitution_missing` · `_unsigned` · `_key_not_pinned` · `_key_mismatch` · `_signature_invalid` · `_invalid` (skjema eller koherens, f.eks. kategoriene summerer over totalen) · `_weakened` (signert, men fjerner en påkrevd beskyttelse eller overskrider et hardt tak) · `_rollback` (lavere versjon enn kjent).
