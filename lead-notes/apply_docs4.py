import re
ROOT = "/home/user/jarvisbuild/.claude/worktrees/docs2/"

D463 = (
    "| D-463 | **WP-G1: UA-7 COMMUNICATIONS HUB - RESTEN (KANALER, KONTAKTER, MØTETRANSKRIPSJON, UTGÅENDE REGLER OG AI-RINGING, PUSH-OPPFØLGING) (mandat: D-450, D-470)** "
    "(branch `claude/wp-g1-comms`; migrasjon 117-119; to uavhengige gjennomganger, to fiks-runder og tre delta-re-reviewer; siste verdict MERGE (dvalende)) | "
    "**Besluttet.** WP-G1 leverer resten av UA-7 som hvilende, flagg-styrt kode (`JARVIS_COMMS_*`, alle AV) og `NOT VERIFIED`. Conversation Graph dekker alle UA-7-kanaler (slack, discord, whatsapp, sms, teams, messenger, instagram, phone; migrasjon 117; E.164 eksakt-treff; merge/split og confidence uendret). "
    "En felles deterministisk utgående policy (`modules/comms`) står foran hver NY `comms.*`-utsendelse (de eldre `twilio`, `telnyx`, `whatsapp`, `slack` og `discord` `notify`-verktøyene omgår den, `DEFERRED`): konto-allowlist, mottakervalidering, stille timer, rate-limit, plattformvinduer, AI-opplysning lagt til i kode, markedsføring feiler lukket "
    "(Reservasjonsregisteret og samtykkeregister er `BLOCKED_EXTERNAL`), forhøyet revisjonsjournal (hash og lengde, aldri teksten), og utsendelse er klasse D `outbound_message` med forespørselsbundet og handlings-/tenant-skopet idempotensnøkkel (brukernøkkel maks 160 tegn), `outcome_unknown` via den delte `afterAcceptedMutation`-hjelperen og atomiske ratetak "
    "(per mottaker tenant-bredt på tvers av rom). Første kontakt med en kald mottaker (ingen innkommende siste 7 døgn og ingen eksakt eller eier-konfigurert lenke med confidence 0,9 eller mer; kontaktbok-lenker teller ikke) krever eierens erklærte `purpose_basis` (fem lukkede verdier, journalført; lovens påvisbarhetskrav i markedsføringsloven § 15, ikke en kunstig godkjenningssperre). "
    "Mottakerens avmelding (STOP) er tenant-bred per normalisert identifikator (telefon deles av sms, whatsapp og samtale), lagres per kanal og kilde, START løfter kun samme kanal og aldri en eierregistrert avmelding, og en STOP droppes ikke stille bortsett fra ekstremtilfellene i runbook §5 (Meta-tak på 100 hendelser per forespørsel, meldings-id over 1000 tegn, Twilio-SID over 64 tegn). "
    "Signerte innkommende webhooks (Slack, Meta, Twilio, Telnyx; rå bytes med 256 KB-tak før signatur, replay-vern, idempotent inntak, per-IP-grense på normalisert sti) lagres som ubetrodd data (regel 7), og rutene finnes kun med flagget på. Eier-eksklusive `comms.*`-verktøy (35 handlinger, ingen på modellflate) og ruter `/comms/preview` og `/comms/action` (grant, suveren eier, step-up, gateway). "
    "Også bygget: leverandørlesinger og utvidede handlinger for Slack, Discord, WhatsApp, Twilio og Telnyx; Google Contacts (les, opprett, endre, slett som klasse D; lenking aldri på en annen kontakts identitet, atomisk bak lås, reversibel `contacts_unlink` og `restore`); Teams (kun delegert), Messenger og Instagram (kun RESPONSE); "
    "møtetranskripsjon-pipeline (rettsgrunnlag attestert av eier med DB-CHECK, transkripsjonsteksten lagres aldri, forpliktelser er forslag, utdrag innrammet som ubetrodd sitat; ingen møte-bot); rammeverk for utgående AI-ringing på Twilio (opplysning leses først, aldri opptak, tidsvindu og per-nummer-grense; kun mot falsk transport) og et svar-oppfølgingssveip som gjenbruker V2-push. "
    "Jarvis eier modellen, policyen og journalen (`JARVIS_CANONICAL`); leverandørene er adaptere og ingen ble kjerne (`CORE_DEPENDENCY_DECISION_REQUIRED=false`). `DEFERRED`: autonom Jarvis-initiert utsendelse, eldre notify-verktøy under policy, taleadapter og lydinngang, opplastingsrute for store transkripter, fulle connector-manifester, Telnyx-kall. "
    "`BLOCKED_EXTERNAL`: Meta app review, Teams delegert samtykke, Google Contacts re-samtykke, Twilio/Telnyx-numre, Reservasjonsregisteret og samtykkeregister (JARVIS-084), APNs, juridisk gjennomgang av DPIA §10 (utkast). "
    "Åpent som MÅ rettes før `JARVIS_COMMS_OUTBOUND` slås på: samme nøkkel med ulik nyttelast for ikke-journalførte handlinger (`record_opt_out`, `authorize_account`) gir ok uten effekt (JARVIS-112). Øvrige oppfølginger: JARVIS-112; eierspørsmål Q-72. "
    "Test: full suite 14555 av 14561 grønne etter første fiks-runde (6 røde: fem kjente sandkasse-feil og en flake i `incidents/repair`); målrettet og vaktbatch grønne etter andre runde og delta2-reviewene. Runbook `docs/runbooks/WPG1_COMMS.md`, DPIA `docs/UA7_COMMUNICATIONS_DPIA.md` §10. |"
)

