# Jarvis masterplan HF3 - Jarvis Multi-Company Identity, Trust & Platform Operations Masterplan v1.3 FINAL (tekstkonvertering)

> Konvertert automatisk fra `HF3_Jarvis_Multi_Company_Identity_Trust_Platform_Operations_Masterplan_v1.3_FINAL.pdf` (`pdftotext -layout`; én fenced blokk per side, sidemarkører beholdt som i
> `02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md`). **PDF-en er originalkilden ved tvil** om formatering, tabeller og sidetall:
> `docs/input/pdf/HF3_Jarvis_Multi_Company_Identity_Trust_Platform_Operations_Masterplan_v1.3_FINAL.pdf`. Teksten er ikke redigert. Dokumentstatus (mottatt som input 2026-11-26, ikke formelt adoptert; ingenting her er et krav
> før eieren har truffet en navngitt D-beslutning, ADR-001 §2.1) og hvilken fil som er hvilken plan: `docs/input/README.md`.

---

<!-- side 1 -->

```text
                                                                  JARVIS | Multi-Company Identity, Trust & Platform Operations | v1.3 FINAL




                                              JARVIS
           MULTI-COMPANY IDENTITY, TRUST &
               PLATFORM OPERATIONS
                                  MASTERPLAN v1.3 FINAL

Styrende prinsipp
Ingen enkeltperson, enhet, modell, credential, server eller administratorkonto skal alene kunne kompromittere alle Jarvis-
organisasjoner i det skjulte. Juridisk selskap er fortsatt tenant-grensen, men v1.3 legger et eksplisitt Platform Plane rundt
tenancy-modellen: juridisk plattformeier, AI-datastrømmer, endepunktssikkerhet, deteksjon, tamper-evident audit,
miljøisolasjon, platform-secrets, succession og operativ drift.




                                            Utarbeidet for Jarvis-plattformen
                                                    13. august 2026




                                          13.08.2026 | Binding design base after export gate
```

---

<!-- side 2 -->

```text
                                                                    JARVIS | Multi-Company Identity, Trust & Platform Operations | v1.3 FINAL

0. v1.3 FINAL - hva denne masterplanen gjør
Dette dokumentet erstatter Multi-Company v1.0, v1.1 og v1.2 FINAL som samlet styringsplan. Alt som var bindende i v1.2
beholdes med mindre v1.3 eksplisitt presiserer eller strammer inn regelen. v1.3 lukker ni nye reelle hull rundt selve
plattformen og innfører fem operative forbedringer slik at security, drift og juridisk ansvar ikke stopper ved tenant-grensen.
 Område                                     v1.3 status                                          Bindende resultat

 Tenant / company isolation                 Beholdt                                              Organization = juridisk selskap; data, penger,
                                                                                                 credentials, memory og authority er org-bound.

 Platform legal ownership                   Ny / låst                                            Kundeoppfølging AS er initial Platform
                                                                                                 Operator; pappas selskap onboardes som
                                                                                                 ekstern tenant med DPA + service agreement
                                                                                                 før persondata kobles.

 Human bus factor                           Ny / låst                                            Succession/continuity pack og minst to
                                                                                                 recovery-custodians før ekstern produksjon.

 Compromised endpoint                       Ny / låst                                            High-risk handlinger kan kreve distinct-device
                                                                                                 approval; global device revoke og posture-
                                                                                                 policy.

 AI provider data boundary                  Ny / låst                                            Per-org modellpolicy, dataklassifisering,
                                                                                                 subprocessor/transfer-registry og provider
                                                                                                 deny/allow.

 Membership truth                           Ny / låst                                            ZITADEL autentiserer; Jarvis DB er eneste
                                                                                                 authority-kilde for memberships/roles/limits.

 Detection + alerting                       Ny / låst                                            Security Event & Alert Plane er production
                                                                                                 gate, ikke valgfri observability.

 Audit integrity                            Ny / låst                                            Audit hash-kjeding + signerte checkpoints til
                                                                                                 separat retention-lagring.

 Environment isolation                      Ny / låst                                            Dev/staging/prod har separate credentials og
                                                                                                 datasett; prod-data/secrets er default deny
                                                                                                 utenfor prod.

 Platform secrets                           Ny / låst                                            Infrastructure credentials får eget platform-
                                                                                                 vault/registry og er utilgjengelige for tenant
                                                                                                 workers.

 Secure SDLC                                Ny / låst                                            RLS migration lint + automatiske tenant-escape
                                                                                                 regresjonstester på hver relevant commit.

 Operations realism                         Ny / låst                                            Patch/CVE, run-rate, IdP operating-model gate
                                                                                                 og faste DR-targets blir en del av DoD.



 Final-prinsipp
 MC er fortsatt et tverrgående tenancy- og authority-lag i Grunnprogrammet, Universal Access og Evolution. v1.3 legger i
 tillegg et Platform Plane og et Operations Plane rundt disse. Det skal fortsatt finnes én IdP-adapter, ett Connections
 Center, én Policy Gateway/Class D-motor, én Finance Gateway, ett Credential Registry per domene og ett Recovery
 Plane.



0.1 Programhierarki og single source of truth
 Domene                                     Autoritativ kilde                                    v1.3-regel

 Identity proof                             ZITADEL via intern OIDC-adapter                      IdP beviser hvem brukeren er. IdP-roller er ikke
                                                                                                 Jarvis authority.

 Membership / roles / limits                Jarvis PostgreSQL                                    organization_memberships + authority_policies
                                                                                                 er eneste beslutningsgrunnlag for company
                                                                                                 access.

 Policy / Class D                           Eksisterende Policy Gateway                          Org, data class, device trust, amount og
                                                                                                 mandate evalueres i samme motor.

 Connections                                UA Connections Center + registry                     MC legger org, AI-policy, provider verification
                                                                                                 og lifecycle på samme connection.

 Secrets                                    Infisical + SecretProvider                           Tenant-secrets og Platform-secrets ligger i
                                                                                                 separate security-domener.




                                            13.08.2026 | Binding design base after export gate
```

---

<!-- side 3 -->

```text
                                                                       JARVIS | Multi-Company Identity, Trust & Platform Operations | v1.3 FINAL
    Domene                                    Autoritativ kilde                                    v1.3-regel

    Workers / tools                           UA runtime                                           Én aktiv org per job; ingen platform-root
                                                                                                   capabilities i tenant worker.

    Finance                                   Eksisterende Finance Gateway                         Ingen nummer-to penge-gateway.

    Audit / detection                         Audit Ledger + Security Event Plane                  Prevention, detection, alert, containment og
                                                                                                   recovery blir én kontrollkjede.




0.2 Bindende anti-duplisering
Én IdP-adapter. Ett Connections Center. Én Policy Gateway. Én Class D-motor. Én Finance Gateway. Ett tenant Credential
Registry. Ett Platform Secret Registry. Ett Recovery Plane. Én Security Event/Alert-tjeneste. Nye krav utvider disse
komponentene; de oppretter ikke parallelle autoritetskilder.


1. Platform Operator - juridisk og operativ eier av Jarvis
    Bindende v1.3-beslutning
    Kundeoppfølging AS er initial juridisk Platform Operator for Jarvis. Holding Sørby Solution AS kan eie aksjer/IP eller motta
    portfolio-data som tenant, men Platform Operator er selskapet som inngår plattformavtaler, drifter systemet og opptrer
    som databehandler når Jarvis behandler personopplysninger på vegne av andre selskaper. Hvis Jarvis senere skilles ut i
    eget AS, brukes en kontrollert Platform Operator Transfer-runbook.



1.1 Tre separate juridiske roller
    Rolle                                     Day-1 enhet                                          Ansvar

    Platform Operator                         Kundeoppfølging AS                                   Driver Jarvis, inngår leverandøravtaler,
                                                                                                   holder platform-secrets, står for drift/support
                                                                                                   og processor-forpliktelser.

    Tenant / behandlingsansvarlig             Hver juridiske bedrift                               Bestemmer formål, data, medlemmer,
                                                                                                   modellpolicy, retention og bruk av Jarvis i
                                                                                                   egen virksomhet.

    Holding / eierlag                         Holding Sørby Solution AS                            Kan eie IP/aksjer og være egen Jarvis-
                                                                                                   tenant; får ikke platform-root eller andre
                                                                                                   tenantdata av den grunn.



1.2 Pappas bedrift er første eksterne tenant
Pappas selskap behandles som en ekstern virksomhet fra første produksjonsdag, selv om relasjonen er familie. Før e-post,
kalender, bank, regnskap, kundeopplysninger eller andre persondata kobles til, skal følgende pakke være signert og
registrert i audit:
       Databehandleravtale mellom pappas selskap som behandlingsansvarlig og Platform Operator som databehandler der
        rollefordelingen faktisk er slik.
       Enkel tjenesteavtale: tjenesteomfang, dataeierskap, support, kostnader, oppsigelse, eksport, sletting/retention,
        hendelsesvarsling og tilgjengelighetsforventninger.
       Subprocessor- og AI-provider-oversikt med aktuelle dataregioner/overføringer og hva tenant kan tillate eller nekte.
       Instruks for behandling: dataformål, kategorier, datatyper, retention, tillatte connectors/modeller og hvem som kan
        godkjenne endringer.
       Kontaktpunkter for sikkerhet, recovery og juridiske henvendelser.

1.3 Platform Plane er ikke en tenant
Platform Operator kan samtidig være eier av en vanlig company-tenant, men infrastructure-administrasjon skal ikke ligge i
den tenantens namespace. Platform Plane har egen identity, vault, audit og access-policy. Platform admin gir rett til å holde
systemet i drift - ikke normal leserett til tenant-innhold.

1.4 Platform Operator Transfer
Hvis Jarvis senere flyttes til eget selskap, skal overføringen håndtere leverandørkontrakter, DPA-er, subprocessor-lister,
domains/DNS, backups, infrastructure credentials, signing keys, billing, audit continuity og tenant-varsling. Tenantdata flyttes
ikke til ny juridisk enhet uten at nødvendige avtaler/instrukser er på plass.

                                              13.08.2026 | Binding design base after export gate
```

