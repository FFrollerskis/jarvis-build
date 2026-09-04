# PROJECT STATUS

**Oppdatert:** 2026-09-04 (branch `claude/ua7-cross-channel-commitments`, base
`main=ce326f51e43fde5c874ef97855d648a3f63dd6d0`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser, ikke her.

## Aktiv fase/oppgave

**D-121 - UA-7 Communications Hub, ANDRE slice: tverr-kanal-forpliktelser og neste handlinger.**
Derivert, ikke fritt valgt: en styrt gap-audit av faktisk `main` mot masterplanens fire
UA-7-akseptansekriterier viste at kriterium 1 («Open commitments **and next actions** visible
**across channels**») var det ENESTE gjenstående, leverandør-uavhengige kriteriet - alt annet
(Slack/Teams/WhatsApp/Messenger/Discord/SMS/SIP, autonom utsending, møtetranskripsjon) krever nye
credentials/scopes og er D-108-sperret. Full audit-matrise: IMPLEMENTATION_PLAN.md, seksjon
«UA-7 ... Andre slice (D-121)». Full begrunnelse: D-121 i DECISIONS_AND_ASSUMPTIONS.md.

## Hva som faktisk ble bygget

**NULL nye tabeller, NULL nye migrasjoner, NULL nye leverandører, NULL nye credentials/scopes.**
Sliceen er en lese-/aggregeringsvisning over de to EKSISTERENDE systems-of-record
(`business_followups` + `business_open_loops`), forankret på Conversation Graph-identiteten i
stedet for på ÉN CRM-kontakt.

1. **`crossChannelCommitmentView()`** - union av eksplisitte oppfølginger OG deterministisk
   detekterte neste handlinger for den EFFEKTIVE identiteten, med kilde (`source_kind`), uendret
   proveniens (`explicit`/`deterministic`/`ai_assisted`), delt prioritets-bucket,
   `canonical_uri`-peker og de AKTIVE kanalene motparten faktisk er nåbar på. Skiller eksplisitt
   mellom `resolved` / `no_linked_contact` / `identity_not_found` - en tom liste er aldri tvetydig.
2. **`crossChannelAttention()`** - tenant-bred «hva er åpent på tvers av kanaler nå», deterministisk
   sortert på forfall (fristløse sist). Forpliktelser som INGEN kanal når rapporteres EKSPLISITT
   (`channel_reachable=false`), aldri stille utelatt. Kanal-rekkevidden aggregeres over **ALLE**
   aktive identiteter lenket til kontakten (se «Arkitekt-review-fiks» under).
3. **KORREKTHETSFIKS:** `linkedContactId()` følger nå merge-kjeden. Før dette ga et oppslag på en
   tombstonet (`status='merged'`) identitet kildens historiske (ofte `NULL`) kontakt i stedet for
   målets - altså nøyaktig det tverr-kanal-bildet merge-en finnes for å skape. Gjelder også
   `crossChannelCommitments()` og `identityTimeline()`. Split-reversibilitet er bevart og testet.
4. **Delt prioriteringsregel:** `classifyAttentionBucket()` trukket ut av
   `OpenLoopService.attentionQueue()` og gjenbrukt begge steder - ÉN kanonisk regel, aldri to
   nesten-like prioriteringsmodeller.

## Arkitekt-review-fiks på PR #70 (ingen ny D-ID, ingen ny slice)

Uavhengig ChatGPT-arkitekt-review fant at `crossChannelAttention()` ikke var sannferdig «på tvers av
kanaler» når ÉN forretningskontakt har FLERE aktive Conversation Graph-identiteter. Første
implementasjon beholdt kun den ELDSTE aktive identiteten per `linked_business_contact_id` og leste
kanaler kun fra den. `046_conversation_graph.sql:94` har KUN en ikke-unik indeks på
`(tenant_id, linked_business_contact_id)` - flere aktive identiteter kan derfor lovlig peke på samme
kanoniske kontakt (to uavhengig opprettede kanal-identiteter lenket til kontakten uten en eksplisitt
`mergeIdentities()`; tilstanden oppstår gjennom det ORDINÆRE API-et). Konsekvensen var reell og
todelt: aktive kanaler på en senere identitet ble **stille utelatt**, og en kontakt hvis eldste
identitet kun hadde REVOKERTE lenker ble rapportert `channel_reachable=false` selv om en annen aktiv
identitet var fullt nåbar - altså et **FALSKT «vi når ikke denne»**.

**Rettet:** rekkevidden aggregeres nå over ALLE aktive identiteter for kontakten. Returformen bytter
det ene, vilkårlige `identity_id`/`display_name`-paret med `identities[]` (`AttentionIdentityReach`)
slik at hver kanal fortsatt attribueres EKSAKT til identiteten som eier lenken - unionen merkes
ALDRI som om den tilhørte én vilkårlig valgt identitet. Ingen identitet og ingen kanal droppes: en
identitet uten aktive kanaler blir stående med tom `channels` («identiteten finnes, men nås ikke» er
selv et faktum). Unionen kan ikke inneholde duplikater fordi
`conversation_channel_links_active_unique_idx` (046:124-126) er unik på
`(tenant_id, channel, channel_identifier) WHERE status='active'`. RLS, read-only-semantikk,
deterministisk ordning, proveniens per kanal og merge/split-mekanikken er UENDRET.

**To nye embedded Postgres-regresjoner** (`service.test.ts`): **AQ** - to aktive identiteter mot
samme kontakt med ulike aktive kanaler → resultatet inneholder BEGGE, korrekt attribuert; **AR** -
eldste identitet har kun en revokert lenke mens en senere identitet er nåbar → `channel_reachable`
er `true`, unionen inneholder den nåbare kanalen, og den revokerte dukker ALDRI opp.

## Autoritet/sikkerhet (D-119-herdingen utvidet, aldri svekket)

`conversation_graph.*` går fra 6 til **8 handlinger, ALLE fortsatt klasse A - namespacet forblir
READ-ONLY**. Begge nye `input_schema`-er er `.strict()` uten `tenant_id`/`memory_space` **og uten
`now`** (en kaller som kunne styre «nå» kunne styre prioritets-bucket). `tenantId`/`memorySpace`
hentes UTELUKKENDE fra `context.identity` (D-68), fail-closed uten den. En adversariell test sender
en prompt-injeksjon som eksplisitt ber om en urelatert privat kontakts forpliktelser og oppgir
kontaktens ID i brødteksten - angriper-identiteten ender med `no_linked_contact`, tom liste og null
lekkasje.

## Kvalitetsporter

- `pnpm -r typecheck`: 21/21 pakker rent.
- `pnpm lint` (`eslint .`): rent.
- `modules/conversation-graph/test/*.test.ts`: **74/74 grønt** (60 service + 14 security, opp fra
  51) mot ekte embedded Postgres/RLS - inkl. de to nye review-regresjonene AQ/AR.
- Lokal full workspace-suite (Windows): **2900/2934 grønt**, 34 feil i 6 filer. Disse er
  **pre-eksisterende og host-spesifikke**, bevist ved en kontrollert A/B-kjøring: NØYAKTIG samme
  filer/tester feiler med og uten denne sliceens endringer stashet (isolert kjøring av de samme
  filene: 31 feil i 5 filer i BEGGE retninger; de resterende 3 er lastavhengig ustabilitet under
  full parallell kjøring, ingen av dem i `conversation-graph`):
  `apps/api/test/worker-coding-wiring.test.ts`,
  `modules/agreements/test/service-rls.test.ts`,
  `modules/business/test/ua3-live-pool-separation.test.ts`,
  `modules/business/test/ua3-open-loops-cost-cleanup.test.ts`,
  `modules/tasks/test/claude-code-agent.test.ts`,
  `modules/tasks/test/sandbox-docker-extra-env.test.ts`,
  `modules/tool-gateway/test/docker-transport.test.ts` (Windows-prosessoppstart `EFTYPE`/`ENOENT`
  mot fake `.cjs`-binærer, kildetekst-assertions, og WIN1252-begrensningen under). Alle passerer i
  CI på Linux.
- gitleaks: egen CI-jobb over hele historikken - **IKKE kjørt lokalt** denne økten (binæren finnes
  ikke på denne hosten).
- **CI på eksakt endelig HEAD:** denne filen navngir BEVISST ingen run-id for den endelige HEAD-en.
  Enhver commit som skriver run-id-en hit endrer selv HEAD og gjør påstanden umiddelbart usann -
  derfor rapporteres run-id + jobbstatus for eksakt endelig HEAD i `CLAUDE_REPORT` på GitHub-issue
  **#68**, som postes FØRST etter at kjøringen faktisk er ferdig og ikke er del av treet. Forrige
  registrerte grønne kjøringer i denne sliceen: run `33831046020` på HEAD
  `ca1d19b7974d73bda7ffbff5935dab3b590cb24b` og run `33830570796`/`33830506706` på HEAD
  `daf231c89d4c36854d9c79216a61bad8cb9f00f6` (**182/182 filer, 2932/2932 tester**, alle tre jobber
  `build-test`/`windows-git-auth`/`gitleaks` `success`). Begge er per definisjon foreldet av
  review-fiks-commiten over.

## Kjent, pre-eksisterende miljøbegrensning (IKKE innført av denne sliceen)

`040_stripe.sql:55` inneholder ett mojibake-tegn (`Ē`, U+0112) i en KOMMENTAR. Uskadelig på
UTF8-databaser (Linux-CI), men gjør at HELE den eksisterende embedded-Postgres-suiten feiler lokalt
på en Windows-host der klyngen initialiseres som WIN1252 - **bevist på et HELT RENT `main`-tre**.
Lokal kjøring krevde også denne økten en MIDLERTIDIG, IKKE-COMMITTET ett-tegns endring som ble
reversert før commit (den er IKKE del av diffen; verifisert med `git status` etterpå). Bør rettes
som en egen, liten oppgave - arkitekten har eksplisitt instruert at den IKKE skal smugles inn i
denne PR-en.

## Flagg-status

`UA7_CROSS_CHANNEL_COMMITMENTS_IMPLEMENTATION_COMPLETE=true`,
`UA7_CONVERSATION_GRAPH_NAMESPACE_READ_ONLY=true` (8 handlinger, alle klasse A),
`UA7_NEW_TABLES_ADDED=0`, `UA7_NEW_PROVIDERS_ADDED=0`, `HOST_ACCEPTANCE_REQUIRED=false` (ren
TypeScript/ToolGateway/PolicyGateway/Postgres/RLS - ingen Windows-/Docker-/enhets-/live-leverandør-
avhengighet innført). UA-7-akseptansekriterier: **1 PASS** (for identiteter med lenket kontakt, nå
med neste handlinger + merge-korrekt oppslag + observerbar kanal-nåbarhet) / PARTIAL for UA-7 som
helhet så lenge kanalene selv er D-108-sperret, **2 PASS** (Gmail-stien, nå også bevist for
forpliktelses-visningen), **3 PASS** (uendret fra D-119), **4 NOT_STARTED**. Uendret:
`UA7_COMPLETE=false`, `UA7_MEETING_TRANSCRIPTION=DEFERRED_WITHIN_PHASE`, `D108_COMPLETE=false`,
`UA6_LIVE_PROVIDER_VERIFICATION_COMPLETE=false`, `UA6_COMPLETE=false`.

## PR-status

Draft-PR **#70** på branch `claude/ua7-cross-channel-commitments`. **IKKE merget, IKKE
self-approved.** Arkitekt-review-funn 1 og 2 er rettet (se avsnittene over). Fersk CI på eksakt
endelig HEAD kjøres etter push og rapporteres med run-id og jobbstatus i `CLAUDE_REPORT` på issue
#68 - ikke i denne filen (se Kvalitetsporter for hvorfor). Venter på ny uavhengig
ChatGPT-arkitekt-review (D-120).

## Blokkeringer

Ingen tekniske. `HARD_EXTERNAL_BLOCKER=false`.

## Neste oppgave

Avventer arkitekt-review. INGEN merge, INGEN neste UA-7-slice, INGEN D-108, INGEN UA-8 startet av
denne runden. Naturlige kandidater etter review: (a) egen liten oppgave for
`040_stripe.sql`-mojibake, (b) UA-7 kriterium 4 / nye kanaler når D-108 faktisk forfaller.
