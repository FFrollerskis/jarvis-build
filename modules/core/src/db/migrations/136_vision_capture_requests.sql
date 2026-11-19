-- WP-G3 (D-465), UA-9 Vision & Physical World, del 4: iPhone-kamera PÅ FORESPØRSEL (kun serverkontrakten).
--
-- iPhone-appen er BLOCKED_EXTERNAL (Apple Developer-konto, signering, APNs). Serversiden er likevel ferdig definert slik at appen kan
-- kobles på uten omskriving: eieren ber om ETT opptak (`vision_capture_requests`, state 'pending', kort levetid) -> enheten viser
-- selv forespørselen og eieren godtar på enheten -> enheten laster opp ETT øyeblikksbilde, SIGNERT med enhetens Ed25519-nøkkel
-- (request_id + sha256 + størrelse + tidsstempel er med i det signerte innholdet) -> serveren verifiserer mot enhetsregisteret og
-- kjører bildet gjennom SAMME pipeline som en HA-hendelse (rutingpolicy, lokal klassifisering, valgfri lagring).
--
-- Forespørselen er ENGANGS: pending -> fulfilled|expired|cancelled|rejected skjer med en betinget UPDATE (compare-and-set på state
-- og utløp), så en gjentatt eller reprodusert opplasting kan aldri behandles to ganger. Det finnes INGEN kontinuerlig strøm,
-- ingen bakgrunnsopptak og ingen automatisk forespørsel: kun eieren (eier-rute, signert enhetsøkt) kan opprette en forespørsel.

CREATE TABLE vision_capture_requests (
  request_id      text PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id text NOT NULL DEFAULT 'personal'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  person_id       text NOT NULL,
  camera_id       text NOT NULL,
  -- Enheten som skal ta bildet. Må være lik kameraets source_ref (kontrolleres i tjenesten og ved opplasting).
  device_id       text NOT NULL,
  state           text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','fulfilled','expired','cancelled','rejected')),
  idempotency_key text CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 128),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  -- Maks 15 minutter (databasens egen klokke); selve standarden er kortere (se capture.ts).
  expires_at      timestamptz NOT NULL,
  resolved_at     timestamptz,
  snapshot_id     text,
  -- sha256 av det aksepterte opplastede bildet (revisjon; bildet selv lagres kun hvis kameraets policy sier store_snapshot).
  upload_sha256   text CHECK (upload_sha256 IS NULL OR upload_sha256 ~ '^[0-9a-f]{64}$'),
  reject_reason   text CHECK (reject_reason IS NULL OR reject_reason ~ '^[a-z0-9_]{1,40}$'),
  task_id         text NOT NULL,
  session_id      text,
  CONSTRAINT vision_capture_requests_ttl CHECK (expires_at > requested_at AND expires_at <= requested_at + interval '15 minutes'),
  CONSTRAINT vision_capture_requests_resolved_has_time CHECK (state = 'pending' OR resolved_at IS NOT NULL)
);
CREATE INDEX vision_capture_requests_pending_idx ON vision_capture_requests (tenant_id, memory_space_id, person_id, device_id, requested_at DESC)
  WHERE state = 'pending';
CREATE INDEX vision_capture_requests_retention_idx ON vision_capture_requests (requested_at);
ALTER TABLE vision_capture_requests ADD CONSTRAINT vision_capture_requests_person_tenant_fkey
  FOREIGN KEY (person_id, tenant_id) REFERENCES person_tenants (person_id, tenant_id);
ALTER TABLE vision_capture_requests ADD CONSTRAINT vision_capture_requests_camera_fkey
  FOREIGN KEY (tenant_id, memory_space_id, person_id, camera_id) REFERENCES vision_cameras (tenant_id, memory_space_id, person_id, camera_id) ON DELETE CASCADE;
ALTER TABLE vision_capture_requests ADD CONSTRAINT vision_capture_requests_snapshot_fkey
  FOREIGN KEY (tenant_id, memory_space_id, person_id, snapshot_id)
  REFERENCES vision_snapshots (tenant_id, memory_space_id, person_id, snapshot_id) ON DELETE SET NULL (snapshot_id);
-- NULL-verdier er distinkte i en unik nøkkel: forespørsler uten idempotensnøkkel kolliderer aldri.
ALTER TABLE vision_capture_requests ADD CONSTRAINT vision_capture_requests_idempotency_key
  UNIQUE (tenant_id, memory_space_id, person_id, idempotency_key);

-- Minste privilegium (review B-L9): kun livssyklus-kolonnene (forbruk/utløp/avvisning og peker til bildet) kan oppdateres - aldri enhet, kamera, person, levetid eller idempotensnøkkel.
GRANT SELECT, INSERT, DELETE ON vision_capture_requests TO jarvis_app;
GRANT UPDATE (state, resolved_at, snapshot_id, upload_sha256, reject_reason) ON vision_capture_requests TO jarvis_app;
ALTER TABLE vision_capture_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE vision_capture_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY vision_capture_requests_tenant ON vision_capture_requests
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY vision_capture_requests_space ON vision_capture_requests AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));
