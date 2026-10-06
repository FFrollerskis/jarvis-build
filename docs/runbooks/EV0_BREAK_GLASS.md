# EV-0: break-glass – nødstopp og nøkkelgjenoppretting (eier-handling)

Gjelder D-410 (Evolution Masterplan v1.2 kap. 6, «Break-glass: offline recovery key + runbook; Jarvis kan ikke lese, rotere eller eksportere eierens nøkkel»).
**Status: `NOT VERIFIED` – skriptet er enhetstestet mot en fake `docker`, men aldri kjørt mot den ekte NAS-en.** Øv deg først (se «Øvelse»).

## Når bruker du dette?
Når Jarvis' egne kanaler (API, Telegram, dashbord) ikke kan stoles på, eller Jarvis/Evolution oppfører seg uventet og du vil stoppe alt **uten å gå gjennom Jarvis**. Jarvis kan ikke kjøre, endre eller lese noe av dette: `ops/break-glass/` er en beskyttet sti (E3), og ingen tjeneste får en privatnøkkel-variabel (vakt-test `break-glass-guard.test.ts`).

## Nøkkelen
- Én offline Ed25519-nøkkel (samme som signerer konstitusjonen, se `EV0_CONSTITUTION_SIGNING.md`). **Privatdelen finnes aldri på NAS, i repoet, i chat eller i `.env`.** NAS har kun fingeravtrykket (`JARVIS_CONSTITUTION_PUBKEY_SHA256`, når tilkoblingen er bygget).
- Oppbevar **to kopier** offline på ulike steder (f.eks. kryptert USB + utskrift i safe). Øv gjenoppretting minst én gang i året. `*.key` og `*private*.pem` er git-ignorert.
- Er du den eneste som kan nå nøkkelen, finnes ingen suksesjon ennå (krav D-MC-35 gjelder ekstern produksjon og er ikke bygget).

## A. Nødstopp (på NAS-verten, som deg selv)
```
cd /sti/til/jarvisbuild
ops/break-glass/freeze-jarvis.sh            # tørrkjøring: viser hva som VIL skje, endrer ingenting
ops/break-glass/freeze-jarvis.sh --yes      # kill switch i databasen + stopp api, worker, voice-gateway
```
Variant: `--no-stop --yes` slår bare på kill switch og lar containerne gå.

Skriptet leser `JARVIS_TENANT_ID` og `JARVIS_OWNER_PERSON_ID` fra `.env` (uten å kjøre filen eller skrive ut verdier), skriver en revisjonsrad (`break_glass.freeze`) som databasen-superbruker inne i postgres-containeren, og setter kill switch-raden (`owner_control_state`, `GLOBAL`). Feiler revisjonen, fortsetter nødstoppet og du får en ADVARSEL.

Verifiser etterpå:
```
docker compose -f infra/local/docker-compose.yml ps
docker compose -f infra/local/docker-compose.yml exec -T postgres psql -U postgres -d jarvis -c "SELECT * FROM owner_control_state;"
docker compose -f infra/local/docker-compose.yml exec -T postgres psql -U postgres -d jarvis -c "SELECT at, type, reason FROM audit_events WHERE type LIKE 'break_glass.%' ORDER BY audit_id DESC LIMIT 5;"
```

## B. Oppheve
```
ops/break-glass/freeze-jarvis.sh --release --yes
docker compose --env-file .env -f infra/local/docker-compose.yml up -d api worker voice-gateway
```
`--release` fjerner kun kill switch-raden og skriver `break_glass.release`; den starter **ikke** tjenestene (det gjør du bevisst selv). Finn og forstå årsaken før du opphever.

## C. Mistet eller kompromittert signeringsnøkkel
1. Er nøkkelen kompromittert: gjør **A** først.
2. Lag nytt par (`sign-constitution.mjs keygen`), sett det nye fingeravtrykket i NAS-`.env`, øk `version` i manifestet, signer på nytt og legg inn nøkkel + signatur via en eier-PR. Gammel signert konstitusjon avvises (`constitution_key_mismatch` / `constitution_rollback`).
3. Dette krever ikke Jarvis i det hele tatt – fingeravtrykket ligger i `.env`, som bare du endrer.

## Øvelse (før du trenger det)
1. `ops/break-glass/freeze-jarvis.sh` (tørrkjøring) – sjekk at planen ser riktig ut.
2. `ops/break-glass/freeze-jarvis.sh --no-stop --yes`, bekreft at Jarvis nekter handlinger (kill switch), deretter `--release --yes`.
3. Først når det virker: øv hele nødstoppet én gang med stopp av containere.

## Hva dette IKKE er
- Ikke bevist mot ekte NAS/Postgres/compose (kun fake `docker` i test).
- Ikke en suksesjonsplan eller flere vokterkontoer (MC D-MC-35).
- Ikke en erstatning for backup/restore (`BACKUP_RESTORE_RUNBOOK.md`).
