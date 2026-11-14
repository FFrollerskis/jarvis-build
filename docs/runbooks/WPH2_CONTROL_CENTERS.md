# WP-H2 Admin Control Centers: Drift, Verdi, Personvern og Sikkerhet + golden-suite-knapp + tilbakekall av autonomi-binding (UA-11 del 3) - slik bruker og verifiserer du det

**Formål:** de fire siste sentrene fra masterplan kap. 21 på samme flate (`/control`) - **Drift**, **Verdi**, **Personvern** og **Sikkerhet** - slik at alle ti sentre er koblet inn - og de to UA-11-hullene H0/H1 lot stå åpne:
**golden-suite-knappen** (kjør forsvarets selvtest fra panelet) og **tilbakekall av eierens autonomi-binding** (la et domene slutte å handle av seg selv).
Alle fire sentrene LESER bare eksisterende kilder (ingen nye eksterne kall, ingen skriving); de to knappene bruker den EKSISTERENDE ruten `/executive/mutate` med uendret grant, step-up, policy og revisjon.

**Status (ærlige ord, ingenting er VERIFIED før du har kjørt NAS-stegene under):**
- Drift-, Verdi-, Personvern- og Sikkerhet-sentret: **WIRED bak flagg, DORMANT som standard** (AV til du slår dem på). Testet mot embedded Postgres som app-rollen (RLS), mot ekte HTTP/ToolGateway/situasjonsmotor og mot sidens ekte script; **NOT VERIFIED** mot NAS/ekte data.
- Golden-suite-knappen: **WIRED bak eget flagg, DORMANT som standard**. Kjøreren er deterministisk og bruker ingen modell, database eller nettverk; resultatet holdes kun i prosessens minne. **NOT VERIFIED** på NAS.
- Tilbakekall av autonomi-binding: **WIRED bak eget flagg, DORMANT som standard**. Et gjennomslag til den eksisterende `situations.clear_autonomy_policy`; kun i økta sitt eget minnerom (**PARTIAL**, se under). **NOT VERIFIED** på NAS.
- Det som ikke kan måles med dagens kilder står som **ikke målt** (se «Det som aldri er målt»). Ingen del av dette er «ferdig» i betydningen «bevist i drift».

## Åpne
`https://<api-vert>/control` fra en innrullert enhet - samme side som H0/H1. **Siden er datadrevet og er ikke endret** (`apps/web/control.html` er byte-identisk med H1): hvert senter oversikten lister vises automatisk, og et senter uten flagg står fortsatt under «Ikke koblet inn».
I chat (kun web-chat fra en signert enhetsøkt - aldri tale eller Telegram): «vis driftssenteret», «vis verdisenteret», «vis personvernsenteret», «vis sikkerhetssenteret» (`executive.get_operations_center` / `get_value_center` / `get_privacy_center` / `get_security_center`, klasse A, kun lesing).

## Flagg (alle AV som standard; KUN den eksakte verdien `on` slår dem på - `true`/`1`/`ON` gir AV)
| Flagg | Slår på | Gjelder |
|---|---|---|
| `JARVIS_CONTROL_CENTER_OPERATIONS=on` | Drift-sentret (side + `executive.get_operations_center`) | api-prosessen |
| `JARVIS_CONTROL_CENTER_VALUE=on` | Verdi-sentret (side + `executive.get_value_center`) | api-prosessen |
| `JARVIS_CONTROL_CENTER_PRIVACY=on` | Personvern-sentret (side + `executive.get_privacy_center`) | api-prosessen |
| `JARVIS_CONTROL_CENTER_SECURITY=on` | Sikkerhet-sentret (side + `executive.get_security_center`) | api-prosessen |
| `JARVIS_CONTROL_GOLDEN_SUITE=on` | knappen «Kjør golden-suite» (i Sikkerhet) + `executive.run_golden_suite` | api-prosessen (krever også Sikkerhet-flagget for å vises) |
| `JARVIS_CONTROL_AUTONOMY_REVOKE=on` | knappen «Tilbakekall autonomi» per binding (i Autoritet) + `executive.revoke_autonomy_binding` | api-prosessen |

