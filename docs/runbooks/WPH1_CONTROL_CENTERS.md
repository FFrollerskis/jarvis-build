# WP-H1 Admin Control Centers: Finans, Minne og Agenter (UA-11 del 2) - slik bruker og verifiserer du det

**Formål:** de tre første sentrene etter H0 på samme flate (`/control`): **Finans**, **Minne** og **Agenter** - og de to UA-11/JARVIS-087-hullene H0 lot stå åpne: dekning av ALLE kjørende agenter/jobber
(AI-sentret viser de 50 første, Agent-sentret viser opptil 200 og sier ifra om resten) og **proveniens på styringsjournalen** (hvem/hvilken kanal/hvilken jobb skrev en beslutning, risiko eller et mål).
Alle tre sentrene LESER bare eksisterende tabeller (ingen nye eksterne kall, ingen skriving); hver knapp bruker en EKSISTERENDE rute med uendret step-up, policy og revisjon.

**Status (ærlige ord, ingenting er VERIFIED før du har kjørt NAS-stegene under):**
- Finans-, Minne- og Agent-sentret: **WIRED bak flagg, DORMANT som standard** (AV til du slår dem på). Testet mot embedded Postgres som app-rollen (RLS) og mot sidens ekte script; **NOT VERIFIED** mot NAS/ekte data.
- Proveniens på styringsjournalen: kolonner finnes alltid (migrasjon 102), skriving er **DORMANT** (AV som standard). Endringer ETTER opprettelse får ikke egen proveniens (**PARTIAL**, se under).
- Mutasjoner herfra: kun nødbryteren for finans og «avbryt jobb» (begge eksisterende). Alt annet er **DEFERRED** og står som tilstand uten knapp.

## Åpne
`https://<api-vert>/control` fra en innrullert enhet - samme side som H0. **Siden er datadrevet og er ikke endret:** hvert senter oversikten lister vises automatisk, og et senter uten flagg står fortsatt under «Ikke koblet inn».
I chat (kun web-chat fra en signert enhetsøkt - aldri tale eller Telegram): «vis finanssenteret» / «vis minnesenteret» / «vis agentsenteret» (`executive.get_finance_center` / `get_memory_center` / `get_agent_center`, klasse A, kun lesing).
Hver seksjon viser **kilde** (tabell) og **når den ble målt**; «Hvorfor …?» forklarer deterministisk. **Ukjent er aldri «i orden»:** det som ikke kan måles står som «ikke målt», og en kilde som svikter gir ukjent kun for SIN seksjon.

## Flagg (alle AV som standard; KUN den eksakte verdien `on` slår dem på - `true`/`1`/`ON` gir AV)
| Flagg | Slår på | Gjelder |
|---|---|---|
| `JARVIS_CONTROL_CENTER_FINANCE=on` | Finans-sentret (side + `executive.get_finance_center`) | api-prosessen |
| `JARVIS_CONTROL_CENTER_MEMORY=on` | Minne-sentret (side + `executive.get_memory_center`) | api-prosessen |
| `JARVIS_CONTROL_CENTER_AGENT=on` | Agent-sentret (side + `executive.get_agent_center`) | api-prosessen |
| `JARVIS_GOVERNANCE_PROVENANCE=on` | skriv proveniens på NYE styringsjournal-poster (`decision_log`, `scenarios`, `risks`, `goals`, `goal_key_results`) | api-prosessen |

Flaggene settes i `.env` (se `.env.example`) og krever **restart av api** (`docker compose up -d api`). AV = H0-oppførselen er uendret: senteret registreres ikke, står under «Ikke koblet inn», og verktøyet svarer `found: false` («senteret er ikke koblet inn»).
Migrasjon 102 kjøres av vanlig migrering; den er additiv (nullbare kolonner) og endrer ingenting når flagget er AV.

## Sentre
| Senter | Seksjoner | Knapper |
|---|---|---|
| **Finans** | Betalingsintensjoner (per tilstand, inkl. **ukjent utfall** = feil), Forbruk og faste kostnader (utgiftssynk, faste trekk, innkjøp), Avvik (alle 10 avviksflagg-tabellene samlet), Leverandører og kontoer (leverandørobjekter, banksamtykker som utløper), Avstemming (siste kjøring, åpne funn), Finans-nødbryter | **Aktiver/oppheve finans-nødbryter** (samme eksisterende handling og risikoklasse som i Autoritet; PÅ krever ikke step-up, AV krever signert enhet) |
| **Minne** | Kilder, Synk (kunnskapskilder + daglige minnejobber), Minner (per rom/sensitivitet/status), Proveniens (minner), Konflikt og karantene, Sletting og eksport, Styringsjournal (beslutninger, scenarier, risiko, mål, nøkkelresultater med proveniens) | ingen (se DEFERRED) |
| **Agenter** | Workere og kø, Kjørende/ventende/pauset jobber (opptil 200 rader), Leaser, Forsøk på nytt og feilede jobber, Avbrytelser, Artefakter, Nettverksomfang og kodejobb-runner | **Avbryt** per jobb (eksisterende `cancel_task`: klasse B, ingen step-up, kan ikke angres) |

