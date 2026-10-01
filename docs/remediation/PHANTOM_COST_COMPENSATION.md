# Kompensasjonsplan: fantomkostnad for `gemma_local` (JARVIS-006)

## Problemet
`gemma_local` (lokal modell – API-kostnad er alltid 0) hadde ingen prisrad og ble belastet `default_rate` (30/150 øre per 1k tokens) på prompts med ~48k tokens verktøyskjema. `BudgetGuard` summerer **alle** `cost_events` siden månedsstart; fantomradene traff 3 000-kr-grensen, utløste den varige kill-switchen (watchdogen re-armerte den hvert minutt) og ble speilet inn i `finance_spend_records` (`source_family = 'model_cost'`).

## Rotårsaken er rettet i kode
`modules/model-gateway/src/pricing.ts` har nå eksplisitt `gemma_local: 0 / LOCAL` (og `scripted`), og `ModelGateway` + oppstart (`api` og `worker`) **nekter å starte** hvis en registrert modell mangler eksplisitt pris eller en lokal modell har ikke-null API-pris. Test: `modules/model-gateway/test/remediation-1-explicit-pricing.test.ts`. Status: `CODE_FIXED` – ikke deployet, ikke runtime-verifisert.

## Historikken kompenseres reversibelt (ingenting slettes)

Skript i `ops/remediation/phantom-cost/`, testet mot en fullt migrert database (`modules/core/test/remediation-1-phantom-cost-compensation.test.ts`):

| Steg | Fil | Endrer data? |
|---|---|---|
| 1 Plan | `01-plan.sql` | Nei. Ett JSON-dokument med antall/summer per tenant og måned, månedens effekt på budsjettet, speilet og kill-switch-rader. |
| 2 Apply | `02-apply.sql` | Ja, i én transaksjon: **arkiverer** originalradene (`remediation_cost_events_archive`, `remediation_finance_spend_records_archive`), setter så `amount_ore = 0` på `gemma_local`-rader, markerer speilet `source_correction_state = 'corrected'`, skriver én `audit_events`-rad per tenant. Nekter uten `jarvis.remediation_confirm`. Etter-betingelse (ingen `gemma_local`-kostnad igjen) ruller ellers alt tilbake. Idempotent. |
| 3 Revert | `03-revert.sql` | Ja: gjenoppretter alle originalbeløp for én navngitt kompensasjon. |

### Operatørrekkefølge (NAS, `BLOCKED_EXTERNAL` – krever host-tilgang)
1. Deploy koden med pris-fiksen (`git pull`, `docker compose up -d --build`). Uten dette skrives nye fantomrader.
2. Restore-verifisert backup av `jarvis` ([BACKUP_RESTORE_RUNBOOK.md](BACKUP_RESTORE_RUNBOOK.md)).
3. `docker compose -f infra/local/docker-compose.yml exec -T postgres psql -U postgres -d jarvis -X -A -t -f - < ops/remediation/phantom-cost/01-plan.sql` – les rapporten.
4. Apply:
   ```bash
   docker compose -f infra/local/docker-compose.yml exec -T -e PGOPTIONS="-c jarvis.remediation_confirm=ARCHIVE_THEN_ZERO_GEMMA_LOCAL_COSTS" postgres \
     psql -U postgres -d jarvis -X -v ON_ERROR_STOP=1 -f - < ops/remediation/phantom-cost/02-apply.sql
   ```
5. Kjør steg 3 igjen: forventet `rows_with_cost: 0` og kompensasjons-ID listet.
6. Kill-switchen deaktiveres av **eieren** (dashbord/Telegram) når budsjettstatus er `ok` – skripten rører ikke `owner_control_state`.
7. Verifisering: `SELECT coalesce(sum(amount_ore),0) FROM cost_events WHERE provider='gemma_local' AND at > now() - interval '1 day'` forblir 0 etter ett døgn.

Angre: `03-revert.sql` med `jarvis.remediation_confirm=RESTORE_GEMMA_LOCAL_COSTS` og `jarvis.compensation_id=<id fra steg 4>`.

## Ikke dekket
Under-telling av ekte forbruk (feilede forsøk, tenke-tokens, STT/TTS) og statisk/fiktiv budsjettstyring er JARVIS-039 (senere del). `kimi` har ikke `pricing_verified_at` (prisen er ikke dato-verifisert).
