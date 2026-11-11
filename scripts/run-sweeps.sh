#!/usr/bin/env bash
# Runs the channel measurement suites, each split over several processes.
# Results are appended to data/results/channel-<suite>.jsonl and finished rows
# are skipped, so the script can be stopped and started again.
#
# Usage: scripts/run-sweeps.sh [shards] [suite ...]
set -u
cd "$(dirname "$0")/.."
SHARDS="${1:-4}"
shift || true
SUITES="${*:-long matrix null impair design hd}"
mkdir -p data/results
for suite in $SUITES; do
  echo "=== $suite ($(date +%H:%M:%S))"
  pids=""
  for ((i = 0; i < SHARDS; i++)); do
    node codec-sim/run-channel.ts "$suite" "$i" "$SHARDS" >> "data/results/log-$suite-$i.txt" 2>&1 &
    pids="$pids $!"
  done
  wait $pids
  echo "    rows: $(wc -l < "data/results/channel-$suite.jsonl" 2>/dev/null || echo 0)"
done
echo "=== done ($(date +%H:%M:%S))"
