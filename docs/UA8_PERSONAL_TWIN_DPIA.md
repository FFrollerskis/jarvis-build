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
