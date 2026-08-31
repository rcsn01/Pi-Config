#!/usr/bin/env bash
set -euo pipefail

# Link this Pi-Config project's global pi resources into ~/.pi/agent:
#   APPEND_SYSTEM.md, extensions, profiles, skills, themes, settings.json
# Idempotent: existing correct links report ok, foreign links and real files
# are skipped, never overwritten. Run from anywhere; assumes this script
# lives in Pi-Config/scripts.

PI_CONFIG_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SOURCE_DIR="$PI_CONFIG_DIR/.pi"
AGENT_DIR="$HOME/.pi/agent"

ITEMS=(SYSTEM.md APPEND_SYSTEM.md extensions profiles skills themes settings.json)

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Error: expected Pi config directory at: $SOURCE_DIR" >&2
  exit 1
fi

if [[ ! -d "$AGENT_DIR" ]]; then
  echo "Error: expected pi agent directory at: $AGENT_DIR (is pi installed?)" >&2
  exit 1
fi

# Compute a relative path from directory $1 to directory $2.
relpath() {
  local from="$1" to="$2"
  local common="$from" back=""
  while [[ "$common" != "/" && "${to#"$common/"}" == "$to" ]]; do
    common="$(dirname -- "$common")"
    back="../$back"
  done
  local rel="${to#"$common/"}"
  rel="${rel#/}"
  echo "${back}${rel}"
}

link_item() {
  local item="$1"
  local link_path="$AGENT_DIR/$item"
  local target="$SOURCE_DIR/$item"

  if [[ ! -e "$target" ]]; then
    echo "skip: $item does not exist in $SOURCE_DIR" >&2
    return 0
  fi

  if [[ -L "$link_path" ]]; then
    if [[ "$link_path" -ef "$target" ]]; then
      echo "ok: $item already linked"
    else
      echo "skip: $link_path is a symlink to $(readlink "$link_path")"
    fi
    return 0
  fi

  if [[ -e "$link_path" ]]; then
    echo "skip: $link_path already exists and is not a symlink — move or merge it manually" >&2
    return 0
  fi

  local target_rel
  target_rel="$(relpath "$AGENT_DIR" "$target")"
  ln -s "$target_rel" "$link_path"
  echo "linked: $link_path -> $target_rel"
}

for item in "${ITEMS[@]}"; do
  link_item "$item"
done