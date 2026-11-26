TS: 2026-11-26T14:13:53.100Z
VERDICT: MERGE. 0 HIGH og 1 MEDIUM, som ikke er en regresjon fra P3: samme feil finnes på `main` (probe bekreftet). Fiksen er verifisert og anbefales i samme PR eller rett etter.

Worktree er rent på `cdf7b46a`. Prober, mutantdriver og logger ligger i `/tmp/lead/P3-review-probes/`, fremdrift i `/tmp/pg-home/p3-review-notes/NOTES.md`.

**1. K1–K7 -> status**
- **K1 (106): BEKREFTET.** 400 `GraphMethodException` og 404 på `ads`-kanten gir `truncated`+`ads_unreadable`, og `create_ad` nektes før POST (0 POST). 5xx og OAuth-400 kastes. 99 annonser er ikke avkortet, 100 er det.
- **K2 (107): BEKREFTET** (se 3). Vakten `executor.ts:144` gir 0 nye mutasjoner i de to tilfellene fra N2d.
- **K3 (104): BEKREFTET.** `ticket_id` slår opp på (tenant, id), kaster `support_ticket_not_found` og oppretter aldri. Feil tenant, feil rom og tom id gir kast uten sending. `ticket_id` i verktøyparametre gir `invalid_parameters` i alle fire varianter. Ved 4 samtidige svar med samme nøkkel: 1 sending, 0 skygge-tickets, 1 `agent_reply`.
- **K4 (094): BEKREFTET** med forbehold (funn 3).
- **K5 (054): BEKREFTET.** `idempotency_key` er `message_key`, uavhengig av task/trace. `trace_id` er strengt økende i samme prosess og over midnatt. Kollisjon kun hvis en omstart tikker i samme UTC-sekund som et tikk før omstarten (INFO).
- **K6 (108): PARTIAL som oppgitt.**
  - Fail-lukket ved uendelig strøm av ferske tokens (stopper på 10 sider), alternerende tokens, token på 2049 tegn, `null`-token og 250 innlegg uten token (kuttet til 200).
  - Eksakt 20 innlegg uten token regnes som komplett (bevisst endring, bygger på uverifisert antakelse).
  - Fail-åpen i ett tilfelle (funn 5).
- **K7: BEKREFTET.** Ingen svekkede assertions: eneste fjernede testlinjer er den bevisst endrede N6-GBP-testen og én variabelutskilling i `remediation-2`. Ingen `.skip`/`.only`.

**2. Funn (rangert)**
1. **MEDIUM, forhåndseksisterende** (`executor.ts:137`). Samtidig duplikat med samme nøkkel, der den andre avvises av en port før ledgeren er reservert (varsler ikke klar), gir feil sluttilstand.
   - Leverandøren muteres 1 gang og ledger blir `succeeded`, men journalen ender terminal `failed` (`class_d_notifier_not_ready`).
   - Vinnerens `complete(applied)` kaster `growth_write_journal_terminal_status`, og kommandoen blir ikke markert `executed`.
   - HEAD: 2 av 3 runder (i den tredje var ledgeren allerede reservert). `main`: 2 av 2.
   - **Fiks (verifisert midlertidig):** legg til `|| (begun.row.status === "requested" && prior === null)` i `mayHaveMutated`. Da ble journal `applied` og taperen `UNKNOWN` uten unntak i 3 av 3 runder. Alle 85 chain-tester og mine 35 prober er grønne.
2. **LOW, test-hull i gammel kode.** Mutant K2-12 (fjern `begun.created ||` i pre-call-`collide`, l.133) overlever hele chain-DB-filen. Den er ikke ekvivalent: en ny journalrad med en egen `failed` ledger-rad ville re-armet og utført. Mutant K3-06 (tom `ticket_id`) overlever byggerens test, men er uten praktisk effekt. Min probe dreper den.
3. **LOW, K4** (`server.ts:2535-2559`). `/infra/status` har fortsatt kun `authedRequest`, uten `requireOwner`. Etter K4 ser enhver grant-innehaver alle frosne connector-id-er i det globale registeret (inkl. finans- og `model:`-id-er). Før var det kun `github`. `connector_health` er lazy per prosess, så dette er ny informasjon. Fiks: bare list for `deps.ownerGate(authed.identity)`, ellers `[]` med `readable:false`. Dette er kodelesing, ikke probe. Ingen lekkasje av feiltekst.
4. **LOW, K1** (`meta-ads-write.ts:231`). Kun `list === null` er fail-lukket. HTTP 200 med `{}`, tom kropp, `{data:null}`, `{data:{}}`, `{error:…}` eller `[]` gir `truncated:false`, og `create_ad` sender 1 POST. **Fiks (verifisert):** `const unreadable = list === null || !Array.isArray(list["data"]);`. Alle 68 engine-tester er grønne og de seks formene gir 0 POST. `paging.next` som ikke-streng er ikke dekket av fiksen.
5. **LOW, K6** (`gbp-write.ts:~222`). Side ≥2 som svarer 200 med `[]` eller tom kropp, etter at side 1 hadde token, gir `truncated:false`. Fiks: krev at en fortsettelsesside er et objekt, ellers kuttet.
6. **INFO.**
   - Ticket slettet mellom `getTicket` og `ingestMessage` gir kast etter sending (probe).
   - Ved samtidige svar får taperen en misvisende `internal_note` om at svaret feilet, selv om det ble sendt.
   - En `outcome_unknown`-rad med `failed` eller fraværende ledger kan aldri løses med samme nøkkel (bevisst; ny nøkkel).
   - Retensjonen sletter ferdige ledger-rader etter 30 dager, så vakten gir da UNKNOWN (ønsket).
   - Opptil 200 innlegg à 1500 tegn per tilstand i ledger/audit.
   - Ved nøyaktig 200 innlegg kan readback kutte bort det nye innlegget og gi falsk UNKNOWN.

