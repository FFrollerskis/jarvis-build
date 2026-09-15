-- UA-10 Proactive Situation Engine - Native Jarvis Situation Core (D-64
-- Core-vs-Adapter-porten kjørt FØRST, se docs/UA10_SITUATION_ENGINE_DESIGN.md):
-- Jarvis EIER selv den kanoniske hendelses-/situasjons-domenemodellen
-- (JARVIS_CANONICAL). Dette er BEVISST en ren KOMPOSISJONS-/tilstandslag-
-- migrasjon - INGEN nye anomali-detektorer bygges her (spend/pipeline-
-- deteksjon finnes ALLEREDE i `business_open_loops`/`OpenLoopService`,
-- infra/home/health har INGEN eksisterende signalkilde og er BEVISST
-- utsatt til egne fremtidige slicer, samme inkrementelle byggerekkefølge
-- som spend/pipeline-detektorene selv fikk over flere separate UA-3/4/6-
-- slicer). `SituationEngine.evaluateCandidate()` er en STABIL, provider-
-- nøytral inngangskontrakt en HVILKEN SOM HELST fremtidig kilde (en
-- business_open_loops-bro, et vision-/helse-/lokasjonshendelses-abonnement)
-- kan kalle uten å røre denne migrasjonen igjen - ZERO live kilde koblet
-- til i denne sliceen (samme "kontrakt FØR leverandør/kilde"-disiplin som
-- D-130/D-153 etablerte for UA-8/UA-9).
--
-- MULTI-SPACE (location-/business_open_loops-stil, IKKE health-stil
-- enkelt-låst space): situasjoner spenner naturlig over flere domener
-- (bedrift, personlig, hjem) - samme begrunnelse som `business_open_loops`
-- allerede bruker det generelle multi-space-mønsteret.
--
-- To tabeller:
--   1. `situation_notification_policies` - eier-konfigurert varslings-
--      policy per (tenant, space): stille timer (quiet hours) og et
--      re-varslingsvindu (resuppress) - EKSPLISITT konfigurert, Jarvis
--      GJETTER ALDRI (samme disiplin som retention-policyene i
--      location/health/vision).
--   2. `situations` - den kanoniske hendelses-/situasjons-tilstanden.
--      Tilstandsmaskin (masterplanens egen rekkefølge): ignore -> remember
--      -> inform -> suggest -> act -> act_notify -> escalate. `detection_key`
--      er den SAMME idempotente dedupe-nøkkelen som `business_open_loops`
--      sin - en gjentatt deteksjon av SAMME underliggende forhold oppdaterer
--      SAMME rad, oppretter ALDRI en duplikat (lukker masterplanens eget
--      akseptansekriterium "No duplicate spam for same event" strukturelt).
--
-- `act_*`-kolonnene er BEVISST tynne - selve klasse D-handlings-bevis
-- (before/after-state, recovery-prosedyre) lever ALLEREDE strukturelt i
-- `tool_executions`/audit-loggen (Q-34/D-130-hardnet ToolGateway-pipeline);
-- denne tabellen lagrer KUN en PEKER (tool_id/action + et kort resultat)
-- til DEN handlingen, ALDRI en dupliserert kopi av evidensen - samme
-- "peker, aldri kopi"-prinsipp som `source_type`/`source_instance_id`
-- andre steder i repoet.

