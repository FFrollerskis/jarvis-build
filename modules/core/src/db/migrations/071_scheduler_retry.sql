-- D-393 (JARVIS-027): daglig scheduler hadde claim-then-deliver UTEN retry: en forbigående feil (nett, DB-blipp, krasj midt i kjøringen)
-- brukte opp dagens eneste forsøk og jobben ble ikke kjørt før i morgen. Nå har raden et forsøkstall og et retry-tidspunkt:
-- feilet kjøring planlegges på nytt med backoff (1, 5, 15 min), en «hengt» claim (krasj) kan overtas etter 15 min, og forsøk er begrenset.
ALTER TABLE scheduler_state
  ADD COLUMN attempts    integer NOT NULL DEFAULT 1,
  ADD COLUMN retry_after timestamptz,
  ADD COLUMN last_error  text;
