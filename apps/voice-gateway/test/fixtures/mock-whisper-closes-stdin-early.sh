#!/bin/bash
# D-256: simulerer en whisper.cpp-binær som avslutter UTEN å lese
# (drenere) stdin i det hele tatt - i motsetning til mock-whisper-ok.sh/
# mock-whisper-fail.sh, som BEGGE alltid konsumerer hele stdin først
# (`wc -c <&0`/`cat >/dev/null`), noe som stille skjulte denne bug-klassen
# i den opprinnelige testsuiten. Når prosessen avsluttes uten å ha lest
# stdin, lukkes lesesiden av pipen - et samtidig `proc.stdin.end(wav)`-kall
# fra Node kan da feile med EPIPE. Beviser at `LocalWhisperStt.end()` nå
# håndterer dette (se `proc.stdin.on("error", ...)` i stt.ts) i stedet for
# å la en uhåndtert "error"-hendelse krasje HELE voice-gateway-prosessen
# (funnet live på NAS-en, D-256).
echo "simulated early-exit whisper failure: stdin never read" >&2
exit 7
