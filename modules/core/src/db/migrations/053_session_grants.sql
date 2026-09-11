-- D-131 (uavhengig arkitektkontroll av PR #79, funn 1 og 2): SKILLER
-- SAMTALEKONTINUITET FRA AUTORISASJONSBEVIS.
--
-- PROBLEMET SOM LUKKES HER (funn 1): `sessions.session_id` ble brukt som
-- device-authentication av `/chat`/`/brief`. En sesjonsrad er
-- samtale-kontinuitet: `resumeOrCreate()` gjenbruker BEVISST samme
-- `session_id` for personens kanaler og overskriver `last_device_id` ved hvert
-- kanalbytte (fase 2 akseptansekriterium 3). En samtale-ID kan derfor per
-- konstruksjon ALDRI dokumentere:
--   * HVILKEN enhet som står bak DETTE kallet (`last_device_id` er mutabel og
--     peker på den SIST aktive enheten - en eldre klient ville blitt
--     re-attribuert til en annen enhets identitet etter et kanalbytte),
--   * om enhetens nøkkel fortsatt er gyldig (tilbakekalling = `devices.
--     public_key_pem IS NULL`, en tilstand sesjonsraden ikke kjenner),
--   * når autoriteten utløper, eller hvilket scope den ble gitt for,
--   * hvilken transport/styrke beviset faktisk hadde (en `TelegramOwnerAuthority`-
--     sesjon er `active`, men den SAMME sesjons-ID-en ble oppgradert til
--     `signed` av den generiske oppslagsveien).
--
-- LØSNINGEN: et SERVERUTSTEDT, AVGRENSET og REVOKERBART grant. `session_grants`
-- er autorisasjonsbeviset; `sessions` forblir UENDRET som samtalekontinuitet.
-- Én sesjon kan ha MANGE samtidige grants (ett per bevist enhet) - det er
-- nettopp derfor «samme samtale på tvers av kanaler» kan bevares UTEN at én
-- enhets autoritet deles med en annen.
--
-- INGEN NY IDENTITETSMODELL: hvert felt i et grant kommer fra den ALLEREDE
-- kanoniske stien (`DeviceService.verifyChallenge()` ->
-- `IdentityService.resolveIdentity()`s person/tenant/enhet/space-konjunksjon ->
-- `SessionService.resumeOrCreate()`). Tabellen lagrer et allerede fattet,
-- allerede revidert vedtak - den fatter aldri et nytt.

CREATE TABLE session_grants (
  -- SHA-256 (hex) av bærer-tokenet, ALDRI tokenet selv: en databaselekkasje
  -- (backup, replika, SELECT-tilgang) skal ikke gi noen et BRUKBART
  -- autorisasjonsbevis. Samme resonnement som for enrollment-billettene under.
  grant_id               text PRIMARY KEY,
  tenant_id              text NOT NULL REFERENCES tenants (tenant_id),
  person_id              text NOT NULL REFERENCES people (person_id),
  -- Den BEVISTE enheten - fast for grantets levetid. Dette er hele forskjellen
  -- fra `sessions.last_device_id`, som endrer seg ved hvert kanalbytte.
  device_id              text NOT NULL REFERENCES devices (device_id),
  -- Samtalen grantet gir tilgang til. Deles med andre enheters grants -
  -- kontinuitet er felles, autoritet er det ikke.
  session_id             text NOT NULL REFERENCES sessions (session_id),
  -- Det AUTORISERTE scopet. En annen space krever et nytt grant (én signatur).
  memory_space           text NOT NULL,
  -- Kanalen beviset ble gitt på. Bindes her slik at en transport ikke kan
  -- gjenbruke et annet grants kanal-attribusjon.
  channel                text NOT NULL,
  auth_strength          text NOT NULL CHECK (auth_strength IN ('passive', 'active', 'signed')),
  -- SHA-256 (hex) av den `devices.public_key_pem` som FAKTISK ble bevist da
  -- grantet ble utstedt. Verifisering sammenligner mot nøkkelen som står i
  -- `devices` NÅ, så BÅDE tilbakekalling (kolonnen blir NULL) OG rotasjon
  -- (kolonnen får en annen verdi) dreper alle utestående grants for enheten
  -- STRUKTURELT - ikke bare hvis noen husket å kalle en revoke-funksjon.
  device_key_fingerprint text NOT NULL,
  issued_at              timestamptz NOT NULL DEFAULT now(),
  -- Absolutt utløp. Kort levetid er trygt fordi ny autorisasjon koster én
  -- signatur - se SESSION_GRANT_TTL_MS i packages/contracts.
  expires_at             timestamptz NOT NULL,
  -- Eksplisitt tilbakekalling (nøkkelrotasjon, eier-handling). Fingerprint-
  -- sjekken over er den strukturelle garantien; denne kolonnen gjør
  -- tilbakekallingen SYNLIG og reviderbar i stedet for bare implisitt.
  revoked_at             timestamptz
);
CREATE INDEX session_grants_device_idx ON session_grants (tenant_id, device_id) WHERE revoked_at IS NULL;
CREATE INDEX session_grants_session_idx ON session_grants (tenant_id, session_id);

-- D-131 funn 2: EKSPLISITT BETRODD EIER-/BOOTSTRAP-AUTORITET FOR INNRULLERING.
--
-- PROBLEMET SOM LUKKES: `/devices/register` autoriserte seg selv med
-- `resolveIdentity(body.identity)` - som VERIFISERER EKSISTENS, ikke
-- AUTENTISERING. En nettverksklient som kjente gyldige (ikke-hemmelige)
-- person-/tenant-/device-ID-er kunne derfor `ON CONFLICT DO UPDATE` inn sin
-- EGEN `public_key_pem` og deretter bestå challenge-/session-flyten med sin
-- egen nøkkel. Nøkkelbeviset var da sirkulært: enheten beviste en nøkkel
-- angriperen nettopp hadde satt.
--
-- Innrullering krever fra nå av ETT av to bevis (se DeviceEnrollmentService):
--   (a) ferskt proof-of-possession fra en ALLEREDE innrullert enhet som
--       tilhører SAMME person i SAMME tenant (dekker både ny enhet og
--       nøkkelrotasjon - en enhet kan re-nøkle seg selv), eller
--   (b) en engangs, kortlevd innrullerings-BILLETT fra denne tabellen,
--       opprettet av en EKSPLISITT lokal eier-handling
--       (`apps/api/src/enroll-ticket-main.ts`, kjørt med de ALLEREDE
--       eksisterende admin-DB-credentialene fra `.env.example`).
--
-- Billetten er bevisst en DB-rad og ikke en hardkodet bypass/miljøflagg: den
-- er engangs, utløper, er bundet til tenant/person (og valgfritt én
-- `device_id`), og hele bruken er reviderbar. Ingen NY ekstern credential
-- innføres - (b) bruker samme admin-rolle migrasjonene allerede kjører som.
CREATE TABLE device_enrollment_tickets (
  -- SHA-256 (hex) av engangs-hemmeligheten. Hemmeligheten selv vises ÉN gang,
  -- på eierens egen terminal, og lagres aldri noe sted.
  ticket_id          text PRIMARY KEY,
  tenant_id          text NOT NULL REFERENCES tenants (tenant_id),
  person_id          text NOT NULL REFERENCES people (person_id),
  -- Valgfri innsnevring til nøyaktig én device_id. NULL = enhver device_id
  -- for den bundne personen/tenanten (fortsatt engangs).
  device_id          text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  -- Engangsbruk håndheves med `UPDATE ... WHERE consumed_at IS NULL RETURNING`
  -- (atomisk test-and-set), aldri med en les-så-skriv-sekvens.
  consumed_at        timestamptz,
  consumed_device_id text
);
CREATE INDEX device_enrollment_tickets_open_idx
  ON device_enrollment_tickets (tenant_id, person_id) WHERE consumed_at IS NULL;

-- Minst mulig rettigheter, samme mønster som 005_rls.sql. UPDATE trengs for
-- tilbakekalling (`session_grants.revoked_at`) og for den atomiske
-- billettkonsumeringen - ALDRI DELETE på noen av dem.
GRANT SELECT, INSERT ON session_grants, device_enrollment_tickets TO jarvis_app;
GRANT UPDATE ON session_grants, device_enrollment_tickets TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['session_grants', 'device_enrollment_tickets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I
         USING (tenant_id = current_setting(''jarvis.tenant_id'', true))
         WITH CHECK (tenant_id = current_setting(''jarvis.tenant_id'', true))',
      t, t
    );
  END LOOP;
END
$$;

-- `/chat`/`/brief` sender KUN et grant-token: ingen `tenant_id`, ingen
-- `person_id`, ingen `memory_space`, ingen `channel`. Det er hele poenget -
-- ingenting identitetsbærende er klient-påstått lenger. Men `session_grants`
-- har `FORCE ROW LEVEL SECURITY`, så et RLS-skopet oppslag krever at
-- `jarvis.tenant_id` allerede ER satt. Samme henne-og-høna-problem, og samme
-- løsning, som `jarvis_list_business_tenant_ids()` (023, Q-27/D-65) og
-- `jarvis_list_all_tenant_ids()` (052): én smal SECURITY DEFINER-funksjon.
--
-- Funksjonen returnerer KUN `tenant_id`, og KUN for en oppgitt `grant_id`
-- (= SHA-256 av et token kalleren allerede må holde). Den lekker derfor
-- ingenting til noen som ikke allerede har tokenet, den svarer aldri på
-- «hvilke grants finnes», og den avgjør INGENTING om gyldighet: utløp,
-- tilbakekalling, nøkkel-fingerprint, person, enhet, space og kanal
-- verifiseres ETTERPÅ av det normale, RLS-skopede oppslaget i
-- `SessionGrantService.verify()`. Å slippe gjennom en tenant-ID her gir
-- altså ingen autoritet i seg selv.
CREATE FUNCTION jarvis_session_grant_tenant(p_grant_id text)
RETURNS text
SECURITY DEFINER
SET search_path = public
LANGUAGE sql STABLE AS $$
  SELECT g.tenant_id FROM session_grants g WHERE g.grant_id = p_grant_id;
$$;

-- Fail-closed leverandør-flate: PUBLIC har INGEN tilgang, KUN jarvis_app.
REVOKE ALL ON FUNCTION jarvis_session_grant_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jarvis_session_grant_tenant(text) TO jarvis_app;
