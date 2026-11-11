#!/usr/bin/env bash
# Fetches the public Xiph.org "derf" test sequences used by the evaluation.
# These are standard codec test clips (talking heads and video-conference
# scenes). They are stored in data/xiph/, which is git-ignored: the clips and
# anything derived from them stay on your machine and are never published.
#
# Usage: scripts/fetch-testdata.sh [small|all]
#   small  CIF clips only (about 0.4 GB)
#   all    CIF clips plus four 720p conference clips (about 3.7 GB)
set -u
BASE="https://media.xiph.org/video/derf/y4m"
DEST="$(cd "$(dirname "$0")/.." && pwd)/data/xiph"
mkdir -p "$DEST"

CIF="akiyo_cif foreman_cif mother_daughter_cif news_cif silent_cif paris_cif deadline_cif sign_irene_cif students_cif"
HD="Johnny_1280x720_60 KristenAndSara_1280x720_60 vidyo1_720p_60fps vidyo4_720p_60fps"

LIST="$CIF"
if [ "${1:-small}" = "all" ]; then LIST="$CIF $HD"; fi

for name in $LIST; do
  out="$DEST/$name.y4m"
  if [ -s "$out" ]; then echo "have $name"; continue; fi
  echo "fetching $name"
  curl -fsSL --retry 3 -o "$out.part" "$BASE/$name.y4m" && mv "$out.part" "$out" || echo "FAILED $name"
done
echo "done"
ls -la "$DEST"
