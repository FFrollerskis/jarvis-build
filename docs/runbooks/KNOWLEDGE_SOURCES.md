# Kunnskapskilder (WP-D1, UA-2) - oppsett, drift og verifisering

**Status:** bygget og testet mot testdobler og ekte embedded Postgres. **Ikke verifisert mot en ekte Drive-konto, en ekte NAS-mappe eller ekte møteeksporter** - verifiseringstrinnene
nederst er det Tobias kjører. Alt er **DVALE (av) til du setter `JARVIS_KNOWLEDGE_SOURCES`**.

Gjeldende dokumenthierarki: [ADR-001](../remediation/ADR-001-dokumenthierarki.md). Personvern: [UA2_KNOWLEDGE_DPIA.md](../UA2_KNOWLEDGE_DPIA.md) og
[PROCESSING_INVENTORY.md](../security/PROCESSING_INVENTORY.md).

## 1. Hva som skjer

Worker-containeren leser kildene du konfigurerer (Drive inkl. Docs/Slides/Sheets, Obsidian, filmapper, GitHub-dokumentasjon, e-postvedlegg, ferdige møtetranskripter), indekserer dem i Postgres
(`knowledge_documents`, `knowledge_embeddings`, entitetsgrafen) og gjør dem søkbare i chatten med `knowledge.search` («hva står det i dokumentene/notatene/referatene om …», «hvilke dokumenter nevner Acme»).
Treff er **sitert, ubetrodd data** (aldri instruks) og bærer sensitivitetsmerke; `special`/helse-treff sendes aldri til en skymodell.

## 2. Oppsett i tre steg

1. **Monter mappene skrivebeskyttet i worker-containeren** (kun for filsystem-/Obsidian-/transkriptkilder). Eksempel på en egen override-fil du lager selv (ikke sjekk inn stier til din NAS):

   ```yaml
   # docker-compose.knowledge.yml (eksempel)
   services:
     worker:
       volumes:
         - /volume1/notater/obsidian:/knowledge/obsidian:ro
         - /volume1/moter:/knowledge/moter:ro
   ```

   Start med `docker compose -f docker-compose.yml -f docker-compose.knowledge.yml up -d worker`.
2. **Sett allowlisten** i `.env`: `JARVIS_KNOWLEDGE_FS_ROOTS=/knowledge` (kommaseparert, absolutte basemapper). Uten den avvises alle filsystemkilder. Aldri `/` eller en systemkatalog.
3. **Sett kildene** i `.env` som én JSON-linje, og start workeren på nytt:

   ```
   JARVIS_KNOWLEDGE_SOURCES=[{"id":"notater","kind":"obsidian","memory_space":"personal","path":"/knowledge/obsidian","trust":"internal"},{"id":"moter","kind":"meeting_transcript","memory_space":"business","path":"/knowledge/moter","retention_days":180,"sync_interval_minutes":60}]
   ```

Workeren logger ved oppstart `knowledge_sources` (antall og kildetyper) og hver synk som `knowledge_source_synced` (kun kilde-id, type, rom og tall - aldri filnavn eller innhold).

**Alt-eller-ingenting:** er noe i listen galt, logges `knowledge_sources_config_rejected` med ALLE problemene (felt og årsak, aldri verdier), og **ingen** kilde registreres. Workeren fortsetter ellers som normalt
(kodejobber, executive og watchdog stopper ikke pga. en skrivefeil). Rett konfigurasjonen og start workeren på nytt. Se etter linjen:

```
docker compose logs worker | grep knowledge_sources
```

## 3. Konfigurasjonsreferanse

