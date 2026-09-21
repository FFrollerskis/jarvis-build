#!/bin/bash
# Task #125 (D-217): en piper-prosess som ALDRI avslutter av seg selv etter
# første ramme - beviser at cancel() faktisk DREPER prosessen
# (child.kill()), IKKE bare venter på at den selv skal bli ferdig. Testen
# setter en kort timeout på selve vitest-assertionen; hvis cancel() var en
# ren "konsument slutter å lese"-implementasjon uten et ekte kill(), ville
# denne prosessen (og dermed testen) hengt til den ytre 30s-timeouten.
set -euo pipefail
cat >/dev/null
printf 'AAAA'
sleep 30
