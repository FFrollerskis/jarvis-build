-- Fase 2: identitetsfundament (CANONICAL_SPEC §3, TENANT_MODEL.md)

CREATE TABLE tenants (
  tenant_id  text PRIMARY KEY,
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('person', 'business')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE people (
  person_id    text PRIMARY KEY,
  display_name text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Medlemskap: hvilke tenants en person har tilgang til, med rolle.
CREATE TABLE person_tenants (
  person_id text NOT NULL REFERENCES people (person_id),
  tenant_id text NOT NULL REFERENCES tenants (tenant_id),
  role      text NOT NULL DEFAULT 'owner',
  PRIMARY KEY (person_id, tenant_id)
);

CREATE TABLE organizations (
  org_id     text PRIMARY KEY,
  tenant_id  text NOT NULL REFERENCES tenants (tenant_id),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  project_id text PRIMARY KEY,
  tenant_id  text NOT NULL REFERENCES tenants (tenant_id),
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sites (
  site_id    text PRIMARY KEY,
  tenant_id  text NOT NULL REFERENCES tenants (tenant_id),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rooms (
  room_id    text PRIMARY KEY,
  site_id    text NOT NULL REFERENCES sites (site_id),
  tenant_id  text NOT NULL REFERENCES tenants (tenant_id),
  name       text NOT NULL
);

CREATE TABLE devices (
  device_id      text PRIMARY KEY,
  tenant_id      text NOT NULL REFERENCES tenants (tenant_id),
  person_id      text NOT NULL REFERENCES people (person_id),
  kind           text NOT NULL,
  -- Offentlig nøkkel for signerte godkjenninger (fase 3 kobler denne til Policy Gateway).
  public_key_pem text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Memory spaces per tenant (space-RLS på minnetabellene kommer i fase 4 sammen med tabellene).
CREATE TABLE memory_spaces (
  memory_space_id text PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants (tenant_id),
  space           text NOT NULL CHECK (space IN ('personal','business','project','health','home','guest','shared')),
  UNIQUE (tenant_id, space)
);