## Regler du kan stole på
- **Kun den suverene eieren, fra en signert enhetsøkt** - nøyaktig som H0. Tale, Telegram, passiv/aktiv økt, en annen person, en delegat, en gjest og en annen tenant nektes av verktøyets port (`control_center_owner_only` / `control_center_requires_signed_device_session`, revideres som `tool.denied`). Porten er fail-closed også hvis kontrollsenter-registeret ikke finnes.
- **Innholdsvern (samme linje som H0):** ingen hemmeligheter, ingen minneinnhold/-emner/kildereferanser, ingen jobbtitler/-resultater/feiltekster/nettverksverter, ingen leverandørnavn/formål/beskrivelser/kontoidentifikatorer. Kun antall, kategorier, tilstander, tidsstempler og interne id-er. `health`-minnerommet leses som ETT antall i en egen lesing og listes aldri.
- **Finansbeløp når ALDRI en modell.** Finansdata er `SECRET_RESTRICTED` (D-378: aldri til sky). Derfor: (1) tekstene i finans-rapporten er beløpsfrie - beløp står kun i måledata (`amount_ore`, øre) som siden viser deg; (2) når en modell betjener et kall (`servingModel` satt) fjernes alle `*_ore`-fakta før svaret bygges
  (`stripMoneyFacts`); (3) `executive.get_finance_center` er låst lokalt i turn-konteksten (samme mekanisme som øvrige begrensede verktøy), og står som `restricted` i verktøymanifestet. Hentes finans-rapporten via `executive.get_control_center`, fjernes beløpene på samme måte.
- **Hvert tall har kilde.** Seksjoner uten målbar kilde står som UKJENT; samlet status er den verste av seksjonene (FAIL > ADVARSEL > UKJENT > OK). Ubetrodd innhold i autoritativt minne (CLAUDE.md regel 7) er **FAIL**, ikke en advarsel.
- **Under kill switch** nekter policyen all lesing av kontrollsentrene (som H0); siden viser gjenopprettingsvisningen.
- **Rate limit:** hvert per-senter-verktøy har 30 kall/min per tenant. Siden bruker `get_control_center` (1 + antall sentre kall per oppdatering), som er hevet fra 30 til **120/min** per tenant for å gi plass til de tre nye sentrene - se Kjente begrensninger.

## Finans: hva «ukjent» betyr her
- En betalingsintensjon som er sendt uten kjent utfall (`submit_outcome_unknown`) er **FEIL** og telles alltid - den er ikke «ventende».
- Avstemmingen er **ikke målt** hvis det ikke finnes noen kjøring; **advarsel** hvis siste kjøring er eldre enn 48 t eller står som «running» i mer enn 30 min; åpne funn teller per type.
- Banksamtykker som utløper innen 14 døgn gir advarsel (maks 20 vises).
- Utgiftssynken er **ikke målt** hvis ingen synk-markør finnes; advarsel hvis eldre enn 48 t.

## Minne: proveniens (JARVIS-087 del 2)
- Migrasjon 102 legger til `prov_channel`, `prov_session_id`, `prov_task_id`, `prov_origin`, `prov_recorded_at` på de fem styringstabellene (alt-eller-ingenting-CHECK; `prov_origin` er `owner_direct`, `model` eller `unspecified`).
- Opphavet utledes KUN fra den betrodde kontekstens egne felter (modellkjøring > eier-direkte > uspesifisert); aldri fra parametere en modell kan sende. Dashbord-ruten (`/governance/mutate`) attesterer `owner_direct` (se «Dekker ikke»).
- **Eldre rader bakdateres aldri:** de står som «ikke registrert». Senteret gir **advarsel** så lenge ingen rad har proveniens (flagget er AV eller ingenting er skrevet ennå) - aldri «i orden» på manglende data.
- **Dekker ikke (PARTIAL):** hvem som ENDRET en post etter opprettelsen får ikke egne kolonner; det ligger kun i `audit_events`. `contentOrigin: "owner_direct"` settes av `/governance/mutate`-ruten selv (eier-autentisert dashbord), ikke av den raske chat-banen - det avviker fra D-449-kommentaren om at kun `main.ts` setter den (flagges for uavhengig review).