Flaggene settes i `.env` (se `.env.example`) og krever **restart av api** (`docker compose up -d api`). De når containeren fordi de står i `SERVICE_ENV.api` (`infra/local/service-env.mjs`) og dermed i den genererte compose-blokken (`wph1-control-env.test.ts` låser det for alle ti flagg).
AV = H0/H1-oppførselen er uendret: senteret registreres ikke, står under «Ikke koblet inn», verktøyet svarer `found: false`, og de to handlingene finnes ikke (`unknown_tool`).
Et senter uten sine avhengigheter registreres heller ikke selv med flagget på (Drift trenger driftsstatus-kilden, Verdi trenger verdirapporten, Sikkerhet trenger eier-kontrollene og kill switch) - da står det som «ikke koblet inn», aldri som en tom «i orden».
Ingen migrasjon er lagt til i denne WP-en.

## Sentre
| Senter | Seksjoner | Knapper |
|---|---|---|
| **Drift** | Åpne hendelser (antall, alvorlighet, bevisgrad - aldri titler), Skymål og tjenester, Hendelsesprodusenter og vakthund, Backup, Restore-øvelser, Runbooks (antall per kategori), Planlagte jobber, Oppetid, Kapasitet (database, tilkoblinger, jobbkø) | ingen (se DEFERRED) |
| **Verdi** | V1-V5 (verdiløkkene med tilstandsord og tall), Bruksfrekvens, Jobber lukket, Spart tid, Eierens korrigeringer | ingen |
| **Personvern** | Behandlingsoversikt (mot de levende tabellene), Behandlere, DPIA-status, Oppbevaring, Slettebevis | ingen |
| **Sikkerhet** | Revisjon (inkl. append-only-trigger), Credential- og tilgangshendelser, Mistenkelig innhold, Gjenoppretting, Golden-suite | **Kjør golden-suite** (klasse A, krever signert enhet, kan angres - gjør ingenting å angre) |
| **Autoritet** (H0, utvidet) | + én knapp per autonomi-binding i økta sitt eget rom | **Tilbakekall autonomi** (klasse C, krever signert enhet, kan IKKE angres) - kun med `JARVIS_CONTROL_AUTONOMY_REVOKE=on` |

Hver seksjon viser **kilde** (tabell/fil) og **når den ble målt**; «Hvorfor …?» forklarer deterministisk. **Ukjent er aldri «i orden»:** samlet status er den verste av seksjonene (FEIL > ADVARSEL > UKJENT > OK), og en kilde som svikter gir ukjent kun for SIN seksjon.

## Regler du kan stole på
- **Kun den suverene eieren, fra en signert enhetsøkt** - nøyaktig som H0/H1. Tale, Telegram, passiv/aktiv økt, en annen person, en delegat, en gjest og en annen tenant nektes av verktøyets port (`control_center_owner_only` / `control_center_requires_signed_device_session`, revideres som `tool.denied`). Porten er fail-closed også hvis kontrollsenter-registeret ikke finnes.
- **Innholdsvern:** ingen hendelsestitler eller -tekst, ingen runbook-tittel/-innhold, ingen revisjons-`payload`, ingen bekreftelsessammendrag (mottakere), ingen avslagstekst (kun en kort kategori når den er et trygt navn), ingen begrunnelser, ingen hemmeligheter. Kun antall, kategorier, tilstander, tidsstempler og interne id-er. `health`-minnerommet leses som ETT antall i en egen lesing og listes aldri.
- **Tenant-isolasjon:** all tenant-lesing går under identitetens tenant (RLS); sentrene teller aldri en annen tenants rader (bevist mot ekte Postgres som app-rolle). Globale driftstabeller (`scheduler_state`, `owner_control_state`, `situation_domain_pauses`) viser kun navn og tidspunkt.
- **Modellen får de samme rapportene (ingen penger å fjerne her).** Verdi viser AI-kostnad (øre) fra de SAMME målingene som den eksisterende `executive.get_value_report` allerede gir chatten - det er ikke finansdomenet (Finans-sentret er fortsatt låst lokalt og beløpsfritt for modeller).
- **Hvert tall har kilde; ukjent er ukjent.** En seksjon uten målbar kilde står som UKJENT, ikke som 0 og ikke som «i orden».
- **Under kill switch** nekter policyen all lesing av kontrollsentrene og begge knappene (de står ikke på policyens selvgjenopprettingsliste); siden viser gjenopprettingsvisningen.
- **Rate limit:** hvert per-senter-verktøy har 30 kall/min per tenant, `run_golden_suite` har 6/min. Siden bruker `get_control_center` (1 + antall sentre kall per oppdatering = 11 med alle ti), som har 120/min per tenant - det tåler ca. 10 oppdateringer i minuttet.

