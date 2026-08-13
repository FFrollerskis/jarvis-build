# Jarvis – tenantmodell (fase 1)

**Status:** v1.0. Implementeres i databasen i fase 2 (RLS); kontraktene bærer allerede `tenant_id`.

## 1. Tenants i første versjon

| tenant_id (foreslått) | Type | Innhold | Memory spaces |
|---|---|---|---|
| `tenant-personal` | Person | Tobias privat: liv, planer, preferanser, hjem | personal, project, health, home, guest, shared |
| `tenant-kundeoppfolging` | Bedrift | Kundeoppfølging AS: kunder, e-post, økonomi, CRM | business, project, shared |

Beslutning D-21: Kundeoppfølging AS er eneste bedrifts-tenant i v1.

## 2. Regler

1. Hver forespørsel bærer `tenant_id` + `memory_space_id` (kontrakt ✅ fase 1).
2. Row Level Security i Postgres håndhever tenant-grensen i databasen selv (fase 2) – aldri bare i
   applikasjonskode.
3. Bedrifts-tenant får egne krypteringsnøkler og egen revisjonslogg (fase 2/7).
4. Kryssing av tenant-grensen skjer kun via `shared`-space med eksplisitt deling – aldri implisitt.
5. Minne-evalen (fase 4) skal bevise null kryss-tenant-lekkasje før minnet får autoritet.
6. `delegation_id` i identitetskonteksten viser når en agent handler på vegne av Tobias;
   delegasjonskjeder revideres i fase 2 (K-10).

## 3. Fremtidig utvidelse (uten redesign)

- Nye tenants = nye rader + nøkler + RLS-policyer; ingen skjemaendring (D-21-krav).
- Flere personer (familie) blir egne `person_id` med egne spaces (parkert: Q-15).
- Flere selskaper blir egne bedrifts-tenants etter samme mønster som Kundeoppfølging AS.
- Multi-tenant på tvers av fysiske noder (NAS + AI-server + sky) håndteres av at all tilgang går
  gjennom samme Policy Gateway og database-RLS – plassering endrer ikke tilgangsmodellen.
