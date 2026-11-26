-- WP-G4b K2 (D-484, Q-75 pkt 7, JARVIS-115 a): autonomi-bindingen kan skopes til EN REGEL eller EN KATEGORI i stedet for hele domenet.
-- Bygger paa 057 (situation_autonomy_policies) og 139 (signalregler). Append-only: ingen eksisterende migrasjon er endret.
--
-- Tidligere gjaldt EN binding per (tenant, rom, domene) ALLE situasjoner i domenet som naadde `suggest` (lekkasje, alarm, aapen port ...). Naa kan eieren
-- binde en handling til en enkelt regel (`rule:<kilde>:<hendelsestype>`, f.eks. aapen garasjeport) eller en kategori (`category:<navn>`) uten aa gi hele domenet
-- autonomi. Bakoverkompatibelt: alle eksisterende rader faar scope_key = '*' (= alle regler, domenebred), og en domenebred binding virker som foer.
-- Presedens og tak (haandheves i applikasjonen, `autonomy-scope.ts`): regel > kategori > domene; den mest spesifikke raden avgjoer (ogsaa naar den er avslaatt =
-- eksplisitt unntak), og en smalere binding kan aldri gi mer enn den brede: er en domenebred binding avslaatt/utloept, er smalere bindinger i domenet uvirksomme.
-- Fysiske handlinger er aldri bindbare (G4/K1-vaktene gjelder uansett scope).
--
-- 1) Binding: scope_key inn i primaernoekkelen. Tenant/rom-RLS (FORCE, 057), RESTRICTIVE rom-policy og det sammensatte FK-et (actor_person_id, tenant_id) -> person_tenants
--    er uendret (radene er fortsatt tenant- og rom-skopet; kolonnen arver tabellens GRANT).
ALTER TABLE situation_autonomy_policies
  ADD COLUMN scope_key text NOT NULL DEFAULT '*'
    CONSTRAINT situation_autonomy_policies_scope_key_ck
    CHECK (scope_key = '*' OR scope_key ~ '^(rule:[a-z_]{3,30}:[a-z_]{3,60}|category:[a-z][a-z_]{2,40})$');
ALTER TABLE situation_autonomy_policies DROP CONSTRAINT situation_autonomy_policies_pkey;
ALTER TABLE situation_autonomy_policies ADD CONSTRAINT situation_autonomy_policies_pkey PRIMARY KEY (tenant_id, memory_space_id, domain, scope_key);

-- 2) Situasjonen baerer regelen som VANT (samme vinner-semantikk som prioritet og begrunnelse, `no_downgrade`): saa er koblingen situasjon -> regel aldri avhengig av at en loggrad
--    er skrevet (loggen skrives i en egen transaksjon etter evalueringen). NULL = situasjonen kommer fra en av de eldre sveipene (ingen regel); da gjelder kun en domenebred binding.
--    Samme format som situation_feedback.rule_key / situation_rule_tuning.rule_key (139).
ALTER TABLE situations
  ADD COLUMN rule_key text
    CONSTRAINT situations_rule_key_ck
    CHECK (rule_key IS NULL OR rule_key ~ '^[a-z_]{3,30}:[a-z_]{3,60}$');
