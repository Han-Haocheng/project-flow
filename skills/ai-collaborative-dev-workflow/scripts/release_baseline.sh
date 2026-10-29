#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 '<发布提交特征>' [阈值]" >&2
  echo "找到最近发布基线，输出其后的提交数；达到阈值时退出 0，否则退出 1。" >&2
  exit 2
}

pattern=${1:-}
threshold=${2:-10}
[ -n "$pattern" ] || usage

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[FAIL] 当前不在 git 工作树内" >&2
  exit 1
fi

base=$(git log --grep "$pattern" -1 --format=%H 2>/dev/null || true)
if [ -z "$base" ]; then
  echo "[FAIL] 未找到发布基线（grep: $pattern）" >&2
  exit 1
fi

count=$(git rev-list --count "$base..HEAD")
echo "baseline=$base"
echo "count=$count"
if [ "$count" -ge "$threshold" ]; then
  echo "release_due=yes"
  exit 0
fi
echo "release_due=no"
exit 1
