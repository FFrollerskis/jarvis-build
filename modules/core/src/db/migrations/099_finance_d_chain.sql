-- WP-F1 (D-462, Q-47 a / JARVIS-019/020/070/072): klasse D-kjeden for penger.
--
-- 1) `first_submit_attempt_at`: tidspunktet for FØRSTE reservasjon av en innsending mot leverandøren. Stripe og Vipps slår sammen gjentatte kall med
--    samme Idempotency-Key, men bare innenfor leverandørens idempotensvindu (Stripe: 24 t). En gjenopptakelse/retry etter at vinduet er passert
--    kan opprette et NYTT objekt hos leverandøren (dobbel belastning) - applikasjonen avviser derfor en ny innsending som ligger utenfor vinduet
--    og krever avstemming i stedet. Kolonnen settes én gang (COALESCE) og nullstilles kun når leverandøren entydig AVVISTE første forsøk (4xx).
--    `submitted_at` kan ikke brukes til dette: den nullstilles når en reservasjon rulles tilbake, og overskrives når utfallet lagres.
-- 2) Webhook-status `rejected`: en korrekt autentisert hendelse hvis innhold er permanent ugyldig (beløp som ikke er et trygt heltall i minste enhet,
--    ukjent objekttype ...) lagres som dødbrev med årsak og besvares 2xx (ingen evig retry) - tilstanden hentes uansett inn igjen av den planlagte
--    leverandør-oppfriskingen, og avstemmingen (100) flagger avviste hendelser. `failed_retryable` er uendret forbeholdt midlertidige feil.
-- 3) Delvise indekser for skanning av reserverte innsendinger uten leverandørsvar (in-flight / ukjent utfall).
--
-- RLS/GRANT er uendret: tabellene har tabellnivå-grants (SELECT/INSERT/UPDATE for jarvis_app) som dekker nye kolonner.

ALTER TABLE payment_intents ADD COLUMN first_submit_attempt_at timestamptz;
ALTER TABLE stripe_refunds ADD COLUMN first_submit_attempt_at timestamptz;
ALTER TABLE vipps_captures ADD COLUMN first_submit_attempt_at timestamptz;
ALTER TABLE vipps_refunds ADD COLUMN first_submit_attempt_at timestamptz;

ALTER TABLE stripe_webhook_events DROP CONSTRAINT stripe_webhook_events_status_check;
ALTER TABLE stripe_webhook_events ADD CONSTRAINT stripe_webhook_events_status_check
  CHECK (status IN ('received', 'verified', 'processed', 'failed_retryable', 'unsupported', 'rejected'));
ALTER TABLE vipps_webhook_events DROP CONSTRAINT vipps_webhook_events_status_check;
ALTER TABLE vipps_webhook_events ADD CONSTRAINT vipps_webhook_events_status_check
  CHECK (status IN ('received', 'verified', 'processed', 'failed_retryable', 'unsupported', 'rejected'));
ALTER TABLE neonomics_webhook_events DROP CONSTRAINT neonomics_webhook_events_status_check;
ALTER TABLE neonomics_webhook_events ADD CONSTRAINT neonomics_webhook_events_status_check
  CHECK (status IN ('received', 'verified', 'processed', 'failed_retryable', 'unsupported', 'rejected'));
ALTER TABLE wallester_webhook_events DROP CONSTRAINT wallester_webhook_events_status_check;
ALTER TABLE wallester_webhook_events ADD CONSTRAINT wallester_webhook_events_status_check
  CHECK (status IN ('received', 'verified', 'processed', 'failed_retryable', 'unsupported', 'rejected'));

CREATE INDEX payment_intents_inflight_idx ON payment_intents (tenant_id, submitted_at) WHERE state = 'submitted' AND provider_ref IS NULL;
CREATE INDEX stripe_refunds_inflight_idx ON stripe_refunds (tenant_id, submitted_at) WHERE state = 'submitted' AND provider_ref IS NULL;
CREATE INDEX vipps_captures_inflight_idx ON vipps_captures (tenant_id, submitted_at) WHERE state = 'submitted';
CREATE INDEX vipps_refunds_inflight_idx ON vipps_refunds (tenant_id, submitted_at) WHERE state = 'submitted' AND provider_ref IS NULL;
