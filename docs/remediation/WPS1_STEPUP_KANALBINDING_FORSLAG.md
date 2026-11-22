# WP-S1 (FORSLAG, ikke bygget): server-side kanalbinding for step-up (JARVIS-111, Q-71)

**Status:** forslag til eierens beslutning. Ingen kode er skrevet. WP-S1 endrer kjerneautentisering og starter derfor først etter en navngitt D-beslutning fra deg (CLAUDE.md: «nye beslutninger logges alltid» og faseporten). Alt i dette dokumentet er `NOT_VERIFIED`.

## 1. Problemet (observerbart i koden)

- `POST /session/authorize` tar `channel` fra klienten (`ChannelSchema`: `web`, `mobile`, `watch`, `voice`, `api`, `system`, `telegram`, `desktop`, `slack`, `discord`, `twilio`). `ChannelSessionAuthority.authorize()` (`modules/core/src/services/channel-session-authority.ts`) validerer bare at kanalen er en gyldig enum-verdi, og utsteder `auth_strength: "signed"` for ENHVER gyldig enhetssignatur, uansett kanal.
- Step-up (`ownerStepUpDenial` i `modules/tool-gateway/src/class-d-pipeline.ts`) godtar `signed` fra kanalene `web`, `desktop`, `api` og `mobile`. Kanalen er altså en PÅSTAND fra en klient som har en gyldig signeringsnøkkel.
- Følge: «tale, Telegram og klokke kan ikke åpne dør, flytte penger eller endre skymål» gjelder bare ærlige klienter. En innrullert enhet med lav tillit (Watch, talegateway, en Telegram-bro) som er kompromittert eller feilkonfigurert kan påstå `web` og få en økt som oppfyller step-up for G2s kritiske hjem- og bilhandlinger, F1s pengekjede, E1s skymål, G4s eier-flate og eierkontrollene.

## 2. Forslag (anbefalt)

1. **Lukket enhetstype.** `devices.kind` er i dag fri tekst. Innfør en lukket liste (f.eks. `iphone`, `mac`, `windows`, `web_browser`, `watch`, `voice_gateway`, `telegram_gateway`, `service`) som settes ved innrulling (innrullingsbilletten bærer typen), og en server-side tabell enhetstype → tillatte kanaler (f.eks. `watch` → `watch`; `voice_gateway` → `voice`; `telegram_gateway` → `telegram`; `iphone` → `mobile`; `mac`/`windows` → `desktop`, `web`, `api`; `web_browser` → `web`; `service` → `api`, `system`).
2. **Håndhevelse i autorisasjonskjernen.** `authorizeProvenDevice` leser allerede enheten og nøkkelfingeravtrykket i samme transaksjon; legg til en sjekk av `kind` mot kanalen. En kanal som ikke hører til enhetstypen NEKTES med `channel_not_allowed_for_device_kind` og en revisjonsrad (fail-closed). `OWNER_STEP_UP_CHANNELS` forblir en egen regel: kanal → step-up er policy, enhetstype → kanal er autorisasjon, og de to komponerer.
3. **Migrasjon.** Kjente `kind`-verdier mappes til lista; ukjente blir `legacy_unknown`, som kun får autorisere kanalen `api` uten eier-step-up til enheten er innrullert på nytt. Rullering av `kind` for en eksisterende enhet krever eksisterende step-up eller break-glass.
4. **Observer før håndheving.** Første uke i modus `observe` (logg og revisjon når regelen ville ha nektet, uten å nekte), deretter `enforce` på en dato du velger. Standard i koden er `enforce` (sikker standard); `observe` settes eksplisitt av deg i miljøet.
5. **Tester.** Alle kanal-x-enhetstype-kombinasjoner, mutasjoner av regelen, `/session/authorize` ende-til-ende mot embedded Postgres, og at G2/G4/F1/E1-flatene fortsatt nekter lavtillits-kanaler. Uavhengig review (to gjennomganger) som øvrige WP-er.

## 3. Alternativer

| # | Alternativ | Vurdering |
|---|---|---|
| A | Behold som i dag, kun dokumentert begrensning | Ingen arbeid, men step-up beskytter bare mot ærlige klienter |
| B | Klienten signerer kanalen sammen med utfordringen | Hjelper ikke mot en kompromittert klient som signerer feil kanal |
| C | Separate nøkkelpar per kanal | Sterkest, men tung innrulling og nøkkelhåndtering |
| D | Tillatte kanaler per innrullingsbillett (per enhet i stedet for per type) | Fleksibelt, mer vedlikehold; kan kombineres med forslaget |

Anbefaling: forslaget i §2 (enhetstype → kanaler server-side, billetten bærer typen), eventuelt med D som utvidelse.

## 4. Hva du må bestemme (navngitt D-beslutning)

1. Listen over enhetstyper og kanalmappingen (skal en telefon også kunne autorisere `web`? skal `mac` kunne autorisere `mobile`?).
2. Nekt eller nedgrader (anbefaling: nekt).
3. Observasjonsperiode og dato for håndheving.
4. Hvilke enheter som er innrullert i dag (stemme-gateway, Watch, Telegram-bro) og hvem som må rulles på nytt.
5. At WP-S1 er et eget program utenfor D-470-listen (kjerneautentisering, migrasjon og re-innrulling).

## 5. Inntil WP-S1 er bygget (gjeldende anbefaling)

Ikke slå på noen `JARVIS_PERSONAL_*`-, `JARVIS_GROWTH_WRITE_*`-, `JARVIS_COMMS_OUTBOUND`- eller `JARVIS_SITUATION_SIGNALS`-flagg på en maskin der en lavtillits-enhet (Watch, stemme, Telegram-bro) er innrullert som signerende enhet; se Q-71 og JARVIS-111 (`docs/OPEN_QUESTIONS.md`, `docs/remediation/FINDINGS_LEDGER.md`).
