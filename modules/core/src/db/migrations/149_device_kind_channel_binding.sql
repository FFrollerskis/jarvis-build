-- WP-S1 (JARVIS-111, Q-71, D-497): SERVER-SIDE KANALBINDING FOR STEP-UP - lukket enhetstype (K1).
--
-- PROBLEMET: `devices.kind` er fritekst som KLIENTEN oppgir ved innrulling, og `POST /session/authorize` tok kanalen fra klienten og ga `auth_strength = 'signed'` til enhver gyldig enhetssignatur uansett
-- kanal. Step-up godtar `signed` fra web/desktop/api/mobile, saa en kompromittert Watch, talegateway eller Telegram-bro kunne PAASTAA `web` og passere step-up. Kanalen var en paastand fra en klient med en
-- gyldig noekkel.
--
-- LOESNINGEN (se docs/runbooks/WPS1_STEPUP_CHANNEL_BINDING.md): en LUKKET enhetstype (`device_kind`) som settes KUN av serveren ved innrulling (billetten baerer typen), og en server-side tabell
-- type -> tillatte kanaler (packages/contracts/src/device-kind.ts, EN kilde) som autorisasjonskjernen haandhever (`observe`/`enforce`).
--
-- EXPAND/CONTRACT, append-only: den eksisterende fritekst-kolonnen `kind` BEHOLDES uendret (informativ etikett; ingen eksisterende rad eller kode brytes), og typen kommer i EN NY kolonne. Alle eksisterende rader
-- faar `legacy_unknown` med mindre fritekstverdien er en KJENT foerstepartsverdi (se CASE under; samme avbildning som `deviceKindFromLegacyLabel` i contracts, laast av en test). En raw INSERT uten
-- `device_kind` blir `legacy_unknown` (minste tillit som standard). `legacy_unknown` beholder dagens oppfoersel for kanaler som IKKE er step-up-kanaler, men kan aldri gi en oekt som oppfyller step-up.
--
-- `device_kind_source` sier HVEM som bestemte typen, saa eieren kan skille det han selv har valgt (`enrollment_ticket`) fra det som kun er utledet av en gammel, klient-oppgitt etikett (`legacy_label`, IKKE
-- verifisert av en eier-handling og skal gjennomgaas foer `enforce`). Invariant (CHECK): `legacy_unknown` <=> `unclassified`.
--
-- Rollback: forover-only (migratoren har ingen ned-migrasjoner). Kolonnene kan staa urort ved tilbakerulling av koden: eldre kode ignorerer dem, og `kind` er uendret. Sett
-- `JARVIS_STEPUP_CHANNEL_BINDING` tilbake til `observe` (standard) for aa gaa tilbake til dagens atferd.

ALTER TABLE devices
  ADD COLUMN device_kind text NOT NULL DEFAULT 'legacy_unknown'
    CONSTRAINT devices_device_kind_ck CHECK (device_kind IN ('iphone', 'mac', 'windows', 'web_browser', 'watch', 'voice_gateway', 'telegram_gateway', 'api_client', 'service', 'legacy_unknown')),
  ADD COLUMN device_kind_source text NOT NULL DEFAULT 'unclassified'
    CONSTRAINT devices_device_kind_source_ck CHECK (device_kind_source IN ('unclassified', 'legacy_label', 'enrollment_ticket', 'trusted_provisioning')),
  ADD CONSTRAINT devices_device_kind_source_consistent_ck CHECK ((device_kind = 'legacy_unknown') = (device_kind_source = 'unclassified'));

