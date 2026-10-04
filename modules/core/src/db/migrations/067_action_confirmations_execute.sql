-- D-382: bekreftelsen bærer selve kallet (scope-bundne parametre fra trusted lag) slik at eierens godkjenning UTFØRER handlingen
-- i deterministisk kode (grant-rute /confirmations) - modellen trenger aldri «prøve igjen», og kan aldri endre kallet etterpå
-- (binding_hash over kanonisk kall + utløp + nonce verifiseres på nytt før utførelse). Resultatet lagres for sporbarhet.
ALTER TABLE action_confirmations
  ADD COLUMN parameters   jsonb,
  ADD COLUMN result       jsonb,
  ADD COLUMN executed_at  timestamptz;
