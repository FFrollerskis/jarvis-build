TS: 2026-11-26T15:30:58.432Z
VERDICT: MERGE ETTER FIKSER. F1 (HIGH) og F2–F9 er lukket eller bevisst redusert, og regresjon og statiske kontroller er grønne. Jeg fant likevel ett usikret søsken av F1 (meldingsflom, MEDIUM), et F5-hull med redirect (LOW) og et par docs-påstander som ikke stemmer. Worktree er ren på `61d40652` (`git status` tom), og ingen restprosesser gjenstår. Prober, mutanter og logger ligger i `/tmp/lead/V2-delta-probes/`, fremdrift i `/tmp/pg-home/v2-delta-notes/NOTES.md`.

## (1) Tidligere funn
- **F1 HIGH: LUKKET.**
  - `p5` med og uten lesende klient: tilkoblingen lukkes etter ca. 32k pings, RSS flat 108 MB, `/health` 200. `p10`: `/health` p50 1 ms, TTS 160 rammer.
  - `d3-pingpong` 12/12: normal klient med 1,7 pings/s og server-ping hvert 150 ms lever. Pong-flom (0 og 125 B) termineres etter 11. Ping 125 B gir ekko. Ping 126 B og fragmentert ping gir 1002. En klient som aldri sender pong termineres. En avvist tilkobling med ping-flom får ingen pong og termineres etter ca. 2,0 s.
  - Se F10 for en sibling-bane som ikke er dekket.
- **F2 MEDIUM: DELVIS** (se F11 under). Statisk utarming er borte: eier kommer inn mot 4 stille ubeviste, og en bevist enhet kastes aldri ut (12 angriperkoblinger rørte den ikke). Fire beviste pluss en femte bevist fra samme peer gir `voice_busy`, som tilsiktet.
- **F3 MEDIUM: LUKKET.** `p4`: lukket etter 40 rammer, RSS flat. Se (4).
- **F4: LUKKET.** `p2` og `p9`: plasser tilbake til 0 og `reserved_for_proven` i `/status`. Mutantene D31–D37 ble alle drept (7/7).
- **F5 LOW: LUKKET med ett hull** (F12 og punkt 3).
- **F6: LUKKET.** 8 av 9 gamle overlevende drept på nytt. M38 er ekvivalent. Se (5).
- **F7: LUKKET.** Mutantene D46–D50 ble alle drept (5/5). En cachet «tilgjengelig» i høyst 5 s gir ved forsvunnet binær spawn-feil, `tts_error` og `/health` 200 i opptil 5 s. Ingen krasj, så det er ufarlig.
- **F8 LOW: LUKKET.** «den 1. mai», «17. mai» og «31. desember» gir én chunk. «14:30», «f.eks.», «kl.», «bl.a.», adresse, e-post, desimaltall og «nr. 5» er uendret. 200 KB-inndata under 80 ms i seks mønstre. Granularitetsinvarians (hel mot tegn-for-tegn mot biter) gir 0 avvik for ny kode og base. `p8` 57/57.
- **F9: LUKKET** for tre av fire punkter. Pre-upgrade er fortsatt DEFERRED og dokumentert.
  - `d5`: en Piper som ignorerer SIGTERM frigir plassen ved 2,0 s uten rester eller zombier. Det gjelder også med et barnebarn som holder pipen. `cancel()` rett etter innvilget plass starter 0 prosesser. En fremmed prosessgruppe overlevde.
  - SIGKILL mot feil prosess (pid-gjenbruk) er bare teoretisk, se INFO under.

## (2) Nye funn
- **F10 MEDIUM, søsken av F1: meldingsflom er ikke dekket.**
  - Sted: `server.ts:834-838` (`rejectFlood`) og `server.ts:870-872`. `rejectFlood` lukker høflig (1008) med 5 s `force`-tidtaker. Under `closing` returnerer ping-handleren tidlig uten bøtte og terminering.
  - Scenario: en klient som ikke svarer på close sender tekstrammer `{}`. `d7-msgflood` mot ekte `main.ts` målte `/health` p50 **138 ms** (baseline 2 ms), maks 192 ms, og en annen økts TTS-strøm på 35 mot 151 rammer per 3 s.
  - Det er samme virkning som opprinnelig F1, men kun latens (RSS ble ikke målt). Kode og docs viser at banen er uendret fra base, men jeg har ikke kjørt den mot base.
  - Fiks: `ws.pause()` i `rejectFlood` og i avvist-stien. Som midlertidig mutant ga det `/health` p50 2 ms og TTS 149 rammer (gjenopprettet). Alternativt terminer med én sending først. Legg til test.
