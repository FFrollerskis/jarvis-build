-- WP-G2 (UA-8 Personal Twin, D-464) P1c: FAMILIE-/DELT-ROM-AUTORITET - medlemmer og roller, invitasjoner, per-medlem deling av helse/lokasjon og «på vegne av»-delegasjon.
--
-- BAKGRUNN (revisjon av det som fantes, D-130/Q-15): `memory_spaces` er tenant-skopet, IKKE person-skopet; `IdentityService.resolveIdentity()` gir enhver person med medlemskap + innrullert enhet i tenanten tilgang til HVERT rom tenanten har.
-- Det finnes derfor ingen per-person-ACL, og et «delt familierom» i en primær-tenant ville gitt hvert medlem tilgang til eierens personal/health/business-rom. Denne migrasjonen endrer ikke identitetsmodellen (D-131/JARVIS-084 røres ikke);
-- den legger et AUTORITETSLAG oppå: en familiesirkel bor i en (anbefalt DEDIKERT) tenant der kun rommet `shared` finnes, og alt som gjelder hva ett medlem kan se av et annet er EKSPLISITTE, tilbakekallbare rader.
--
-- STRENGESTE STANDARD (strukturelt, ikke konvensjonelt):
--   * helse og lokasjon er KUN synlig for personen selv. En annen person ser ingenting uten en deling (`family_shares`) som personen SELV har gitt: `granted_by_person_id = subject_person_id` er en CHECK, så ingen
--     (heller ikke eieren eller en kodefeil) kan opprette en deling på en annens vegne. Eieren har ingen «bakdør» til et medlems helse/lokasjon.
--   * en delegasjon («på vegne av») kan KUN gis av prinsipalen selv, har påkrevd utløp (maks 90 dager), og scope er en LUKKET liste uten penger, helse, kommunikasjon eller klasse D-handlinger.
--   * en invitasjon er bundet til EN bestemt person som allerede er innrullert i sirkel-tenanten, og kan KUN aksepteres av den personen selv (`decided_by_person_id = invitee_person_id`).
--   * medlemmets EGEN datatenant (`data_tenant_id`, der helse/lokasjon bor) velges av personen selv og verifiseres i tjenesten (medlem av tenanten, ved skriving og ved hver lesing) - IKKE med FK (tenant-kryssende FK er forbudt, JARVIS-076).
-- Alt er `shared`-rommet (CHECK) med tenant + RESTRICTIVE memory-space-RLS (samme mønster som resten). Hver rad er MERKET (regel 4): tenant, space, aktør, kilde, tidspunkt. Ingen hemmeligheter lagres.

CREATE TABLE family_members (
  tenant_id            text NOT NULL REFERENCES tenants (tenant_id),
  person_id            text NOT NULL,
  memory_space_id      text NOT NULL DEFAULT 'shared' CHECK (memory_space_id = 'shared'),
  role                 text NOT NULL CHECK (role IN ('owner', 'adult', 'child', 'guest')),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left', 'removed')),
  -- Tenanten der medlemmets EGNE data (lokasjon/helse) bor. Medlemmet velger den selv ved aksept; sirkel-tenanten selv er lov (Q-15-scenarioet).
  data_tenant_id       text NOT NULL,
  added_by_person_id   text NOT NULL,
  invitation_id        text,
  joined_at            timestamptz NOT NULL DEFAULT now(),
  ended_at             timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, person_id),
  CONSTRAINT family_members_ended_iff_inactive CHECK ((status = 'active') = (ended_at IS NULL)),
  FOREIGN KEY (person_id, tenant_id) REFERENCES person_tenants (person_id, tenant_id)
  -- `data_tenant_id` har BEVISST ingen FK: en FK mot en ANNEN tenants rad omgår RLS og er forbudt av scope-FK-vakten (JARVIS-076, baseline tom). At personen faktisk er medlem av datatenanten verifiseres i stedet av `FamilyService`
  -- mot `person_tenants` under datatenantens egen RLS-kontekst - ved aksept/innstilling (skriving) OG ved hver lesing av en delt kategori (fail closed hvis medlemskapet er borte).
);
-- Nøyaktig ÉN aktiv eier per sirkel (den suverene eieren).
CREATE UNIQUE INDEX family_members_one_owner_idx ON family_members (tenant_id) WHERE role = 'owner' AND status = 'active';