## Drift: hva «ukjent» betyr her
- Et åpent hendelse gir **advarsel**, en kritisk gir **FEIL**; en hendelse som har stått åpen over 7 døgn nevnes. Er hendelsesprodusentene av, står «ingen åpne hendelser» som **advarsel** (ingen deteksjon betyr ikke ingen hendelser).
- **Backup og restore-øvelser** leses fra `backup-status.json` (WP-C2). Uten statusfil står begge som **ikke målt**. En vellykket restore-verifisering som er eldre enn to ganger intervallet er advarsel, en feilet er advarsel, og «aldri kjørt»/«ikke satt opp» er **ukjent** (en backup som aldri er gjenopprettet er ikke bevist).
- **Oppetid:** kun prosessens starttidspunkt og Postgres' starttidspunkt er målt. **Tilgjengelighet i prosent er ikke målt** (det finnes ingen ekstern oppetidsovervåking). **Ledig diskplass er ikke målt** (API-containeren kan ikke se vertens disk). **Vakthundens egne sjekker er ikke målt** herfra (den kjører i worker uten delt lagring) - kun via hendelsesprodusenten «watchdog».
- **Kapasitet:** databasestørrelse (kun tall, ingen terskel), tilkoblinger (advarsel fra 80 %, FEIL fra 95 % av `max_connections`), jobbkø mot taket for samtidige jobber, backup-fotavtrykk. Jobber som aldri har kjørt finnes ikke i `scheduler_state` og kan derfor ikke listes.
- **Handlinger (kjør backup, restart tjeneste, rydd artefakter) har ingen knapp (DEFERRED):** de finnes kun som V5-forslag (`host_runbook`) som du utfører på verten.

## Verdi: hva som er målt
- V1-V5 viser **tilstandsordet** fra `describeValueLoops` (f.eks. sovende / ikke bygget) som kjent fakta - «OK» på tilstandsordet betyr bare at tilstanden er kjent, ikke at løkken virker. V3 (Builder Loop) og V5 (forslag) er rene beredskaps-/forslagsvisninger; **ingenting aktiveres** (D-397).
- Målinger uten kilde står som **ikke målt** (`ingen kilde koblet inn` / `målingen feilet`) - aldri 0. Advarsel gis for tapte løperdøgn, forfalte oppfølginger og lav fullføringsandel (under 70 % med minst 5 avsluttede jobber).
- **Spart tid** og **eierens korrigeringer** er **aldri målt** (ingen kilde finnes; katalogen sier det rett ut) og står alltid som `IKKE MÅLT`.

## Personvern: hva som er målt
- **Behandlingsoversikten** (`docs/security/PROCESSING_INVENTORY.md`, D-420) parses og sammenlignes med de LEVENDE tabellene (`pg_tables`): en levende tabell uten rad i oversikten er en advarsel (og telles). Denne WP-en fant at `schema_migrations` manglet (migratoren oppretter den; D-420-vakten ser bare `CREATE TABLE` i migrasjonene) - raden er lagt til.
- **DPIA-status er det dokumentet erklærer** («UTKAST», «ikke godkjent») - **ikke en juridisk vurdering**. Så lenge oversikten er et utkast og noen DPIA ikke er godkjent, er det **advarsel**, aldri «i orden». Skyleverandører står som IKKE VERIFISERT i dokumentet, og det telles.
- **Oppbevaring:** de fem daglige retensjonssveipene (siste kjøring), rader som er eldre enn oppbevaringsgrensen likevel står igjen (`tool_executions` > 180 d, `session_grants` > 30 d, med 2 døgns karens), og alderen på de eldste radene i tabellene UTEN automatisk sletting (`audit_events`, `cost_events` - oppbevaring der er en eierbeslutning, migrasjon 073).
- **Slettebevis:** `erasure_requests` og `erasure_fingerprints` (samme leser som Minne-sentret). En mislykket sletting er **FEIL**. **Sletteinngangen (`ErasureService`) er ikke koblet i produksjon (JARVIS-060)**, og om slettinger er gjenanvendt etter en restore måles ikke - begge står rett ut.
- **Dokumentet er ikke i api-imaget** (`api.Dockerfile` kopierer apps/packages/modules/config; `.dockerignore` utelater `docs`). Uten det står dokumentdelen som **ikke målt**, men databasedelene måles likevel. For å måle også dokumentet i drift, monter `docs/` skrivebeskyttet (valgfritt, **NOT VERIFIED**) - legg i en lokal compose-override:
  ```yaml
  services:
    api:
      volumes:
        - ../../docs:/app/docs:ro
  ```
  (stien er relativ til `infra/local/`; `read_only: true` på rotfilsystemet hindrer ikke en `:ro`-binding). Senteret leser kun den ene filen, uten å følge symlenker, maks 512 KB, med 5 sekunders frist.