Q72 = (
    "| Q-72 | **WP-G1 (D-463): valg for eieren.** (1) Tillate autonom Jarvis-initiert utsendelse? *Anbefaling:* nei foreløpig; behold eier-ruten til NAS-verifiseringen er gjort (krever D-beslutning om systemidentitet). "
    "(2) Beholde Telnyx-kall? *Anbefaling:* dropp (AI-opplysningen kan ikke garanteres først uten `call.answered`-flyten). (3) Markedsføring, samtykkeregister og Reservasjonsregisteret (JARVIS-084, Q-47f)? *Anbefaling:* behold feil-lukket; krever jurist. "
    "(4) Møte-bot? *Anbefaling:* nei; bruk transkript-eksport og tekstinntak (en møte-bot ville utløst D-64-porten). (5) Binde lokal Whisper-adapter og bygge en eier-opplastingsrute for lyd og store transkripter? *Anbefaling:* ja, via voice-gateway-prosessen og kun lokalt. "
    "(6) Fulle connector-manifester og dashbord-registrering for `comms.*`? *Anbefaling:* oppfølger-WP med `new-connector.mjs`. (7) Bekrefte standardgrensene (stille timer 22-08, 3 meldinger per mottaker per døgn og 1 kald, 30 per konto per time, ringevindu 09-20 med 1 kall per nummer per døgn)? *Anbefaling:* jurist-sjekk før live bruk. "
    "(8) `purpose_basis`: er de fem verdiene riktig liste, og holder en eier-erklæring som påvisbarhet? *Anbefaling:* behold feil-lukket og la en jurist gå gjennom listen mot markedsføringsloven § 15 før noe flagg slås på. "
    "(9) START: skal START på én kanal løfte hele navnerommet (SMS-START åpner WhatsApp)? *Anbefaling:* nei (dagens regel: kun samme kanal; en eierregistrert STOP kan aldri løftes av mottaker; en mottaker som har stoppet på både SMS og WhatsApp må sende START på begge). "
    "(10) Angre en feilregistrert STOP: ingen vei finnes. *Anbefaling:* tillat angring kun av `owner_recorded`-rader, med step-up, begrunnelse og audit, aldri av `recipient_request`; behold `record_opt_out` uten step-up. "
    "(11) Kontakter: lagre konfliktforslag, og la `contact_sync`-lenker ikke telle som relasjonsbevis for første kontakt (i dag regnes en lenket kontakt som kald, så dine egne kontakter trenger `purpose_basis`)? *Anbefaling:* ja til begge i en oppfølger; bekreft at kald-regelen er ønsket. "
    "(12) Eldre `*.notify`-verktøy under policyen (de omgår STOP og tak i dag)? *Anbefaling:* ja, med egen D-beslutning. (13) Én samlemigrasjon for DB-trigger som sjekker `source` ved løfting av eier-STOP, DELETE-grant, rom-CHECK og saltet innholds-hash? *Anbefaling:* ja, i neste integrasjonsvindu. "
    "(14) Verifiser i sandbox: WhatsApp knappsvar-felt og `Polly.Liv` som norsk Twilio-stemme (eller bytt til en dokumentert norsk stemme). | "
    "Åpen. Reist 2026-11-19 av WP-G1-gjennomgangene; ingenting blokkerer merge (alt er DORMANT/AV og `NOT VERIFIED`) |"
)

