-- UA-10 Proactive Situation Engine - P1 AKTIVERING (D-160, se
-- docs/UA10_SITUATION_ENGINE_DESIGN.md §10). P0 (056_situations.sql, PR #85)
-- beviste at MEKANISMEN er trygg naar den kalles - men INGENTING kalte den:
-- ingen bro fra `business_open_loops`, ingen wiring, ingen leveranse av
-- INFORM/SUGGEST-varsler, ingen autonomi-grense. Denne migrasjonen legger
-- til de TO tingene aktiveringen trenger som VARIG tilstand:
--
--   1. INFORM/SUGGEST-leveransebokfoering paa `situations`. P0 stemplet
--      `last_notified_at` i selve `evaluateCandidate()`-transaksjonen
--      (dedupe-/resuppress-ANKERET), men ingen sendte varselet. Et varsel
--      som er "sendt" i bokfoeringen uten aa vaere LEVERT ville stille
--      undertrykt eierens varsling i hele resuppress-vinduet. Derfor
--      skilles naa ANKER (`last_notified_at`, uendret semantikk) fra
--      LEVERANSE (`inform_delivered_at`, settes KUN etter bekreftet
--      `ToolResult.ok === true` eller bekreftet `tool_executions`-bevis).
--      Selve varselteksten FRYSES (`inform_message`) ATOMISK med ankeret -
--      SAMME laerdom som `act_notify_message` (arkitekt-review runde 9,
--      PR #85): `reason` er MUTERBAR ved re-deteksjon, og en varsel-noekkel
--      avledet av muterbar tekst mister sitt eget bevis og dupliserer.
--
--   2. `situation_autonomy_policies` - eierens EKSPLISITTE autonomi-grense
--      per (tenant, space, domene): HVILKEN tool/action/parametre auto-ACT
--      faar kalle `actOn()` med for en situasjon som naar `suggest`.
--      FRAVAER av rad = INGEN auto-ACT (fail-closed) - samme "fravaer av
--      konfigurasjon betyr ALDRI et farlig standardvalg"-prinsipp som
--      resuppress_hours/retensjonsvinduene. Jarvis GJETTER ALDRI en
--      handling; masterplanens "ACT uses valid owner/delegated authority"
--      betyr her at EIEREN har bundet handlingen paa forhaand, OG at
--      `ToolGateway.execute()`/`PolicyGateway.authorize()` fortsatt
--      autoriserer HVERT enkelt kall (uendret).

ALTER TABLE situations
  -- Frosset INFORM/SUGGEST-varseltekst. Settes ATOMISK sammen med
  -- `last_notified_at` i `evaluateCandidate()` naar en syklus er
  -- `newly_actionable`; leveransen (service.ts `deliverPendingInformNotifications()`)
  -- avleder varsel-noekkelen mot `tool_executions` KUN av denne teksten +
  -- `last_notified_at`, ALDRI av `reason` lest paa nytt.
  ADD COLUMN inform_message      text,
  -- Settes KUN etter BEKREFTET leveranse, og alltid til NOEYAKTIG det
  -- `last_notified_at`-ankeret leveransen gjaldt - en NY syklus (nytt anker
  -- etter resuppress-vinduet) er dermed "ikke levert" igjen av konstruksjon,
  -- uten noen egen nullstilling.
  ADD COLUMN inform_delivered_at timestamptz,
  -- Tekst kan bare finnes naar det finnes et anker aa binde den til, og
  -- leveranse kan bare bokfoeres naar det finnes en tekst som ble levert.
  -- BEVISST IKKE "anker => tekst" (den strengere retningen): P0-rader som
  -- fikk et anker FOER denne migrasjonen har ingen frossen tekst, og de
  -- skal ikke gjoere migrasjonen umulig - de leveres ikke (query-en i
  -- service.ts krever `inform_message IS NOT NULL`) og faar en ny, komplett
  -- syklus naar resuppress-vinduet aapner igjen.
  ADD CONSTRAINT situations_inform_message_anchor_ck
    CHECK (inform_message IS NULL OR last_notified_at IS NOT NULL),
  ADD CONSTRAINT situations_inform_delivery_ck
    CHECK (inform_delivered_at IS NULL OR inform_message IS NOT NULL);

CREATE TABLE situation_autonomy_policies (
  tenant_id        text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id  text NOT NULL DEFAULT 'business'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  -- SAMME fri-tekst-domenenavn som `situations.domain` og
  -- `DomainPauseRegistry` - en policy binder ETT domene, aldri "alt".
  -- (`*`-pausen i `situation_domain_pauses` er en STOPP-grense og har
  -- BEVISST ingen "start alt"-motpart her.)
  domain           text NOT NULL CHECK (length(domain) > 0 AND domain <> '*'),
  tool_id          text NOT NULL CHECK (length(tool_id) > 0),
  action           text NOT NULL CHECK (length(action) > 0),
  -- Statiske, kanoniske parametre som sendes UENDRET til `actOn()` for
  -- HVER situasjon i domenet (pluss `situation_id`/`source_open_loop_id`
  -- som `runSituationSweep()` legger til fra situasjonens EGNE immutable
  -- felt - ALDRI `reason`, som er muterbar og ville brutt
  -- `act_operation_fingerprint`-bindingen ved en retry).
  parameters       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(parameters) = 'object'),
  enabled          boolean NOT NULL DEFAULT true,
  -- Den EIEREN som bandt handlingen. Sammensatt FK mot `person_tenants`
  -- (001_identity.sql, PRIMARY KEY (person_id, tenant_id)): aktoeren MAA
  -- vaere medlem av policyens EGET tenant - samme scope-safe moenster som
  -- `situations_owner_scope_fk` (056). Den SOVEREIGN-sjekken (aktoer ==
  -- konfigurert eier) haandheves i applikasjonskoden
  -- (`SituationEngine.setAutonomyPolicy()`, fail-closed uten konfigurert
  -- autoritet) - samme moenster som `DomainPauseRegistry.assertAuthorized()`.
  actor_person_id  text NOT NULL REFERENCES people (person_id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, memory_space_id, domain),
  CONSTRAINT situation_autonomy_policies_actor_scope_fk
    FOREIGN KEY (actor_person_id, tenant_id) REFERENCES person_tenants (person_id, tenant_id)
);

-- Eier-konfigurert policy (som `situation_notification_policies`), IKKE
-- hendelsesdata - BEVISST utelatt fra Q-20 memory-space-erasure
-- (modules/erasure/src/plan.ts), samme klassifisering som retensjons-
-- og varslingspolicyene.
GRANT SELECT, INSERT, UPDATE, DELETE ON situation_autonomy_policies TO jarvis_app;

ALTER TABLE situation_autonomy_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE situation_autonomy_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY situation_autonomy_policies_tenant ON situation_autonomy_policies
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY situation_autonomy_policies_space ON situation_autonomy_policies AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));