## Sikkerhet: hva som er målt
- **Revisjon:** antall hendelser/avslag/feil/ukjent utfall siste døgn og 7 døgn (`audit_events`, kun typer og tidsstempler - `payload` leses aldri), avslagsårsaker som korte kategorier, og **om append-only-triggeren (`audit_events_append_only`) er intakt** (`pg_trigger`). Deaktivert trigger er **FEIL** (manipulasjonsbevis mot den ekte tabellen er testet).
- **Credential- og tilgangshendelser:** utførte/avviste kontrollhandlinger siste 30 døgn (tilbakekall, gjenoppretting, frys, enhet, kill switch), det som er tilbakekalt/frosset akkurat nå (kun NAVN, aldri verdier), og avviste innrulleringer/grants/identiteter.
- **Mistenkelig innhold:** bekreftelser utløst av ubetrodd innhold (`action_confirmations.taint_reasons`), minnekarantene og avviste minneforslag. **Det som ikke kan telles står rett ut som ikke målt:** antall hemmeligheter fjernet av hemmelighetsskanneren, treff holdt tilbake av skyskjermen og radar-karantene er ikke lagret noe sted (prosesslokale tellere).
- **Gjenoppretting:** kill switch (leses fra den VARIGE tilstanden `owner_control_state`, ikke en prosesslokal cache; mens den er aktiv nekter policyen lesing av sentrene, så posten er i praksis «av» når du ser den - men rapporten påstår aldri «av» uten å ha lest tilstanden), finans-nødbryter, frosne connectorer, tilbakekalte credentials og pausede domener - det som venter på å bli opphevet - og hvor mange gjenopprettingshandlinger som er utført. Selve gjenopprettingsknappene bor i Autoritet-sentret (samme ruter).

