# PROJECT STATUS

**Oppdatert:** 2026-09-03 (branch `claude/ua7-conversation-graph`, base uendret
`main=db0bf1c575ded615b93bca4367681e3f458853da`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser, ikke her.

## Aktiv fase/oppgave

D-119 (UA-7 første slice, Conversation Graph + confidence-basert reversibel
identitetsopploesning) er implementert og lå som draft PR #67. En ekstern uavhengig final-review
FØR merge fant reelle svakheter i selvgjennomgangen - **D-119 SECURITY HARDENING-runde** kjørt og
fullført på SAMME PR #67 (ingen ny D-ID, ingen nytt slice). Full detalj: D-119-addendum i
DECISIONS_AND_ASSUMPTIONS.md.

## D-119 SECURITY HARDENING - seks bekreftede funn, alle rettet

1. **`performed_by`-forfalskning (CONFIRMED):** `ConversationGraphTransport.invoke()` mottok
   aldri den ekte `ToolInvocationContext` (D-68) og stolte råtekst på
   `parameters.performed_by`. Fiks: `merge_identities`/`split_merge` FJERNET fra
   ToolGateway-overflaten (8→7 handlinger); service-metodene forblir en tiltrodd intern API.
2. **tenant/space-spoofing:** revidert - bekreftet et REPO-BREDT, allerede dokumentert D-49-mønster
   (delt av alle transporter), ikke en D-119-spesifikk defekt. Ingen kodeendring, dokumentert
   ærlig.
3. **Confidence-selvforfremming (CONFIRMED):** transporten leste `confidence`/`match_method` råtekst
   fra parametre. Fiks: hardkodet `manual`/`0.5`, fjernet feltene fra ToolGateway sitt
   `input_schema` (strict zod avviser nå ethvert forsøk på å sende dem).
4. **Kryss-tenant-pekere (CONFIRMED, bevist empirisk mot ekte Postgres):** FK-sjekker respekterer
   ikke RLS. Fiks: eksplisitt tenant-eierskapsvalidering av `identity_id`/
   `linked_business_contact_id`/`linked_person_id` i `linkChannelIdentity()`.
5. **Flertrinns merge/split-reversibilitet (CONFIRMED):** `splitMerge()` sjekket ikke om
   `target_identity_id` siden var slått sammen videre. Fiks: `target`-status-sjekk +
   `resolveEffectiveIdentity()`.
6. **Samtidighet (CONFIRMED, begge):** dobbel-split-race og foerste-lenke-orphan-race. Fiks:
   `FOR UPDATE` + unik indeks; Postgres advisory-lås. Pluss deterministisk lock-rekkefølge i
   `mergeIdentities()` for å unngå en unngåelig deadlock (samme gjennomgangsrunde).

Migrasjon `046_conversation_graph.sql` AMENDERT (ikke ny `047`) - aldri kjørt mot en persistent
database, PR #67 fortsatt umerget (§23 i herdingsordren).

## Kvalitetsporter (etter herding)

- `pnpm -r typecheck`: 21/21 pakker rent.
- `pnpm lint` (`eslint .`): rent.
- `modules/conversation-graph/test/*.test.ts`: **48/48 grønt** (39 service + 9 security, opp fra
  33 - +15 nye herding-regresjonstester). Samtidighetstestene (dobbel-split, foerste-lenke-race,
  motsatt-retning-merge) verifisert stabile over 4 uavhengige kjøringer.
- Full workspace-suite: **182/182 filer, 2908/2908 tester grønt** (opp fra 182/2893). Ett
  urelatert pre-eksisterende flakey-funn (`modules/tasks/test/coding-agent-eval-timeout.test.ts`,
  hook-timeout under FULL parallell ressurskonkurranse) - bekreftet IKKE-relatert ved isolert
  kjøring (består konsekvent, ~2.7s) og ved en etterfølgende full ren kjøring som ga 182/182 uten
  unntak.
- gitleaks (hele git-historikken, 277 commits): `no leaks found`.

## Flagg-status

`D119_PREMERGE_HARDENING=PASS`, `PR67_READY_FOR_FINAL_REVIEW=true`,
`UA7_CONVERSATION_GRAPH_IMPLEMENTATION_COMPLETE=true`,
`UA7_CONVERSATION_GRAPH_SUITE_VERIFIED=true`,
`UA7_CONVERSATION_GRAPH_HOST_VERIFIED=NOT_REQUIRED` (ren TypeScript/ToolGateway/PolicyGateway/
Postgres/RLS/samtidighet/DB-constraint-herding, fullt bevist i eksisterende embedded-Postgres-
testmiljø - ingen fysisk-host-avhengig atferd introdusert av denne runden), `UA7_COMPLETE=false`
(kun første slice), `UA7_MEETING_TRANSCRIPTION=DEFERRED_WITHIN_PHASE`. Uendret: `D108_COMPLETE=false`,
`UA6_LIVE_PROVIDER_VERIFICATION_COMPLETE=false`, `UA6_CREDENTIAL_PHASE_COMPLETE=false`,
`UA6_COMPLETE=false`.

UA-7 akseptansekriterier re-evaluert etter herding: **1 (commitments across channels): PASS**
for identiteter med lenket kontakt. **2 (untrusted messages cannot exfiltrate): PASS** for
Gmail-innhøstingsstien. **3 (identity merges reversible+confidence-tracked): PASS** (nå med
bevist proveniens-grense, kryss-tenant-isolasjon, flertrinns-reversibilitet og samtidighet -
ikke bare den opprinnelige selvgjennomgangen). **4 (transcription retention): NOT_STARTED.**

## PR-status

PR #67 (branch `claude/ua7-conversation-graph`) forblir **draft**, `mergeable_state=clean`, ZERO
åpne review-tråder. Fersk CI BEKREFTET grønt mot den eksakte nye HEAD-en `6d4017579948be7716c24cc8f86708b2a9d0bf32`
denne herdingen produserte - `build-test`/`gitleaks`/`windows-git-auth` alle `conclusion=success`
(workflow run `33764910713`, samme resultat replikert på run `33764906350`). PR-beskrivelsen
oppdatert med full herdingssammendrag. INGEN merge uten Tobias/ekstern arkitekt sin eksplisitte
godkjenning.

## Blokkeringer

Ingen. Venter KUN på Tobias/ekstern arkitekt sin endelige merge-vurdering.

## Neste oppgave

D-119 PRE-MERGE SECURITY HARDENING er FERDIG: seks bekreftede funn rettet, 48/48 målrettede
tester grønt, full regresjon 182/182/2908/2908 grønt, gitleaks rent, fersk CI grønt på eksakt HEAD,
PR-beskrivelse oppdatert, ZERO åpne review-tråder. `D119_PREMERGE_HARDENING=PASS`,
`PR67_READY_FOR_FINAL_REVIEW=true`. Venter på Tobias/ekstern arkitekt sin finale merge-beslutning
- INGEN merge utført av denne økten. INGEN neste UA-7-slice, INGEN D-108, INGEN UA-8 startet.
