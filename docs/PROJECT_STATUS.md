# PROJECT STATUS

**Oppdatert:** 2026-09-18 (branch `tobias/manual-masterplan-k1-owner-control-authority`, PR #93,
HEAD `2af8295cd43462215084da843a77ebc8e813fd81`). Aktiv oppgave: **K1 - durable/delt
`OwnerControls`+`KillSwitch` + kanonisk `owner_controls.*` ToolGateway-namespace +
`executive.get_control_surface_status` (D-164/D-165) - NÅ HOST-BEVIST for kjernemekanismen.**
`MERGE_AUTHORIZED=false`, `SELF_APPROVAL=false`, `MERGED=false`. Sovereign som helhet **FORTSATT
IKKE komplett**. Ingen ny masterplan, ingen UGREEN-migrering startet.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Hvor `main` står nå

- **PR #92 (Sovereign graduation-audit, D-163)** merget `34c9c474…` (2026-09-17), K1 valgt av
  arkitekt-review runde 1 (5241197516) som neste Sovereign-slice.
- Main komponerer UA-9 Vision + UA-10 Situation Engine + UA-11 Executive Mode i
  `apps/api/src/main.ts`. `apps/api/src/worker-main.ts` kobler ingen av de tre eier-vendte
  namespacene (`situations`/`executive`/`vision`) - fortsatt tilsiktet (D-163 B).
- **K1 (PR #93, IKKE merget):** lukker UA-11 akseptansekriterium 3 sitt siste gjenstående gap - nå
  bevist BÅDE i suite OG på ekte Windows/Docker Desktop-host.

## K1 - hva er gjort (D-164/D-165)

1. **Migrasjon 058** (`owner_control_state`, global, ingen RLS/tenant_id).
2. **`modules/policy`**: `KillSwitch`/`OwnerControls` fikk `*Durable()`-metoder (LIVE per-kall
   DB-spørring, ingen cache) + `restore()` - eksisterende synkrone API byte-identisk uendret.
3. **Ny pakke `@jarvis/owner-controls`**: kanonisk `owner_controls.*` ToolGateway-namespace, 7
   handlinger (get_control_state/activate+deactivate_kill_switch/freeze+unfreeze_connector/
   revoke+restore_credential).
4. **`apps/api/src/main.ts`+`worker-main.ts`**: begge konstruerer nå `killSwitch`/`ownerControls`
   med SAMME `pool`+`authority`, kaller `restore()` FØR bruk, `controls: ownerControls` satt i
   `PolicyGateway` (tidligere aldri satt).
5. **`@jarvis/executive`**: ny handling `get_control_surface_status` (klasse A) komponerer
   `owner_controls.get_control_state`+`situations.get_pause_state`.
6. **`/infra/pause`-premisset korrigert** (fersk-verifisert: den ruten muterer `InfraExecutionGate`/
   D-104, en annen mekanisme - IKKE rørt av K1, se D-164 F).
7. **96 nye/påvirkede tester, alle grønne, empirisk kjørt** (ikke bare typecheck):
   `modules/owner-controls/test/owner-control-authority.test.ts` (22, ekte embedded Postgres -
   persistens/restart, TO uavhengige `pg.Pool` ser samme tilstand LIVE, autorisasjon/klasse-D,
   ToolGateway-komposisjon, "intet oppstartsvindu", audit, RLS-N/A bevist, idempotency-dedupe,
   credential revoke/restore, executive-komposisjon), `k1-owner-control-authority-host-run-wiring.test.ts`
   (15), `executive/service-transport.test.ts` gruppe G (5). Regresjon bekreftet grønn: policy (31)/
   situations (169)/executive (43)/apps-api (169)/tool-gateway (352) - 759 eksisterende + 96 nye =
   ingen endring i utfall.
8. **Host-akseptanse KJØRT OG PASSERT (2026-09-18, run_id `d7d5d246`)**: Tobias sin faktiske kjøring
   av `node --env-file=.env --experimental-transform-types modules/owner-controls/scripts/k1-owner-control-authority-host-run.ts`
   på Windows/Docker Desktop 4.87.0. **10/10 markører PASS, `hard_fail=false`**: Q-21 runtime-rolle,
   migrasjon 058, kill switch-aktivering med EKTE eier-identitet, api-/worker-side-blokkering (to
   separate `pg.Pool`, null delt JS-hukommelse), EKTE `docker compose restart api worker` midt i
   kjøringen, tilstand overlevde restart med INGEN oppstartsvindu (ingen `restore()` kalt eksplisitt),
   gjenopptak fra worker-siden gjenoppretter BEGGE sider (inkl. ekte cross-prosess connector-frys-
   synlighet), audit-bevis (6 rader, korrekt actor/reason, ingen credential-verdi), cleanup byte-
   identisk med tilstanden før kjøringen. Se D-165 for full kryssjekk mot scriptets kildekode.
   **IKKE host-bevist av dette spesifikke harnesset** (forblir suite/CI-proven): `revoke_credential`/
   `restore_credential`, `executive.get_control_surface_status`, `idempotency_key`-dedupe.

**Status:** `PRODUCTION_VERIFIED` for kill switch + connector-frys-kjernemekanismen (D-165).
`revoke_credential`/`restore_credential`/`executive.get_control_surface_status`/idempotency forblir
suite/CI-proven, ikke overdrevet til host-proven. Se RUNTIME_GATES.md/SOVEREIGN_GRADUATION_MATRIX.md
for den eksplisitte host-proven/suite-proven-distinksjonen.

## Blokkeringer

1. **Merge av denne PR-en.** `MERGE_AUTHORIZED=false`; krever uavhengig arkitekt-review mot exact
   HEAD + en separat, eksplisitt merge-closeout-ordre (samme protokoll som alle foregående
   Sovereign-slices) før merge. Dette er nå den ENE gjenstående gaten - host-akseptanse er lukket.
2. **Embedded-Postgres-flake (B.3, port-kontensjon)** fortsatt kjent i repo-suiten (uendret, ikke
   K1-relatert, ikke rørt av denne sliceen) - påvirker KUN full `pnpm -w test` av HELE workspacet,
   ikke de målrettede K1-suitene (som er 100% grønne).

## Neste oppgave

PR #93 venter på uavhengig arkitekt-review (siste gjenstående gate). Etter merge: ingen ny slice er
valgt ennå. K2 (decision log-domenet) forblir en lavere-prioritert, ikke-startet fremtidig kandidat
(se Q-35, SOVEREIGN_GRADUATION_MATRIX.md §Neste-steg). Sovereign som helhet er **FORTSATT IKKE
komplett**. Ingen ny masterplan, ingen UGREEN-migrering.
