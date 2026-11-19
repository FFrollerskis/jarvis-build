import re
ROOT = "/home/user/jarvisbuild/.claude/worktrees/docs2/"

Q71 = (
    "| Q-71 | **Step-up-kanalen er klient-påstått (JARVIS-111; funnet i WP-G2 review A, MEDIUM-3; arvet fra D-131/D-462).** `POST /session/authorize` gir `auth_strength: signed` for ENHVER kanalverdi (også `system`, `telegram`, `voice`, `watch`) til en enhet som kan signere, og step-up-sjekken (`ownerStepUpDenial`) leser `identity.channel`. "
    "Påstanden «tale, Telegram og klokke kan ikke åpne dør, flytte penger eller gjøre skyendringer» gjelder derfor kun ærlige klienter: den som har nøkkelen til en Watch- eller tale-enhet kan be om kanalen `web` og passere step-up for alle mutasjoner (penger, sky, growth, hjem, bil). "
    "(1) Skal enhetstype bindes til tillatte kanaler (lukket enhetstype web, desktop, mobile, watch, voice, api ved innrulling; `/session/authorize` gir `signed` kun for kanaler som hører til enhetstypen; eksisterende enheter med fri `kind` får `signed` bare for nettleser/desktop etter re-innrulling, fail-closed)? *Anbefaling:* ja, som egen WP-S1 med navngitt D-beslutning (endrer kjerneautentisering, krever migrasjon og re-innrulling av dine enheter). "
    "(2) Inntil da: ikke slå på noen `JARVIS_PERSONAL_*`-, `JARVIS_GROWTH_WRITE_*`- eller `JARVIS_COMMS_OUTBOUND`-flagg på en maskin der en lavtillits-enhet (Watch, stemme) er innrullert. | "
    "Åpen. Reist 2026-11-19 av WP-G2-gjennomgangen; blokkerer ikke merge (alt er DORMANT/AV), men BLOKKERER aktivering av pengebevegende, fysiske og utgående flagg |"
)
J111 = (
    "| JARVIS-111 | P1 | Step-up-kanalen er klient-påstått: `POST /session/authorize` (`server.ts` ~:961) gir `auth_strength: signed` for enhver `ChannelSchema`-verdi (også `system`, `telegram`, `voice`, `watch`) til en enhet som kan signere; ingen binding enhetstype til kanal (`devices.kind` er fritekst og ubrukt); "
    "`ownerStepUpDenial` (`class-d-pipeline.ts` ~:58) leser `identity.channel`; en innehaver av en lavtillits-nøkkel kan be om kanalen `web` og passere step-up for alle mutasjoner (penger, sky, growth, hjem, bil, utgående kommunikasjon) | "
    "Oppstrøms D-131/D-462 (funnet i WP-G2 review A) | `OPEN` | `apps/api/src/server.ts`, `modules/core/src/services/channel-session-authority.ts` (~:171-211), `modules/tool-gateway/src/class-d-pipeline.ts` (~:58) | "
    "`modules/core/test/channel-session-authority.test.ts` test D (samme nøkkel gir `mobile` og `web`) | — | WP-G2 | Rest: Q-71 og egen WP-S1 (navngitt D-beslutning; migrasjon; re-innrulling). |"
)
for name, row, n in (("Q71", Q71, 3), ("J111", J111, 10)):
    cells = row.strip().strip("|").split("|")
    assert len(cells) == n, (name, len(cells), [c[:30] for c in cells])

def edit(path, fn):
    p = ROOT + path
    s = open(p, encoding="utf-8").read()
    s2 = fn(s)
    assert s2 != s, path
    open(p, "w", encoding="utf-8").write(s2)

def oq(s):
    lines = s.split("\n")
    assert not any(l.startswith("| Q-71 |") for l in lines)
    h = next(i for i, l in enumerate(lines) if l.startswith("## Åpne spørsmål – krever Tobias"))
    sep = next(i for i in range(h, len(lines)) if lines[i].startswith("|---"))
    lines[sep + 1:sep + 1] = [Q71]
    return "\n".join(lines)
edit("docs/OPEN_QUESTIONS.md", oq)

def led(s):
    lines = s.split("\n")
    assert not any(l.startswith("| JARVIS-111 |") for l in lines)
    idx = max(i for i, l in enumerate(lines) if l.startswith("| JARVIS-110 |"))
    lines[idx + 1:idx + 1] = [J111]
    return "\n".join(lines).replace("JARVIS-001 … JARVIS-110", "JARVIS-001 … JARVIS-111", 1)
edit("docs/remediation/FINDINGS_LEDGER.md", led)
print("ok")
