#!/bin/bash
# D-256: simulerer en piper-binær som avslutter UTEN å lese (drenere) stdin
# i det hele tatt - i motsetning til mock-piper-fail.sh (som alltid
# konsumerer hele stdin først, `cat >/dev/null`), noe som stille skjulte
# denne bug-klassen i den opprinnelige testsuiten. Beviser at
# `LocalPiperTts.synthesize()` nå håndterer dette (se `proc.stdin.on("error",
# ...)` i tts.ts) i stedet for å la en uhåndtert "error"-hendelse krasje HELE
# voice-gateway-prosessen (samme klasse som mock-whisper-closes-stdin-early.sh,
# funnet live på NAS-en).
echo "simulated early-exit piper failure: stdin never read" >&2
exit 9
