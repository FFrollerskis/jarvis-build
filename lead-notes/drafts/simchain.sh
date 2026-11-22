#!/bin/bash
# Usage: simchain.sh <start-commit> <branch-ref>...   Simulerer GitHub-merge (to foreldre) av hver gren i rekkefølge; skriver konflikter og tre.
set -u
cd /home/user/jarvisbuild
cur=$1; shift
for br in "$@"; do
  out=$(git merge-tree --write-tree --name-only "$cur" "$br" 2>&1); rc=$?
  tree=$(echo "$out" | head -1)
  if [ $rc -ne 0 ]; then echo "KONFLIKT ved $br:"; echo "$out" | sed -n '2,12p'; exit 1; fi
  cur=$(git commit-tree -p "$cur" -p "$br" -m "sim merge $br" "$tree")
  echo "ren: $br -> tre $(echo $tree | cut -c1-8)"
done
echo "SLUTT: $cur tre $(git rev-parse $cur^{tree} | cut -c1-8)"
