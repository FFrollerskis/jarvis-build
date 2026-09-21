-- Task #123 (D-214, oppfølging av task #121): produsent av EKTE
-- `requires_approval`-selvendringsforespørsler for VILKÅRLIGE kodeendringer,
-- pluss selve merge-koblingen for godkjente rader. Gjenbruker den
-- eksisterende `createCodingHandler`/`ClaudeCodeAgent`-kodeagent-pipelinen
-- (D-96/D-100/D-101, via `TaskService.submit()`/task-køen) - i motsetning
-- til `personality_config`-sporet (task #121) er `target_paths`/`branch`/PR
-- IKKE kjent ved opprettelsestidspunktet for en `code_change`-forespørsel;
-- den ekte kodejobben kjører ASYNKRONT FØRST, en diff å klassifisere finnes
-- ikke før jobben fullfører.
--
-- Ny status `pending_job`: raden starter her for `code_change`-forespørsler
-- (aldri `pending_ci`, som forutsetter en allerede kjent, eksakt diff - se
-- 060 sitt filhode). `SelfModificationService.sweepPendingJobs()` sjekker
-- jobbens status periodisk; når den fullfører og en PR faktisk ble
-- opprettet, klassifiseres PR-ens FAKTISKE endrede filer (ALDRI antatt) via
-- `classifySelfModification()` - SAMME autoritet som resten av modulen -
-- og raden går videre til enten `pending_ci` (viste seg å være
-- zero_review, gjenbruker den EKSISTERENDE zero-review-sveipen uendret),
-- `awaiting_approval` (requires_approval, venter på Telegram-godkjenning),
-- eller `rejected` (forbidden - ALDRI presentert for godkjenning i det hele
-- tatt, uansett hva eieren måtte ønske).
ALTER TABLE self_modification_requests DROP CONSTRAINT self_modification_requests_status_check;
ALTER TABLE self_modification_requests ADD CONSTRAINT self_modification_requests_status_check
  CHECK (status IN (
    'pending_job', 'pending_ci', 'merged', 'ci_failed', 'awaiting_approval', 'approved', 'rejected', 'expired'
  ));

-- KUN satt for `kind = 'code_change'`-rader (NULL for `personality_config`) -
-- se types.ts sitt filhode for hvorfor task-køens EGEN tenant-partisjonering
-- krever disse, selv om selve selvendrings-tabellen bevisst forblir global/
-- uten RLS (samme presedens som 060/058).
ALTER TABLE self_modification_requests ADD COLUMN coding_task_id text;
ALTER TABLE self_modification_requests ADD COLUMN coding_tenant_id text;

-- Sveipen (SelfModificationService.sweepPendingJobs()) spør gjentatte ganger
-- etter samme, lille undergruppe (status = 'pending_job') - samme "billig
-- delvis indeks holder sveipen rask selv når FERDIG-historikken vokser"-
-- begrunnelse som 060 sin `self_modification_requests_open_idx`.
CREATE INDEX self_modification_requests_pending_job_idx
  ON self_modification_requests (status)
  WHERE status = 'pending_job';
