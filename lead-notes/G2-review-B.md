VERDICT: MERGE ETTER FIKSER (ingen BLOCKER; 3 MEDIUM bor fikses eller aksepteres bevisst; resten LOW/INFO kan ga som oppfolging)

Reviewer B, WP-G2 @ d91d2197, egen worktree g2-rev-b (tom `git status` etter alt). Dekker familie, helse-inntak, Apple DAV, okonomi-lesing, kontekst, docs, lockfile. Probe-/mutasjonsfiler: /tmp/lead/G2-review-B-probes/ (logger: /tmp/lead/logs/g2-review-b-*.log). Baseline pa ren gren (postgres, 2 workers): 18 testfiler/211 tester i mitt omrade (familie, helse, DAV, okonomi, kontekst, ruter, erasure) + 22 vaktfiler/516 tester grønne.

## Funn (rangert; fil:linje i d91d2197)
MEDIUM-1  DAV-rutene omgar PolicyGateway/ToolGateway (kill switch, credential-revokering, connector-freeze). apps/api/src/personal-dav.ts:66-101, apple-dav.ts:566.
  Kill switch hores kun i PolicyGateway.authorize (policy-gateway.ts:198), revokering kun i ToolGateway (gateway.ts:919,:1341). `/personal/dav/*` kaller AppleDavClient direkte
  (utgaende skriving/sletting mot tredjepart), og `JARVIS_PERSONAL_APPLE_DAV_*` er ikke credential_refs pa noen connector. Aktiv kill switch/`revokeCredential` stopper altsa IKKE DAV.
  personal-routes.ts:12-14 («utforelsen gar UTELUKKENDE via ToolGateway.execute()/domenetjenestene (policy ...)») er misvisende for DAV: «domenetjenestene» er her en ra klient utenfor gatewayen (CLAUDE.md regel 6). Mitigert av eier+step-up+allowlist.
  Fiks: `killSwitch.isActiveDurable()` + `controls.isRevokedDurable(ref)` for hver utsendelse i handleDavRoute (les og skriv), eller kjor via gatewayen.
MEDIUM-2  Helse-inntak: ETT ugyldig `observed_at` velter HELE batchen (reprodusert mot embedded PG). validation.ts:18 + intake.ts:100,108.
  JS `Date.parse` er lenient, INSERT castes i PG. Med 365 d retensjon (byggerens anbefaling Q-G2-4) gir `2026-09-31T10:00:00Z` (22008) og `x 2026-10-15`/`2026-10-15 junk` (22007)
  ukaught pg-feil midt i transaksjonen: rollback av alle prover (rows_added=0 for gyldige sosken) + 500 -> appen resender samme giftige batch for evig. Bryter intake.ts:63. Kortere vindu: samme strenger
  blir misvisende `expired` (`x 5` -> ar 2001). Fiks (verifisert): `observed_at: z.string().datetime({ offset: true })` i HealthObservationInputSchema (zod 3.25.76 avviser alle strengene over inkl. dag-per-maned og offset-lose tider, godtar Z/offset); og/eller SAVEPOINT + catch per prove.
MEDIUM-3  Testgap: `If-Match` pa PUT i AppleDavClient.update (apple-dav.ts:469) er ikke bevist (mutant D1 overlever: alle 28 DAV-tester gronne uten headeren). Testen setter `PUT 412` men asserter ikke headeren;
  GET-tidspunkt-sjekken (:458) maskerer den. Eneste vern mot tapt oppdatering mellom GET og PUT er uten regresjonsvern. Fiks: fake-server endrer ressursen mellom GET og PUT; assert header + 412.
LOW-1  DAV vCard: Apple `itemN.`-gruppeegenskaper (`item1.EMAIL`+`item1.X-ABLabel`, community-observert, Apple-doc ikke hentet) er usynlige for list/get og urorte av update (apple-dav.ts:142 `name`-match).
  Probe: gruppert primaer-epost/telefon vises ikke; `update {emails}` LEGGER TIL ny EMAIL og lar `item1.EMAIL;type=pref` sta; readback sier SUCCESS. Fake-dataene har aldri grupper.
