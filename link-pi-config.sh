#!/usr/bin/env bash
set -euo pipefail

# Link every sibling project folder's .pi directory to this Pi-Config project's .pi.
# Assumes this script lives in the Pi-Config project root.

PI_CONFIG_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECTS_DIR="$(dirname -- "$PI_CONFIG_DIR")"

# On macOS, the current path may have different casing than the real directory
# entry (for example Pi-config vs Pi-Config). Re-read the sibling entry so the
# symlink text uses the directory name as it appears in Projects/.
for sibling_dir in "$PROJECTS_DIR"/*/; do
  sibling_dir="${sibling_dir%/}"
  if [[ "$sibling_dir" -ef "$PI_CONFIG_DIR" ]]; then
    PI_CONFIG_DIR="$sibling_dir"
    break
  fi
done

PI_CONFIG_NAME="$(basename -- "$PI_CONFIG_DIR")"
TARGET_DIR="$PI_CONFIG_DIR/.pi"
TARGET_REL="../$PI_CONFIG_NAME/.pi"

if [[ ! -d "$TARGET_DIR" ]]; then
  echo "Error: expected Pi config directory at: $TARGET_DIR" >&2
  exit 1
fi

for project_dir in "$PROJECTS_DIR"/*/; do
  project_dir="${project_dir%/}"
  project_name="$(basename -- "$project_dir")"
  link_path="$project_dir/.pi"

  # Do not link Pi-Config to itself.
  if [[ "$project_dir" -ef "$PI_CONFIG_DIR" ]]; then
    continue
  fi

  if [[ -L "$link_path" ]]; then
    current_target="$(readlink "$link_path")"
    if [[ -e "$link_path" && "$link_path" -ef "$TARGET_DIR" ]]; then
      echo "ok: $project_name/.pi already links to $PI_CONFIG_NAME/.pi"
    else
      echo "skip: $project_name/.pi is already a symlink to $current_target"
    fi
    continue
  fi

  if [[ -e "$link_path" ]]; then
    echo "skip: $project_name/.pi already exists and is not a symlink"
    continue
  fi

  ln -s "$TARGET_REL" "$link_path"
  echo "linked: $project_name/.pi -> $TARGET_REL"
done
