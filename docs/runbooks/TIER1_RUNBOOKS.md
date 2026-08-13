# Tier 1-runbooks og eierskap (fase 10)

**Eier for alle Tier 1-tjenester: Tobias.** Alarmkanal: Telegram (watchdog, uverifisert til token
finnes). Failover-beskrivelser under. RTO/RPO: se DEPLOYMENT_STRATEGY §4. Sist testet: restore
2026-08-13 (automatisert test, målt tid i CI); øvrige øves når runtime-miljøene finnes.

## postgres
- **Symptom:** watchdog `database`-sjekk feiler / API 500.
- **Precheck:** er prosessen/containeren oppe? disk full?
- **Tiltak:** (1) restart databasetjenesten (reversibelt, maks 2 forsøk via watchdog-action);
  (2) ved korrupsjon: restore fra siste backup (BackupService/pg_dump) i FERSK instans, verifiser
  audit-antall, pek Jarvis om. **Aldri** slett datamapper uten godkjenning.
- **Failover:** NAS-instans er primær (D-20); dev-PC kan kjøre midlertidig kopi fra backup.

## core-api
- **Symptom:** /health svarer ikke.
- **Tiltak:** restart prosessen (én tjeneste, reversibelt). Sjekk migrasjonsstatus og DB-tilkobling.
- **Failover:** stateless - kan startes på annen node mot samme database.

## worker
- **Symptom:** watchdog `stuck_tasks` (utløpte leases).
- **Tiltak:** ingen manuell inngripen nødvendig for selve jobben (lease-reclaim tar den); restart
  worker-prosessen hvis den er død. Undersøk last_error på failed jobber.

## kostnad
- **Symptom:** watchdog `cost_explosion` - kill switch ER aktivert automatisk.
- **Tiltak:** vurder cost_events-rapporten (costReport), identifiser kilden (kind/task), roter
  ev. lekket nøkkel, deaktiver kill switch MANUELT når årsaken er forstått. Grensene (D-09)
  revideres bevisst - aldri heves i panikk.

## vault (Infisical - etter D-35)
- **Symptom:** secret-henting feiler (tjenester får credential_unavailable - fail closed).
- **Tiltak:** restart Infisical-container; ved tap: restore fra vault-backup (dokumenteres ved
  D-35-oppsett). Jarvis-tjenester trenger ikke restart (henter ved behov).

## kill switch-øvelse
Aktiver manuelt → verifiser at ALLE verktøykall nektes (policytest) → deaktiver → verifiser normal
drift. Automatisert i testsuiten; fysisk øvelse gjentas ved hver miljøendring.
