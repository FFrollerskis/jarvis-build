#!/bin/bash
# Task #125 (D-217): simulerer en whisper.cpp-prosessfeil (f.eks. ugyldig
# modell/korrupt wav) - konsumerer stdin (samme kontrakt som ok-scriptet),
# skriver til stderr og feiler med et ikke-null exit-kode, for å bevise at
# LocalWhisperStt.end() kaster en beskrivende feil i stedet for å late som
# et transkript ble produsert.
cat >/dev/null
echo "simulated whisper failure: model_load_error" >&2
exit 3