-- Backfill: kjente foerstepartsverdier -> lukket type (`web` fra nettsidene, `iphone`/`watch` fra appene, `service`/`voice` fra seed) og de lukkede navnene selv; alt annet (`phone`, `pc`, `mobile`,
-- `desktop-agent`, `api`, ...) er tvetydig og blir `legacy_unknown`/`unclassified`. EN setning, saa CHECK-invarianten gjelder hele veien. `btrim` fjerner kun vanlige mellomrom i endene (samme som TS).
UPDATE devices d
   SET device_kind = m.k,
       device_kind_source = CASE WHEN m.k = 'legacy_unknown' THEN 'unclassified' ELSE 'legacy_label' END
  FROM (
    SELECT device_id,
           CASE lower(btrim(kind))
             WHEN 'web' THEN 'web_browser'
             WHEN 'voice' THEN 'voice_gateway'
             WHEN 'iphone' THEN 'iphone'
             WHEN 'mac' THEN 'mac'
             WHEN 'windows' THEN 'windows'
             WHEN 'web_browser' THEN 'web_browser'
             WHEN 'watch' THEN 'watch'
             WHEN 'voice_gateway' THEN 'voice_gateway'
             WHEN 'telegram_gateway' THEN 'telegram_gateway'
             WHEN 'api_client' THEN 'api_client'
             WHEN 'service' THEN 'service'
             ELSE 'legacy_unknown'
           END AS k
      FROM devices
  ) m
 WHERE m.device_id = d.device_id;

-- Revisjon av hver klassifisering migrasjonen gjorde (en rad per enhet; antallet enheter er lite). `legacy_kind` er den gamle etiketten (avkortet), aldri nokkelmateriale.
INSERT INTO audit_events (tenant_id, person_id, device_id, type, decision, reason, payload, actor_kind, process)
SELECT tenant_id, person_id, device_id, 'device.kind_classified', 'ALLOW', 'migration_149_' || device_kind_source,
       jsonb_build_object('device_kind', device_kind, 'device_kind_source', device_kind_source, 'legacy_kind', left(kind, 64)),
       'system', 'migrate-149'
  FROM devices;

-- Billetten baerer typen. En eksisterende (ikke-konsumert) billett uten type blir `legacy_unknown`: enheten rulles inn uten step-up-evne til eieren utsteder en ny billett med type (billettene lever 15 minutter).
ALTER TABLE device_enrollment_tickets
  ADD COLUMN device_kind text NOT NULL DEFAULT 'legacy_unknown'
    CONSTRAINT device_enrollment_tickets_device_kind_ck CHECK (device_kind IN ('iphone', 'mac', 'windows', 'web_browser', 'watch', 'voice_gateway', 'telegram_gateway', 'api_client', 'service', 'legacy_unknown'));

-- STRUKTURELL VAKT: en enhets type (og kilden) kan kun endres av `DeviceService.registerDeviceOn()`, som setter `jarvis.device_kind_change = 'on'` i SAMME transaksjon etter at innrullingsreglene er vurdert
-- (kun en eier-billett endrer en eksisterende enhets type; `device_proof` endrer aldri typen). Enhver annen UPDATE som endrer typen (en fremtidig rute, en feil, raw SQL) avvises, og HVER endring revideres her
-- uansett hvilken kodevei som gjorde den (ogsaa en eier som retter typen med admin-SQL: sett variabelen i samme transaksjon, se runbooken). Dette er en vakt mot FEIL kodeveier, ikke mot en kompromittert
-- api-prosess (den kan sette variabelen selv); den som kan det har allerede skrivetilgang til tabellen.
CREATE FUNCTION jarvis_devices_kind_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('jarvis.device_kind_change', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'device_kind_change_not_authorized: %', OLD.device_id;
  END IF;
  INSERT INTO audit_events (tenant_id, person_id, device_id, type, decision, reason, payload, actor_kind)
  VALUES (NEW.tenant_id, NEW.person_id, NEW.device_id, 'device.kind_changed', 'ALLOW', 'device_kind_changed',
          jsonb_build_object('from', OLD.device_kind, 'to', NEW.device_kind, 'from_source', OLD.device_kind_source, 'to_source', NEW.device_kind_source),
          'system');
  RETURN NEW;
END
$$;
CREATE TRIGGER devices_kind_guard
  BEFORE UPDATE ON devices
  FOR EACH ROW
  WHEN (OLD.device_kind IS DISTINCT FROM NEW.device_kind OR OLD.device_kind_source IS DISTINCT FROM NEW.device_kind_source)
  EXECUTE FUNCTION jarvis_devices_kind_guard();