---

<!-- side 4 -->

```text
                                                                     JARVIS | Multi-Company Identity, Trust & Platform Operations | v1.3 FINAL

2. Kanonisk tenantmodell
 Objekt                                     Eier                                                  Delingsregel

 User                                       Person                                                Global identitet; authority er membership-
                                                                                                  spesifikk.

 Organization                               Juridisk selskap                                      Hard data-, money-, credential- og authority-
                                                                                                  grense.

 Business Unit                              Organization                                          Intern produkt/avdelingsgrense; kan senere
                                                                                                  carve-out til nytt AS.

 Workspace                                  Org eller BU                                          Kan deles kun via eksplisitt membership/share.

 Connection                                 Organization                                          Provider account eies av korrekt legal tenant.

 Credential                                 Tenant vault                                          Aldri synlig for modell, annen org eller platform
                                                                                                  worker uten eksplisitt break-glass.

 Memory                                     User / Org / BU                                       Cross-scope = default deny.

 Budget                                     Org / BU                                              Kan ikke automatisk lånes av annen org.

 Approval policy                            Organization                                          Approver må ha Jarvis DB authority i samme
                                                                                                  org.

 Platform secret                            Platform Plane                                        Aldri tenant-eid; aldri tilgjengelig for normal
                                                                                                  agent runtime.




2.1 Portfolio
Portfolio er en virtuell aggregasjon. Den kan hente godkjente KPI-er fra flere organizations som brukeren faktisk har authority
i, men den blir aldri et globalt tenant med raw customer data, secrets eller generell cross-org retrieval.


3. Identity, membership og Company Lock
3.1 Authentication vs authorization - én sannhet
 D-MC-26
 ZITADEL er authn/identity provider. Jarvis PostgreSQL er den eneste autoritative kilden for organization_memberships,
 roles, business-unit scopes, limits og approval authority. En ZITADEL-rolle eller organization claim kan aldri alene gi
 tilgang til company-data eller handlinger.


Flyt: ZITADEL -> identity_provider_subject -> Jarvis user -> Jarvis membership check -> org-session -> Policy Gateway.
Eventuelle organization-objekter i IdP kan brukes for login/federation/UX, men må behandles som metadata og kan ikke
overstyre Jarvis DB.

3.2 Company Lock
1. Bruker logger inn med passkey som foretrukket metode; sterk fallback/recovery er separat.
2. Jarvis viser bare organizations der Jarvis DB har aktivt membership.
3. Ved sensitiv org-åpning, org-switch, timeout eller risikosignal kreves step-up.
4. Server utsteder kortlivet org-session bundet til user_id, membership_id, org_id, auth_strength, device_id og
policy_version.
5. Frontend-org_id er aldri authority; API utleder org fra servervaliderte claims.
6. Class D er et tillegg og validerer action parameters, org, authority, device trust, expiry og nonce.

3.3 Device trust og kompromittert endepunkt
Device Registry utvides fra registrering til trust-state. Day-1 states: trusted, limited, revoked. Et device kan nedgraderes ved
mistanke, gammel app/OS, recovery, login-anomali eller manuell revoke. Manglende posture-evidence skal ikke behandles
som full trust for high-risk.

 Scenario                                                              Policy

 Vanlig A/B read/reversible handling                                   Kan utføres på trusted device med gyldig org-session.



                                             13.08.2026 | Binding design base after export gate
```

---

<!-- side 5 -->

```text
                                                                          JARVIS | Multi-Company Identity, Trust & Platform Operations | v1.3 FINAL
    Scenario                                                                Policy

    Class D uten finance                                                    Kan kreve re-auth + signed approval på samme device hvis policy
                                                                            tillater det.

    Finance / ny mottaker / cross-company / høy terskel                     Policy kan kreve distinct trusted device: godkjenning på
                                                                            telefon/Watch mens handling initieres på PC, eller motsatt.

    Device suspected compromised                                            Revoke device + sessions + pending approvals; force recovery
                                                                            review ved behov.

    Emergency response                                                      Owner kan bruke "logg ut alle enheter" som revokerer org-sessions,
                                                                            device tokens og sensitive pending grants.



3.4 Anti-MFA-fatigue
      Ingen blind "Approve?"-push for Class D. Approval viser organization, action, target/payee, amount og relevante
       parametere.
      Gjentatte approval prompts rate-limites og genererer security event.
      Et avvist high-risk prompt skal ikke automatisk sendes på nytt av agenten.
      Recovery og device-enrollment bruker uavhengig kanal og kan ikke initieres i loop av samme kompromitterte session.


4. Succession, bus factor og tapt person
    Mål
    Recovery skal fungere også hvis Platform Owner ikke kan delta. Ingen bedriftsdata skal bli permanent låst fordi én person
    er død, syk, utilgjengelig eller mister alle enheter.



4.1 Platform Continuity Pack
Før pappas tenant går i produksjon opprettes en fysisk/offline Platform Continuity Pack. Den skal være forståelig for en
teknisk tredjepart og inneholde:
      Systemkart og leverandøroversikt, men ingen unødvendige plaintext-secrets.
      Hvor krypterte recovery-nøkler/escrow-materiale finnes og hvordan tilgang autoriseres.
      Minst to navngitte recovery-custodians, hvor minst én ikke er avhengig av brukerens vanlige Jarvis-enheter.
      Instruks for ZITADEL/IdP, Core DB, Infisical, backup, DNS/domain, server og signing keys.
      Prosedyre for å returnere/eksportere hver tenants data uten å åpne andre tenants.
      Kontakt til regnskapsfører/advokat eller annen uavhengig ressurs dersom juridisk eierskap må bevises.

4.2 Succession approval
Succession er ikke en vanlig support-reset. Aktivering krever dokumentert trigger, identitets-/rollebevis, audit, varsling til
relevante org-eiere og cooling-off der situasjonen tillater det. Recovery-custodian får bare de capabilities som er nødvendige
for gjenoppretting/overføring - ikke varig owner-rolle i alle tenants.

4.3 Årlig drill
Minst årlig skal en tabletop/drill bevise at en annen autorisert person kan finne Continuity Pack, verifisere backup, starte
dokumentert recovery og produsere tenant-spesifikk eksport uten tilgang til andre orgs.


5. Secrets, credentials og Platform Secret Domain
5.1 Tenant credentials
Tenant-credentials følger v1.2: OAuth der mulig, minste scopes, backend callback, secret_ref i DB, per-org vault
paths/projects, job-scoped machine identities og ingen secret values i LLM-kontekst.

5.2 Platform secrets - egen security domain
Jarvis sine egne infrastructure credentials er mer kraftige enn mange tenant-secrets og får derfor eget Platform Secret
Registry + platform-vault. De klassifiseres separat og kan ikke legges under Holding, Kundeoppfølging-tenant eller en
generell "Jarvis admin"-mappe.




                                                  13.08.2026 | Binding design base after export gate
```

