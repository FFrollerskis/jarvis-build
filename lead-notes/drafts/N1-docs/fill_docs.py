#!/usr/bin/env python3
# WP-N1: fyller inn endelige tall i docs (oppfølging etter apply_docs.py). Bruk: fill_docs.py ROOT "<SUITE_FINAL-tekst>" [--dry]
import sys, pathlib
ROOT = pathlib.Path(sys.argv[1]); SUITE_FINAL = sys.argv[2]; DRY = "--dry" in sys.argv
def rd(p): return (ROOT / p).read_text(encoding="utf-8")
def wr(p, s):
    if not DRY: (ROOT / p).write_text(s, encoding="utf-8")
def sub1(s, old, new, label):
    n = s.count(old)
    if n != 1: raise SystemExit(f"FEIL: {label}: forventet 1 treff, fant {n}")
    return s.replace(old, new)
PENDING_D = "pågår (føres inn når den er ferdig)"
PENDING_S = "kjøring pågår (føres inn når den er ferdig)"

# ---- D-477
D = rd("docs/DECISIONS_AND_ASSUMPTIONS.md")
D = sub1(D, "to uavhengige gjennomganger, to fiks-runder og delta-re-reviewer) | **Besluttet og bygget**", "to uavhengige gjennomganger, tre fiks-runder og delta-re-reviewer) | **Besluttet og bygget**", "D477-tittel")
D = sub1(D, "Eierens egne ruter og Telegram-varsel er uendret. 9) **IKKE bygget",
 "Eierens egne ruter og Telegram-varsel er uendret. En LOKAL ulåst verktøytur (dagstak, `JARVIS_TOOL_TURN_MODEL=off` eller fallback) som leser en restricted-origin-jobb låses selv: det uholdte, modellvendte viewet bærer en trusted `restricted: true` (satt av `ChatJobs.present` fra kontrakten, aldri fra tekst), `trackedExecutor` låser turen på den (fail-closed også for utkuttet output), og skyviewet er uendret (`withheld`, ingen lås); `jobbstatus` er fail-closed når `jobOrigin` mangler. Med `JARVIS_TOOL_TURN_MODEL=off` låser derfor enhver tur som leser en restricted-origin-jobb (streng, ikke løs). 9) **IKKE bygget", "D477-jobber")
D = sub1(D, "delta 2 (snever, runde-2-endringene): " + PENDING_D + ". Tre eksakt-form-tester",
 "delta 2 (snever, runde-2-endringene): A «merge», B «merge» (ett nytt LOW: en lokal, ulåst verktøytur kunne lese en låst jobbs resultat og lagre svaret umerket); runde 3 (liten: dette LOW, `jobOrigin` fail-closed og et testhull): B bekreftet «merge» (A sin tilsvarende INFO lukkes av samme fiks; produksjonsdeltaen på +51/-10 linjer er reviewet av B alene). Tre eksakt-form-tester", "D477-review")
D = sub1(D, "**Test:** N1-settet 211 tester i 17 filer (ekte Postgres der DB trengs); byggerens mutantsett 106 (105 drept av en feilet assertion, M48 ekvivalent) og reviewernes egne ca. 230 mutanter; `typecheck`, `lint` og `check:containment` exit 0; full suite (lokal, embedded Postgres): `17949ceb` 16 827 av 16 832 (990 filer, de fem røde er de kjente sandkasse-feilene), endelig HEAD " + PENDING_S + ". ",
 "**Test:** N1-settet 226 tester i 17 filer (ekte Postgres der DB trengs); byggerens mutantsett 122 (121 drept av en feilet assertion, M48 ekvivalent) og reviewernes egne ca. 320 mutanter; `typecheck`, `lint` og `check:containment` exit 0; full suite (lokal, embedded Postgres): `17949ceb` 16 827 av 16 832 (990 filer) og `b60bceb6` 16 861 av 16 866 (992 filer), endelig HEAD `f1aa33e8` " + SUITE_FINAL + "; de fem røde er hver gang de kjente sandkasse-feilene. ", "D477-test")
wr("docs/DECISIONS_AND_ASSUMPTIONS.md", D)

# ---- PROJECT_STATUS
P = rd("docs/PROJECT_STATUS.md")
P = sub1(P, "To uavhengige gjennomganger, to fiks-runder og delta-re-reviewer (" + PENDING_D + "); N1-settet 211 tester i 17 filer, 106 mutanter (105 drept, 1 ekvivalent), full suite `17949ceb` 16 827 av 16 832 (kun de fem kjente sandkasse-feilene), endelig HEAD " + PENDING_S + ".",
 "To uavhengige gjennomganger, tre fiks-runder og delta-re-reviewer (siste verdikt «merge» fra begge); N1-settet 226 tester i 17 filer, 122 mutanter (121 drept, 1 ekvivalent), full suite `b60bceb6` 16 861 av 16 866 og endelig HEAD `f1aa33e8` " + SUITE_FINAL + " (kun de fem kjente sandkasse-feilene).", "status-n1")
wr("docs/PROJECT_STATUS.md", P)

# ---- FINDINGS_LEDGER (JARVIS-101)
L = rd("docs/remediation/FINDINGS_LEDGER.md")
L = sub1(L, "17 N1-testfiler/211 tester (ekte Postgres der DB trengs); flagg-AV-differensial mot ren `ec3e684e` (508 sammenligninger, 0 forskjeller); 106 mutanter (105 drept, 1 ekvivalent) pluss reviewernes ca. 230 egne; full suite `17949ceb` 16 827/16 832 (de fem kjente sandkasse-feilene), endelig HEAD " + PENDING_S + " |",
 "17 N1-testfiler/226 tester (ekte Postgres der DB trengs); flagg-AV-differensial mot ren `ec3e684e` (508 sammenligninger, 0 forskjeller); 122 mutanter (121 drept, 1 ekvivalent) pluss reviewernes ca. 320 egne; full suite `b60bceb6` 16 861/16 866 og endelig HEAD `f1aa33e8` " + SUITE_FINAL + " (de fem kjente sandkasse-feilene) |", "ledger-101")
wr("docs/remediation/FINDINGS_LEDGER.md", L)
print("OK (dry)" if DRY else "OK: endelige tall ført inn")