LOW-2  DAV datoer (apple-dav.ts:157): `2026-02-30T10:00:00Z` -> 20260302 (stille skift); tidsstempel uten offset = serverens lokale tid; heldags-event + `start` som tidspunkt gir blandet VALUE=DATE/DATE-TIME;
  DTSTART+DURATION + `end` gir BEGGE DURATION og DTEND (ugyldig iCalendar). Tvetydig lokaltid ved høstskifte tolkes som 2. forekomst (RFC 5545: 1.). `create` uten tittel: `summary:""`/`null` omgar «summary kreves» (SUMMARY utelates, SUCCESS),
  og `end < start` / heldags-start + tidspunkt-slutt aksepteres (probe dav-create-probe.mjs) - kun serveren avgjor. Fiks: streng regex+rundtur; kryssfelt-validering; fjern DURATION; behold verditype.
LOW-3  `parseMultistatus` kvadratisk (apple-dav.ts:320): 1 MiB (taket) `<D:response ` uten lukking = 12,8 s blokkert event-loop (malt; 262 KB = 0,75 s). Krever fiendtlig/kompromittert server. Dessuten dekodes ikke `&#xD;`
  /andre numeriske tegnreferanser (linjer far `&#xD;`-hale -> DTSTART=null), og `HTTP/1.1 404` i event-tekst setter status 404 (skjuler eventet). Standard-taket 1 MiB er heller ikke testet (mutant D4 overlever).
LOW-4  DAV samlings-URL-vern er kun tekstlig (apple-dav.ts:42-51): `https://localhost./`, `*.localhost`, `127.0.0.1.nip.io`, `metadata.google.internal` godtas (probe). Kun eier-konfig; selv-hostet NAS (Q-G2-6) ma tillate LAN.
  Dokumenter at det er tastefeil-vern, avvis `localhost.`/`.localhost`. Server-`href` FOLGES ALDRI (kun hrefFor(uid) bygges av UID-regex): BEKREFTET trygt (D2/D3 drept).
LOW-5  Familie: `removeMember`/`leave` (service.ts:304-325) rorer ikke `person_tenants`/enhets-grants. Probe: fjernet medlem er fortsatt innrullert (identitetsniva-tilgang til sirkel-tenantens `shared`-rom, Q-15);
  kun familie-autoriteten kuttes. Runbook §4/§10 krever ikke avinnrullering/enhetstilbakekall ved fjerning.
LOW-6  Familie: `grantDelegation` (service.ts:474) og `grantShare` (:374) fanger ikke 23505. Probe: 4 samtidige grantDelegation gir 3 ra pg-feil -> 500 `family_failed` i stedet for idempotent retur (grantShare har samme mangel, men gikk 4/4 ok i proben = timing); jf. invite :219 og bootstrap :181 som fanger den.
LOW-7  `setItemDone` (service.ts:585) skriver ingen revisjonsrad (probe: audit_events 9 -> 9), mot «hver endring revideres» (service.ts:26). Rutene item/done, item/add, list/create, event/create har ellers ikke step-up (kun on_behalf_of) - bevisst, men ikke dokumentert.
LOW-8  DAV D-41-klassifisering (opprett/endre B, slett C) overser server-side scheduling (iTIP/iMIP, RFC 6638, Apple CalendarServer-opphav; uverifisert mot iCloud): `update`/`delete`/`status=CANCELLED` av et arrangement
  eieren organiserer kan sende e-post til deltakere (ikke reversibelt). Update bevarer ATTENDEE-linjer + oker SEQUENCE; `DavItem` viser ikke deltakere; update krever ingen typet bekreftelse. Fiks: avvis/bekreft nar ATTENDEE finnes, vis `has_attendees`, ta det inn i D-41-tabellen.
LOW-9  DPIA §9 Apple-rad: «innhold leveres kun til eierens signerte enhet», men DAV-LESING krever bare eier-grant (runbook §6 sier det rett). D-464/Q-G2-1..7 er ikke i DECISIONS/OPEN_QUESTIONS (kun runbook §12 + rapport) - leaden ma legge dem inn.
INFO-1  «barn deler/ser aldri helse» er KUN tjenestelogikk (grantShare + readShared seer-sjekk). DB-CHECK `granted_by = subject` er proveniens, ikke autentisering; subjektets rolle sjekkes ikke ved lesing (probe: admin-innsatt
  barn-helsedeling leses OK). Defense-in-depth: sjekk subjektrolle i readShared. Sirkel-id/IDOR: alt scoped pa tenant+RLS; ingen kryss-tenant-lekkasje funnet (tester med to tenants/sirkler).
