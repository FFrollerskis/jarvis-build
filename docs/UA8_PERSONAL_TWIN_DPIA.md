# UA-8 — DPIA / data-governance-notat (Personal Digital Twin: kontekst, lokasjon, helse)

**Status:** UA-8 «Personal Digital Twin» — provider-uavhengig kjerne bygget (D-130, 2026-09-09).
`UA8_ACCEPTANCE_2` («health/location follows configured routing + retention») dekkes av dette notatet.
Dette notatet dekker de TRE NYE persondata-kategoriene D-130 introduserer: personlig kontekst
(`context_observations`), lokasjon/geofencing (`location_*`) og helse (`health_metric_observations`).
Samme form og disiplin som `UA3_BUSINESS_DPIA.md`/`UA7_COMMUNICATIONS_DPIA.md`: kort og teknisk, ikke
juridisk teater — og det utfyller, erstatter ikke, `docs/security/DPIA_DRAFT.md`.

> **Jarvis avgjør ALDRI selv et rettslig grunnlag.** Samme prinsipp som `modules/consent` (D-91) og
> `UA7_COMMUNICATIONS_DPIA.md` (D-122): koden håndhever en eier-KONFIGURERT retensjon/routing.
> Ingenting i dette notatet er en påstand fra Jarvis om at et gitt grunnlag faktisk er gyldig.

## 1. Hvilke data behandles (faktisk, ikke planlagt)

| Datakategori | Tabell | Hva som faktisk lagres |
|---|---|---|
| **Personlig kontekst** | `context_observations` (`049_context_engine.sql`) | Sted/enhet/møte/aktivitet-dimensjoner, PER dimensjon: `value` (jsonb, generisk form — ikke rå sensordata), `source_type`/`source_instance_id` (PEKER til kilden, f.eks. `device_id` eller en `business_activities`-rad — ALDRI kopi av kildeinnhold), `basis` (`deterministic`/`inferred`), `observed_at` |
| **Lokasjon** | `location_observations`/`location_zones`/`location_zone_visits` (`050_location.sql`) | Rå punkter (`lat`/`lon`/`accuracy_meters`), eier-definerte geofences (senter+radius), avledede sone-besøk (inn/ut-tidspunkt) |
| **Helse** | `health_metric_observations` (`051_health.sql`) | Et LITE, bevisst avgrenset MVP-sett metrikker (`heart_rate`/`steps`/`sleep_duration_minutes`/`weight_kg`), `value`+`unit`, PEKER til kilde (aldri rå leverandørnyttelast) |

**Ikke behandlet i dag (eksplisitt, ikke stilltiende utelatt):** INGEN live provider-tilkobling for
noen av de tre kategoriene (ingen Apple Health/HealthKit, ingen Apple/Google-lokasjonstjeneste, ingen
bil-API) — kun den kanoniske, provider-nøytrale ingestion-/lagringskontrakten. Se §5.

## 2. Retensjon

| Data | Retensjon | Håndhevet av |
|---|---|---|
| Lokasjonsobservasjoner | Eier-KONFIGURERT vindu (`location_retention_policies`, mirrorer `consent_enforcement_policies`-mønsteret — Jarvis håndhever den registrerte verdien, gjetter aldri en default utover en dokumentert fallback) | `LocationService.purgeExpiredObservations()`, kjørt daglig via `DailyScheduler` (`location-retention-sweep`, `apps/api/src/main.ts`) |
| Helseobservasjoner | Eier-KONFIGURERT vindu (`health_retention_policies`, samme mønster) | `HealthService.purgeExpiredObservations()`, kjørt daglig (`health-retention-sweep`) |
| Kontekstobservasjoner | Følger EKSISTERENDE Q-20/erasure-fundament (`modules/erasure/src/plan.ts`) — ingen egen tids-basert retensjon utover dette (kontekst er "hva som er sant NÅ", ikke en historikk som skal vokse ubegrenset — presisjon på dette punktet er en fremtidig forbedring, ikke et hull: hver ny observasjon for samme dimensjon overskriver via `ON CONFLICT`, så tabellen vokser IKKE ubegrenset med tidens gang for et gitt (person, space, dimensjon)-par) | Erasure-plan (`context_observations` registrert i BÅDE `planMemorySpace`/`planTenant` og `planPerson`) |

