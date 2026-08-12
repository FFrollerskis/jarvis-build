# Jarvis – databehandler- og regionmatrise

**Status:** v1.0-skjelett (fase 1-krav: eksplisitte felter for LLM, STT, TTS og realtime).
Fylles ut FØR en leverandør tas i bruk; «TBD / benchmark required» betyr at valget ikke er tatt.
Ingen leverandør er valgt i fase 1.

| Kategori | Leverandør | Tjeneste | Region | Databehandleravtale | Trener på data? | Retensjon hos leverandør | Tillatte memory spaces | Status |
|---|---|---|---|---|---|---|---|---|
| LLM | TBD / benchmark required | – | – | – | – | – | – | Velges i fase 3 (D-14/Q-04) |
| LLM (lokal) | TBD | – | lokalt (NAS/PC) | ikke relevant | nei | ingen | alle inkl. health (D-23) | Vurderes fase 3+/10 |
| STT | TBD / benchmark required | – | – | – | – | – | – | Norsk benchmark fase 5 (D-10) |
| TTS | TBD / benchmark required | – | – | – | – | – | – | Norsk benchmark fase 5 (D-10) |
| Realtime (tale-til-tale) | TBD / benchmark required | – | – | – | – | – | – | Egen kategori i fase 5-benchmark |
| Embeddings | TBD | – | – | – | – | – | – | Velges i fase 4 |

## Regler

1. En rad med «TBD» kan ikke tas i produksjonsbruk. Punktum.
2. `health`-space kan aldri sendes til en radleverandør uten egen eksplisitt beslutning + sterk
   minimering (D-23, CANONICAL_SPEC §3).
3. Hver utfylt rad krever: verifisert region, signert/akseptert databehandleravtale, dokumenterte
   trenings- og retensjonsvilkår, og dato for kontroll (vilkår endrer seg – kontrolleres på nytt ved
   implementasjon eller kjøp, jf. masterplanen).
4. Matrisen revideres ved hvert leverandørvalg og minst per fase-port.
