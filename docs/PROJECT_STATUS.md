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
   (`channel_reachable=false`), aldri stille utelatt.
3. **KORREKTHETSFIKS:** `linkedContactId()` følger nå merge-kjeden. Før dette ga et oppslag på en
   tombstonet (`status='merged'`) identitet kildens historiske (ofte `NULL`) kontakt i stedet for
   målets - altså nøyaktig det tverr-kanal-bildet merge-en finnes for å skape. Gjelder også
   `crossChannelCommitments()` og `identityTimeline()`. Split-reversibilitet er bevart og testet.
4. **Delt prioriteringsregel:** `classifyAttentionBucket()` trukket ut av
   `OpenLoopService.attentionQueue()` og gjenbrukt begge steder - ÉN kanonisk regel, aldri to
   nesten-like prioriteringsmodeller.

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
- `modules/conversation-graph/test/*.test.ts`: **72/72 grønt** (58 service + 14 security, opp fra
  51) mot ekte embedded Postgres/RLS.
- Full workspace-suite: se PR-beskrivelsen/CI for eksakte tall på endelig HEAD.
- gitleaks: kjøres autoritativt i CI (egen jobb, hele historikken) - IKKE kjørt lokalt denne økten
  (binæren finnes ikke på denne hosten).

## Kjent, pre-eksisterende miljøbegrensning (IKKE innført av denne sliceen)

`040_stripe.sql:55` inneholder ett mojibake-tegn (`Ē`, U+0112) i en KOMMENTAR. Uskadelig på
UTF8-databaser (Linux-CI), men gjør at HELE den eksisterende embedded-Postgres-suiten feiler lokalt
på en Windows-host der klyngen initialiseres som WIN1252 - **bevist på et HELT RENT `main`-tre**.
Lokal kjøring denne økten krevde en MIDLERTIDIG, IKKE-COMMITTET ett-tegns endring som ble reversert
før commit (den er IKKE del av diffen). Bør rettes som en egen, liten oppgave - ikke smugles inn i
en UA-7-slice.

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

Draft-PR på branch `claude/ua7-cross-channel-commitments`. **IKKE merget, IKKE self-approved.**
Venter på fersk CI på eksakt endelig HEAD, deretter uavhengig ChatGPT-arkitekt-review (D-120).

## Blokkeringer

Ingen tekniske. `HARD_EXTERNAL_BLOCKER=false`.

## Neste oppgave

Avventer arkitekt-review. INGEN merge, INGEN neste UA-7-slice, INGEN D-108, INGEN UA-8 startet av
denne runden. Naturlige kandidater etter review: (a) egen liten oppgave for
`040_stripe.sql`-mojibake, (b) UA-7 kriterium 4 / nye kanaler når D-108 faktisk forfaller.
