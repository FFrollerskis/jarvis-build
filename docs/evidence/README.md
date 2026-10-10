# Evidens (WP-J, D-450)

Her ligger **kjørebevis** fra verifiseringsøkten for HF1/HF2: det en kommando faktisk skrev, på en navngitt kode (git-SHA), på en navngitt vert. En rad i
[`../CLOSURE_MATRIX_HF1_HF2.md`](../CLOSURE_MATRIX_HF1_HF2.md) kan **først** stå som `VERIFIED` når den lenker til en fil her (eller en URL til en uforanderlig
kjøring) – det håndheves av CI-vakten `modules/core/test/wpj-closure-matrix.test.ts`. «PASS» i en evidensfil betyr at *denne målingen* var som forventet akkurat da;
det er ikke det samme som at en masterplan-port er lukket (se vurderingsfeltet nederst i hver fil).

## Slik lager du en evidensfil

Fra repoets rot på maskinen der kommandoen skal kjøres (NAS-en for gate-kjøringer, Mac-en for Xcode-ting osv.):

```bash
node ops/acceptance/record-evidence.mjs <id> --note "kort kontekst" -- <kommando> [argumenter...]
# eksempel:
JARVIS_BACKUP_DIR=/volume1/jarvisbuild-data/backups/encrypted \
  node ops/acceptance/record-evidence.mjs ua0-gate-nas -- ops/acceptance/nas-ua0-gate.sh
# eller, når kommandoen allerede er kjørt:
ops/acceptance/nas-ua0-gate.sh | node ops/acceptance/record-evidence.mjs ua0-gate-nas --stdin
```

- Filen heter `docs/evidence/<dato>-<id>.md` og **overskrives aldri**: filen reserveres FØR kommandoen kjører, så samme id to ganger kjører ikke kommandoen to ganger (exit 3). En ny kjøring får ny id (f.eks. `ua0-gate-nas-2`).
- Kommandoen kjøres **uten skall** (argv) i egen prosessgruppe; ved tidsavbrudd (`--timeout-s`, standard 600) stoppes hele gruppen. Utdata over 200 kB avkortes og det står i filen.
- Med `--stdin` har opptakeren **ikke** kjørt noe: filen sier «Exit: ukjent» og at utdataene er limt inn utenfra. Kjør helst kommandoen direkte.
- Hemmelighetsformer redigeres bort og telles - i utdata, kommandolinje og `--note`: nøkkelord + verdi i alle vanlige former (`TOKEN=…`, `"password": "…"`, `PGPASSWORD=…`), PEM/PGP-blokker, leverandørnøkler (GitHub, GitLab, OpenAI/Anthropic, Slack, Stripe, Telegram, npm, Vault, Infisical m.fl.), Bearer/Authorization/Cookie og hemmelige hoder, URL med passord eller `?token=`, webhook-URL-er. Utdata saneres først (ESC-sekvenser, kontrolltegn, usynlige tegn og Unicode-mellomrom fjernes). `--scan` leser stdin og skriver kun regelnavn og antall (brukes av NAS-porten).
- Det er en **siste sikring**, ikke en lisens: les filen før den committes. `gitleaks` kjører også i CI.
- Exit-koden fra kommandoen følger med (feil er også evidens). Opptakeren selv: 0 = kommandoen ga 0, 1 = kommandoen feilet (filen er skrevet), 2 = bruksfeil, 3 = filen kunne ikke skrives / finnes.

## Kjente grenser for redigeringen

Redigeringen er mønsterbasert og fanger **ikke**: en tilfeldig streng uten nøkkelord og uten kjent prefiks (f.eks. en rå AWS secret key eller Cloudflare-token alene på en linje); `-pPASSORD` (kort flagg, f.eks. `mysql -pPASS`); en verdi på linjen etter nøkkelen; en hemmelighet delt over flere linjer; nøkkelnavn uten ordene i listen (`pin`, `pass`, bare `key`); URL-passord med uenkodet `/`; fullbredde-bokstaver som etterligner nøkkelord. **Personopplysninger fanges ikke i det hele tatt.** Mot den uavhengige reviewerens korpus på 100 realistiske former lekker 20 (før rettelsene: 62); 0 av 28 harmløse linjer (git-SHA-er, UUID-er, «ikke satt», token-budsjetter) ble redigert feil.

## Etterpå

1. Åpne filen og fyll ut **Vurdering** (PASS / WARN / FAIL / UNKNOWN, hvilke matriserader den gjelder, hva som *ikke* ble dekket).
2. Commit filen og lenk den fra den aktuelle raden i lukkingsmatrisen (`docs/evidence/<fil>.md`); først da kan statusen flyttes til `VERIFIED`.
3. En evidensfil som viser WARN/UNKNOWN/FAIL flytter ikke noe til `VERIFIED` – raden beholder sin status og feilen beskrives.

## Hva som ikke hører hjemme her

Hemmelighetsverdier, rå samtaleinnhold, personopplysninger, kundedata og helse-/økonomiinnhold. Evidens skal være tall, navn, tilstander og tidsstempler. Er du i tvil: lim
utdataene i chatten i stedet for å committe dem.