CREATE TABLE situation_notification_policies (
  tenant_id           text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id     text NOT NULL DEFAULT 'business'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  -- NULL på BEGGE betyr "ingen stille timer konfigurert" (INFORM/SUGGEST kan
  -- nå eieren når som helst) - EKSPLISITT fravær, ikke en gjettet standard.
  -- Verdier er UTC-time [0,23]. Et vindu som krysser midnatt (f.eks. 22->6)
  -- støttes direkte av `isWithinQuietHours()` i service.ts.
  quiet_hours_start_utc integer CHECK (quiet_hours_start_utc IS NULL OR quiet_hours_start_utc BETWEEN 0 AND 23),
  quiet_hours_end_utc    integer CHECK (quiet_hours_end_utc IS NULL OR quiet_hours_end_utc BETWEEN 0 AND 23),
  -- Personvern-/varslingsstøy-beskyttende, ENDELIG standard (24 timer) i
  -- FRAVÆR av eier-konfigurasjon - samme "fravær av konfigurasjon betyr
  -- ALDRI et ubegrenset/farlig standardvalg"-prinsipp som location/vision
  -- sine retensjonsvinduer (MOTSATT retning av D-92 sin "disabled"
  -- fail-open-standard).
  resuppress_hours       integer NOT NULL DEFAULT 24 CHECK (resuppress_hours > 0),
  actor_person_id        text REFERENCES people (person_id),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, memory_space_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON situation_notification_policies TO jarvis_app;

ALTER TABLE situation_notification_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE situation_notification_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY situation_notification_policies_tenant ON situation_notification_policies
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY situation_notification_policies_space ON situation_notification_policies AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

CREATE TABLE situations (
  situation_id         text PRIMARY KEY,
  tenant_id             text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id       text NOT NULL DEFAULT 'business'
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  -- Fri-tekst-domenenavn (f.eks. 'spend','pipeline','deadlines','infra',
  -- 'home','health') - BEVISST IKKE en lukket CHECK-enum: nye domener
  -- (infra/home/health-detektorer) skal kunne begynne å kalle
  -- `evaluateCandidate()` UTEN en ny migrasjon, samme "domene-pause er
  -- navnebasert, ikke en forhåndsregistrert liste"-fleksibilitet som
  -- `DomainPauseRegistry` i service.ts krever.
  domain                text NOT NULL CHECK (length(domain) > 0),
  -- Sammensatt FK mot `person_tenants` legges IKKE til her - `owner_person_id`
  -- er BEVISST NULLABLE og UTEN medlemskaps-FK (samme presedens som
  -- `business_open_loops.owner_person_id`, se open-loop-service.ts sin
  -- kommentar): en situasjon speiler ofte en allerede-skjedd HENDELSE (et
  -- utgiftsavvik, en infra-alarm), ikke nødvendigvis en navngitt eiers
  -- personlige handling - å TVINGE et medlemskapsbevis her ville avvist
  -- gyldige eierløse situasjoner.
  owner_person_id       text REFERENCES people (person_id),
  -- Løs peker til kilden (ALDRI en kopi av kildedataene) - `NULL` er den
  -- normale P0-tilstanden siden INGEN live kilde er koblet til ennå.
  source_open_loop_id   text REFERENCES business_open_loops (open_loop_id),
  -- Idempotent deteksjon - SAMME "detection_key"-mønster som
  -- `business_open_loops` (020_business_open_loops.sql sin kommentar):
  -- en re-evaluering av SAMME underliggende forhold oppdaterer DENNE raden,
  -- oppretter ALDRI en duplikat.
  detection_key         text NOT NULL,
  stage                 text NOT NULL DEFAULT 'remember'
    CHECK (stage IN ('ignore','remember','inform','suggest','act','act_notify','escalate')),
  priority               text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  confidence             numeric CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  reason                 text NOT NULL,
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  -- Varslingsbokføring - grunnlaget `isResuppressWindowOpen()` (service.ts)
  -- bruker for å avgjøre om DENNE syklusen faktisk er "ny nok" til å telle
  -- som en NY varsling, ALDRI en stille duplikat-varsling for samme
  -- uendrede forhold.
  last_notified_at       timestamptz,
  -- Tynne pekere til DEN faktiske klasse D-handlingen (se filhode) - ALDRI
  -- en kopi av `tool_executions` sitt before/after-bevis.
  act_tool_id            text,
  act_action             text,
  -- KUN 'succeeded'/'denied' - den FINERE "unverified" postcondition-
  -- distinksjonen ToolGateway sin egen `tool_executions`-tabell fører
  -- (Q-34/D-130) er BEVISST IKKE duplisert her (samme "peker, aldri
  -- kopi"-prinsipp som filhodet dokumenterer) - fra `SituationEngine.
  -- actOn()` sitt ståsted er BÅDE en nektet OG en ubekreftet handling
  -- "ingen bekreftet suksess" (`ToolResult.ok === false` for begge, se
  -- gateway.ts sin egen kommentar om nøyaktig dette designvalget).
  act_result             text CHECK (act_result IS NULL OR act_result IN ('succeeded','denied')),
  opened_at              timestamptz NOT NULL DEFAULT now(),
  resolved_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, detection_key)
);
CREATE INDEX situations_queue_idx ON situations (tenant_id, memory_space_id, status, stage, priority);
CREATE INDEX situations_domain_idx ON situations (tenant_id, memory_space_id, domain, status);

-- Q-20-mønster: situasjoner er OPERASJONELL hendelsestilstand (som
-- `business_open_loops`), IKKE append-only systemrevisjon - `UPDATE` er
-- PÅKREVD for tilstandsmaskin-overganger (`evaluateCandidate()`/`actOn()`/
-- `resolve()`); `DELETE` er PÅKREVD for Q-20-erasure når `owner_person_id`
-- er satt (registreres i `modules/erasure/src/plan.ts` i en FREMTIDIG
-- slice når en person-scoped situasjon faktisk kan oppstå fra en live
-- kilde - P0 har INGEN live kilde, se filhode).
GRANT SELECT, INSERT, UPDATE, DELETE ON situations TO jarvis_app;

ALTER TABLE situations ENABLE ROW LEVEL SECURITY;
ALTER TABLE situations FORCE ROW LEVEL SECURITY;
CREATE POLICY situations_tenant ON situations
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY situations_space ON situations AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));
