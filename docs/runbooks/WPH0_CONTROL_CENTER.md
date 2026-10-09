# WP-H0 Admin Control Center (UA-11) - slik bruker og verifiserer du det

**Formål:** ÉN flate (`/control`) der du ser og STOPPER det som kjører: connectorer, autoritet/brytere, modellleverandører og agenter.
UA-11-kravet: «eieren kan stoppe/tilbakekalle/rekonfigurere enhver connector, leverandør, agent eller autonomidomene fra ÉN kontrollflate».
Kontrollsentrene LESER bare; hver knapp bruker en EKSISTERENDE rute med uendret step-up, policy og revisjon.

## Åpne
`https://<api-vert>/control` fra en innrullert enhet (samme enhetsinnlogging som dashbordet). Siden er ikke lagt som fane i skallet (`/`) - sett et bokmerke. I chat: «vis kontrollsentrene» (`executive.get_control_center`, kun lesing).
Hver seksjon viser **kilde** (tabell/komponent) og **når den ble målt**; «Hvorfor …?» forklarer deterministisk (ingen modell) hvorfor et senter er advarsel/feil/ukjent.
**Ukjent er aldri «i orden»:** det som ikke kan måles står som «ikke målt».

## Sentre som er koblet inn
| Senter | Viser | Knapper |
|---|---|---|
| Integrasjoner | alle 57 oppføringer i connector-registeret: konfigurert, auth-helse, scopes (de handlingene DEKLARERER - innvilgede scopes måles ikke), synk, API-versjon, vedlikeholdstid, siste feilkategori; pause/tilbakekall-status også for modellleverandører | test, pause/gjenoppta, tilbakekall/gjenopprett |
| Autoritet | eier/delegert autoritet, enheter og grants, autonomi-bindinger, kill switch, finans-nødbryter, infra-modus, pauser, risikoklasser A-D (antall per klasse), policyer og grenser, åpne bekreftelser | kill switch av/på, finans-nødbryter, pause/gjenoppta domene, gjenoppta frosset connector, gjenopprett credential, tilbakekall enhet |
| AI | leverandører (helse, krets, kost), ruting (Gemma først, sensitive turer, D-431/D-449-rutene, dagstak), kost/prognose, evals, delegeringsoverhead, kjørende agenter | **pause/gjenoppta leverandør**, **tilbakekall/gjenopprett nøkkel**, **avbryt agent** |

Ikke koblet inn ennå (står under «Ikke koblet inn», aldri som «i orden»): Finans, Minne, Agent, Drift, Verdi, Personvern, Sikkerhet.
Value Center (WP-C4) er ikke på main; krokpunktet står beskrevet i `apps/api/src/control-center/register.ts`.

## Regler du kan stole på
- **Kun den suverene eieren** (eier-person i eier-tenant, ingen delegasjon) får rapportene. En annen person, en delegat, en gjest og en annen tenant nektes av verktøyets port (`control_center_owner_only`, revideres som `tool.denied`) før noe bygges. Handlingene bruker de eksisterende rutenes egen eier-/step-up-/policy-håndhevelse; `executive.cancel_task` har i tillegg samme eier-port.
- Knappen viser FØR du trykker: risikoklasse A-D, om den krever **signert enhetsøkt** (step-up), og om den kan angres. Klasse D krever at du skriver handlingsnavnet.
- Step-up: stopp-handlinger som PAUSER eller FRYSER (pause domene, frys connector/leverandør, kill switch PÅ, finans-nødbryter PÅ, avbryt jobb, test) krever ikke step-up. Alt annet krever signert enhetsøkt fra nettleser/app (aldri tale/Telegram): gjenoppta, gjenopprett, **tilbakekall av nøkkel og enhet**, oppheve kill switch/nødbryter.
- Rapporten viser aldri hemmeligheter, begrunnelsestekster, jobbtitler/-resultater, meldings- eller minneinnhold - kun antall, kategorier, tidsstempler og kilde.
- **Under kill switch** nekter policyen ALL lesing av kontrollsentrene (de står bevisst ikke på den smale gjenopprettingslisten). Siden viser da en gjenopprettingsvisning med den ene eksisterende handlingen «Opphev kill switch» (signert enhet + skrevet navn) i stedet for en tom flate. Dashbordet (`/dashboard`) viser samme tilstand.