Q-20-sletting treffer alle tre kategoriene direkte (ikke bare via retensjonsvinduet) — se §6.

## 3. Rettsgrunnlag

| Behandling | Registrert grunnlag | Merknad |
|---|---|---|
| Eierens egen kontekst/lokasjon/helse i eget system | Eierens egen behandling av egne data i eget system | Ingen tredjepart involvert i denne sliceen (ingen ekstern provider koblet til) |
| `health`-space | Strukturelt LÅST til nøyaktig `memory_space_id = 'health'` (DB-CHECK, `051_health.sql`) + RESTRICTIVE RLS — samme "structural, not conventional"-prinsipp D-129 etablerte for tenant/space-integritet | Helsedata kan aldri ende opp i `personal`/`business`/andre spaces ved en applikasjonslag-bug — databasen selv nekter det |
| Fremtidig ekstern provider (Apple Health, lokasjonstjeneste, bil-API) | **INGEN registrert ennå** — kapabiliteten finnes ikke i denne sliceen | Får ikke bygges før en D-64/D-41-port er kjørt PER provider (samme presedens som Google Ads/Zendesk/Stripe) og — for helse/lokasjon spesifikt — dette notatet er utvidet FØR bygging |

## 4. Databehandlere

**Ingen.** Denne sliceen kobler INGEN ekstern databehandler til for kontekst/lokasjon/helse.
`HealthMetricSource`-adapterkontrakten (`modules/health/src/types.ts`) og `MobilityAdapter`-kontrakten
(`packages/contracts/src/mobility.ts`) er provider-nøytrale GRENSESNITT — kun `FakeHealthMetricSource`/
`FakeMobilityAdapter` (test-only) implementerer dem i dag. `docs/security/PROCESSOR_REGION_MATRIX.md`
skal utvides med en rad FØRST når en faktisk leverandør velges og kobles til (samme regel D-122 etablerte:
en `TBD`-rad ved siden av et live leverandørkall er en usann rad — men her finnes INGEN live kall ennå,
så INGEN rad er lagt til enda heller, per samme prinsipp motsatt vei).

## 5. Bevisst utsatt innenfor UA-8 (`DEFERRED_WITHIN_UA8_BY_DEPENDENCY`)

| Kapabilitet | Port som må kjøres først |
|---|---|
| Live Apple Health-integrasjon | Fysisk iPhone/Apple Watch + Apple Health-entitlement (ekstern/fysisk gate) + D-64/D-41-port. `HealthMetricSource`-kontrakten finnes klar til å implementeres mot |
| Live lokasjonstjeneste (Apple/Google) | Fysisk enhet + D-64/D-41-port. Provider-nøytral modell er BEVISST valgt som system-of-record slik at ingen provider blir domeneeier (D-64-presedens, se `location_*`-migrasjonens filhode) |
| Bil-API/mobilitet | Eksplisitt Tobias-leverandørbeslutning (ordren forbød å velge bilprovider i denne sliceen) — kun kontrakten (`packages/contracts/src/mobility.ts`) er bygget |
| iOS/watchOS-klient som faktisk sender kontekst/lokasjon/helse | Kompilering krever Mac + Apple Developer-konto (ekstern/fysisk gate) — Swift-kildekoden finnes fra Fase 8-grunnlaget (`apps/mobile/`), uendret av D-130 |

## 6. Hva som er STRUKTURELT håndhevet (ikke bare skrevet)

1. **Tenant+space-isolasjon for alle tre kategoriene** — `ENABLE`/`FORCE ROW LEVEL SECURITY` + tenant-
   policy + RESTRICTIVE space-policy på ALLE nye tabeller (samme mønster som `consent_decisions`,
   D-91). Bevist med ekte RLS-sesjonstester (ikke applikasjonslag-filter), inkl. et negativt kontrolltilfelle
   (samme space i scope viser dataene) for å bevise testen faktisk måler noe.