Felt som gjelder alle kilder: `id` (små bokstaver/sifre/`._:-`, 1-63 tegn, unik per rom), `kind`, `memory_space` (påkrevd, et kjent rom), `enabled` (false = valideres men kjører ikke), `default_sensitivity`
(gulv: `normal|sensitive|special`, standard `sensitive`), `max_sensitivity` (tak: dokumenter strengere enn dette indekseres IKKE), `trust` (`untrusted` standard | `internal`), `retention_days` (1-3650),
`sync_interval_minutes` (15-10080, standard 360). Ukjente felt avvises (også `tenant_id` - tenant kommer alltid fra eieren).
Sensitivitet: stikkordsklassifiseringen merker hemmeligheter, helse og økonomi som `special` (aldri til en skymodell, men fortsatt lagret og synlig for lokal modell). For kilder som kan inneholde slikt
(kode, konfigurasjon, private notater) kan du sette `"max_sensitivity": "sensitive"` - da indekseres `special`-dokumenter slett ikke. `default_sensitivity: "special"` holder en hel kilde borte fra skymodeller.

| kind | Påkrevd | Valgfritt |
|---|---|---|
| `drive` | `folder_id` ELLER `whole_drive: true` (bevisst valg, aldri standard) | `sheets` (`first` = første ark via Drive-eksport, `all` = ett dokument per ark via Sheets-API), `max_sheet_rows`, `max_sheet_columns`, `max_sheets_per_file` |
| `obsidian` | `path` | `max_files`, `max_file_bytes`, `max_depth` |
| `filesystem` | `path` | `extensions` (delmengde av tekstendelsene), `max_files`, `max_file_bytes`, `max_depth` |
| `meeting_transcript` | `path` | `formats` (`txt|vtt|srt|json`), `max_files`, `max_file_bytes`, `max_depth` |
| `github` | `repo` (`eier/navn`) | - (skrivebeskyttet) |
| `email_attachment` | - | `max` (1-100), `query` |

Sikkerhetsgrenser som håndheves i kode: stier må være absolutte og normaliserte (ingen `..`), innenfor en allowlistet basemappe, og aldri i systemkataloger eller `.ssh`/`.aws`-lignende kataloger;
den SANNE (symlink-oppløste) roten sjekkes på nytt før hver synk, og en rot som er blitt en symlink ut av allowlisten synkes ikke (ingenting tombstones). GitHub er låst til `JARVIS_GITHUB_REPO`
(åpne andre repo bevisst med `JARVIS_GITHUB_ALLOW_OTHER_REPOS=true`). **Endre aldri en kildes `id` etter første synk** - de gamle dokumentene blir da foreldreløse; fjern kilden (se 7) og opprett den på nytt.

## 4. Google Drive (Docs, Slides, Sheets)

- Krever Drive-OAuth-credentialen i hvelvet (samme som Drive-verktøyet). Uten den hoppes kilden over med `knowledge_source_skipped ... drive_credentials_missing` og prøves igjen automatisk.
- Docs/Slides leses som ren tekst, Sheets som CSV (med radtak). `sheets: "all"` krever Sheets-credentialen (`JARVIS_GOOGLE_SHEETS_TOKEN`); mangler den, hoppes arkene over (beskyttet mot tombstoning) og resten synkes.
- Positiv MIME-allowlist; makro-/skript-/kjørbare filer og alt binært leses aldri; maks 5 MiB per lesing. Kilden er skrivebeskyttet - synken endrer aldri noe i Drive.
- Drive-begrenseren tillater 20 lesinger i minuttet; kilden pauser derfor ~3 s mellom kall. En stor disk kan ta timer første gang - bruk `folder_id`, ikke `whole_drive`, når du kan.

## 5. Møtetranskripter

Ferdige filer (`txt`, `vtt`, `srt`, `json` med talere og tidsstempler). Tale→tekst er UA-7 og ikke bygget. Deltakere lagres kun som navn/referanse, **e-postadresser lagres aldri** (redigeres bort).
Sett `retention_days` for transkriptkilder (de inneholder tredjeparts persondata). Innholdet er data - en instruks i et referat følges aldri.

## 6. Entitetsgraf og påstandsverifisering