**3. K2 replay og kappløp (`k2-results.jsonl`, 35 prober)**
- Tabell journal × ledger (4×5), `main`-executor mot HEAD, samme DB og gateway:
  - `main` utfører en andre leverandørmutasjon i `outcome_unknown` × {fraværende, `failed`}.
  - HEAD gir i disse to cellene `UNKNOWN growth_write_replay_ledger_unproven` med `gateway.execute`=0, mutasjoner=0 og journalrad uendret.
  - Alle andre 18 celler er identiske mellom `main` og HEAD.
  - `requested` × {fraværende, `failed`} gir 1 mutasjon begge steder (legitim krasj før gateway).
  - `applied` og `failed` gir 0 mutasjoner.
- 5 samtidige replays av `outcome_unknown` × {`failed`, fraværende, `unverified`, `reserved`, `succeeded`}: 0 mutasjoner, ingen unntak. `requested` × {fraværende, `failed`} og fersk nøkkel gir nøyaktig 1 mutasjon.
- Tenant B med As nøkkel ser ikke As rad (`findByKey`=null), får `FAILED credential_not_bound_to_identity`, As rad er urørt.
- Kommando `pending_execution` heles til `execution_unknown`. `cancelled` og `superseded` er uendret og aldri `executed`.
- Klasse D/step-up/policy: ingen endring i `executor.ts` eller ruten, og ingen leverandørkall når vakten slår til.

**4. Mutanter**
- 59 unike mutanter (62 kjøringer), eksakte tekstbytter mot K1–K6.
- 52 drepte av de nye testene.
- 6 overlevde mot de nye testene:
  - Ekvivalente: K2-03, K2-13, K6-08.
  - K1-07 er en strengere variant (fiksforslaget), ikke en regresjon.
  - K3-06 og K2-12 er testhullene i funn 2.
- K2-19 (fjern hele vakten) ble bare kjørt mot gamle tester, der den overlever.
- Ledger-påstanden i 107(a) er bekreftet: «`reserved` som `failed`» (K2-17), «dropp heling» (K2-18) og «fjern vakt» (K2-19) overlever alle gamle tester (`^(?!.*V4)`). K2-17 og K2-18 er drept av V4.
- Byggerens «51 drepte» er bekreftet i omfang, ikke ordrett: jeg hadde ikke hans liste.

**5. Regresjon, guards og merge-tree**
- `modules/growth` og `modules/support`: 28 filer, 586 tester grønne.
- Guards og apps/api-utvalg (wph1, wph2, tool-manifest, env-drift, d398, d420, wpj, wpc4-*, remediation-2, e1-infra-status, wpd3-*, wpk-*, wpp3-054): 22 filer, 356 tester grønne.
- Hele `apps/api/test`: 229 filer, 3414 tester, exit 0. De kjente sandkassefeilene dukket ikke opp.
- Gitleaks `origin/main..HEAD`: 9 commits, no leaks.
- `git merge-tree --write-tree` mot `origin/claude/wp-g3b-vision-rest` (`ee41c011`): ren. Eneste felles fil er `apps/api/src/server.ts`, med disjunkte hunker. Ingen konflikt i `.gitleaksignore`.

**6. Docs-avvik**
- `docs/runbooks/WPD3_GROWTH_WRITES.md` er foreldet (docs-PR-punkt for lead):
  - l.75 sier «én side på 20» og «paginering DEFERRED (PARTIAL)», men K6 har bygget paginering.
  - l.116 beskriver replay av `outcome_unknown` uten å nevne `growth_write_replay_ledger_unproven`.
- `WPP3_SMALL_FIXES.md` §9: SQL-navnene stemmer (`connector_freeze`, `control_target`). Stegene er reversible og ufarlige. Steg 1 fryser `cloudflare` i prod, så bruk en mindre kritisk connector eller et rolig tidspunkt.
- Ledger-påstandene stemmer med koden:
  - 107(b): UNKNOWN uten sending er tryggere enn `collide()`.
  - 104: `reply()`s egen doc var riktig.
  - 094: `server.ts:2543` er den gamle linjen.
  - 054: `apps/api/src/follow-up-push.ts` er filen som skriver.
- Ledger-status: 107 kan stå som `CODE_FIXED`, men åpne en oppfølger (107c) for funn 1 hvis fiksen ikke tas nå. 106 og 108 bør nevne rest-tilfellene i funn 4 og 5.

**7. Ikke verifisert**
- Leverandørfakta: Googles `pageToken`/`nextPageToken` og «fraværende token = slutt», og om Metas `ads`-kant utelater arkiverte/slettede annonser. Ingen live-kjøring, ingen NAS.
- Funn 3 er kun kodelesing (ingen probe med ikke-eier-grant).
- Jeg kjørte ikke `pnpm -r typecheck`, lint eller containment på nytt (byggeren oppgir OK), heller ikke suiter utenfor growth, support og apps/api.
- Hendelse: `/dev/null` ble erstattet av en tom vanlig fil rundt 13:48 (årsak ukjent, mulig sandkassemiljøet). Det brøt embedded-Postgres-init. Jeg reparerte det med `rm -f /dev/null && mknod -m 666 /dev/null c 1 3`. Det påvirker ikke prosjektkode.