CREATE FUNCTION family_members_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.person_id IS DISTINCT FROM OLD.person_id OR NEW.memory_space_id IS DISTINCT FROM OLD.memory_space_id
     OR NEW.added_by_person_id IS DISTINCT FROM OLD.added_by_person_id THEN
    RAISE EXCEPTION 'family_members_immutable_column' USING ERRCODE = '23514';
  END IF;
  -- Rollen kan ikke endres på et aktivt medlem (en rolleendring er et nytt medlemskap: forlat/fjern, inviter på nytt) - ingen stille opprykk til eier/voksen.
  IF OLD.status = 'active' AND NEW.status = 'active' AND NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'family_members_role_immutable_while_active' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER family_members_guard BEFORE UPDATE ON family_members FOR EACH ROW EXECUTE FUNCTION family_members_guard();

CREATE TABLE family_invitations (
  invitation_id         text PRIMARY KEY,
  tenant_id             text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id       text NOT NULL DEFAULT 'shared' CHECK (memory_space_id = 'shared'),
  invitee_person_id     text NOT NULL,
  -- Eier kan ikke inviteres (det finnes nøyaktig én, den suverene eieren).
  role                  text NOT NULL CHECK (role IN ('adult', 'child', 'guest')),
  invited_by_person_id  text NOT NULL,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  decided_at            timestamptz,
  decided_by_person_id  text,
  -- Timebaserte intervaller (ikke «days»): kalenderdager følger sesjonens tidssone/sommertid, og grensen skal være nøyaktig det tjenesten beregner (ttl i timer/dager * 24 t).
  CONSTRAINT family_invitations_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '720 hours'),
  CONSTRAINT family_invitations_decided CHECK ((status = 'pending') = (decided_at IS NULL)),
  -- Bare invitert person selv kan akseptere eller avslå (egen autoritet); tilbakekall gjøres av en annen (eier).
  CONSTRAINT family_invitations_invitee_decides CHECK (status NOT IN ('accepted', 'declined') OR decided_by_person_id = invitee_person_id),
  CONSTRAINT family_invitations_not_self CHECK (invitee_person_id <> invited_by_person_id),
  UNIQUE (tenant_id, invitation_id),
  -- Den inviterte må allerede være innrullert i sirkel-tenanten (identitetsmodellen eier innrulleringen; denne tabellen oppretter aldri tilgang til en tenant).
  FOREIGN KEY (invitee_person_id, tenant_id) REFERENCES person_tenants (person_id, tenant_id),
  FOREIGN KEY (invited_by_person_id, tenant_id) REFERENCES person_tenants (person_id, tenant_id)
);
CREATE UNIQUE INDEX family_invitations_one_pending_idx ON family_invitations (tenant_id, invitee_person_id) WHERE status = 'pending';
CREATE INDEX family_invitations_lookup_idx ON family_invitations (tenant_id, status, created_at DESC);

-- Terminale statuser (accepted/declined/revoked/expired) endres aldri; kjernekolonner er uforanderlige.
CREATE FUNCTION family_invitations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invitation_id IS DISTINCT FROM OLD.invitation_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.invitee_person_id IS DISTINCT FROM OLD.invitee_person_id
     OR NEW.role IS DISTINCT FROM OLD.role OR NEW.invited_by_person_id IS DISTINCT FROM OLD.invited_by_person_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'family_invitations_immutable_column' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'family_invitations_terminal_status' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER family_invitations_guard BEFORE UPDATE ON family_invitations FOR EACH ROW EXECUTE FUNCTION family_invitations_guard();

-- Deling av PERSONLIGE data (helse-sammendrag, lokasjon) fra ett medlem (subjektet) til ett annet (seeren). Kun subjektet kan gi den (CHECK), kun to lukkede kategorier, og den kan tilbakekalles av begge parter.
CREATE TABLE family_shares (
  share_id               text PRIMARY KEY,
  tenant_id              text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id        text NOT NULL DEFAULT 'shared' CHECK (memory_space_id = 'shared'),
  subject_person_id      text NOT NULL,
  viewer_person_id       text NOT NULL,
  category               text NOT NULL CHECK (category IN ('location', 'health_summary')),
  granted_by_person_id   text NOT NULL,
  granted_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz,
  revoked_at             timestamptz,
  revoked_by_person_id   text,
  last_used_at           timestamptz,
  use_count              integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  CONSTRAINT family_shares_subject_grants CHECK (granted_by_person_id = subject_person_id),
  CONSTRAINT family_shares_not_self CHECK (viewer_person_id <> subject_person_id),
  CONSTRAINT family_shares_expiry CHECK (expires_at IS NULL OR (expires_at > granted_at AND expires_at <= granted_at + interval '8760 hours')),
  CONSTRAINT family_shares_revocation CHECK ((revoked_at IS NULL) = (revoked_by_person_id IS NULL)),
  UNIQUE (tenant_id, share_id),
  FOREIGN KEY (tenant_id, subject_person_id) REFERENCES family_members (tenant_id, person_id),
  FOREIGN KEY (tenant_id, viewer_person_id) REFERENCES family_members (tenant_id, person_id)
);
CREATE UNIQUE INDEX family_shares_one_active_idx ON family_shares (tenant_id, subject_person_id, viewer_person_id, category) WHERE revoked_at IS NULL;
CREATE INDEX family_shares_viewer_idx ON family_shares (tenant_id, viewer_person_id, category) WHERE revoked_at IS NULL;

