TS: 2026-11-26T10:59:35.848Z
Tipp `2203b705`, pushet til `origin/claude/wp-g3b-vision-rest` (`https://github.com/FFrollerskis/jarvis-build.git`), rent tre. Seks nye commits siden `36ea2665`, 15 totalt på `origin/main..HEAD`. FIX-1 til FIX-5 er alle ferdige, ingen DEFERRED.

**FIX-1 (F1), ferdig.** Typet bekreftelse regner nå også det avledede G4-vinduet som forkorting: `min(grunnvindu, ny) < (rad ? min(grunnvindu, rad) : grunnvindu)`, avgjort i den låste transaksjonen.
- Regelen er én funksjon, `signalSituationWindowDays` i `modules/situations/src/signal-retention.ts`. Sveipet bruker den selv, uendret oppførsel. Det er en liten endring i G4-filen utover G3b-filene.
- `main.ts` tar verdien fra den allerede parsede G4-wiringen og sender den via `buildVisionRuntime` og ruten til `VisionService`. Ingen ny `process.env`-lesing, og uten `JARVIS_SITUATION_SIGNALS=on` er alt uendret.
- Rød først: 31 røde tester før koden.
- Nye tester: `wpg3b-vision-retention-g4-chain` (30; S1–S6, S3 med grunnvindu 90, og et orakel over 168 overganger mot det ekte sveipet), `g3b-retention-derived` (22) og `g3b-retention-transitions`.
- Det siste er 756-overgangsorakelet promotert fra reviewer-proben, og det er grønt uendret.

**FIX-2 (F2), ferdig.** `affects_existing: ["signal_situations"]` står i get/set med signalbryteren på. I 409 og revisjonsraden står det bare når akkurat den endringen forkorter det avledede vinduet, og aldri med signalbryteren av. Orakelet beviser at feltet i 409 er nøyaktig «sveipet ville slettet mer». Runbook §4, DPIA §2 og PROCESSING_INVENTORY er oppdatert med `min`-regelen og at åpne situasjoner og `security_alert` kan slettes. Påstanden om at ingen test dekker kjeden er fjernet.

**FIX-3 (F3), ferdig.** Runbook §6 trinn 11 har advarselen «ikke kjør på produksjonsdata», «noter verdiene først» og et avsluttende «sett tilbake til {30, null}».

**FIX-4 (F5/F6), ferdig.** `setRetentionPolicy` er `@internal` med kommentar. En kildevakt pinner at ingen produksjonskode som bruker `@jarvis/vision` kaller den (grep viste ingen kallere). Svaret har `memory_space` = grantets eget space, aldri tenant eller person. Rød først: 4 røde tester før koden.

**FIX-5 (C14), ferdig.** Koden var riktig, så jeg la inn en pin-test i `wpg3b-privacy-vision-card`. Ødelagt `defaults` (null, undefined, en getter som kaster) gir ett UNKNOWN-element og en målt seksjon.

**Mutanter.** 22 egne mot FIX-1 og 4 mot FIX-4 er alle drept. C14 er drept av pinnen. S24 er drept av det promoterte overgangsorakelet; mot byggerens to opprinnelige G3b-filer alene overlever den fortsatt (reviewerens funn), og `g3-lifecycle` dekker den. Totalt 28 kjørt, 0 overlevende med dagens suite.

**Statiske kontroller.** `pnpm -r --workspace-concurrency=2 run typecheck` (35 pakker), `pnpm lint` og `pnpm check:containment` ga exit 0. gitleaks over 15 commits: no leaks found.

**Testtall** (som `postgres`, 2 arbeidere): guard-batchen ga 103 filer / 1 879 tester grønne. Den dekker blant annet `wph1-flag-off-selection-baseline` 7, `wph2-flag-off-main-parity` 12, `wpg4-signals-retention-wiring` 7, `wpg4-fix-lifecycle` 29, d420, d398-*, `wpj-closure-matrix`, env-drift og part3-tool-manifest. Doc-vaktene ble kjørt på nytt etter siste dokumentendring (9 filer / 141 tester). `wpn1b-structure` finnes ikke i denne grenen.

**Nye antakelser til D-485** (fra nr. 12):
- **12.** G4-grunnvinduet er `JARVIS_SITUATION_LOG_RETENTION_DAYS` (7–365, standard 30), hentet fra den parsede wiringen. Uten kamerapolicy fra tjenesten er det avledede vinduet alltid grunnvinduet.
- **13.** Den avledede regelen er konservativ: den gjelder alle spaces eieren skriver i, mens G4 bare sveiper hjem, helse og business. En `personal`-grant kan dermed få en bekreftelse som ikke trengs.
- **14.** `affects_existing` finnes bare med signalbryteren på. I 409 og revisjonen står det bare når det avledede vinduet faktisk forkortes. Alt er stabile koder.
- **15.** En forlengelse gir aldri lengre levetid for avledede situasjoner enn grunnvinduet.
- **16.** `memory_space` i svaret er grantets eget space.
- **17.** Gammel `setRetentionPolicy` er `@internal`, med kildevakt.

**NOT VERIFIED.**
- Hele suiten er ikke kjørt, og ingenting er kjørt mot en kjørende installasjon.
- Selve `main.ts` er ikke startet med signaler og vision på. Sammensetningen er bevist ved å bygge `buildVisionRuntime` og wiringen i testen, pluss kildevakter på `main.ts`.
- Rate limit på de nye rutene (uendret `authedRequest`), step-up-kanalen (WP-S1/JARVIS-111), NAS-trinnene i runbook §6 og `en_US.UTF-8`.
- Notater: `/tmp/pg-home/g3b-fix1-notes/NOTES.md`.
