#!/usr/bin/env bash
set -euo pipefail

# Link a project's .pi directory to this Pi-Config project's .pi.
# Run with no arguments to be prompted for project paths, or pass one or more
# project paths as arguments. Assumes this script lives in the Pi-Config root.

PI_CONFIG_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
TARGET_DIR="$PI_CONFIG_DIR/.pi"

if [[ ! -d "$TARGET_DIR" ]]; then
  echo "Error: expected Pi config directory at: $TARGET_DIR" >&2
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

link_project() {
  local path="$1"
  path="${path/#\~/$HOME}"

  local project_dir
  if ! project_dir="$(cd -- "$path" 2>/dev/null && pwd -P)"; then
    echo "error: not a directory: $1" >&2
    return 0
  fi

  if [[ "$project_dir" -ef "$PI_CONFIG_DIR" ]]; then
    echo "skip: $project_dir is the Pi-Config project itself"
    return 0
  fi

  local link_path="$project_dir/.pi"

  if [[ -L "$link_path" ]]; then
    if [[ -e "$link_path" && "$link_path" -ef "$TARGET_DIR" ]]; then
      echo "ok: $project_dir/.pi already links to Pi-Config/.pi"
    else
      echo "skip: $project_dir/.pi is already a symlink to $(readlink "$link_path")"
    fi
    return 0
  fi

  if [[ -e "$link_path" ]]; then
    echo "skip: $project_dir/.pi already exists and is not a symlink"
    return 0
  fi

  local target_rel
  target_rel="$(relpath "$project_dir" "$TARGET_DIR")"
  ln -s "$target_rel" "$link_path"
  echo "linked: $project_dir/.pi -> $target_rel"
}

if [[ $# -gt 0 ]]; then
  for path in "$@"; do
    link_project "$path"
  done
else
  while true; do
    read -r -p "Enter the path to a project to link (or press Enter to finish): " path || break
    if [[ -z "$path" ]]; then
      break
    fi
    link_project "$path"
  done
fi
