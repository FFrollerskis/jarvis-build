-- Remediering del 9 (D-397, JARVIS-042): godkjenning og merge bindes til en EKSAKT commit-SHA.
--
-- Før dette ble `awaiting_approval` -> `approved` -> merge avgjort mot BRANCHEN: eieren godkjente «en PR», og et senere push på
-- samme branch (av en kompromittert kodejobb, eller bare en ny commit) ble merget under den gamle godkjenningen. Nå:
--   classified_head_sha  PR-ens head-SHA den gangen diffen ble klassifisert (og eieren varslet / zero-review-raden opprettet).
--   approved_head_sha    SHA-en eieren faktisk godkjente - satt ved `resolveApproval('approved')` fra classified_head_sha, og KUN
--                        hvis PR-ens nåværende head fortsatt er den.
-- `attemptMerge` krever at PR-ens nåværende head === bundet SHA, kjører CI mot SHA-en (ikke branch-navnet) og sender SHA-en som
-- `sha`-precondition i merge-kallet. Rader uten bundet SHA (opprettet før denne migrasjonen) feiler LUKKET (ci_failed).
-- Nullable med vilje: eksisterende rader har ingen SHA, og det er nettopp det som gjør dem ikke-mergbare.
ALTER TABLE self_modification_requests ADD COLUMN classified_head_sha text;
ALTER TABLE self_modification_requests ADD COLUMN approved_head_sha text;

ALTER TABLE self_modification_requests ADD CONSTRAINT self_modification_requests_sha_format_check
  CHECK (
    (classified_head_sha IS NULL OR classified_head_sha ~ '^[0-9a-f]{7,64}$')
    AND (approved_head_sha IS NULL OR approved_head_sha ~ '^[0-9a-f]{7,64}$')
  );
