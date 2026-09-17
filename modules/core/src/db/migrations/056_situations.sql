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

-- Arkitekt-review-runde 1 (PR #85, HEAD 767d100) Funn 2: `source_open_loop_id`
-- refererte tidligere KUN `business_open_loops.open_loop_id` (PK-only FK) -
-- ID-en ALENE beviser IKKE at raden faktisk hoerer til SAMME tenant+space
-- som situasjonen selv. `business_open_loops.open_loop_id` er allerede
-- global-unik (PK) - denne UNIQUE-en er derfor et RENT tillegg (alltid
-- oppfylt av PK-en), som gjoer den ETTERFOELGENDE sammensatte FK-en under
-- mulig: Postgres kan da HAANDHEVE (transaksjonelt, race-fritt - IKKE en
-- applikasjons-nivaa-sjekk som kan raake) at et `source_open_loop_id` en
-- situasjon peker paa alltid deler NOEYAKTIG tenant_id+memory_space_id med
-- situasjonen selv.
ALTER TABLE business_open_loops ADD CONSTRAINT business_open_loops_scope_uq UNIQUE (open_loop_id, tenant_id, memory_space_id);

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
  -- Funn 6 (arkitekt-review runde 2, PR #85): sammensatt scope-safe FK
  -- legges til RETT ETTER denne tabellens definisjon (se
  -- `situations_owner_scope_fk` under) - en `owner_person_id` som IKKE er
  -- MEDLEM av situasjonens EGET tenant avvises av databasen (MATCH SIMPLE -
  -- default - en NULL `owner_person_id`, den vanlige eierløse P0-tilstanden,
  -- trigger ALDRI sjekken).
  owner_person_id       text REFERENCES people (person_id),
  -- Løs peker til kilden (ALDRI en kopi av kildedataene) - `NULL` er den
  -- normale P0-tilstanden siden INGEN live kilde er koblet til ennå.
  -- Funn 2 (se over): scope-safe sammensatt FK legges til RETT ETTER denne
  -- tabellens egen definisjon (kolonnene må eksistere først).
  source_open_loop_id   text,
  -- Idempotent deteksjon - SAMME "detection_key"-mønster som
  -- `business_open_loops` (020_business_open_loops.sql sin kommentar):
  -- en re-evaluering av SAMME underliggende forhold oppdaterer DENNE raden,
  -- oppretter ALDRI en duplikat. Funn 1 (arkitekt-review runde 1, PR #85):
  -- kollisjonsdomenet MÅ inkludere `memory_space_id` - to ulike memory
  -- spaces skal kunne ha SIN EGEN situasjon for samme fri-tekst
  -- `detection_key` uten å kollidere (samme flerspace-disiplin som resten
  -- av tabellen) - se UNIQUE-en under (erstatter den tidligere
  -- (tenant_id, detection_key)-only UNIQUE-en).
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
  -- Funn 3 (arkitekt-review runde 1, PR #85): et ATOMISK, VARIG "claim" på
  -- raden FØR noe eksternt `ToolGateway.execute()`-kall gjøres -
  -- `act_idempotency_key` er den EKTE idempotens-nøkkelen som BÅDE denne
  -- raden OG selve `ToolGateway.execute()`-kallet bruker. Første `actOn()`-
  -- kall som klarer å sette denne (WHERE-betinget UPDATE, se service.ts)
  -- "vinner" claimen; et SENERE `actOn()`-forsøk med en ANNEN nøkkel for
  -- SAMME situasjon avvises FØR noe eksternt kall gjøres. Et forsøk med
  -- SAMME nøkkel (en legitim retry etter en krasj mellom det eksterne
  -- kallet og den avsluttende persisteringen under) claimer på nytt trygt -
  -- `ToolGateway.execute()` sin EGEN idempotency_key-dedupe (tool_executions)
  -- garanterer at selve SIDE-EFFEKTEN aldri gjentas.
  act_idempotency_key    text,
  act_claimed_at          timestamptz,
  -- Funn 1 (arkitekt-review runde 2, PR #85): `act_idempotency_key` ALENE
  -- bandt IKKE selve OPERASJONEN (tool_id/action/parametre) - en SENERE
  -- `actOn()`-kall for SAMME situasjon med SAMME nøkkel, men et ANNET
  -- tool_id/action/parametersett, ble tidligere sluppet gjennom claimen (kun
  -- nøkkel-likhet ble sjekket) og kunne ende med å skrive et FEILAKTIG
  -- "succeeded"-resultat for en handling som ALDRI faktisk ble utført (den
  -- opprinnelige, ANNERLEDES handlingen sitt bekreftede resultat ble
  -- gjenbrukt). Denne kolonnen lagrer en SHA-256-fingeravtrykk av HELE den
  -- immutable operasjonen (situation_id + tool_id + action + kanonisk
  -- parametre - se `computeActOperationFingerprint()` i service.ts) satt
  -- ATOMISK SAMTIDIG med selve claimen - en retry med SAMME nøkkel, men et
  -- ULIKT fingeravtrykk, avvises EKSPLISITT (`SituationActOperationMismatchError`).
  act_operation_fingerprint text,
  -- Funn 1 (arkitekt-review runde 9, PR #85): den EKSAKTE varselteksten
  -- ACT+NOTIFY sender, FROSSET ATOMISK SAMMEN med selve claimen (fra raden
  -- låst med FOR UPDATE i claim-transaksjonen). Varsel-nøkkelen mot
  -- `tool_executions` avledes KUN av denne teksten (`computeNotifyKey()` i
  -- service.ts) - ALDRI av `reason`, som `evaluateCandidate()` fortsatt
  -- oppdaterer ved en re-deteksjon OGSÅ etter at stadiet har nådd 'act'.
  -- Uten frysing kunne en retry etter krasj (bekreftet varsel, men
  -- stage='act_notify' aldri persistert) regne ut en ANNEN nøkkel fra en
  -- endret `reason`, aldri finne beviset, og sende et DUPLIKAT. CHECK-en
  -- `situations_act_claim_tuple_ck` under gjør en claim UTEN frossen tekst
  -- (eller enhver annen DELVIS claim/frigjøring) strukturelt umulig.
  act_notify_message     text,
  opened_at              timestamptz NOT NULL DEFAULT now(),
  resolved_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- Funn 1 (arkitekt-review runde 10, PR #85): claimen er ETT ATOMISK
  -- TUPPEL over alle fire feltene - enten er ALLE NULL (uclaimet/frigjort)
  -- eller ALLE satt (claimet). Runde 9 sin CHECK dekket kun "nøkkel =>
  -- melding", så en UPDATE som nullet KUN `act_idempotency_key` (og lot
  -- claimed_at/fingeravtrykk/melding stå) passerte både CHECK og trigger -
  -- neste `actOn()` ville sett raden som uclaimet og kunne claimet/utført
  -- en ANNEN operasjon oppå eksisterende claim/bevis (duplikat ekstern
  -- utførelse). Tilsvarende for nøkkel+melding uten fingeravtrykk. Denne
  -- CHECK-en avviser ENHVER delvis-NULL-permutasjon; triggeren under avviser
  -- enhver delvis-ERSTATNING mens claimen står. Sammen tillater de KUN:
  -- komplett NULL -> claimet, uendret claimet, komplett claimet -> NULL.
  CONSTRAINT situations_act_claim_tuple_ck CHECK (
    (act_claimed_at IS NULL AND act_idempotency_key IS NULL
      AND act_operation_fingerprint IS NULL AND act_notify_message IS NULL)
    OR
    (act_claimed_at IS NOT NULL AND act_idempotency_key IS NOT NULL
      AND act_operation_fingerprint IS NOT NULL AND act_notify_message IS NOT NULL)
  ),
  UNIQUE (tenant_id, memory_space_id, detection_key)
);
CREATE INDEX situations_queue_idx ON situations (tenant_id, memory_space_id, status, stage, priority);

-- Funn 1 (arkitekt-review runde 9, PR #85), skjerpet i runde 10: claim-
-- feltene er IMMUTABLE så lenge claimen står. CHECK-en
-- `situations_act_claim_tuple_ck` over garanterer at claimen ALLTID er et
-- KOMPLETT tuppel (alle fire NULL eller alle fire satt); denne triggeren
-- garanterer at INGEN av de fire (`act_claimed_at`, nøkkel, operasjons-
-- fingeravtrykk, frossen varseltekst) kan ENDRES av noen som helst senere
-- UPDATE (uansett kodesti) mens claimen står. Tillatt er kun selve claimen
-- (komplett NULL -> satt, `actOn()`) og en eksplisitt, KOMPLETT frigjøring
-- (satt -> NULL for alle fire, `releaseStuckActClaim()`); en delvis
-- frigjøring stoppes av CHECK-en, en delvis erstatning av denne triggeren.
-- Samme plpgsql-/RAISE-mønster som repoets append-only-triggere
-- (002_sessions_events.sql, 004_audit_cost.sql, 008_memory.sql).
CREATE OR REPLACE FUNCTION situations_act_claim_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.act_idempotency_key IS NOT NULL AND NEW.act_idempotency_key IS NOT NULL AND (
       NEW.act_claimed_at IS DISTINCT FROM OLD.act_claimed_at
    OR NEW.act_idempotency_key IS DISTINCT FROM OLD.act_idempotency_key
    OR NEW.act_operation_fingerprint IS DISTINCT FROM OLD.act_operation_fingerprint
    OR NEW.act_notify_message IS DISTINCT FROM OLD.act_notify_message
  ) THEN
    RAISE EXCEPTION 'situations_act_claim_immutable: claim-feltene kan ikke endres mens claimen staar (situation_id=%)', OLD.situation_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER situations_act_claim_immutable
  BEFORE UPDATE ON situations
  FOR EACH ROW EXECUTE FUNCTION situations_act_claim_immutable();
CREATE INDEX situations_domain_idx ON situations (tenant_id, memory_space_id, domain, status);

-- Funn 2 (se kommentaren over `business_open_loops_scope_uq`): scope-safe
-- sammensatt FK - en `source_open_loop_id` som IKKE tilhoerer NOEYAKTIG
-- SAMME (tenant_id, memory_space_id) som situasjonen selv, avvises av
-- databasen selv (MATCH SIMPLE - default - betyr at en NULL
-- `source_open_loop_id`, den normale P0-tilstanden, aldri trigger sjekken).
ALTER TABLE situations ADD CONSTRAINT situations_source_open_loop_scope_fk
  FOREIGN KEY (source_open_loop_id, tenant_id, memory_space_id)
  REFERENCES business_open_loops (open_loop_id, tenant_id, memory_space_id);

-- Funn 6 (arkitekt-review runde 2, PR #85): en NULLABLE `owner_person_id`
-- betyr IKKE at scope-integritet kan droppes NÅR den faktisk er satt - uten
-- denne sammensatte FK-en kunne en `owner_person_id` fra et HELT ANNET
-- tenant lagres på en situasjon (kun `people`-eksistens ble sjekket, ALDRI
-- medlemskap). `person_tenants` sin egen PK `(person_id, tenant_id)`
-- gjoer denne referansen mulig direkte, ingen ny UNIQUE noedvendig.
ALTER TABLE situations ADD CONSTRAINT situations_owner_scope_fk
  FOREIGN KEY (owner_person_id, tenant_id)
  REFERENCES person_tenants (person_id, tenant_id);

-- Funn 6 (arkitekt-review runde 1, PR #85): `DomainPauseRegistry` sin
-- rene in-memory-tilstand (domain-pause.ts) er PROSESS-LOKAL og
-- OMSTART-FLYKTIG - SAMME "fase 1-skjelett"-begrensning som `KillSwitch`
-- (modules/policy/src/kill-switch.ts) og `OwnerControls`
-- (modules/policy/src/authority.ts) ALLEREDE har i DAG, IKKE en ny,
-- UA-10-spesifikk brist. Denne tabellen gir `DomainPauseRegistry` en
-- VARIG *Durable*-variant (se domain-pause.ts sine `*Durable()`-metoder +
-- `restore()`) - en omstart GLEMMER IKKE lenger en aktiv pause
-- (fail-CLOSED oppstartsgjenoppretting) NÅR en pool er gitt ved
-- konstruksjon og `restore()` kalles. INGEN tenant-scoping/RLS her med
-- vilje: en pause er en EIER-/SOVEREIGN-handling (samme globale, ikke
-- tenant-partisjonerte omfang som `KillSwitch` selv - `isPaused(domain)`
-- har ALDRI tatt en tenant-parameter). Ekte SANNTIDS tvers-av-prosess-
-- konsistens (flere SAMTIDIG kjørende worker-prosesser) er FORTSATT IKKE
-- dekket i P0 (kun omstart-av-SAMME-prosess-varighet) - flagget eksplisitt
-- i domain-pause.ts sitt filhode, ikke stilltiende utelatt.
CREATE TABLE situation_domain_pauses (
  domain      text PRIMARY KEY,
  reason      text NOT NULL,
  paused_by   text REFERENCES people (person_id),
  paused_at   timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON situation_domain_pauses TO jarvis_app;

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