---

<!-- side 6 -->

```text
                                                                    JARVIS | Multi-Company Identity, Trust & Platform Operations | v1.3 FINAL
 Kategori                                  Eksempler                                              Regel

 Identity root                             OIDC client secrets, signing/bootstrap keys            Bare identity/recovery service identities; ikke
                                                                                                  tenant runtime.

 Database root                             DB admin, replication, backup credentials              App bruker aldri owner/root role; root er
                                                                                                  offline/limited.

 Deploy / CI                               GitHub Actions, registry, deploy keys                  Environment-scoped; prod deploy har separat
                                                                                                  identity.

 Host / network                            Server admin, SSH, VPN, firewall                       Human access via named identities; root usage
                                                                                                  auditeres.

 DNS / TLS                                 Domain registrar, DNS API, ACME credentials            Separate high-risk platform identities.

 Backup / encryption                       Backup encryption, recovery keys                       Offline/escrow + tested restore.

 Monitoring / alert                        Alert endpoints, log sinks                             Kan sende varsler; får ikke tenant content by
                                                                                                  default.




5.3 Platform Secret Registry - minimum metadata
 Felt                                                                 Formål

 platform_secret_id                                                   Stabil identitet uten secret value.

 environment                                                          dev / staging / prod / recovery.

 category                                                             identity / db / deploy / host / dns / backup / monitoring.

 secret_ref                                                           Peker til platform-vault.

 owner_role                                                           Hvem som kan administrere lifecycle.

 allowed_services                                                     Eksakt service allowlist.

 risk_class                                                           A/B/C/D eller root/recovery-special.

 rotation_policy                                                      Maks alder / event-driven rotation / provider-specific.

 last_rotated / last_used                                             Operativt bevis og stale-secret detection.

 break_glass_policy                                                   Hvordan recovery skjer uten permanent superadmin.



5.4 Risk-based rotation
For rotérbare statiske secrets er følgende Day-1 maksimumsmål bindende med mindre provider har kortere krav eller
dokumentert exception:
 Risk                                      Maks mål for statisk secret                            I tillegg

 A                                         365 dager                                              Roter ved lekkasje/owner change.

 B                                         180 dager                                              Roter ved relevant offboarding/permission
                                                                                                  change.

 C                                         90 dager                                               Health check + revocation test.

 D / finance                               30 dager                                               Immediate rotation ved incident, ownership
                                                                                                  change eller suspected compromise.

 Root / master / recovery-special          Provider-/runbook-spesifikk                            Ingen blind kalenderrotasjon som kan ødelegge
                                                                                                  recovery; rotasjon krever testet prosedyre og
                                                                                                  to-person review der mulig.


Short-lived tokens og workload identities foretrekkes foran langlivede statiske secrets. OAuth refresh-token lifecycle følger
providerens støttede rotation/revocation-mekanisme og EV-17.


6. Dev, staging og prod - miljøisolasjon
 Hard regel
 PROD credentials NEVER DEV. PROD customer data NEVER DEV som standard. Miljøgrensen håndheves i vault, DB,
 CI, storage, workers og provider accounts - ikke bare i variabelnavn.

                                            13.08.2026 | Binding design base after export gate
```

---

<!-- side 7 -->

```text
                                                                        JARVIS | Multi-Company Identity, Trust & Platform Operations | v1.3 FINAL
 Miljø                            Data                                    Credentials                             Tillatt bruk

 dev                              Syntetiske seed-data                    Kun dev accounts/secrets                Lokal utvikling, unit/integration,
                                                                                                                  destructive tests.

 staging                          Syntetiske eller eksplisitt             Separate staging provider               Release candidate, migration, end-
                                  sanitiserte fixtures                    accounts                                to-end og DR rehearsal uten prod
                                                                                                                  authority.

 prod                             Reelle tenantdata                       Prod-only secrets og workload           Kun signert release pipeline +
                                                                          identities                              audited admin.

 recovery                         Kun det som trengs til restore-test     Offline/escrow credentials              Isolert DR, ikke normal runtime.




6.1 Vault-struktur
Prod-tenant projects/paths er fysisk/logisk separert fra non-prod. Platform-vault er også environment-scoped. En dev worker
eller CI-jobb skal teknisk ikke kunne resolve prod secret_ref, selv om repo eller prompt forsøker.

6.2 Sanitized data gate
Hvis en feil ikke kan reproduseres uten prod-lignende data, brukes en eksplisitt sanitization/export-jobb som fjerner direkte
identifikatorer og re-evaluerer sensitive felt før staging. Kopiering av rå prod-tabeller til dev er forbudt.


7. AI Provider Data Boundary
 Kjernepresisering
 "Ingen credentials i AI-kontekst" beskytter hemmeligheter, men ikke innhold. E-post, dokumenter, kundeinformasjon og
 agentkontekst som sendes til ekstern modell er en separat dataflyt og må styres per organization.



7.1 Data sensitivity classes
 Klasse                                        Eksempel                                              Default ekstern modell

 S0 Public                                     Publisert nettsidetekst, offentlige produktdata       Tillatt innen org provider-policy.

 S1 Internal                                   Interne notater uten sensitive kunde-/finance-        Tillatt hos godkjent provider.
                                               data

 S2 Confidential                               Kundemail, kontraktsutkast, CRM, interne KPI-         Kun providers med godkjent
                                               er                                                    DPA/terms/region/retention for org.

 S3 Restricted                                 Bank/identity secrets, særlige persondata,            Default DENY til ekstern modell; krever
                                               root/recovery, ufiltrert sensitive finance            eksplisitt policy og dokumentert lovlig/teknisk
                                                                                                     grunnlag hvis noensinne aktivert.




7.2 Model Provider Registry
 Felt                                                                     Krav

 provider / legal_entity                                                  Hvem mottar data og hvilken avtale gjelder.

 regions / processing_locations                                           Dokumenteres fra gjeldende provider-vilkår.

 DPA_status / subprocessor_list                                           Må være vurdert for relevant tenant og data class.

 transfer_basis                                                           Registreres når personopplysninger kan behandles utenfor EØS; juridisk
                                                                          grunnlag verifiseres.

 training_use / retention_terms                                           Faktiske kontraktsvilkår logges; ikke antas.

 zero_retention_available                                                 Brukes som krav for sensitive flows der avtale/produkt faktisk støtter det;
                                                                          ellers kan policy gi DENY.

 max_data_class                                                           Høyeste klasse provider er godkjent for.

 verification_date / owner                                                Når vilkår sist ble kontrollert og hvem som godkjente.




                                                13.08.2026 | Binding design base after export gate
```

---

<!-- side 8 -->