## Golden-suite-knappen
- **Hva den gjør:** kjører den deterministiske golden-suiten (`apps/api/src/golden-suite.ts`, WP-B/D-452: regresjonsvern for Jarvis' egne regler, inkl. red-team-kategoriene) mot den EKTE modellverktøyflaten, fra panelet. **Ingen modell kalles, ingen database leses eller skrives, ingenting går over nettverket** (kildevakt og en test som stubber `fetch` til å kaste).
- **Resultatet:** antall oppgaver, kjørt, bestått, ikke bestått (navn), hoppet over (navn - telles aldri som bestått), red-team-brudd per kategori, `hard_stop`, to digester (`suite_digest` = hvilken suite; `result_digest` = SHA-256 av et kanonisk utfall uten tidspunkt/varighet, så to kjøringer gir samme digest), og `model_calls: 0`. Det vises i Sikkerhet → Golden-suite.
- **Hva det IKKE beviser:** en bestått suite sier at reglene i suiten fortsatt holder - ikke at drift er trygg. Resultatet holdes kun i prosessens minne og nullstilles ved omstart (da står seksjonen som «ikke kjørt» = ukjent).
- **Hvordan den kjøres:** knappen går via `POST /executive/mutate` (`run_golden_suite`) - samme grant-, step-up- (signert enhet) og revisjonsvei som øvrige kontrollknapper; verktøyets port krever i tillegg eier + signert økt og den står aldri på en modellflate. Én kjøring om gangen (samtidige kall deler kjøringen), maks 6/min. Handlingen er den ENESTE lesende i `EXECUTIVE_MUTATE_ACTIONS` - bevisst, for å bruke den eksisterende step-up/revisjon-veien i stedet for en ny rute.

## Tilbakekall av autonomi-binding
- **Hva er en binding:** eierens eksplisitte tillatelse for ETT situasjonsdomene til at Jarvis utfører en bestemt handling selv (`situation_autonomy_policies`, D-160). **Fravær av binding = ingen auto-ACT** (fail-closed): situasjoner i domenet blir liggende som forslag til du handler. Å tilbakekalle = domenet går tilbake til det strengeste nivået.
- **Hva knappen gjør:** `executive.revoke_autonomy_binding {domain}` er et rent gjennomslag til `situations.clear_autonomy_policy` med den UENDREDE identiteten (ingen tenant-/rom-/aktørparametre kan sendes). Motorens egen sovereign-eier-port gjelder i tillegg til policyen. Verktøyet er **klasse C**, eier-kun (nekter alle andre FØR noe kalles), **krever step-up** (signert enhet - ikke på unntakslisten for stopp-handlinger), revideres (både det ytre `executive`-kallet og det nøstede `situations`-kallet) og er **idempotent** (en gjentatt tilbakekalling gir `removed: false` uten feil).
- **Snevert tolket (narrowest safe interpretation):** bindingen **slettes** (den eksisterende primitiven) - den deaktiveres ikke. Parametrene lagres ikke og kan ikke gjenopprettes: for å binde på nytt må du gi handling og parametre på nytt (`situations.set_autonomy_policy`). Knappen vises kun for bindinger i **økta sitt eget minnerom** (`clear_autonomy_policy` virker alltid i identitetens eget rom); bindinger i andre rom vises med en forklaring i stedet, og **health-rommet er isolert** (kun et antall, kan ikke tilbakekalles herfra) - **PARTIAL**.
- **Rask stans uten å slette:** «Pause domene» (Autoritet → Pauser og tilbakekall) stopper auto-ACT umiddelbart uten å fjerne bindingen, og kan oppheves igjen. Bruk tilbakekall når du vil at bindingen skal forsvinne.

## Det som aldri er målt (permanent ukjent med dagens kilder)
Ekstern tilgjengelighet i prosent · ledig diskplass på NAS · vakthundens egne sjekker · spart tid · eierens korrigeringer · antall hemmeligheter fjernet av skanneren · treff holdt tilbake av skyskjermen · radar-karantene · om slettinger er gjenanvendt etter en restore · eksportlogg for minne (H1). Å måle dem krever ny instrumentering (egne WP-er); de er listet her for at et grønt panel aldri skal leses som «alt er målt».

## Kjente begrensninger (DEFERRED/PARTIAL - ikke stille utelatt)
- **DEFERRED:** drifts-handlinger (kjør backup, restart tjeneste, rydd artefakter) har ingen knapper - kun V5-forslag på verten. Sletting og eksport av minne har ingen app-rute (JARVIS-060).
- **PARTIAL:** tilbakekall av autonomi gjelder kun økta sitt eget rom, og sletter (deaktiverer ikke) bindingen. Et alternativ (deaktivere i stedet for å slette, eller tilbakekalle på tvers av rom) krever en ny motor-primitiv og er et eier-valg - se åpne spørsmål i rapporten.
- **PARTIAL:** Personvern måler dokumentet kun hvis `docs/` er montert; DPIA-status er dokumentets egen erklæring.
- **PARTIAL:** golden-suite-resultatet holdes i prosessens minne (ikke varig); en omstart nullstiller det.
- **Verdi:** kostnadstall (øre) er de samme som i `get_value_report`; om du vil at Verdi skal være låst lokalt som Finans, er det en egen beslutning.

## Verifiser på NAS (NOT VERIFIED - ikke kjørt mot ekte data/NAS ennå)
Test kun mot sandbox-ressurser (blast radius): bruk et domene som ikke har situasjoner (`h2-test`), aldri et ekte domene.
1. I `.env`: `JARVIS_CONTROL_CENTER_OPERATIONS=on`, `JARVIS_CONTROL_CENTER_VALUE=on`, `JARVIS_CONTROL_CENTER_PRIVACY=on`, `JARVIS_CONTROL_CENTER_SECURITY=on`, `JARVIS_CONTROL_GOLDEN_SUITE=on`, `JARVIS_CONTROL_AUTONOMY_REVOKE=on`. `docker compose up -d api`. Kontroller at flaggene når containeren:
   `docker compose exec api printenv | grep -E 'JARVIS_CONTROL_(CENTER|GOLDEN|AUTONOMY)'` (forvent seks nye linjer med `=on`, pluss H1-flaggene hvis de er på).
2. Åpne `/control` fra en innrullert enhet: Drift, Verdi, Personvern og Sikkerhet er flis og står IKKE lenger under «Ikke koblet inn»; «10 av 10 sentre er koblet inn» hvis H1-flaggene også er på. Hver seksjon har kilde og tidspunkt; det som ikke er målbart står som «ikke målt».
3. **Drift:** backup/restore viser statusfilens verdier (eller «ikke målt» uten fil); oppetid viser prosess- og databasestart; kapasitet viser databasestørrelse og tilkoblinger. Ingen hendelsestitler vises.
4. **Golden-suite:** Sikkerhet → Golden-suite viser «ikke kjørt». Trykk «Kjør golden-suite» → dialogen viser klasse A + «krever signert enhetsøkt» → bekreft. Forvent «N av N bestått», to digester og `model_calls: 0`. I databasen:
   `SELECT type, tool_id, action, person_id FROM audit_events WHERE action = 'run_golden_suite' ORDER BY audit_id DESC LIMIT 1;` (forvent `tool.executed`, `executive`, din person). Gjenta fra Telegram/tale → forvent nekt.
5. **Tilbakekall (sandbox):** opprett en test-binding for et domene uten situasjoner (admin-rollen, kun test):
   `INSERT INTO situation_autonomy_policies (tenant_id, memory_space_id, domain, tool_id, action, parameters, actor_person_id) VALUES ('<tenant>', 'personal', 'h2-test', 'telegram', 'notify', '{}'::jsonb, '<eier-person>');`
   Åpne Autoritet → Delegert autonomi: raden `personal:h2-test` har knappen «Tilbakekall autonomi: h2-test» (klasse C, krever signert enhet, kan ikke angres). Trykk og bekreft → forvent `SELECT count(*) FROM situation_autonomy_policies WHERE domain = 'h2-test';` = 0 og to `tool.executed`-rader (`executive.revoke_autonomy_binding` og `situations.clear_autonomy_policy`). Trykk igjen er ikke mulig (knappen er borte); et nytt API-kall gir `removed: false`.
6. **Personvern:** uten `docs/`-montering står dokumentdelen som «ikke målt» og databasedelene er målt. Med monteringen (se over) står dekningen mot levende tabeller som 100 %, oversikten som UTKAST og DPIA-ene som ikke godkjent (advarsel).
7. **Sikkerhet:** «Revisjon → append-only» er OK, «Gjenoppretting» viser det som er frosset/tilbakekalt/pauset akkurat nå (kun navn). (Mens kill switch er aktiv nekter policyen all lesing av sentrene og siden viser gjenopprettingsvisningen - se H0; kill switch-posten leser den varige tilstanden og er derfor i praksis «av» når du kan se senteret.)
8. **Rollback:** sett flaggene til `off` (eller fjern dem), `docker compose up -d api` → sentrene står under «Ikke koblet inn» igjen, knappene og verktøyene er borte, og H0/H1-sentrene er uendret. Ingenting ligger igjen (ingen migrasjon, ingen varig tilstand utover en eventuell test-binding du allerede har slettet).

## Utvikler: hvordan det er testet og hvor det henger sammen
- Sentrene: `apps/api/src/control-center/{operations,value,privacy,security}.ts`; kjøreren `apps/api/src/golden-suite-runner.ts` (kontrakten `GoldenSuiteControl` i `modules/executive/src/control-center/golden-suite.ts`); knappen `security.golden_suite.run` bygges i Sikkerhet kun når en kjører er koblet inn; tilbakekall-knappen `authority.revoke_autonomy:<rom>:<domene>` bygges i `authority.ts` kun med `autonomyRevoke`.
- Verktøy: rader i `CONTROL_CENTER_READ_TOOLS` (`tools.ts`), `run_golden_suite`/`revoke_autonomy_binding` som flaggstyrte definisjoner i `executiveToolDefinitions(transport, { goldenSuite, autonomyRevoke })`; speilet i `modules/tool-gateway` (`chat-read-tier.ts`, `tool-manifest.ts`, `turn-context.ts`).
- Tester (`apps/api/test/`): `wph2-control-centers` (enhet), `wph2-control-tools`, `wph2-golden-suite-runner`, `wph2-control-wiring` (main.ts-koblingen), `wph2-{operations,privacy,security}-center-db` (ekte SQL som app-rolle), `wph2-control-gateway-db` (ekte ToolGateway + alle flagg), `wph2-control-routes` (ekte HTTP + situasjonsmotor + kill switch), `wph2-control-page` (sidens ekte script); `wph1-control-env` låser at alle ti flagg når containeren.
- Legg til et nytt senter: se «Utvikler» i `WPH1_CONTROL_CENTERS.md` (inkludert manifest-steget - uten det når flagget aldri containeren).
