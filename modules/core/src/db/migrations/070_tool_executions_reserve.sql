-- D-392 (JARVIS-004/022): reserve-then-execute-ledger for eksterne verktøyhandlinger.
--
-- Tidligere ble `tool_executions`-raden skrevet ETTER den eksterne bivirkningen, inne i samme transaksjon som holdt en DB-forbindelse
-- under hele leverandørkallet. En audit-skrivefeil, tidsavbrudd eller SIGKILL midt i kallet rullet tilbake raden mens bivirkningen
-- hadde skjedd - og en retry utførte den på nytt (dobbel utbetaling/melding/sletting).
--
-- Nå reserveres raden (status 'reserved') og COMMITTES FØR leverandørkallet; transaksjonen holdes ikke åpen over nettverket.
-- En 'reserved'-rad som aldri ble ferdigstilt betyr «utfall ukjent» og blokkerer retry (aldri en ny mutasjon) til eieren har avstemt
-- den (`ToolGateway.reconcile`). `failed` er nå FAKTISK brukt: leverandøren avviste/kastet før et bekreftet utfall, og retry er tillatt.

ALTER TABLE tool_executions DROP CONSTRAINT tool_executions_status_check;
ALTER TABLE tool_executions ADD CONSTRAINT tool_executions_status_check
  CHECK (status IN ('reserved', 'succeeded', 'failed', 'unverified'));

GRANT UPDATE (status, external_id, executed_at, before_state, after_state, postcondition_reason) ON tool_executions TO jarvis_app;