```text
                                                                    JARVIS | Multi-Company Identity, Trust & Platform Operations | v1.3 FINAL
7.3 Per-org modellpolicy
Hver organization kan tillate eller nekte providers og dataklasser. Pappas selskap skal kunne si "mine S2-data går ikke til
Provider X" uten å påvirke Tobias sine selskaper. Context Builder merker data class; Model Gateway velger bare provider
som både global registry og org policy tillater.

7.4 Subprocessors og tredjeland
AI providers, cloud/hosting, observability og andre underleverandører som kan motta personopplysninger inngår i
subprocessor-oversikten. Overføringer utenfor EØS skal identifiseres og ha gyldig overføringsgrunnlag før de aktiveres for
persondata. Provider-verifisering re-kjøres ved vesentlige kontrakts-/subprocessor-endringer.


8. Connections Center og credential lifecycle
Connections Center er fortsatt samme UA-panel. v1.3 legger til AI-provider-policy, environment, data class, verification,
alerting og rotation status.
 Connection mode                            Eksempel                                             Tillegg i v1.3

 Organization-owned                         Meta, Google Ads, GitHub Org, GCP/Vercel             Org + env + verification + allowed_tools + data
                                                                                                 class.

 Delegated user                             Ansatts Gmail/Calendar                               Employee/privacy policy, offboarding, third-
                                                                                                 party data, AI-provider restrictions.

 Restricted finance                         Bank, Stripe, Vipps (mottak), firmakort              Finance Gateway, Class D, device trust,
                                                                                                 second-device policy, strong alerting.

 AI provider                                OpenAI/Claude/Gemini/Kimi o.l.                       Org allow/deny,
                                                                                                 DPA/subprocessor/region/retention verification,
                                                                                                 max data class.




8.1 Lifecycle
1. Owner/Admin velger Connect i riktig org og miljø.
2. OAuth brukes der det finnes; callback går til backend og secrets går aldri via LLM.
3. Secret lagres i korrekt tenant-vault eller platform-vault; DB lagrer kun ref + metadata.
4. Connection health, provider verification, rotation and policy status overvåkes.
5. Workers får kortlivet identity for eksakt org, environment og secret path.
6. Revoke invalidates grants, sessions/jobs/caches as relevant and emits security event.
7. EV-17 utfører maintenance på samme registry; ingen separat rotator.


9. Data, memory og secure-by-default schema
9.1 Pipeline-wide isolation
 System                                                               Obligatorisk kontroll

 PostgreSQL                                                           org_id + FORCE RLS + WITH CHECK + tenant transaction context.
                                                                      App roles uten BYPASSRLS.

 Vector / full-text                                                   Org-filter/source ownership før ranking og before-return validation.

 Files/object storage                                                 Separate org prefixes/buckets + scoped signed URLs + env
                                                                      boundary.

 Memory / conversations                                               User/org/BU scopes; org-switch starter ny/segmentert context.

 Workers / jobs                                                       Eksakt én org + env + capability set.

 Caches                                                               org_id + data_class + policy_version + environment i key.

 Logs/traces                                                          Org-tagged metadata, secret redaction, payload minimization.

 Backups                                                              Restore bevarer org ownership; cross-tenant post-restore tests.




                                            13.08.2026 | Binding design base after export gate
```

---

<!-- side 9 -->

```text
                                                                        JARVIS | Multi-Company Identity, Trust & Platform Operations | v1.3 FINAL
9.2 Secure-by-default migration contract
Alle nye tabeller må klassifiseres som GLOBAL, USER_OWNED, ORG_OWNED eller PLATFORM. CI-migration-linter nekter
merge når en ORG_OWNED-tabell mangler obligatoriske controls.

    ORG_OWNED krav                                                        CI PASS

    org_id                                                                NOT NULL + FK til organizations + passende index.

    RLS                                                                   ENABLE RLS + FORCE RLS.

    Policies                                                              SELECT/INSERT/UPDATE/DELETE policies og WITH CHECK der
                                                                          relevant.

    App role                                                              Ingen table owner/BYPASSRLS i runtime.

    Tenant context                                                        Må settes server-side inne i transaction; ikke stole på frontend
                                                                          header.

    Security definer                                                      Default deny; krever eksplisitt review/allowlist.

    Negative fixture                                                      Org A/B seed og cross-tenant read/write attempt må feile.



9.3 Isolation tests i CI
Acceptance-matrisen er ikke kun en engangs production drill. Et automatisert subset kjøres på hver relevant
commit/migration: DB escape, memory retrieval, secret resolution, org-session tampering, cache keys og critical policy rules.
Full DR, break-glass og legal lifecycle kjøres periodisk/ved release.

9.4 Org-switch og attachments
       Default: ny context thread/segment ved org-switch.
       Tidligere org-historikk kan ikke trekkes inn uten eksplisitt share.
       Attachments/artifacts revalideres mot ny org.
       Pågående job beholder opprinnelig org selv om UI bytter org.


10. Authority, Class D og Finance
10.1 Day-1 roles
Day-1 UX bygger bare Owner + Viewer/Auditor og nødvendige systemroller. Admin, Finance, Marketing, Developer, Support
og Operator finnes i datamodellen, men aktiveres når det er reelt behov.

10.2 Class D approval contract
    Felt                                                                  Krav

    org_id / business_unit_id                                             Må matche resource og connection.

    approver_user_id                                                      Aktivt Jarvis DB membership + relevant role/limit.

    approver_device_id                                                    Registered device; trust-state må tilfredsstille action-policy.

    second_device_evidence                                                Påkrevd når org/action/amount policy krever distinct-device
                                                                          approval.

    action + parameters                                                   Signeres deterministisk og vises menneskelig ved approval.

    amount/currency/target                                                Påkrevd for spend/finance og nye payees.

    policy_version                                                        Eksakt authority/device/data policy som ga lov.

    expiry + nonce                                                        Kortlivet, single-use, replay = DENY.



10.3 Company money
       Ingen agent kan belaste feil juridisk enhet.
       Cross-company transfer er alltid eksplisitt Class D og kan aldri skje som automatisk optimalisering.
       Finance Gateway er eneste spend enforcement. MC og UA spend caps evalueres samme sted.
       Finance worker kan ikke hente marketing/cloud secrets og omvendt.
       Finance actions genererer høy-signal security events og kan kreve independent notification etter org policy.

                                                13.08.2026 | Binding design base after export gate
```

---

<!-- side 10 -->

```text
                                                                             JARVIS | Multi-Company Identity, Trust & Platform Operations | v1.3 FINAL

11. Detection, alerting og incident response
    Ny production gate
    Forebygging uten deteksjon er ikke nok. Jarvis må kunne oppdage, varsle, inneholde og etterforske misbruk mens det
    skjer - ikke bare lese audit etterpå.



11.1 Security Event Plane
Alle kritiske tjenester publiserer normaliserte security events med org_id eller platform_scope, actor, device, action, risk,
reason, source, timestamp og correlation_id. Alert Engine evaluerer regler uten å gi LLM authority til å undertrykke eller
omskrive sikkerhetshendelser.
    Event                                                                      Minimum response

    Repeated Class D DENY / replay                                             Rate-limit, alert owner/security channel, preserve evidence.

    Recovery request / new passkey                                             Immediate independent notification + high-risk workflow.

    Break-glass                                                                Real-time notification + start/end alert + post-event review.

    New / revoked device                                                       Notify user/org owner; suspicious enrollment can pause Class D.

    Unusual org switching / tenant escape attempts                             Alert + risk elevate + session review.

    Secret resolution anomaly                                                  Deny if scope mismatch; alert platform security.

    Finance threshold / new payee / cross-company                              High-severity audit + second-device/notification per policy.

    Multiple failed login/step-up attempts                                     Rate-limit, lock/suspend step-up path as appropriate, notify.

    Audit checkpoint failure                                                   Production health alert; no silent degradation.




11.2 Independent alert channel
Owner/recovery-varsling må ha minst én kanal som ikke er avhengig av den samme org-connection som kan være
kompromittert eller revoked. Day-1: privat e-post og/eller SMS/telefonkontakt lagret som recovery contact utenfor tenant
connection registry. Kanalvalg testes før production.

11.3 Rate limiting
       Login brute-force protection håndheves i IdP og overvåkes i Security Event Plane.
       Org-switch, recovery, passkey enrollment, Class D, connection creation og secret-sensitive endpoints får egne rate
        limits.
       Repeated deny er et signal, ikke bare HTTP 403.

11.4 Incident lifecycle
detect -> alert -> contain -> investigate -> recover -> postmortem. Kill switch/revoke kan stoppe org, connection, worker
class, device eller platform capability uten å kreve modellbeslutning.


12. Tamper-evident audit
12.1 Hash-chained ledger
Append-only i database er ikke tilstrekkelig når Platform Operator kontrollerer databasen. Hvert audit event får prev_hash +
event_hash. Sekvensbrudd eller endret payload gjør verifikasjon feilbar og synlig.

12.2 Signed checkpoints
Minst hver time i produksjon signeres et checkpoint over siste audit hash/sequence og eksporteres til separat retention-
lagring eller systemkonto som normal application/database admin ikke kan omskrive uten separat spor. Daglig verifikasjon
kan automatiseres; feil gir high-severity alert.

12.3 Audit domains
       Tenant audit: org-specific actions, connections, policy, data lifecycle, model/provider use.
       Platform audit: deploys, root/admin, vault bootstrap, backup/restore, IdP admin, DNS, monitoring changes.
       Security audit: alerts, containment, recovery, break-glass, succession actions.

                                                     13.08.2026 | Binding design base after export gate
```

