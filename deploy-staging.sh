#!/usr/bin/env bash
# Deploy V2 to the staging box.
#
# reset --hard rather than pull: the running server writes its content out of
# the database and onto disk -- speakers, partners, the images -- so the
# checkout is always dirty, and a pull that touches any of those files refuses.
# Those files are derived data. Throwing them away is safe because the next
# boot writes them again from the database, which is where they actually live.
set -euo pipefail

cd /home/ubuntu/regsymp-v2
git fetch origin main
echo "was:  $(git log --oneline -1)"
git reset --hard origin/main
echo "now:  $(git log --oneline -1)"

npm ci --no-audit --no-fund --silent
pm2 restart regsymp-v2 --update-env >/dev/null
echo "restarted; waiting for it to answer"

for _ in $(seq 1 30); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:8800/api/health)" = "200" ]; then
    echo "up"
    exit 0
  fi
  sleep 4
done

echo "it did not come up; last lines of its log:" >&2
tail -20 ~/.pm2/logs/regsymp-v2-error.log >&2
exit 1
