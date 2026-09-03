# PROJECT STATUS

**Oppdatert:** 2026-09-03 (branch `claude/ua7-conversation-graph`, base uendret
`main=db0bf1c575ded615b93bca4367681e3f458853da`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser, ikke her.

## Aktiv fase/oppgave

D-119 (UA-7 første slice, Conversation Graph + confidence-basert reversibel
identitetsopploesning) er implementert på draft PR #67. Etter en FØRSTE ekstern
security-hardeningsrunde (seks funn, alle rettet - se DECISIONS_AND_ASSUMPTIONS.md), fant en
ANDRE uavhengig ekstern final-review to relaterte svakheter som overlevde den runden -
**D-119 FINAL AUTHORITY / TENANT-BOUNDARY HARDENING** kjørt og fullført på SAMME PR #67 (ingen
ny D-ID, ingen nytt slice). Full detalj: begge D-119-addenda i DECISIONS_AND_ASSUMPTIONS.md.

## D-119 FINAL AUTHORITY HARDENING - to bekreftede funn, begge rettet

1. **Tenant/space-parameter-authority-bypass (`D119_TENANT_PARAMETER_AUTHORITY_BYPASS_CONFIRMED=true`,
   bevist empirisk):** til tross for at FØRSTE runde korrekt rettet `performed_by`, leste
   `ConversationGraphTransport` FORTSATT `tenant_id`/`memory_space` fra kallerparametre for de
   gjenværende handlingene - en probe viste at en tenant-A-autentisert kaller kunne BÅDE lese OG
   skrive tenant B sine rader ved å forfalske `parameters.tenant_id`. Fiks: `tenant_id`/
   `memory_space` fjernet fra ALLE `input_schema`-er; transporten henter dem UTELUKKENDE fra
   `context.identity` (D-68 `ToolInvocationContext`, nå REQUIRED, fail-closed uten den).
2. **Canonical link-mutasjon uten trygg proveniens (`D119_CANONICAL_LINK_MODEL_MUTATION_RISK_CONFIRMED=true`,
   `D119_LINK_REVERSIBILITY_CLAIM_VALID=false`):** `link_channel_identity` (overlevde første
   runde) hadde ZERO produksjonskallere, ingen legitim kallerstyrt bruk for
   `created_by_person_id`/`source_type`/`source_instance_id`/`external_id` (den tiltrodde
   Gmail/Telegram-synkveien kaller service-en direkte, aldri via ToolGateway), og en
   `reversible: true`-påstand uten noen faktisk revoke-metode. Fiks: handlingen FJERNET HELT
   (samme presedens som `merge_identities`/`split_merge`) - `conversation_graph.*` er nå
   **READ-ONLY via ToolGateway** (6 handlinger, alle klasse A).

## Kvalitetsporter (etter begge herdingsrunder)

- `pnpm -r typecheck`: 21/21 pakker rent.
- `pnpm lint` (`eslint .`): rent.
- `modules/conversation-graph/test/*.test.ts`: **51/51 grønt** (41 service + 10 security, opp fra
  48 - +3 nye regresjonstester for tenant-authority/link-fjerning).
- Full workspace-suite: **182/182 filer, 2911/2911 tester grønt** (opp fra 182/2908). Ingen
  flakey-funn denne kjøringen.
- gitleaks (hele git-historikken OG working tree): `no leaks found`.

## Flagg-status

`D119_FINAL_AUTHORITY_HARDENING=PASS`, `PR67_READY_FOR_FINAL_REVIEW=true`,
`UA7_CONVERSATION_GRAPH_IMPLEMENTATION_COMPLETE=true`,
`UA7_CONVERSATION_GRAPH_SUITE_VERIFIED=true`,
`UA7_CONVERSATION_GRAPH_HOST_VERIFIED=NOT_REQUIRED` (ren TypeScript/ToolGateway/PolicyGateway/
Postgres/RLS-herding, fullt bevist i eksisterende embedded-Postgres-testmiljø - ingen
fysisk-host-avhengig atferd introdusert av denne runden), `UA7_COMPLETE=false` (kun første
slice), `UA7_MEETING_TRANSCRIPTION=DEFERRED_WITHIN_PHASE`. Uendret: `D108_COMPLETE=false`,
`UA6_LIVE_PROVIDER_VERIFICATION_COMPLETE=false`, `UA6_CREDENTIAL_PHASE_COMPLETE=false`,
`UA6_COMPLETE=false`.

UA-7 akseptansekriterier re-evaluert etter begge herdingsrunder: **1 (commitments across
channels): PASS** for identiteter med lenket kontakt. **2 (untrusted messages cannot
exfiltrate): PASS** for Gmail-innhøstingsstien. **3 (identity merges reversible+confidence-
tracked): PASS** (nå med bevist proveniens-/tenant-grense, kryss-tenant-isolasjon, flertrinns-
reversibilitet, samtidighet, OG strukturelt umulig tenant-spoofing/canonical-link-forfalskning).
**4 (transcription retention): NOT_STARTED.**

## PR-status

PR #67 (branch `claude/ua7-conversation-graph`) forblir **draft**. Herdingscommiten er pushet;
fersk CI på den eksakte nye HEAD-en verifiseres før noe merge-forslag vurderes (se
git-log/PR-beskrivelse for eksakt HEAD-SHA og CI-run-ID-er). INGEN merge uten Tobias/ekstern
arkitekt sin eksplisitte godkjenning.

## Blokkeringer

Ingen tekniske. Venter på fersk CI-bekreftelse på ny HEAD, deretter Tobias/ekstern arkitekt sin
endelige merge-vurdering.

## Neste oppgave

Bekreft fersk CI grønt på eksakt ny HEAD, oppdater PR #67 sin beskrivelse med denne andre
herdingsrundens sammendrag, lever sluttrapport. INGEN merge, INGEN neste UA-7-slice, INGEN
D-108, INGEN UA-8 startet av denne runden.