---

<!-- side 11 -->

```text
                                                                   JARVIS | Multi-Company Identity, Trust & Platform Operations | v1.3 FINAL
12.4 Audit retention
Retention følger legal/policy requirements og må ikke slettes bare fordi en tenant er deleted hvis audit må bevares som
sikkerhets- eller lovbevis. Audit skal minimere sensitive payloads og lagre references/hashes der full payload ikke er
nødvendig.


13. Privacy, databehandleravtaler og lifecycle
13.1 DPA scope
Når Platform Operator behandler personopplysninger på vegne av en tenant, skal databehandlerforholdet være klart og
dokumentert. DPA/instruks må minst beskrive behandlingen, formål, varighet, typer data/registrerte, sikkerhet,
underleverandører, bistand, deletion/return og audit/tilsyn der dette er relevant.

13.2 Delegated employee connections
Ansatts Gmail/Calendar innebærer personopplysninger om den ansatte og tredjepersoner. Org policy må beskrive scopes,
hva som lagres, AI-provider restrictions, retention, employee information og offboarding. Suspendert bruker -> sessions
revoked -> delegated grants and model policies re-evaluated.

13.3 Third-country / subprocessor governance
Provider Registry skal vise om personopplysninger kan behandles utenfor EØS, relevante underleverandører og dokumentert
transfer/legal review. Ingen S2/S3-persondata sendes til provider før required verification state er APPROVED for den org-
en.

13.4 Organization lifecycle
 State                                    Normal runtime                                        Krav

 active                                   Ja                                                    Full policy/authority.

 suspended                                Write default deny                                    Sessions/restricted tools revokes per policy.

 offboarding                              Begrenset                                             Connections revoke, data export,
                                                                                                retention/legal hold evaluate.

 archived                                 Nei                                                   Data beholdes kun etter retention/legal hold;
                                                                                                regnskapskrav vurderes.

 delete_pending                           Nei                                                   Cooling-off + owner confirmation + legal
                                                                                                hold check.

 deleted                                  Nei                                                   Live data removed/anonymized;
                                                                                                audit/required retention handled separately.



13.5 Bokføringsloven
Regnskapsmateriale som faller inn under Bokføringsloven skal ikke slettes før gjeldende oppbevaringskrav er utløpt. v1.3
beholder minimum fem år for relevante kategorier som planleggingskrav, men konkret klassifisering og eventuelle særregler
verifiseres før production deletion.

13.6 Ownership transfer, legal hold og cross-org sharing - runbook first
For Day-1 med to brukere beholdes datamodell og bindende regler, men full UI/automatisering for sjeldne hendelser kan
vente. Før slike hendelser skjer må en godkjent runbook brukes. Dette gjelder ownership transfer, BU carve-out, legal hold
administration og cross-org share. Secrets kan aldri deles via generic share.


14. Recovery, Disaster Recovery og continuity
14.1 Day-1 DR targets
 Komponent                                Initial target                                        Bevis

 Core PostgreSQL                          RPO <= 4 h / RTO <= 8 h                               Automated encrypted backup + tested restore
                                                                                                + RLS/tenant integrity.

 ZITADEL / IdP                            RPO <= 4 h / RTO <= 8 h                               DB + masterkey recovery, users/clients/org
                                                                                                linking consistent.

                                           13.08.2026 | Binding design base after export gate
```

---

<!-- side 12 -->

```text
                                                                           JARVIS | Multi-Company Identity, Trust & Platform Operations | v1.3 FINAL
 Komponent                                        Initial target                                        Bevis

 Infisical / secret metadata                      RPO <= 4 h / RTO <= 8 h                               Per-org/platform isolation and machine
                                                                                                        identities after restore.

 Audit checkpoints                                External checkpoint <= 1 h                            Chain verification and no silent gap.

 Object storage                                   RPO <= 24 h / RTO <= 24 h Day-1                       Org ownership and signed access boundaries.


Disse er initiale engineering targets, ikke en lovpåstand. De kan endres bare via logget decision etter målt bruk, kost og
hardware.

14.2 Degraded mode - låst policy
 Situation                                        Tillatt                                               Forbudt

 IdP kort nede                                    Eksisterende gyldige org-sessions kan fortsette       Nye users/memberships, recovery, new high-
                                                  innen eksisterende scope for A/B og reversible        risk sessions.
                                                  low-risk operations.

 IdP lengre nede                                  Read-only/A handlinger på fortsatt gyldig             Class D, finance, new connections, role
                                                  session hvis policy tillater.                         changes, passkey enrollment.

 Core/Policy uncertainty                          Fail closed for writes/high-risk.                     "Temporary allow all".

 Total recovery                                   Documented Recovery Plane + audit +                   Hidden admin bypass.
                                                  independent notification.




14.3 Restore drills
Quarterly for identity/core during early production; at least annually full platform continuity drill including succession, tenant
export, audit verification, device revoke and selected connection recovery. Failed drill opens incident/task; gate is not PASS
until rerun succeeds.


15. Platform Operations Plane
15.1 IdP operating model gate
ZITADEL remains the preferred identity technology behind the internal adapter, but v1.3 separates technology choice from
operating model. Self-hosting is allowed only when MC-1 production readiness proves backup/restore, masterkey recovery,
monitoring, patching and operator capacity. If that gate is not met, a managed OIDC/IdP deployment behind the same
adapter may be used temporarily; the Jarvis membership/authority model does not change.

15.2 Vulnerability and patch management
 Severity / scope                                                            Default remediation target

 Known actively exploited / internet-facing critical                         As soon as practical; target <= 24 hours when safe fix/mitigation
                                                                             exists.

 Critical                                                                    <= 72 hours.

 High                                                                        <= 14 days.

 Medium                                                                      <= 30 days / monthly patch window.

 Low                                                                         Planned maintenance.


IdP, vault, reverse proxy, OS/container base images and internet-facing dependencies are included. Upgrades are tested in
staging first unless emergency mitigation requires faster containment.

15.3 Operational cost / run-rate
Platform Operator skal følge månedlig run-rate fra Day-1: server/hosting, backup storage, domains/DNS, SMS/e-mail alert
channels, observability, IdP/vault, AI inference, security tooling og provider fees. Self-hosting sammenlignes mot managed
alternative på total operating cost, ikke bare lisenspris.




                                                   13.08.2026 | Binding design base after export gate
```

---

<!-- side 13 -->