- Entitetsgrafen (kjente navn fra minnet, domener, repo-navn, prosjektnøkler, e-postadresser KUN som hash) er alltid på for konfigurerte kilder. `knowledge.search` med `mentions` svarer på «hvilke dokumenter nevner X»,
  og hvert treff lister hva det nevner. Modellassistert uttrekk er AV (`JARVIS_KNOWLEDGE_ENTITY_LLM=off`); `local` bruker kun lokal modell, `on` følger dokumentets sensitivitet (aldri sky for `special`).
- `knowledge.get_claim_status` (alltid på) viser kildeverifiseringsstatusen til en påstand: UNKNOWN, RESEARCHING, PROVISIONAL, VERIFIED, DISPUTED. **VERIFIED krever minst N uavhengige kilder** (standard 2,
  `JARVIS_KNOWLEDGE_CLAIM_MIN_SOURCES` 2-10; minst én primærkilde ELLER minst 3) og ingen motstridende evidens. Tre kopier av samme oppstrøms-påstand er én kilde. Motstrid gir DISPUTED. Dette er Jarvis' egen
  kildeverifisering, ikke en fasit.
- Skriving (registrere påstand, legge til/trekke tilbake evidens, foreslå promotering) er AV: `JARVIS_KNOWLEDGE_CLAIM_WRITES=on` i api. Handlingene står på ingen modellflate og har i dag **ingen eier-rute/UI** -
  de finnes som verktøy for eier-/system-veier (se «Begrensninger»). Promotering er alltid bare et forslag til minnets karantene.

## 7. Fjerne en kilde

`enabled: false` (eller fjern oppføringen) stopper nye synker, men **lar eksisterende dokumenter ligge**. Fjern selve innholdet med erasure-scope `knowledge_source` (se [DATA_ERASURE.md](../DATA_ERASURE.md)); det tar med
embeddings, entitetslenker, foreldreløse entiteter og evidensutdrag. Kilder med `retention_days` fjernes automatisk fysisk etter fristen.

## 8. Verifisering (kjøres av Tobias - ikke gjort i byggemiljøet)

1. `docker compose logs worker | grep -E "knowledge_sources|knowledge_source_"` - forvent `knowledge_sources` med riktig antall og `knowledge_source_synced` per kilde (`created > 0` første gang, `unchanged` deretter).
2. Spør i chatten: «hva står det i dokumentene mine om <noe du vet står i en av filene>?» - forvent treff med tittel og kilde, og en merknad om at innholdet er sitert data.
3. Rom-isolasjon: spør i et annet rom enn kildens - forvent ingen treff.
4. Drive: legg inn et Google-regneark med noen få rader og en `special`-aktig tekst (f.eks. et helseord) i en testmappe; forvent at helse-dokumentet ikke vises for en skymodell («holdt tilbake»-merknad) men gjør det for lokal modell.
5. Feilkonfig: sett en ugyldig verdi (f.eks. `"kind":"web"`) og start workeren - forvent `knowledge_sources_config_rejected` og at ingen kilde synkes.
6. Telling i databasen (som admin): `SELECT source_type, source_instance_id, memory_space_id, count(*) FROM knowledge_documents WHERE NOT deleted GROUP BY 1,2,3;`

## 9. Begrensninger (ærlig)

- Verifisert kun mot testdobler; ingen ekte Drive-/NAS-/transkriptkjøring.
- Skrive-handlingene i kildeverifiseringen (`register_claim`, `add_claim_evidence`, `retract_claim_evidence`, `propose_claim_promotion`) har ingen eier-rute eller dashbord: de kan foreløpig kun nås av kode med
  eier-/systemidentitet via ToolGateway. Selve lesingen og tilstandsmaskinen er ferdig og testet.
- Sensitivitetsklassifiseringen er stikkordsbasert (Q-52); sett gulv/tak per kilde og evaluer mot ekte materiale.
- Pieces er IKKE bygget (ingen kjent offentlig API, Q-22).