2. **`health`-space er DB-strukturelt umulig å blande med andre spaces** — `CHECK (memory_space_id =
   'health')` PLUSS RLS, bevisst dobbel håndhevelse (samme "structural, not conventional"-presedens
   som D-129's composite-FK-lærdom), bevist med en rå INSERT-forsøk-test som viser Postgres selv
   avviser en feil space-verdi.
3. **Kryss-tenant/kryss-space relasjons-integritet for lokasjon** — `location_zone_visits` bruker
   sammensatte `(tenant_id, memory_space_id, id)`-fremmednøkler mot BÅDE `location_zones` OG
   `location_observations` (D-129-lærdommen anvendt direkte på ny kode, ikke gjenoppdaget separat) —
   bevist med en rå cross-scope-INSERT-test som viser en ekte Postgres FK-avvisning (`23503`).
4. **Retensjon er reell sletting, ikke en udokumentert kolonne** — `purgeExpiredObservations()` for
   BÅDE lokasjon og helse er faktisk koblet inn i `DailyScheduler` (`apps/api/src/main.ts`,
   `location-retention-sweep`/`health-retention-sweep`, daglig), ikke bare skrevet og aldri kalt.
5. **Ingen sensordata uten kilde-peker** — samtlige tre kategorier lagrer `source_type`/
   `source_instance_id` som en PEKER, aldri en kopi av rå leverandørnyttelast (samme "peker, aldri
   kopi"-prinsipp som `business_activities`, P0).
6. **Deterministisk kilde foretrekkes alltid over gjettet** — `context_observations.basis` skiller
   eksplisitt `deterministic` fra `inferred`, og en eksisterende deterministisk observasjon blokkerer
   en senere inferert observasjon for samme dimensjon (dokumentert presedensregel, `modules/context/src/service.ts`).

Bevist i `modules/context/test/service-rls.test.ts` (12), `modules/location/test/{service-rls,
zone-scope-integrity}.test.ts` (14), `modules/health/test/service-rls.test.ts` (18).

## 7. Kjent, dokumentert restrisiko (ikke skjult)

1. **Ingen live provider betyr denne sliceens praktiske eksponering er lav** — men modellen/RLS/
   retensjon er bygget NÅ, FØR en provider kobles til, nettopp for at koblingen senere ikke skal
   presse frem en hastig, uferdig datamodell (samme rekkefølge-disiplin som D-64 krever generelt).
2. **`context_observations`' "møte pågår"-deteksjon kan ikke bevise møtets SLUTTTIDSPUNKT** — kun
   startdata finnes i dag i `business_activities` (ingen varighet lagret der). Engine returnerer
   ærlig `end_time_known: false` i stedet for å anta møtet fortsatt pågår eller er ferdig — dokumentert
   gap, ikke skjult som en falsk "vet"-tilstand.
3. **`memory_spaces` er tenant-scoped, ikke person-scoped** (samme funn som Q-15/Q-31 (D-130) i
   `OPEN_QUESTIONS.md`) — en "delt familie-space" for kontekst/lokasjon/helse gir i dag samme tilgang
   til alle personer med medlemskap+registrert enhet i tenanten, ingen finere per-person-ACL. Relevant
   her fordi helse/lokasjon er spesielt sensitive kategorier — flagget eksplisitt, ikke silently
   akseptert som "godt nok".
4. **HA-gateway-target-validation-gapet (Q-34)** gjelder IKKE denne DPIA-en direkte (det er en
   home/car-handlings-integritet, ikke en persondata-kategori) — nevnt her kun for kryssreferanse siden
   begge ble funnet i samme slice.

## 8. Oppdateringsplikt

Dette notatet oppdateres FØR — ikke etter — hver nye kontekst-/lokasjon-/helse-databehandler tas i
bruk: Apple Health, en lokasjonstjeneste, en bil-API, eller enhver annen ekstern kilde/sluk for disse
tre kategoriene. Samme regel som `PROCESSOR_REGION_MATRIX.md` sin egen: en rad som ikke er fylt ut,
er ikke i produksjonsbruk.

## 9. WP-G2 (D-464, 2026-11-18): nye datakategorier og endringer (DORMANT, alt bak `JARVIS_PERSONAL_*`-flagg)

> **Jussen er UTKAST, ikke juridisk gjennomgått.** Samme prinsipp som øverst: koden håndhever en eier-KONFIGURERT retensjon/ruting; Jarvis avgjør aldri selv et rettslig grunnlag. Ingenting under er i produksjonsbruk (alle flagg AV, ingen ekte enhet/konto koblet til).
> Detaljer, tester og NAS-verifisering: `docs/runbooks/WPG2_PERSONAL.md`. Behandlingsinventaret (`docs/security/PROCESSING_INVENTORY.md`) har tabellene.

| Kategori | Hva som lagres | Retensjon | Ruting / mottakere | Status |
|---|---|---|---|---|
| **Utvidede helsemetrikker** (migrasjon 128) | Seks nye størrelser i `health_metric_observations` (hvilepuls, HRV/SDNN, oksygenmetning, respirasjonsfrekvens, aktiv energi, treningsminutter) + en ekstern prøve-id (HealthKits `uuid`, en pseudonym kilde-peker) og kilde-pekeren `apple_health`/enhet. Lukket liste, hver verifisert mot Apples dokumentasjon 2026-11-18 | Som §2: eier-konfigurert vindu, **inntaket er fail-closed uten policy**, ingen prøver tas inn som allerede er utløpt, og prøver HealthKit melder slettet fjernes | `health`-rommet alene (DB-CHECK + RLS); aldri til en modell, prompt, logg eller verktøy (SECRET_RESTRICTED); ingen databehandler | Bygget, `DORMANT`; appen `BLOCKED_EXTERNAL` |
| **Bil** (migrasjon 125) | Handlingsjournal for bil (og hjem): kjøretøy-id, normalisert tilstand (låst/ulåst, klima, lading), utfall, aktør, tidspunkt. WP-G2c (migrasjon 144): de skjema-validerte forespørselsparameterne (`request_params`) og resultatet av en eier-avstemming (antall forsøk, tidspunkt, fast begrunnelseskode, normalisert tilstand). Ingen lokasjon, ingen hemmeligheter | Ingen automatisk opprydding (`DEFERRED`, eierbeslutning); slettes med rom/person | Eierens egen Home Assistant; bil-API først når en leverandør er valgt (D-64-port + denne DPIA-en utvides FØR bruk) | Bygget, `DORMANT`; leverandør ikke valgt |
| **Familie/delte rom** (migrasjon 126/127) | Medlemskap og roller, invitasjoner, samtykke-poster (delinger av lokasjon eller helse-sammendrag, delegasjoner for lister/kalender) og felles lister/kalender (menneske-skrevet tekst = ubetrodd data). Delingen lagrer KUN hvem som deler hva med hvem; seeren får avledet svar (sonenavn; skritt i dag og søvn siste natt) hentet ved lesing fra personens egen datatenant. WP-G2c (D-483): sonenavnet vises bare med en observasjon ≤ 6 t gammel (ellers ukjent; `observed_at` = sist sett), så et gammelt sted aldri fremstår som «nå»; invitasjons-id-er er ikke et orakel (en annens invitasjon og en ukjent id gir samme 404); alle svar under `/personal/` har `Cache-Control: no-store` | Utløpte/tilbakekalte samtykke-poster beholdes som bevis til sirkelen/personen slettes; ingen automatisk opprydding (`DEFERRED`) | Kun sirkelens medlemmer etter eksplisitt deling; ingen databehandler; revisjon uten innhold. Fjerning/forlating tilbakekaller delinger, delegasjoner OG personens enheter/grants i sirkel-tenanten (permanent) | Bygget, `DORMANT`; provisjonering og verge-tilgang ikke bygget |
| **Personlig økonomi** | Ingenting nytt lagres: lesing (rute, ikke verktøy) av eksisterende kanoniske banktabeller (`bank_*`) i `personal`-rommet; fritekst fra banken er ubetrodd data | Som UA-6 (regnskapskrav, ikke avklart som sletteregel) | Kun eierens signerte enhet; aldri til en modell, prompt eller samtale (SECRET_RESTRICTED, Q-64); ingen nye databehandlere (Neonomics er allerede en behandler for UA-6) | Bygget (kun lesing), `DORMANT`; personlig bankkobling `NOT VERIFIED`; samtale-tilgang **IKKE bygget** (Q-64/Q-66) |
| **Apple-data** (kalender, påminnelser, kontakter) | Ingenting lagres hos Jarvis: eier-kun-ruter (`/personal/dav/*`) leser og endrer eierens egne data direkte i iCloud via CalDAV/CardDAV. Revisjonen (`audit_events`) har samling, UID og utfall - aldri innhold; et forsøk som kill switch/tilbakekalt credential stopper gir ÉN DENY-rad (handling, samling og årsak). Tekst fra iCloud er ubetrodd data | Ingen kopi hos Jarvis; retensjon styres av eierens iCloud-konto | Eierens verifiserte grant -> API -> iCloud med et app-spesifikt passord (D-108). LESING krever kun eier-grant (innholdet leveres til eierens klient, ikke nødvendigvis en signert enhet), og HVER mutasjon krever i tillegg en enhetssignert økt; aldri til en modell, prompt eller verktøy. **iCloud er en ekstern databehandler** (Apple sier at kalender og kontakter over CalDAV/CardDAV ikke har innebygd ende-til-ende-kryptering; sammendrag av Apples sider, ikke hentet i sin helhet), og passordet gir tilgang til hele kontoens kalender/kontakter: Jarvis begrenser bare gjennom en samlings-allowlist. Endring/sletting av en hendelse MED deltakere kan få iCloud til å sende e-post til deltakerne (iTIP, uverifisert; kan ikke trekkes tilbake): krever eierens eksplisitte flagg. Dette notatet og `PROCESSOR_REGION_MATRIX.md` utvides FØR live bruk | Bygget (bevist kun mot en falsk server), `DORMANT`; live `BLOCKED_EXTERNAL`; påminnelser over iCloud CalDAV er trolig ikke tilgjengelige for oppgraderte lister (runbook §6) |

**Mindreårige.** Familiesirkelen kan ha barn som medlemmer. Barn kan se andres delte lokasjon og dele sin egen lokasjon, men verken se eller dele helse (strengeste standard i koden). **Rettslig grunnlag og foresattes samtykke for mindreårige er IKKE løst** (åpent eierspørsmål Q-G2-3); barns helse deles ikke før en juridisk vurdering foreligger.
**Presisering av «kun eier på en signert enhet» (A-M3, ÅPEN oppstrøms).** Påstanden «tale, Telegram og klokke kan ikke åpne en dør eller utføre en kritisk handling» gjelder bare for ÆRLIGE klienter: step-up avgjøres av grantets `auth_strength` og kanal, og kanalen er KLIENT-PÅSTÅTT (`POST /session/authorize`, D-131/D-462, uendret av WP-G2) - en innrullert enhet med gyldig nøkkel kan påstå en annen kanal. Ingen ny persondata følger av dette, men styrken av vernet for de fysiske handlingene (lås, alarm, bil) avhenger av at innrullerte enheter ikke er kompromittert. Føres som egen ledger-post og eierspørsmål (runbook §0/§12, Q-G2-12); oppfølgingen (server-side kanal-autoritet) bør være på plass FØR fysiske handlinger tas i live bruk.
**Transportvei for helse-inntak.** Serversiden mottar fra eierens egen nettvei. En tredjeparts relé/tunnel (f.eks. en skybasert proxy) ville vært en databehandler for særlige kategorier og krever at dette notatet og `PROCESSOR_REGION_MATRIX.md` oppdateres FØR bruk (Q-G2-4).
**Strukturelt håndhevet (nytt):** (1) helse og lokasjon er kun synlig for personen selv uten en deling personen selv har gitt (DB-CHECK, ingen eier-bakdør); (2) «på vegne av» krever prinsipalens egen delegasjon med påkrevd utløp; (3) idempotent inntak (unik indeks på kilde + prøve-id); (4) helsedata har ingen modellflate (vakt-tester over kildetreet);
(5) alle nye tabeller har FORCE RLS, er registrert i slettekjeden og inventaret. **Restrisiko (ikke skjult):** kumulative helsemetrikker kan telles dobbelt hvis appen ikke sender slettede prøver (HealthKit slår sammen delprøver); datatenant-pekeren i familiesirkelen er ikke en FK (tenant-kryssende FK er forbudt) og verifiseres i tjenesten; handlingsjournalen kan vise når huset/bilen er låst (eier-kun).
