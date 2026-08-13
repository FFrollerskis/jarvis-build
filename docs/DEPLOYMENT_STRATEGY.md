# Jarvis – drifts- og deploystrategi

**Status:** Utkast v1.0. Ved motstrid gjelder [CANONICAL_SPEC.md](CANONICAL_SPEC.md).

## 1. Prinsipp: lokal først, målt migrasjon senere

Jarvis starter på eksisterende maskinvare (D-20): **UGREEN DXP4800 Plus (NAS)** er 24/7-basen for
Jarvis-data, databaser, Home Assistant, Docker-tjenester, nettsider, filer og backup; **PC-en
(RTX 4070, Windows 11)** brukes til utvikling og tyngre AI/GPU-arbeid. En kraftigere dedikert
AI-server (f.eks. RTX 5080-klasse) bygges **kun når 30–90 dagers måling av kostnad, oppetid og
personvernbehov dokumenterer behovet** («mål før kjøp»). Mac mini/NUC inngår ikke i startplanen.
Alt bygges derfor:

- containerisert (Docker via WSL2) med `docker-compose` som eneste lokale orkestrering
- konfigurert via miljøvariabler/vault – ingen hardkodede maskiner, stier eller regioner
- mot ren PostgreSQL – kjører identisk i lokal container, på egen server eller i Supabase-sky

## 2. Trinn

### Trinn 0 – Utvikling (fase 1–4)

- Dev-stacken på PC-en: Core, Postgres (pgvector, tsvector, pgmq), Langfuse – i docker-compose.
- Secrets: SOPS + age og lokal git-ignorert `.env`; ingen kjørende vault før flere tjenester trenger
  delte secrets (D-16, senest fase 7).
- Webchat nås lokalt (localhost/LAN). Ingen inngående porter fra internett.
- NAS-en settes opp i parallell (Docker, backup-mål); nedetid på dev-PC-en er OK i denne fasen.

### Trinn 1 – Første reelle bruk (fase 5–7)

- Prod flyttes til **UGREEN-NAS-en (24/7)**: Core, Postgres, Home Assistant, watchdog og backup.
- PC-en (RTX 4070) er utviklingsmaskin og **GPU-worker**: Claude Code/Codex-sandboxer, tunge jobber
  og ev. lokale modeller. NAS-en fungerer selv om PC-en er av.
- Ekstern uptime-sjekk (billig VPS eller gratis tjeneste), UPS-vurdering for NAS, kryptert backup ut
  av huset (objektlagring).
- Sikker fjernadgang via VPN/tunnel (f.eks. WireGuard/Tailscale-klasse) – aldri åpne porter direkte.
- Telegram-varsling i drift.

### Trinn 2 – Dedikert AI-server (etter måling, del av fase 10)

- Bygg kraftigere AI-server (f.eks. RTX 5080-klasse) for lokale modeller **kun når 30–90 dagers
  måling dokumenterer behovet** – beslutningen tas på måltall, ikke antakelser.
- NAS-en forblir 24/7-base for Tier 1; AI-serveren er compute-node.
- Voice Gateway plasseres der latens til rommene er best (typisk NAS eller lokal node per sted).

### Trinn 3 – Hybrid (senere)

- Skykomponenter der det gir mening (f.eks. ekstern watchdog, backup, ev. Supabase-sky).
- Hytte som eget «site» med egen HA og lokal fallback.

## 3. Miljøer

| Miljø | Formål | Hvor |
|---|---|---|
| `dev` | Utvikling, kastbare data | PC |
| `test` | Automatiske tester, policy-/minne-evals, CI | PC/CI |
| `prod` | Tobias sin faktiske Jarvis | UGREEN-NAS (24/7) |

Prod-data brukes aldri i dev/test uten anonymisering. Migrasjoner er versjonerte og reverserbare.

## 4. Backup og recovery

| Tier | Innhold | RPO | RTO | Metode |
|---|---|---|---|---|
| 1 | Identitet, autoritativ DB, vault | 15 min–2 t | ≤4 t | WAL-arkivering/kontinuerlig + daglig full, kryptert, off-site |
| 2 | Oppgaver, aktive prosjekter, artefakter | ≤4 t | samme arbeidsdag | Periodisk synk til objektlagring |
| 3 | Arkiv, media, eksporter | daglig/ukentlig | dager | Ukentlig kopi |

- Backup er kryptert før den forlater huset; nøkler i sikker nøkkellagring (age-nøkler i fase 1,
  vault når den er innført per D-16) + offline kopi.
- **Restore testes med faktisk tidtaking** (øvelse i fase 10, deretter periodisk). En backup som aldri er
  gjenopprettet regnes ikke som verifisert.
- Menneskelesbar minneeksport (se MEMORY_ARCHITECTURE §8) inngår som ekstra sikkerhetsnett.

## 5. Observability og watchdog i drift

- Langfuse (selvhostet) for LLM-traces, kostnad, latens, evals – koblet til `task_id`.
- Systemmetrics: container-helse, disk, RAM, GPU, temperatur, UPS-status.
- Watchdog kjører både lokalt og som ekstern sjekk (kan ikke dø sammen med maskinen den overvåker).
- Varsling: Telegram med alvorlighetsgrad og lenke til runbook.
- Tiltak: kun eksplisitte, reversible handlinger (restart av én tjeneste). Autonom reparasjon kommer
  senere som signerte runbooks med precheck, timeout, rollback og maks forsøk.

## 6. Kostnadsstyring i drift

- Startgrenser: varsel 1 000 kr/mnd, aktiv godkjenning 2 000 kr/mnd, hardgrense 3 000 kr/mnd (signert
  overstyring mulig). Håndheves i Model Gateway/Policy Gateway.
- Kostnad per modell, agentprofil, tenant og `task_id` – synlig i dashboard, revideres etter 30 dager.
- Sky-/infrastrukturkostnad inngår i samme månedstall.

## 7. Oppgradering og utrulling

- Git er sannhet; små, forståelige commits; CI kjører tester + policytester + minne-eval før merge.
- Deploy = ny container-tag + migrasjoner; rollback = forrige tag + reverserbar migrasjon.
- Ingen deploy av Tier 1-tjenester uten fersk backup.
