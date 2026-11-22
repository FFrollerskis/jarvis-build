-- WP-G3 (D-465), UA-9 Vision & Physical World, del 5: «åpning» som hendelsestype.
--
-- 055_vision.sql sitt lukkede MVP-sett (v1) hadde fem hendelsestyper og sa at settet "utvides NÅR en faktisk kilde/brukstilfelle
-- krever det". Masterplanen (UA-9) og byggeordren nevner dørklokke-/sikkerhetshendelser: bevegelse, dørklokke og ÅPNING. Home
-- Assistant leverer åpningssensorer (dør/vindu/garasje) som en egen sensorklasse, og en åpning er hverken bevegelse, tilstedeværelse
-- eller et sikkerhetsvarsel - den får derfor en egen type. Settet forblir LUKKET: ukjente typer avvises fortsatt av både zod-skjemaet
-- (types.ts) og denne CHECK-en, og modellutdata kan aldri introdusere en ny type (classifier.ts avviser det).

DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'vision_event_observations'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%event_type%' LOOP
    EXECUTE format('ALTER TABLE vision_event_observations DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;
ALTER TABLE vision_event_observations ADD CONSTRAINT vision_event_observations_event_type_check
  CHECK (event_type IN ('object_detected','person_present','motion_detected','doorbell_event','security_alert','opening_detected'));