CREATE FUNCTION family_shares_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.share_id IS DISTINCT FROM OLD.share_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.subject_person_id IS DISTINCT FROM OLD.subject_person_id
     OR NEW.viewer_person_id IS DISTINCT FROM OLD.viewer_person_id OR NEW.category IS DISTINCT FROM OLD.category OR NEW.granted_by_person_id IS DISTINCT FROM OLD.granted_by_person_id
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'family_shares_immutable_column' USING ERRCODE = '23514';
  END IF;
  -- En tilbakekalt deling åpnes aldri igjen (en ny deling er en ny rad med nytt samtykke).
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by_person_id IS DISTINCT FROM OLD.revoked_by_person_id) THEN
    RAISE EXCEPTION 'family_shares_revocation_final' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER family_shares_guard BEFORE UPDATE ON family_shares FOR EACH ROW EXECUTE FUNCTION family_shares_guard();

-- «På vegne av»: prinsipalen gir en annen person (agenten) rett til å gjøre NOEN lukkede ting i prinsipalens navn. Kun prinsipalen kan gi den; utløp er påkrevd; ingen penger, helse, kommunikasjon eller klasse D.
CREATE TABLE family_delegations (
  delegation_id         text PRIMARY KEY,
  tenant_id             text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id       text NOT NULL DEFAULT 'shared' CHECK (memory_space_id = 'shared'),
  principal_person_id   text NOT NULL,
  agent_person_id       text NOT NULL,
  scope                 text NOT NULL CHECK (scope IN ('shared_lists', 'shared_calendar')),
  granted_by_person_id  text NOT NULL,
  granted_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  revoked_at            timestamptz,
  revoked_by_person_id  text,
  CONSTRAINT family_delegations_principal_grants CHECK (granted_by_person_id = principal_person_id),
  CONSTRAINT family_delegations_not_self CHECK (agent_person_id <> principal_person_id),
  CONSTRAINT family_delegations_expiry CHECK (expires_at > granted_at AND expires_at <= granted_at + interval '2160 hours'),
  CONSTRAINT family_delegations_revocation CHECK ((revoked_at IS NULL) = (revoked_by_person_id IS NULL)),
  UNIQUE (tenant_id, delegation_id),
  FOREIGN KEY (tenant_id, principal_person_id) REFERENCES family_members (tenant_id, person_id),
  FOREIGN KEY (tenant_id, agent_person_id) REFERENCES family_members (tenant_id, person_id)
);
CREATE UNIQUE INDEX family_delegations_one_active_idx ON family_delegations (tenant_id, principal_person_id, agent_person_id, scope) WHERE revoked_at IS NULL;

CREATE FUNCTION family_delegations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.delegation_id IS DISTINCT FROM OLD.delegation_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.principal_person_id IS DISTINCT FROM OLD.principal_person_id
     OR NEW.agent_person_id IS DISTINCT FROM OLD.agent_person_id OR NEW.scope IS DISTINCT FROM OLD.scope OR NEW.granted_by_person_id IS DISTINCT FROM OLD.granted_by_person_id
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'family_delegations_immutable_column' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by_person_id IS DISTINCT FROM OLD.revoked_by_person_id) THEN
    RAISE EXCEPTION 'family_delegations_revocation_final' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER family_delegations_guard BEFORE UPDATE ON family_delegations FOR EACH ROW EXECUTE FUNCTION family_delegations_guard();

GRANT SELECT, INSERT, UPDATE, DELETE ON family_members, family_invitations, family_shares, family_delegations TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['family_members', 'family_invitations', 'family_shares', 'family_delegations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant ON %I
         USING (tenant_id = current_setting(''jarvis.tenant_id'', true))
         WITH CHECK (tenant_id = current_setting(''jarvis.tenant_id'', true))', t, t);
    EXECUTE format(
      'CREATE POLICY %I_space ON %I AS RESTRICTIVE
         USING (memory_space_id = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))
         WITH CHECK (memory_space_id = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))', t, t);
  END LOOP;
END
$$;