```text
                                                                  JARVIS | Multi-Company Identity, Trust & Platform Operations | v1.3 FINAL
15.4 Minimum ops cadence
 Cadence                                                            Task

 Continuous                                                         Health, security events, backup failures, audit checkpoint failures.

 Weekly                                                             Patch/CVE review, stale credentials, failed auth/recovery review.

 Monthly                                                            Cost report, access review for platform admins, secret rotation
                                                                    queue, provider/subprocessor change review.

 Quarterly                                                          Core/IdP restore drill, tenant isolation regression review, break-
                                                                    glass test.

 Yearly                                                             Full succession/continuity drill, legal/provider policy review,
                                                                    architecture decision cleanup.




16. Runtime, UI og pappa-opplevelsen
16.1 UI routes
 Route                                                              Innhold

 /login                                                             IdP login/passkey/MFA.

 /portfolio                                                         Organizations brukeren har Jarvis DB membership i.

 /org/{slug}                                                        Dashboard + org-bound conversation.

 /org/{slug}/connections                                            Connections + verification + AI data policy + rotation/health.

 /org/{slug}/members                                                Memberships/roles/suspend/revoke.

 /org/{slug}/authority                                              Class D mandates, device/second-device policy, spending limits.

 /org/{slug}/security                                               Company Lock, devices, sessions, recovery, alerts, break-glass.

 /org/{slug}/privacy                                                Retention, employee connectors, data export, legal hold.

 /org/{slug}/audit                                                  Tamper-evident event timeline + verification status.

 /platform/ops                                                      Platform Operator only: infrastructure health, cost, CVE, backups,
                                                                    platform secrets - no routine tenant payload.




16.2 Pappa-opplevelsen
Pappa lager egen user, registrerer egen bedrift, signerer onboarding-pakken, registrerer passkeys/recovery contacts og
kobler egne providers. Han ser egne data, connections, budgets, model-provider choices, audit og alerts. Han ser ikke
Holding, Kundeoppfølging-data, Tobias private memory eller Platform Plane secrets. Tobias har heller ikke tilgang til pappas
company content uten eksplisitt membership eller break-glass i samsvar med avtale/policy.


17. Datamodell v1.3 FINAL
17.1 Eksisterende + nye tabeller
 Tabell                                                             Nøkkelfelter / hensikt

 organizations                                                      legal identity, lifecycle_state, owner_user_id, security_tier.

 business_units                                                     org_id, budget_profile, status.

 users                                                              identity_provider_subject, profile.

 organization_memberships                                           user_id, org_id, roles, status, limits, valid_from/to - authority source of truth.

 org_sessions                                                       user/org/membership/device/auth_strength/policy_version/expiry.

 service_connections                                                org/provider/account/secret_ref/scopes/status/verification/data policy refs.

 authority_policies                                                 org/action class/threshold/device requirements/approver rules/version.

 budgets                                                            org/BU/provider/category/period/hard_limit.

 cross_org_shares                                                   resource-specific, purpose, acceptance, expiry, status.


                                          13.08.2026 | Binding design base after export gate
```

---

<!-- side 14 -->

```text
                                                                                JARVIS | Multi-Company Identity, Trust & Platform Operations | v1.3 FINAL
Tabell                                                                           Nøkkelfelter / hensikt

recovery_requests                                                                request state, channels, cooling-off, verification, completion.

provider_verifications                                                           org/provider/legal/technical verification lifecycle.

legal_holds / ownership_transfers / org_lifecycle_events                         Runbook-backed legal/lifecycle state.

model_provider_registry                                                          provider legal entity, region, DPA, subprocessors, transfer, retention/training
                                                                                 terms, max_data_class.

org_model_policies                                                               org provider allow/deny, max data class, restrictions, policy version.

devices                                                                          trust_state, last_seen, posture evidence, revoke state.

security_events                                                                  scope/org, actor, device, risk, type, correlation, disposition.

security_alerts                                                                  event refs, severity, channel, notification/containment status.

audit_events                                                                     org/platform scope, sequence, prev_hash, event_hash,
                                                                                 payload_ref/minimized data.

audit_checkpoints                                                                scope, sequence, root_hash, signature, external_location, verification status.

platform_secret_registry                                                         environment/category/secret_ref/owner/allowed services/risk/rotation.

platform_operator_records                                                        legal entity, active_from/to, agreement refs, operator-transfer state.

subprocessors                                                                    provider, role, processing location, transfer review, verification date.

succession_contacts                                                              role, independent channel, verification, active status.

continuity_drills                                                                scenario, date, result, evidence ref, follow-up.




17.2 Schema classification metadata
Migration tooling holder en manifest/classification for every table. ORG_OWNED tables cannot be deployed without RLS
controls; PLATFORM tables cannot be queried by tenant app role; GLOBAL tables cannot contain tenant payload unless
explicitly designed and reviewed.


18. Revidert byggeplan - kompatibel med MC-0 til MC-13
For å unngå rework beholdes MC-0..MC-13-navnene. v1.3-krav absorberes inn i eksisterende faser i stedet for å starte et
femte parallelt program.
Fase                                                 v1.3 Definition of Done                                  Planramme

MC-0 Canonical + Legal                               Platform Operator låst, DPA/service template,            3-5 d
                                                     authority source truth, anti-duplisering, open
                                                     decisions/owners/deadlines, succession owners.

MC-1 Identity                                        OIDC adapter, passkeys, IdP operating-model              1-3 u
                                                     gate, rate limiting/monitoring, masterkey + restore.

MC-2 Org schema                                      Organizations/BUs/memberships + platform                 1-2 u
                                                     operator records + table classification.

MC-3 Org sessions                                    Org claims, membership validation, device binding,       1-2 u
                                                     switch-org.

MC-4 Company Lock + device/recovery                  Step-up, distinct-device policy, device revoke,          2-3 u
                                                     high-assurance recovery.

MC-5 Vault + environments                            Per-org vault, Platform Secret Domain,                   2-3 u
                                                     dev/staging/prod isolation, rotation policy.

MC-6 Connections + AI boundary                       Connections Center, provider verification, model         2-4 u
                                                     registry, org AI policies, subprocessors.

MC-7 Authority                                       Day-1 roles, Class D, device trust, limits; same         2-3 u
                                                     Policy Gateway.

MC-8 Data/Memory hardening                           RLS, retrieval/files/cache/log/backup isolation +        3-5 u
                                                     migration lint + CI tenant tests.

MC-9 Agent runtime                                   Every conversation/job/tool/trace org+env scoped;        2-4 u
                                                     no platform-root capability.

MC-10 Finance                                        Org-bound Finance Gateway +                              2-3 u
                                                     second-device/alert policies.

MC-11 Multi-user UX                                  Pappa onboarding, agreements, recovery, alerts,          1-3 u
                                                     model policy UX.


                                                      13.08.2026 | Binding design base after export gate
```

---

<!-- side 15 -->

```text
                                                                                       JARVIS | Multi-Company Identity, Trust & Platform Operations | v1.3 FINAL
 Fase                                                     v1.3 Definition of Done                                     Planramme

 MC-12 Portfolio                                          Approved KPI aggregation only.                              1-2 u

 MC-13 Production Gate                                    Detection, tamper-evident audit, restore,                   3-5 u
                                                          succession, legal/privacy, tenant escape, incident
                                                          drill.




18.1 Total planramme
Revidert planramme: ca. 20-38 arbeidsuker for hele MC-sporet med én hovedbygger + AI-assistanse hvis alt skal ferdigstilles
og automatiseres. Dette er ikke 20-38 nye uker oppå UA/EV: MC-1/3/5/7/8/9/10 absorberer store deler av arbeid som uansett
finnes i foundation/runtime/finance. Day-1 kan gå raskere ved å holde ownership transfer, legal hold og cross-org share som
testede runbooks i stedet for full UI/automation.

18.2 Byggerekkefølge
 Bølge                                                    Faser                                                       Fokus

 A - legal + foundation                                   MC-0, start MC-1/2/5                                        Platform owner/DPA, identity source truth,
                                                                                                                      vault/environment before new permanent
                                                                                                                      connectors.

 B - trust boundary                                       MC-3/4/7/8                                                  Sessions, Company Lock, devices, authority,
                                                                                                                      RLS/CI.

 C - data egress + runtime                                MC-6/9/11                                                   Connections, AI provider boundary, pappa
                                                                                                                      onboarding, multi-org runtime.

 D - high risk                                            MC-10 + detection/audit                                     Finance only after identity/secrets/RLS/device
                                                                                                                      gates.

 E - intelligence + production                            MC-12/13                                                    Portfolio, DR, succession, legal, alerts, tamper-
                                                                                                                      evident audit, full negative tests.




19. Operative beslutninger med eier og frist
v1.3 låser prinsippene, men enkelte miljøspesifikke verdier må fylles inn før gate. De er ikke "glemt"; de har eier, default og
deadline.
 ID                              Beslutning                          Default / regel                      Eier                            Frist

 O-01                            Platform Operator legal setup       Kundeoppfølging AS; sign DPA         Platform Owner + juridisk       Før MC-0 PASS
                                                                     + service agreement med              review
                                                                     pappas selskap.

 O-02                            Independent recovery channels       Minst privat e-post +                Org Owner                       Før første external tenant
                                                                     telefon/SMS utenfor tenant
                                                                     connections.

 O-03                            Succession custodians               Minst 2, minst 1 uavhengig av        Platform Owner                  Før første external tenant
                                                                     vanlig Jarvis-device.

 O-04                            IdP operating model                 Self-host only if MC-1 ops gate      Platform Owner                  MC-1 Gate
                                                                     passes; otherwise managed
                                                                     behind adapter.

 O-05                            DR targets                          Start med tabellen i kap. 14;        Platform Ops                    Før production
                                                                     endring krever decision log.

 O-06                            AI provider approvals               Ingen S2/S3 provider før             Org Owner + Platform Operator   Før provider enabled
                                                                     registry/legal/terms verification.

 O-07                            Second-device triggers              Default for finance/new              Org Owner                       Før MC-10
                                                                     payee/cross-company og org-
                                                                     defined high-risk thresholds.

 O-08                            Alert recipients                    Minst owner + independent            Org Owner                       Før production
                                                                     recovery channel for high
                                                                     severity.

 O-09                            Run-rate budget                     Set monthly soft/hard                Platform Operator               Før MC-1 prod
                                                                     operational budget + AI spend
                                                                     caps.




                                                          13.08.2026 | Binding design base after export gate
```

