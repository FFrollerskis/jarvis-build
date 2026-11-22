-- WP-N1 (Q-66, JARVIS-101): «begrenset»-merking av samtalehistorikken.
--
-- Problem: `messages` bar ingen merking. Et LOKALT svar fra en tur som er låst til SECRET_RESTRICTED (finans-/helseverktøy, D-381; minne fra
-- helse-rommet; rådet; Finans-/Verdi-senteret) kunne derfor ligge i historikken uten stikkord som trigger tekstklassifisereren, og følge med til en
-- senere tur som går til en SKYmodell (leverandørnavn, nødbryter-tilstand, AI-kostnad, saldo i omskrevet form).
--
-- Løsning (additiv, expand-only): én boolsk kolonne `messages.restricted` (standard false = som før). Samtalemotoren setter den KUN når
-- `JARVIS_RESTRICTED_CONTEXT_GUARD=on` (flagg AV = kolonnen settes aldri; alle eksisterende rader er og forblir false). Klassifiseringen leser den:
-- en merket rad regnes som SECRET_RESTRICTED uansett tekst (D-384/Q-51 D-partisjoneringen) og låser en tur lokalt når den blir værende i konteksten.
-- Eldre api-kode (uten kolonnen i spørringene) fungerer uendret mot den nye tabellen; ny kode krever migrasjonen (migrate-tjenesten kjører først).
--
-- Tilgang (minste privilegium, RLS/tenant-isolasjon uendret): app-rollen har kun SELECT/INSERT på `messages` (005). Den får nå UPDATE KUN på
-- kolonnen `restricted` (kolonne-nivå: innhold, rolle, sesjon og tenant kan fortsatt aldri endres av app-rollen), og en trigger gjør merket ENVEIS:
-- en begrenset melding kan aldri gjøres ubegrenset igjen (en feil i appen kan ikke fjerne en begrensning). `FORCE ROW LEVEL SECURITY` og
-- `messages_tenant_isolation` (005) gjelder også UPDATE (USING + WITH CHECK), så en tenant kan bare merke egne rader.

ALTER TABLE messages ADD COLUMN restricted boolean NOT NULL DEFAULT false;

CREATE FUNCTION messages_restricted_monotonic() RETURNS trigger AS $$
BEGIN
  IF OLD.restricted AND NOT NEW.restricted THEN
    RAISE EXCEPTION 'messages_restricted_monotonic: en begrenset melding kan aldri gjøres ubegrenset';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER messages_restricted_monotonic
  BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_restricted_monotonic();

GRANT UPDATE (restricted) ON messages TO jarvis_app;