- **F11 LOW, F2-rest: churn kaster ut eierens ventende tilkobling før `markProven`** (`limits.ts:220-243`, `server.ts:514-517`).
  - I kollapset peer (127.0.0.2 med XFF ignorert, topologien er NOT VERIFIED) og med 80 ms Core-authorize fikk eieren 30/30 ved 25 forsøk/s, **6/30 ved 50/s og 0/30 ved 100/s** (`voice_evicted`). Med 20 ms authorize og 200/s: 9/30.
  - Det krever kontinuerlig flom fra samme peer. En eksisterende bevist sesjon påvirkes ikke.
  - Fiks: en «authorizing»-tilstand som ikke kan kastes ut mens Core-kallet pågår, og/eller minimumsalder (f.eks. 2–3 s) før utkasting.
  - Docs «Gjenstår» nevner ikke churn, og «alltid inn» overdriver.
- **F12 LOW (F5): redirect gir feil «ikke sendt».** Begge `fetch`-kallene (`server.ts:110`, `:164`) følger redirect. Ved 307/308 med mål som gir ENOTFOUND eller ECONNREFUSED er `isRequestNotSent` = true selv om serveren mottok hele forespørselen (målt 100 % i begge moduser, chat og stream). Det gir dobbel-ACT bare hvis et redirectende ledd allerede har utført turen. Fiks: `redirect: "error"` i begge kall. Det hindrer også at `grant_token` i kroppen sendes videre til en annen vert.
- **F13 LOW, testhull.** Fire mutanter overlever reelt:
  - D04: `pingOutstanding` aldri nullstilt gjør ubedt pong-flom gratis etter første server-ping.
  - D12: per-peer-utkasting velger en annen peers tilkobling.
  - D62: `releaseWhenGone` uten `signalCode`-vakt gir 5 s forsinket slot og SIGKILL mot død pid.
  - D45: syscall-presedens.
  - Fiks: legg til tester for hver.
- **INFO:**
  - `killProcessGroup` sjekker bare `exitCode`, ikke `signalCode` (ellers pid-gjenbruk, teoretisk).
  - `claimUnproven` kaster ikke ut, så en klient uten bevis får `voice_busy` når to ubeviste holdes. `voice.html` sender alltid bevis.
  - En utløpt grant lar billetten stå som «bevist» til idle eller maksvarighet.
  - Utkastede sockets lever opptil 5 s mot 2 s for avviste.

## (3) F5: kan det gi dobbel-ACT?
**Nei i den direkte topologien. Ja bare via redirect (F12).**
- Fault-injection (`d1-f5-faultinject`) kjørte ekte `HttpCoreClient` mot en rå TCP-stub, 15 moduser, `chat` og `stream`, 2–25 iterasjoner. Invariant: not-sent=true betyr at serveren ikke mottok noe. Ingen brudd utenom redirect.
- Per kode:

| Kode | Utfall |
|---|---|
| ECONNREFUSED og EAFNOSUPPORT (connect), også `localhost` dual-stack AggregateError | ikke sendt (målt) |
| ENOTFOUND | ikke sendt (målt); EAI_AGAIN har samme `syscall` (`getaddrinfo`) |
| ECONNRESET: RST før connect fullføres | ikke sendt (serveren så 0 byte) |
| ECONNRESET: RST etter headers, etter full forespørsel, partial body eller close uten svar | ukjent, claim beholdes (målt) |
| ETIMEDOUT, EHOSTUNREACH, ENETUNREACH med `syscall` connect | ikke sendt (kun resonnert og testet syntetisk, ikke produsert på nett) |
| `UND_ERR_*` uten `syscall` | ukjent |
| 502, 504 (også HTML) fra mellomledd | ukjent (`core_5xx`, 0 av 24 «ikke sendt») |
| keep-alive og deretter nedstengt lytter | ECONNREFUSED, ikke sendt |