## Kjente begrensninger (DEFERRED/PARTIAL - ikke stille utelatt)
- **Finans:** manuell disposisjon av en intensjon med ukjent utfall er ikke bygget (WP-F1) - du avstemmer i leverandørens portal; avstemmingskjøring på forespørsel herfra er **DEFERRED** (kjøres av den planlagte `finance-reconcile-sweep`).
- **Minne:** godkjenn/avvis av karantene-forslag skjer i dashbordets eksisterende rute (ikke herfra); **sletting (ErasureService) og eksport (MemoryExporter) har ingen app-rute** (JARVIS-060) og ingen sporbar eksportlogg - eksport står som **ikke målt**. Ingen nye mutasjoner er oppfunnet.
- **Agenter:** det finnes **ingen worker-hjerteslag**. En worker er kun «bevist i live» av en claim siste 24 t eller en kjørende jobb med fornyet lease; en ledig worker kan ikke skilles fra en stoppet og står som **ikke målt**. Jobb-runneren på verten (WP-C1) kalles ikke herfra - dens helse utledes av kodejobbenes `host_job_runner_error:`-feil.
  Faktisk nettverksisolasjon (container/egress) måles av `ops/job-runner/acceptance.sh` på verten, ikke her (**DEFERRED**). Maks 200 aktive jobber vises som rader; resten telles og sies ifra om.
- Modellen får aldri beløp, jobbtitler eller minneinnhold - men du ser dem heller ikke her (jobbtittel står i chatten, `/chat/jobs`).
- `get_control_center` har 120 kall/min per tenant (var 30); hver sideoppdatering gjør 1 + 6 kall med alle sentrene på. Legges flere sentre til (H2), må grensen vurderes på nytt eller kallene samles.

## Verifiser på NAS (NOT VERIFIED - ikke kjørt mot ekte data/NAS ennå)
1. I `.env`: `JARVIS_CONTROL_CENTER_FINANCE=on`, `JARVIS_CONTROL_CENTER_MEMORY=on`, `JARVIS_CONTROL_CENTER_AGENT=on`, `JARVIS_GOVERNANCE_PROVENANCE=on`. `docker compose up -d api`. Kontroller at migrasjon 102 er kjørt:
   `SELECT column_name FROM information_schema.columns WHERE table_name = 'decision_log' AND column_name LIKE 'prov_%' ORDER BY 1;` (forvent 5 rader).
2. Åpne `/control` fra en innrullert enhet: Finans, Minne og Agenter er flis i oversikten og står IKKE lenger under «Ikke koblet inn». Hver seksjon har kilde og tidspunkt; det som ikke er målbart står som «ikke målt».
3. Chat: «vis finanssenteret» → forvent summary/explanation uten kronebeløp. Åpne samme senter på siden → beløp i måledata (`amount_ore`). Gjenta fra Telegram eller tale → forvent nekt (`control_center_requires_signed_device_session`/verktøyet ikke tilgjengelig).
4. Opprett en beslutning i dashbordet (styringsjournalen). Forvent i Minne → Styringsjournal at posten har proveniens, og i databasen:
   `SELECT prov_channel, prov_origin, prov_recorded_at FROM decision_log ORDER BY created_at DESC LIMIT 1;` (forvent `prov_origin = owner_direct`). Eldre rader skal fortsatt ha NULL (vises som «ikke registrert»).
5. Start en bakgrunnsjobb («… i bakgrunnen»). Agenter → «Kjørende, ventende og pauset jobber» viser jobben (uten tittel); trykk «Avbryt» → forvent `task.cancelled` i `audit_events` og status `cancelled`/`cancel_requested`.
6. Finans → «Aktiver finans-nødbryter» → forvent samme tilstand i Autoritet-sentret; «Opphev» krever signert enhet.
7. **Rollback:** sett flaggene til `off` (eller fjern dem), `docker compose up -d api` → sentrene står under «Ikke koblet inn» igjen, `/control` for H0-sentrene er uendret, og migrasjon 102-kolonnene blir liggende (nullbare, ubrukte).

## Utvikler: legg til et senter
1. `apps/api/src/control-center/<id>.ts`: `ControlCenterDefinition` (kun lesing; `controlSection`/`controlItem`/`controlAction` fra `@jarvis/executive`; data via `tenantRead`/`tenantSpaceRead`/`settle` fra `shared.ts`).
2. `register.ts`: ett flagg i `CONTROL_CENTER_FLAGS` og én linje i `registerControlCenters()` (`flagOn` krever eksakt `on`).
3. Verktøy: en rad i `CONTROL_CENTER_READ_TOOLS` (`modules/executive/src/control-center/tools.ts`) - transporten og enumerasjonstestene leser tabellen. Speil i `modules/tool-gateway`: `chat-read-tier.ts`, `tool-manifest.ts` (effekt `read`, sensitivitet), `VOICE_EXCLUDED_KEYS`, og et smalt intent i `turn-context.ts` (executive-familien overstyres ellers av `max_tools_per_round`). Er dataen finansiell: legg verktøyet i `RESTRICTED_TOOL_KEYS` og sentret i `MONEY_REDACTED_CENTERS`.
4. Tester: flagg AV, ikke-eier nektet, tenant-isolasjon, redigering, «ikke målt», DB-støttet som app-rolle (`apps/api/test/support/h0-db.ts`), og at siden viser sentret uten endring (`wph1-control-page.test.ts`).
