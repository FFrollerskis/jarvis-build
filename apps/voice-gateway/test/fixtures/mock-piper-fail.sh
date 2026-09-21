#!/bin/bash
# Task #125 (D-217): simulerer en piper-prosessfeil - konsumerer stdin,
# skriver til stderr og feiler med et ikke-null exit-kode, UTEN å produsere
# noen lydrammer i det hele tatt.
cat >/dev/null
echo "simulated piper failure: voice_model_load_error" >&2
exit 2