J112 = (
    "| JARVIS-112 | P2 | WP-G1 åpne oppfølginger: (a) MÅ rettes før `JARVIS_COMMS_OUTBOUND` slås på: samme handling og samme nøkkel med ulik nyttelast gir `ok + deduplicated` uten effekt for ikke-journalførte handlinger (`record_opt_out(K, A)` og så `(K, B)` registrerer ikke B; `authorize_account(K, X)` og så `(K, Y)` autoriserer ikke Y); fiks: nyttelast-fingeravtrykk i den skopede nøkkelen eller `idempotency_key_collision`; "
    "(b) DB-triggeren `comms_recipient_opt_outs_guard` sjekker ikke `source` før en `owner_recorded`-avmelding løftes, DELETE-grant og rom-CHECK mangler, innholds-hashen er usaltet (krever migrasjon); (c) samtidig eller forsinket STOP og START avgjøres av prosesseringsrekkefølge, ikke leverandørtid (Twilio har ingen signert tidsstempel); "
    "(d) en STOP som nr. 120 i én Meta-forespørsel droppes stille (tak 100), og meldings-id over 1000 tegn eller Twilio-SID over 64 tegn forkastes; (e) nøkler på 161-200 tegn gir den misvisende feilen `idempotency_key_required`; (f) kontaktkonflikter lagres ikke som forslag, og eier-angre av en feilregistrert STOP finnes ikke; "
    "(g) ratetak per memory space for kontotak, Europe/Oslo uten helligdager, Slack `fatal_error` er tvetydig, policy-avslag regexes som `auth_failed` i connector-helse (delt kode, eksisterende), eldre notify-verktøy omgår policy; (h) testhull: best-lenke-valg (`funnel.ts` ~:257) | "
    "WP-G1 (D-463) | `OPEN` | `modules/comms/src/{funnel,store,owner-actions,policy}.ts`, `modules/comms/src/webhooks/parsers.ts`, `modules/conversation-graph/src/transport.ts` | `modules/comms/test/**` (stop-slots, key-scope, caps-cross-room, relationship-evidence, inbound-keys), delta2-reviewernes prober i `/tmp/lead` | — | WP-G1 | "
    "Rest: Q-72; (a) er en betingelse for aktivering av utgående sending; dokumentert i `docs/runbooks/WPG1_COMMS.md` §10. |"
)

for name, row, n in (("D463", D463, 3), ("Q72", Q72, 3), ("J112", J112, 10)):
    cells = row.strip().strip("|").split("|")
    assert len(cells) == n, (name, len(cells), [c[:30] for c in cells])

def edit(path, fn):
    p = ROOT + path
    s = open(p, encoding="utf-8").read()
    s2 = fn(s)
    assert s2 != s, path
    open(p, "w", encoding="utf-8").write(s2)

def dec(s):
    lines = s.split("\n")
    assert not any(l.startswith("| D-463 |") for l in lines)
    i = max(i for i, l in enumerate(lines) if l.startswith("| D-462 |"))
    lines[i + 1:i + 1] = [D463]
    return "\n".join(lines)
edit("docs/DECISIONS_AND_ASSUMPTIONS.md", dec)

def oq(s):
    lines = s.split("\n")
    assert not any(l.startswith("| Q-72 |") for l in lines)
    h = next(i for i, l in enumerate(lines) if l.startswith("## Åpne spørsmål – krever Tobias"))
    sep = next(i for i in range(h, len(lines)) if lines[i].startswith("|---"))
    lines[sep + 1:sep + 1] = [Q72]
    return "\n".join(lines)
edit("docs/OPEN_QUESTIONS.md", oq)

def led(s):
    lines = s.split("\n")
    assert not any(l.startswith("| JARVIS-112 |") for l in lines)
    idx = max(i for i, l in enumerate(lines) if l.startswith("| JARVIS-111 |"))
    lines[idx + 1:idx + 1] = [J112]
    return "\n".join(lines).replace("JARVIS-001 … JARVIS-111", "JARVIS-001 … JARVIS-112", 1)
edit("docs/remediation/FINDINGS_LEDGER.md", led)
print("ok")