- `journal.release` er no-op på «completed», så TTS-feil etter Core-svar kan ikke gjenåpne claimen. Abort, barge-in og frakobling gir `complete`, aldri `release`.

## (4) Tilgjengelighet for legitim bruk (`d4`, `d2`)
- 36 s sammenhengende tale i sanntid: ingen feil, verken med 64 ms- eller 20 ms-rammer (1,1 MiB). 30 s VAD-tur er 960 kB, godt under 2 MiB, så `turn_audio_limit` nås ikke ved normal bruk.
- Nettverksstans med burst: 64 ms-rammer går fint til 12 s, 20 ms-rammer til 4 s. Over det lukkes tilkoblingen med `rate_limited` fra den **gamle** rammebøtta. Den nye byte-bøtta slår aldri først ved vanlige rammestørrelser, så F3 gjør tilgjengeligheten ikke dårligere.
- F2: en bevist enhet slipper alltid inn ved admisjon med mindre peer eller global er full av beviste. Churn er unntaket (F11).

## (5) Mutanter
71 kjørt (`mut/dmut.py`): **egne 62, 56 drept, 6 overlevde** (D04, D12, D30, D45, D59, D62).
- Per gruppe: ping/pong 9/10, tracker og start 9/10, lyd, tur og køer 9/10, slots 7/7, core-errors 7/8, cache 5/5, chunker 7/7, kill og terminering 3/5.
- D04, D12, D45 og D62 er reelle testhull (F13). D30 er nær-ekvivalent (ca. 10 kB preRoll). D59 er forsvarskode (5 s sikkerhetstimer), som byggerens F9f.
- Reviewerens 9 fra runde 1: 8 drept, M38 ekvivalent.

## (6) Regresjon og flak
Som `postgres`, maks 2 arbeidere:
- `apps/voice-gateway/test` uten e2e: 36 filer / 500 tester OK.
- `voice-e2e` 6/6, pluss `apps/api`-statiske tester og alle guards: 24 filer / 196 tester OK. Tallet stemmer med runbook §9.
- `tsc` på voice-gateway, `eslint apps/voice-gateway` og `pnpm check:containment`: exit 0.
- K2, audio-bounds og proven-slots kjørt 10× (67/67 hver gang), mens andre agenters vitest gikk samtidig. Ingen flak. Ping-testen på 100 ms holdt.
- p-serien mot `61d40652`:
  - Grønne: `p1` 33/33, `p7` 3/3, `p8` 57/57, `p9`, `p12`, `p14` 16/16.
  - `p2` C1 og `p3` 1a/1c/2a er tilsiktet endret atferd (utkasting).
  - `p6` 4/6b/7b er probe-artefakter (`p6b` 6/6). `p13` 30/31 er den kjente `AAA=`.
- Gitleaks: kun den kjente falske positiven i `97b8b758`.

## (7) Docs mot kode
- `VOICE_ARCHITECTURE.md` §8 og runbook §2 sier at «meldingsflom» gir «andre økter målbart uberørt». Det er målt bare for ping og er falskt for tekstflom (F10).
- «En bevist enhet kommer alltid inn» (runbook §2/§10, `VOICE_ARCHITECTURE.md` §8) overdriver. Churn er ikke nevnt under «Gjenstår».
- Runbook §5 sier «beviset er `syscall`». Det mangler forbehold om redirect (F12).
- Alle tall i §2-tabellen stemmer med `DEFAULT_VOICE_LIMITS`. Testtallene i §9 stemmer. «Aldri et krasj» er rettet, og `NOT VERIFIED` står aldri som fakta.

## (8) Ikke verifisert
- Faktisk Docker/Tailscale-topologi. F11 er modellert via 127.0.0.2.
- F10 mot base er bare kodelest, ikke kjørt.
- Ekte Piper, Whisper, mikrofon, NAS og skynett.
- Standardtidene (idle 120 s, ping 30 s) i sanntid. Her er korte grenser brukt.
- EHOSTUNREACH, ENETUNREACH, connect-ETIMEDOUT og EAI_AGAIN er ikke produsert på ekte nett.
- Pre-upgrade TCP/HTTP er DEFERRED og ikke målt. Churn-flom og fd-bruk er ikke målt utover det som står her.
