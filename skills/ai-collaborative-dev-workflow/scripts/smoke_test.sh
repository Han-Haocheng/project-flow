#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cd "$tmp"
git init -q -b dev
git config user.name "smoke-test"
git config user.email "smoke@test.invalid"
printf 'a\n' > a.txt
printf 'b\n' > b.txt
git add a.txt b.txt
git commit -q -m "chore: smoke baseline"
head_before=$(git rev-parse HEAD)

printf 'x\n' >> a.txt
git add a.txt
if bash "$SCRIPT_DIR/check_staged_files.sh" b.txt >/dev/null 2>&1; then
  echo "FAIL: 越界暂存未被拦截"
  exit 1
fi
echo "PASS: 越界暂存被拦截"
git commit -q -m "chore: commit a.txt"

printf 'y\n' >> b.txt
git add b.txt
if ! bash "$SCRIPT_DIR/check_staged_files.sh" b.txt >/dev/null 2>&1; then
  echo "FAIL: 归属内暂存被误拦"
  exit 1
fi
echo "PASS: 归属内暂存通过"
git commit -q -m "chore: commit b.txt"

base=$(git log --grep "smoke baseline" -1 --format=%H)
count=$(git rev-list --count "$base..HEAD")
if [ "$count" -lt 2 ]; then
  echo "FAIL: 基线计数异常 count=$count"
  exit 1
fi
echo "PASS: 基线计数=$count"

mkdir -p .agents
cat > .agents/COLLAB_STATE.md <<EOF
state_version: 1
updated_at: smoke-test
last_session: smoke
baseline: $head_before
EOF
state_out=$(bash "$SCRIPT_DIR/check_state.sh" .agents/COLLAB_STATE.md 2>&1 || true)
case "$state_out" in
  *"状态基线"*)
    echo "PASS: 状态基线漂移被检出"
    ;;
  *)
    echo "FAIL: 状态基线漂移未检出"
    echo "$state_out"
    exit 1
    ;;
esac

cat > .agents/BROKEN_STATE.md <<EOF
this is not a valid collab state
EOF
broken_out=$(bash "$SCRIPT_DIR/check_state.sh" .agents/BROKEN_STATE.md 2>&1 || true)
case "$broken_out" in
  *"台账"*)
    echo "PASS: 台账损坏被检出"
    ;;
  *)
    echo "FAIL: 台账损坏未检出"
    echo "$broken_out"
    exit 1
    ;;
esac

echo "ALL PASS"
