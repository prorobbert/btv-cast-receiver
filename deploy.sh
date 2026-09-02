#!/bin/sh
# Stamp the build, then publish. Always --prod: the Cast console maps one url per application id, so a
# draft url is not what any registered receiver id points at.
set -e
cd "$(dirname "$0")"

stamped=$(date "+%Y-%m-%d %H:%M")
commit=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
dirty=""
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then dirty="+"; fi

cat > version.js <<EOF
/*
 * Rewritten by deploy.sh on every deploy. Committed with a placeholder so a fresh checkout still
 * loads, and so the receiver can always say which build is on screen — the device caches nothing but
 * you cannot otherwise tell a stale receiver from a fresh one.
 */
window.BTV_BUILD = { stamped: "$stamped", commit: "$commit$dirty" };
EOF

echo "stamped $stamped ($commit$dirty)"
netlify deploy --prod
