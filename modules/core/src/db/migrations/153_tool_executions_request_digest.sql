-- WP-T1 K2 (JARVIS-102, Q-65 pkt 1, D-497): request_digest paa ToolGateway-ledgeren (`tool_executions`).
--
-- Ledgeren er noeklet paa (tenant_id, idempotency_key) ALENE (010): samme noekkel med en ANNEN nyttelast (eller en annen handling) ga det lagrede resultatet som `deduplicated: true`, aldri en feil.
-- Denne kolonnen lagrer et avtrykk av FORESPOERSELEN som reserverte raden, slik at gatewayen kan avvise `idempotency_key_reuse_mismatch` naar noekkelen gjenbrukes til noe annet
-- (flagget `JARVIS_TOOL_REQUEST_DIGEST=off|observe|enforce`, standard off).
--
--   * `request_digest` = SHA-256 (hex, 64 tegn) over den kanoniske forespoerselen {v, tool_id, action, parameters uten idempotensnoekkel, tenant_id, person_id}.
--     Kanoniseringen og testvektorene staar i packages/contracts/src/request-digest.ts og docs/runbooks/WPT1_REQUEST_DIGEST.md - ETT avtrykk som ogsaa en fremtidig Approval v2 binder.
--   * NULL = raden ble skrevet FOER denne migrasjonen, eller mens flagget stod paa `off`. ALDRI backfill: parametrene lagres ikke i ledgeren, saa et avtrykk kan ikke utledes i ettertid
--     (en gjetning ville vaert en falsk binding). Gatewayen behandler en NULL-rad som i dag (og logger det i `observe`/`enforce`).
--   * Skrives KUN ved INSERT (reservasjonen). Ingen UPDATE-rettighet paa kolonnen: UPDATE-rettighetene paa `tool_executions` er kolonnevise (011/070), og `jarvis_app` kan derfor aldri endre en digest
--     etter at den er satt. Tabellens FORCE-RLS og tenant-policy (010) er uendret.
--   * Ingen indeks: ingen soek slaar opp paa avtrykket. Konfliktsjekken skjer paa primaernoekkelen (tenant_id, idempotency_key), som allerede er indeksert.
--
-- Expand/contract: kun EXPAND (additiv, nullbar kolonne). En eldre kodeversjon ignorerer kolonnen (INSERT og SELECT navngir kolonnene). Tilbakerulling: la kolonnen staa og sett flagget til `off`
-- (eller rull tilbake koden); radene med avtrykk er harmlose for eldre kode. Erasure og retensjon er uendret: tabellen er APPEND_ONLY_EVIDENCE (d395-dekningstesten) og 073 sletter hele avsluttede rader; kolonnen er et ett-veis avtrykk, aldri klartekst fra parametrene.

ALTER TABLE tool_executions ADD COLUMN request_digest text;
ALTER TABLE tool_executions ADD CONSTRAINT tool_executions_request_digest_format
  CHECK (request_digest IS NULL OR request_digest ~ '^[0-9a-f]{64}$');