## Pause og tilbakekall av en modellleverandør (JARVIS-087)
- **Pause** = `freeze_connector` på `model:<leverandør>` (f.eks. `model:anthropic`). **Tilbakekall** = `revoke_credential` på leverandørens nøkkel (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`;
  `GEMINI_API_KEY` stopper også `gemma_hosted` som deler den). Verdien slettes aldri. Tilbakekall-knapp finnes for de registrerte leverandørene (anthropic, openai, gemini); pause finnes for alle konfigurerte.
- `ModelGateway` leser dette **live ved hvert modellkall**, i både api og worker - ingen omstart. En pauset leverandør er «ikke konfigurert» overalt: AUTO/QUALITY/…, eksplisitte valg, fallback, critic og AI-råd.
  Oversikter som ikke er et modellkall (`meshStatus`, AI-rådets kandidatliste) bruker siste leste tilstand i prosessen og er oppdatert fra neste modellkall.
- **Sensitivitetsrutingen er uendret:** helse, økonomi og hemmeligheter (SECRET_RESTRICTED) går ALDRI til sky. Pauser du en LOKAL leverandør (`gemma_local`), får slike turer ingen svar før du gjenopptar eller en annen
  lokal modell er brukbar - de faller aldri til sky. Knappen sier dette før du trykker. Vanlige turer faller til en annen leverandør / den lokale modellen (D-354/D-431/D-449).
- Kan pausetilstanden ikke leses ved første kall etter oppstart, nektes modellkallet (fail-closed); senere lesefeil bruker siste kjente tilstand.
- Dekkes IKKE: talemodeller (STT/TTS, `SpeechAdapter`) og minnets embeddings (alltid lokale, D-386) - de er ikke LLM-leverandører i `ModelGateway`. Manuelle live-skript i `*/scripts/` bygger egne gatewayer og følger ikke pausen.

## Avbryt en agent/jobb
`executive.cancel_task` er et gjennomslag til den eksisterende kanselleringsveien (samme som chatens «avbryt jobb <id>»): ikke startet jobb avbrytes med en gang, kjørende jobb stopper ved neste trygge punkt.
Sideeffekter som allerede er utført rulles ikke tilbake, og en avbrutt jobb kan ikke gjenopptas (send den inn på nytt). Kun eieren; pauset jobb kan ikke avbrytes herfra. Nektes under kill switch.

## Kjente begrensninger (DEFERRED/PARTIAL - ikke stille utelatt)
- Golden-suite/modellkvalitet er ikke målt (EV-4 DEFERRED); spesialist-delegering (D-355) er ikke koblet inn i drift; rådgiver-avvik i skygge spores i trace-sinken, ikke i databasen.
- Ikke handlinger her (skjer i chat/dashbord der parametrene vises): lime inn ny nøkkel, tilbakekall av en autonomi-binding (ingen rute), endre infra-modus, godkjenne/avvise åpne bekreftelser.
- Modellhelse og kretser gjelder api-prosessen (workeren har sine egne); tellerne for AI-rådets auto-trigger er prosesslokale og nullstilles ved omstart.
- Hver oppdatering gjør 1 + (antall sentre) kall til `executive.get_control_center`, som har 30 kall/min per tenant: fint for 3 sentre, må økes eller samles når flere kobles inn.

## Verifiser på NAS (NOT VERIFIED - ikke kjørt mot ekte leverandører/NAS ennå)
1. Åpne `/control` → AI → «Pause anthropic» → bekreft. Forvent «Utført». Sjekk: `SELECT control_kind, control_target, actor_person_id, changed_at FROM owner_control_state;` (rad `connector_freeze / model:anthropic`).
2. Send en chat-melding som trenger et verktøy. Forvent svar fra lokal modell og loggen `d431_cloud_tools_failed_fallback_local`; ingen nye Anthropic-rader:
   `SELECT provider, count(*) FROM cost_events WHERE at > now() - interval '10 minutes' GROUP BY provider;`
3. Samme sjekk i worker-loggen for en delegert bakgrunnsjobb (workeren leser samme tilstand).
4. AI → «Gjenoppta anthropic» (krever signert enhet) → neste verktøytur går til Sonnet igjen, uten omstart.
5. Start en bakgrunnsjobb («… i bakgrunnen»), åpne AI → Kjørende agenter → «Avbryt» → forvent `task.cancelled` i `audit_events` og status `cancelled`/`cancel_requested`.
6. Autoritet → «Aktiver kill switch» → skriv `activate_kill_switch` → forvent gjenopprettingsvisningen på siden; «Opphev kill switch» (skriv `deactivate_kill_switch`, signert enhet) → vanlig visning igjen.

## Utvikler: legg til et senter
Lag `apps/api/src/control-center/<id>.ts` (`ControlCenterDefinition`, kun lesing, bruk `controlSection`/`controlItem`/`controlAction` fra `@jarvis/executive`), legg til én linje i `registerControlCenters()` og utvid
`ControlCenterWiring` additivt. Handlinger kan KUN peke på rutene i `CONTROL_ACTION_ENDPOINTS` med navn fra `CONTROL_ACTION_ALLOWED` (låst av test mot rutenes egne allowlister).