---

<!-- side 16 -->

```text
                                                              JARVIS | Multi-Company Identity, Trust & Platform Operations | v1.3 FINAL

20. Threat model v1.3
Scenario                                                        Kontroll

URL/header tenant tampering                                     Server-issued org-session + Jarvis DB membership + RLS.

Prompt injection requests other org                             Context Builder/Tool Gateway org scoped; model cannot choose tenant.

Compromised user PC                                             Device trust, distinct-device high-risk approval, revoke all sessions/devices,
                                                                alerting.

Compromised worker                                              Job-scoped identity, one org/env, secret path allowlist, no platform root.

AI provider gets tenant content                                 Per-org provider policy + data class + provider/subprocessor/transfer
                                                                verification.

IdP role drift                                                  IdP is authn only; Jarvis DB membership is authority source.

Brute-force / MFA fatigue                                       IdP/app rate limits, explicit action signing, alert on repeated attempts.

Platform admin alters audit                                     Hash chain + externally signed checkpoints + verification alerts.

Dev leaks prod data/secrets                                     Hard env vault separation, synthetic data, CI policy.

CI/deploy key compromised                                       Platform Secret Domain, env-scoped deploy identity, rotation/revoke, audit.

Platform Owner unavailable                                      Continuity Pack + multiple custodians + tenant-specific recovery/export.

Systemadmin compromised                                         Split scopes, no routine tenant content, platform vs tenant roles, tamper-
                                                                evident evidence.

Backup restore mixes tenants                                    Restore validation + CI/post-restore cross-tenant tests.

Cross-org share abused                                          Resource-specific, bilateral for sensitive, expiry/revoke, no generic secret
                                                                share.

Tenant leaves / company sold                                    Runbook for export, revoke, legal hold, ownership transfer, audit continuity.




21. Production acceptance matrix v1.3 FINAL
Test                                                            PASS-kriterium

DB escape CI                                                    Cross-tenant read/write fails on every relevant migration build.

Memory / conversation escape                                    Retrieval, org-switch, attachments and prior tool results never cross org
                                                                without share.

Secret escape                                                   Tenant worker cannot resolve other tenant or platform secret.

Membership drift                                                Changing IdP org/role without Jarvis DB membership gives no authority.

Session tampering                                               Slug/header/client state cannot switch tenant.

Compromised device                                              Revoked/limited device loses sensitive authority; distinct-device rule actually
                                                                blocks same-device takeover path.

Approval replay                                                 Wrong org/role/device/policy/nonce/expiry = DENY.

Finance                                                         Wrong org budget/credential/payee policy cannot be charged.

AI egress                                                       Org policy/provider/data class deny blocks model call before payload leaves
                                                                boundary.

Provider legal state                                            S2/S3 flow cannot run when provider/subprocessor/transfer verification is
                                                                missing/expired.

Environment escape                                              Dev/staging identity cannot read prod DB/vault/object storage.

Platform secret escape                                          Tenant app/worker cannot query Platform Secret Registry value or vault path.

Alerting                                                        Repeated Class D deny, recovery, break-glass and audit checkpoint failure
                                                                produce tested independent notification.

Audit tamper                                                    Edit/delete/reorder of historical event breaks chain/checkpoint verification.

IdP outage                                                      Degraded mode does not mint new sensitive authority.

Restore                                                         Core/IdP/vault restore preserves tenant isolation and meets evidence target.

Succession                                                      Authorized custodian can execute documented recovery/export without global
                                                                tenant data access.

DPA/onboarding                                                  External tenant cannot enable person-data connections before legal
                                                                onboarding gate is recorded.


                                      13.08.2026 | Binding design base after export gate
```

---

<!-- side 17 -->

```text
                                                                    JARVIS | Multi-Company Identity, Trust & Platform Operations | v1.3 FINAL
 Test                                                                 PASS-kriterium

 Offboarding/lifecycle                                                Connection revoke, retention/legal hold and data export behave according to
                                                                      state.

 Ownership/share runbook                                              Dry-run shows controlled transfer/share without secret/raw-memory leakage.

 Vulnerability ops                                                    Critical patch drill/exception path is documented and auditable.

 Cost telemetry                                                       Monthly platform and model run-rate can be produced from operational data.

 Break-glass                                                          Reason, expiry, notification, evidence and post-review all present.




21.1 Evidence over statusord
PASS krever testresultat eller operativt bevis: CI run, failed escape attempt, restore evidence, signed checkpoint verification,
recovery drill, alert delivery, agreement record eller auditerbar lifecycle. "Implementert" uten bevis er ikke PASS.


22. Styrende arkitekturvedtak v1.3 FINAL
 ID                                                                   Vedtak

 D-MC-01                                                              Organization = juridisk selskap = primær security boundary.

 D-MC-02                                                              Hver person har egen Jarvis-identitet; ingen shared users.

 D-MC-03                                                              Company Lock bruker per-user step-up/passkey, ikke delt company
                                                                      password.

 D-MC-04                                                              Tenant credentials eies av org og lagres i per-company vault; LLM ser aldri
                                                                      secret values.

 D-MC-05                                                              Business units er underdeling innen samme juridiske selskap.

 D-MC-06                                                              Portfolio er aggregasjon, ikke tenant; cross-org default deny.

 D-MC-07                                                              Class D og Finance Gateway verifiserer authority i korrekt org.

 D-MC-08                                                              ZITADEL brukes via intern OIDC-adapter; self-host er bare production mode
                                                                      når operations gate passerer, ellers kan managed deployment brukes uten å
                                                                      endre Jarvis authority-modell.

 D-MC-09                                                              Infisical/machine identity isoleres etter company, environment og security tier.

 D-MC-10                                                              Pappas onboarding er self-service; Tobias håndterer ikke hans credentials.

 D-MC-11                                                              MC er tverrgående lag i Grunnprogram/UA/EV, ikke parallelt program.

 D-MC-12                                                              Én IdP-adapter, ett Connections Center, én Policy/Class D, én Finance
                                                                      Gateway og ett tenant Credential Registry.

 D-MC-13                                                              IdP production readiness krever masterkey recovery, backup/restore,
                                                                      monitoring og degraded policy.

 D-MC-14                                                              Account recovery er high-assurance med independent notification, audit og
                                                                      cooling-off.

 D-MC-15                                                              Delegated employee connections omfattes av privacy/offboarding/model-
                                                                      provider policy.

 D-MC-16                                                              Org lifecycle støtter suspend/offboarding/archive/delete_pending/delete/legal
                                                                      hold.

 D-MC-17                                                              Ownership transfer og BU->org carve-out er kontrollerte migrasjoner med
                                                                      audit continuity.

 D-MC-18                                                              Provider verification starter ved org creation og blokkerer bare relevante
                                                                      capabilities.

 D-MC-19                                                              Org-switch starter ny/segmentert context; ingen chat-history inheritance.

 D-MC-20                                                              Cross-org shares er resource-scoped, tidsbegrenset, revokerbart og bilateralt
                                                                      godkjent der policy krever.

 D-MC-21                                                              Day-1 bruker minimalt rollesett; vekstroller aktiveres ved behov.

 D-MC-22                                                              Finance aktiveres først etter identity/secrets/authority/runtime/RLS/device
                                                                      gates.

 D-MC-23                                                              Deletion/archive/legal hold respekterer Bokføringsloven og annen lovpålagt
                                                                      retention.




                                            13.08.2026 | Binding design base after export gate
```

