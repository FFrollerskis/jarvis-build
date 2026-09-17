# PROJECT STATUS

**Oppdatert:** 2026-09-17 (branch `tobias/manual-masterplan-k1-owner-control-authority` fra exact
`main=34c9c474a478cb7aab7858284ec0606eab51c128` = PR #92 sin merge-commit). Aktiv oppgave: **K1 -
durable/delt `OwnerControls`+`KillSwitch` + kanonisk `owner_controls.*` ToolGateway-namespace +
`executive.get_control_surface_status` (D-164).** `MERGE_AUTHORIZED=false`, `SELF_APPROVAL=false`,
`MERGED=false`. Sovereign som helhet **FORTSATT IKKE komplett**. Ingen ny masterplan, ingen
UGREEN-migrering startet.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Hvor `main` står nå

- **PR #92 (Sovereign graduation-audit, D-163)** merget `34c9c474…` (2026-09-17), K1 valgt av
  arkitekt-review runde 1 (5241197516) som neste Sovereign-slice.
- Main komponerer UA-9 Vision + UA-10 Situation Engine + UA-11 Executive Mode i
  `apps/api/src/main.ts`. `apps/api/src/worker-main.ts` kobler ingen av de tre eier-vendte
  namespacene (`situations`/`executive`/`vision`) - fortsatt tilsiktet (D-163 B).
- **K1 (denne PR-en, IKKE merget):** lukker UA-11 akseptansekriterium 3 sitt siste gjenstående gap.

## K1 - hva er gjort (D-164)

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
   ToolGateway-komposisjon, "intet oppstartsvindu", audit, RLS-N/A bevist),
   `k1-owner-control-authority-host-run-wiring.test.ts` (15), `executive/service-transport.test.ts`
   gruppe G (5). Regresjon bekreftet grønn: policy (31)/situations (169)/executive (43)/
   apps-api (169)/tool-gateway (352) - 759 eksisterende + 96 nye = ingen endring i utfall.
8. **Host-akseptanse-harness bygget, IKKE kjørt**: `modules/owner-controls/scripts/
   k1-owner-control-authority-host-run.ts`+`-live.ts` (samme to-fils-mønster som UA-10/UA-5).

**Status:** `FIXED_SUITE_VERIFIED`, `HOST_ACCEPTANCE_REQUIRED=true` - IKKE `PRODUCTION_VERIFIED`
før Tobias faktisk kjører host-harnessen på Windows/Docker-hosten. Se D-164, RUNTIME_GATES.md,
SOVEREIGN_GRADUATION_MATRIX.md.

## Blokkeringer

1. **Merge av denne PR-en.** `MERGE_AUTHORIZED=false`; krever uavhengig arkitekt-review mot exact
   HEAD + en separat, eksplisitt merge-closeout-ordre (samme protokoll som alle foregående
   Sovereign-slices) før merge.
2. **Host-akseptanse.** `HOST_ACCEPTANCE_REQUIRED=true` - Tobias må kjøre
   `node --env-file=.env --experimental-transform-types modules/owner-controls/scripts/k1-owner-control-authority-host-run.ts`
   på Windows/Docker-hosten (AKTIVERER den ekte globale kill switchen kortvarig - les scriptets
   eget filhode) før denne raden kan flippes til `PRODUCTION_VERIFIED`.
3. **Embedded-Postgres-flake (B.3, port-kontensjon)** fortsatt kjent i repo-suiten (uendret, ikke
   rørt av denne sliceen).

## Neste oppgave

Etter merge + host-akseptanse av K1: ingen ny slice er valgt ennå. K2 (decision log-domenet)
forblir en lavere-prioritert, ikke-startet fremtidig kandidat (se Q-35, SOVEREIGN_GRADUATION_MATRIX.md
§Neste-steg). Sovereign som helhet er **FORTSATT IKKE komplett**. Ingen ny masterplan, ingen
UGREEN-migrering.
