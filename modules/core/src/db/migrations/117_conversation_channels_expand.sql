-- WP-G1 (D-463, UA-7 Communications Hub - resterende kanaler): Conversation Graph får alle UA-7-kanalene.
-- Forward-safe (expand-only): to CHECK-constraints på `conversation_channel_links` utvides (flere tillatte verdier). Ingen kolonne, tabell, rad eller indeks endres.
--
-- 046 ga kun `email`/`telegram` (D-119: «fremtidige kanaler utvides additivt - ny CHECK-verdi - når en UA-7-slice faktisk bygger kanalen»). Denne migrasjonen er den additive utvidelsen:
--   channel:      + slack, discord, whatsapp, sms, teams, messenger, instagram, phone
--   match_method: + exact_phone_e164 (nøyaktig samme E.164-nummer), exact_handle (nøyaktig samme kanal-spesifikke bruker-id), contact_sync (kontaktsynk der leverandøren selv knytter nummeret/e-posten)
-- Identifikatorene normaliseres av `normalizeChannelIdentifier` (modules/conversation-graph/src/normalize.ts) - eksakt, aldri fuzzy, aldri et gjettet landnummer. Confidence, reversibel merge/split og
-- den delvis unike indeksen på (tenant, kanal, identifikator) for AKTIVE lenker er UENDRET. `CONVERSATION_CHANNELS` i TypeScript speiler denne listen (låst av test).
--
-- Constraint-navnene slås opp via definisjonen (ikke hardkodet): 046 definerte dem inline, og et navn kan ha endret seg i en miljø-spesifikk reparasjon. Feiler oppslaget (0 treff), stopper migrasjonen høyt.
DO $$
DECLARE
  chan_con  name;
  match_con name;
BEGIN
  SELECT c.conname INTO chan_con FROM pg_constraint c
   WHERE c.conrelid = 'conversation_channel_links'::regclass AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%channel = ANY%' AND pg_get_constraintdef(c.oid) NOT LIKE '%match_method%' AND pg_get_constraintdef(c.oid) NOT LIKE '%status%';
  SELECT c.conname INTO match_con FROM pg_constraint c
   WHERE c.conrelid = 'conversation_channel_links'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%match_method%';
  IF chan_con IS NULL OR match_con IS NULL THEN
    RAISE EXCEPTION '117: fant ikke CHECK-constraintene på conversation_channel_links (channel=%, match_method=%)', chan_con, match_con;
  END IF;
  EXECUTE format('ALTER TABLE conversation_channel_links DROP CONSTRAINT %I', chan_con);
  EXECUTE format('ALTER TABLE conversation_channel_links DROP CONSTRAINT %I', match_con);
END
$$;

ALTER TABLE conversation_channel_links
  ADD CONSTRAINT conversation_channel_links_channel_check
  CHECK (channel IN ('email', 'telegram', 'slack', 'discord', 'whatsapp', 'sms', 'teams', 'messenger', 'instagram', 'phone'));

ALTER TABLE conversation_channel_links
  ADD CONSTRAINT conversation_channel_links_match_method_check
  CHECK (match_method IN ('exact_email', 'owner_configured', 'manual', 'exact_phone_e164', 'exact_handle', 'contact_sync'));