---

<!-- side 18 -->

```text
                                                                     JARVIS | Multi-Company Identity, Trust & Platform Operations | v1.3 FINAL
22.1 Nye v1.3-vedtak
 ID                                                                    Vedtak

 D-MC-24                                                               Kundeoppfølging AS er initial Platform Operator; Platform Plane er
                                                                       juridisk/teknisk separert fra tenant authority.

 D-MC-25                                                               Før første eksterne tenant behandler persondata skal DPA/service agreement
                                                                       og subprocessor/provider-oversikt være registrert.

 D-MC-26                                                               ZITADEL = authentication. Jarvis PostgreSQL = eneste authority/membership
                                                                       source of truth.

 D-MC-27                                                               Ingen single human/device/model/credential/server/admin account skal alene
                                                                       kunne kompromittere alle orgs i det skjulte.

 D-MC-28                                                               AI provider dataflow styres per org via data classes, provider registry,
                                                                       subprocessors og allow/deny policy.

 D-MC-29                                                               High-risk action kan kreve distinct trusted device; same-device approval er
                                                                       ikke alltid tilstrekkelig.

 D-MC-30                                                               Security detection/alerting er production requirement; repeated
                                                                       deny/recovery/break-glass er signals.

 D-MC-31                                                               Audit er tamper-evident med hash chain og signerte eksterne checkpoints.

 D-MC-32                                                               Dev/staging/prod er hardt isolert; prod secrets og prod customer data er
                                                                       default deny utenfor prod.

 D-MC-33                                                               Platform infrastructure secrets har eget registry/vault og kan aldri nås av
                                                                       normal tenant agent runtime.

 D-MC-34                                                               ORG_OWNED schema må passere migration lint for org_id/RLS/WITH
                                                                       CHECK og CI tenant-escape tests.

 D-MC-35                                                               Succession/continuity pack + minst to recovery-custodians kreves før ekstern
                                                                       production onboarding.

 D-MC-36                                                               Rotérbare statiske credentials har risk-class-basert maximum age og event-
                                                                       driven immediate rotation.

 D-MC-37                                                               Low-frequency transfer/legal-hold/share kan være bindende runbook før full
                                                                       automation, men må testes før bruk.

 D-MC-38                                                               Platform Ops må måle run-rate, patch/CVE status, backups og recovery; self-
                                                                       hosting godkjennes på total operations capability, ikke bare teknisk deploy.




23. Offisiell designbasis og juridisk verifikasjon
v1.3 bygger på v1.2 sin tekniske designbasis (ZITADEL, OAuth/WebAuthn, Infisical) og de nye operative funnene. Juridiske
roller og provider-vilkår skal verifiseres for faktisk selskapsstruktur og faktisk dataflyt før produksjon. Følgende offisielle
norske kilder er brukt til å kontrollere de viktigste personvern-/oppbevaringskravene i v1.3:
• Datatilsynet - Databehandleravtale - Forholdet behandlingsansvarlig/databehandler og Art. 28-avtale.
• Datatilsynet - Når må man inngå databehandleravtale - Når ekstern virksomhet behandler personopplysninger på vegne av
en annen.
• Datatilsynet - Overføring ut av EØS - Krav om overføringsgrunnlag og oversikt over leverandørkjede/underleverandører.
• Lovdata - Bokføringsloven § 13 - Oppbevaring av relevante kategorier regnskapsmateriale, blant annet fem år for kategorier
i §13 første ledd nr. 1-4.

 Juridisk disclaimer
 Masterplanen er et teknisk og operativt styringsdokument, ikke juridisk rådgivning. Konkrete DPA-er, tjenesteavtaler,
 behandlingsgrunnlag, transfer assessments, retention og leverandørvilkår må kvalitetssikres for den faktiske driften før de
 brukes kommersielt.




24. Migrering fra v1.2 til v1.3
1. Oppdater CANONICAL_SPEC-referansen fra v1.2 til v1.3 og logg D-MC-24 til D-MC-38.
2. Utpek Kundeoppfølging AS som Platform Operator record og opprett Platform Plane security domain.
3. Splitt platform-secrets fra tenant Infisical paths; etabler Platform Secret Registry.
4. Gjør Jarvis DB membership til eksplisitt eneste authority source og fjern/ignorer eventuelle IdP-role shortcuts.
5. Legg data_classification + org_model_policy foran Model Gateway og registrer eksisterende AI providers.
                                             13.08.2026 | Binding design base after export gate
```

---

<!-- side 19 -->

```text
                                                                     JARVIS | Multi-Company Identity, Trust & Platform Operations | v1.3 FINAL
6. Utvid Device Registry med trust_state + revoke-all + distinct-device approval policy.
7. Legg Security Event Plane + alert channels + rate limit signals foran production finance/recovery.
8. Oppgrader audit schema til hash chain + external signed checkpoints og verifier job.
9. Opprett dev/staging/prod isolation og flytt alle eksisterende secrets til korrekt environment.
10. Bygg migration linter og CI tenant fixtures før neste større schema wave.
11. Lag Continuity Pack, custodians og full succession tabletop.
12. Signer onboarding-pakke med pappas bedrift før persondata/providers aktiveres.
13. Kjør v1.3 acceptance matrix og arkiver evidence refs i PROJECT_STATUS/audit.


25. Final dokument- og production gate
 Gate                                                                  PASS

 Document export                                                       Hele PDF rendret og visuelt kontrollert; ingen klipp, overlapp, svarte tegn
                                                                       eller uleselige tabeller.

 Decision log                                                          D-MC-01 til D-MC-38 er logget eller eksplisitt superseded i
                                                                       CANONICAL_SPEC.

 Legal onboarding                                                      Platform Operator, DPA/service agreement template, subprocessors og
                                                                       pappa-gate er på plass.

 Identity/authority                                                    IdP authn og Jarvis membership authority er testet separat.

 Platform security                                                     Platform secrets, environment isolation, device trust, detection og
                                                                       tamper-evident audit PASS.

 Recovery                                                              IdP/Core/vault restore + succession drill PASS.

 CI                                                                    Migration lint + automated tenant negative tests green.

 AI data egress                                                        Provider registry + org policy blocks disallowed S2/S3 payloads before
                                                                       network egress.

 Finance                                                               High-risk device/authority/alert controls verified before activation.

 Evidence                                                              Ingen gate DONE uten test/log/restore/agreement/drill evidence.



 Sluttstatus
 Når gate 25 er PASS, er v1.3 FINAL den bindende basen for Jarvis multi-company identity, tenancy, credentials, AI data
 boundaries, platform operations, detection, audit, recovery, privacy og company isolation. Samme Core kan betjene
 Tobias sine selskaper, pappas bedrift og senere eksterne kunder uten at tenantgrensene eller Platform Plane blandes.



25.1 Neste handling
1) Legg v1.3 FINAL inn i CANONICAL_SPEC. 2) Logg D-MC-24 til D-MC-38 og oppdater tidligere D-MC-08/D-MC-09 der
v1.3 presiserer operating model/environment. 3) Start MC-0 med Platform Operator + DPA/service agreement + membership
truth. 4) Parallelt bygg Platform Secret Domain, environment isolation og migration lint. 5) Ikke onboard pappas persondata
eller aktiver finance før relevante v1.3-gates er bevist.




                                             13.08.2026 | Binding design base after export gate
```