INFO-2  Kontekst (BUILT_UNWIRED bekreftet: ingen kallsted utenom tester, flagget `JARVIS_PERSONAL_CONTEXT` er ikke lest av noe): deriveTimeContext korrekt for alle 7 ukedager, DST-dager og midnatt (Node 22/ICU 78); kaster RangeError pa
  ugyldig dato/sone. detectTrips: `atHome` substring begge veier («Os» vs hjem «Oslo», «Oslo lufthavn» = hjemme), tom hjemmeliste feiler apent, O(n^2) (20 000 kjedede events = 3,1 s), `Math.max(...)`-stakkgrense; `trip_id` bærer ekstern event_id.
INFO-3  HealthKit: Apple sier «condensed/coalesced» ogsa for heartRate (ikke bare kumulative); `sleepAnalysis`-sum har ingen uuid (appen ma lage id; endret sum under samme id = `conflict` for alltid); steps fra iPhone+Watch kan dobbelttelles
  i `steps_today`; «naa»-sted i familievisning har ingen maksalder (observed_at = innreise, ikke sist sett). `json()` har ikke `Cache-Control: no-store` (POST-svar). DAV har bare global rate limit.
INFO-4  Regel 4: familie-radene har aktor/tenant/rom/tidspunkt, men ingen egen kilde-/session-/task-kolonne (kun revisjonsraden har kanal+sesjon); migrasjon 126-hodet «hver rad er MERKET (kilde...)» er litt for sterkt.
INFO-5  DAV-revisjon bruker alltid `decision: "ALLOW"` (personal-wiring.ts:131) ogsa for `rejected:*`/`UNKNOWN`-rader (utfallet star kun i payload) - misvisende for DENY/ALLOW-oppsummeringer. `not_the_invitee` vs `not_found` avslorer at en invitasjons-id finnes (UUID, lav risiko).

## Byggerens pastander -> status
| Pastand | Status | Bevis |
|---|---|---|
| Flagg AV = identisk med main, ingen jobber/tilstand | BEKREFTET | wph1/wph2, env-drift, compose-isolation, D-420, d395-erasure, schema-invariants (scope-FK), flags-wiring, status, connector-sdk, tool-manifest/kontrollflate: 22 vaktfiler 516 tester gronne (+3 filer 50 tester: familie, inntak, kontekst); createPersonalWiring bygger bare passive objekter; ruter 404 uten deps |
| Deling kun fra subjektet (DB-CHECK); on-behalf kun med delegasjon+utlop | BEKREFTET | M1,M6 drept; direkte SQL 23514 |
| Barn ser/deler aldri helse | DELVIS | kun tjeneste (M3/M4 drept), ikke DB (INFO-1) |
| Familie step-up, eier-kun, kryss-tenant, datatenant uten FK verifisert i tjeneste | BEKREFTET | R1-R4, M5, M10 drept; to-tenant-tester mot embedded PG; reader filtrerer person |
| 10 lukkede metrikker verifisert mot Apple | BEKREFTET | alle 10 identifikatorer + percent()=0.0-1.0 + HKDeletedObject (midlertidig) + allAsleepValues + HKObject.uuid hentet fra developer.apple.com (.md) 2026-11-19; «stadiene overlapper ikke» står ikke pa Apple-siden |
| Helse: enhet/person-binding, idempotens, fail-closed retensjon, aldri verktoy/skyprompt/logg | BEKREFTET (MEDIUM-2) | H1-H8, X1 drept; race-probe: 1 rad, riktig conflict/duplicate; kun main/routes/wiring importerer @jarvis/health. Enhet A kan ikke skrive for person B: person kommer fra grantet, som kun utstedes etter nokkelbevis og `lockDeviceKeyOn(tenant, person, device)` (device-authority.ts:97-160); DELETE/INSERT scopet pa person+kilde+RLS |
| DAV: href-SSRF, allowlist, redirect, readback, step-up, audit-for, typet sletting | BEKREFTET (LOW-4, MEDIUM-1) | D2,D3,D5-D7,D9-D14 drept |
| DAV: «ingen datatap ved endring» | DELVIS | VALARM/ukjente felt bevart; LOW-1/LOW-2/MEDIUM-3 |
| Okonomi: kun rute, eier+step-up+personal, ingen skriving/logg av beløp | BEKREFTET | F1-F3 drept; feil logges som klassenavn |
| Lockfile minimal og lovlig | BEKREFTET | diff = 3 linjer (workspace-lenke `@jarvis/context`), ingen nye pakker/hasher; `pnpm install --frozen-lockfile --lockfile-only --offline` exit 0 pa uthentet manifest+lock (lock uendret, sha lik) og feiler «outdated» uten linjene |
| .env.example/service-env/compose kun egne linjer; gitleaks | BEKREFTET | 16 compose-linjer + 16 service-env-navn + 26 .env.example-linjer, alle JARVIS_PERSONAL_*; gitleaks 11 commits «no leaks found» |
| Typecheck/lint/containment | BEKREFTET | tsc --noEmit exit 0 for context/health/erasure/tool-gateway/api; eslint pa alle 57 endrede ts/mjs exit 0; check:containment OK |
| Juss tydelig UTKAST | BEKREFTET | DPIA §9 + runbook topp |
| «Ingen vakt er svekket eller utvidet» | BEKREFTET | `git diff --name-status`: 16 modifiserte filer, ingen er en test/fixture/baseline (alle nye tester er rene tillegg); wph1/wph2-fixturene uendret |

## Mutasjonskontroller: 52 mutanter, 47 drept, 5 overlevde (harness + mutantlister i /tmp/lead/G2-review-B-probes/)
Drept: M1,M3-M10 (familie-tjeneste), B1-B4,B6-B11 (DB: CHECK/trigger/indeks/FK i mig. 126), R1-R4 (rute-step-up/eier), H1-H8 (helse-porter/binding/idempotens/utlop/fremtid/kilde), D2,D3,D5-D7,D9-D14 (DAV), F1-F3 (okonomi), X1 (batchtak), X2 (erasure).
Overlevde: D1 (If-Match pa PUT = MEDIUM-3), D4 (standard 1 MiB-tak utestet; testene gir eksplisitt maxBytes), D8 (GET-pre-sjekk fjernet = ekvivalent, PUT If-Match tar over),
B5 (`family_shares_expiry`-CHECK, DB-backstop uten test), B12 (FK invited_by -> person_tenants, DB-backstop uten test; tjenesten lar bare eier invitere).
IDOR-probe (zz-g2b-family-idor-probe): 11 id-baserte metoder x (eier, voksen) i sirkel B mot ID-er fra sirkel A + 3 forfalskede aktorer (A-tenant, B-person) -> alle not_found/not_a_member/share_required/delegation_required; A uendret (item ikke ferdig, event/deling/delegasjon/invitasjon intakt, 3 medlemmer), 0 reader-kall. Samme sirkel (barn/voksen mot andres id-er, self-grant, barn-helse, invite som eier): alle nektet.

## Ikke verifisert
- Live iCloud (dialekt, endepunkter, 401/403-semantikk, E2E-pastand): support.apple.com utilgjengelig herfra; kun tredjepartskilder. Falsk server er realistisk for protokollogikk (etag/412/If-None-Match), IKKE for interop (ingen 3xx, grupperte props, flere VEVENT, `&#xD;`, 404-propstat).
- Hele suiten ikke kjort (som avtalt). A sitt omrade (klasse D, journal, HA/bil, flagg-AV-identitet for verktoyflaten) ikke vurdert; observasjon til A: samme «gar ikke via ToolGateway.execute»-sporsmal som MEDIUM-1.
- iTIP-sideeffekten (LOW-8) er ikke provosert mot en ekte server; vCard-gruppeegenskapene er bekreftet kun via community-kilder (ez-vcard/Evolution), ikke Apple-dokumentasjon.
- Ekte HTTP-ingress (`authedRequest`, 64 KiB-grense, device-rate-limit) er ikke ende-til-ende testet for /personal/* (rutetestene stubber `authed`); koden gjenbruker eksisterende, testet inngang.
