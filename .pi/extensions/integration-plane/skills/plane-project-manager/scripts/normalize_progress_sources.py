#!/usr/bin/env python3
"""Normalize common repo progress sources for Plane sync planning.

This script is intentionally read-only. It does not call Plane.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


def as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def project_name_from(path: Path) -> str:
    parts = path.parts
    if ".project-manager" in parts:
        idx = parts.index(".project-manager")
        if idx > 0:
            return parts[idx - 1]
    if "apps" in parts:
        idx = parts.index("apps")
        if idx > 0:
            return parts[idx - 1]
    return path.parent.name


def status_from_progress(progress: int) -> str:
    if progress >= 100:
        return "done"
    if progress > 0:
        return "in_progress"
    return "todo"


def normalize_phase(value: Any) -> str:
    phase = str(value or "development").strip().lower()
    return phase if phase in {"development", "testing", "deployment", "operations"} else "development"


def normalize_project_manager_config(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text())
    project_meta = data.get("project")
    project_name = project_name_from(path)
    if isinstance(project_meta, str) and project_meta.strip():
        project_name = project_meta.strip()
    items = []
    for feature in data.get("features", []):
        feature_id = str(feature.get("id") or "").strip()
        progress = as_int(feature.get("progress"))
        points = feature.get("points")
        located = feature.get("locatedSection") or feature.get("locatedPage") or ""
        items.append(
            {
                "project_name": project_name,
                "source_path": str(path),
                "external_source": "project-manager-config",
                "external_id": f"{project_name}:{feature_id}",
                "feature_id": feature_id,
                "name": str(feature.get("name") or feature_id),
                "progress": progress,
                "status": str(feature.get("status") or status_from_progress(progress)),
                "phase": normalize_phase(feature.get("phase")),
                "points": points,
                "category": feature.get("category"),
                "located": located,
            }
        )
    return {"source_path": str(path), "project_name": project_name, "adapter": "project-manager-config", "items": items}


def extract_raw_features_array(text: str) -> str:
    marker = "RAW_FEATURES"
    start = text.find(marker)
    if start < 0:
        return ""
    equals = text.find("=", start)
    if equals < 0:
        return ""
    bracket = text.find("[", equals)
    if bracket < 0:
        return ""
    depth = 0
    in_string: str | None = None
    escape = False
    for idx in range(bracket, len(text)):
        ch = text[idx]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == in_string:
                in_string = None
            continue
        if ch in {"'", '"', "`"}:
            in_string = ch
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return text[bracket + 1 : idx]
    return ""


def split_object_literals(array_text: str) -> list[str]:
    objects = []
    depth = 0
    start: int | None = None
    in_string: str | None = None
    escape = False
    for idx, ch in enumerate(array_text):
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == in_string:
                in_string = None
            continue
        if ch in {"'", '"', "`"}:
            in_string = ch
        elif ch == "{":
            if depth == 0:
                start = idx
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start is not None:
                objects.append(array_text[start : idx + 1])
                start = None
    return objects


def ts_value(obj: str, key: str) -> Any:
    string_match = re.search(rf"\b{re.escape(key)}\s*:\s*(['\"])(.*?)\1", obj, re.S)
    if string_match:
        return string_match.group(2)
    number_match = re.search(rf"\b{re.escape(key)}\s*:\s*(-?\d+(?:\.\d+)?)", obj)
    if number_match:
        raw = number_match.group(1)
        return float(raw) if "." in raw else int(raw)
    bool_match = re.search(rf"\b{re.escape(key)}\s*:\s*(true|false)", obj)
    if bool_match:
        return bool_match.group(1) == "true"
    return None


def normalize_roadmap_ts(path: Path) -> dict[str, Any]:
    text = path.read_text()
    project_name = project_name_from(path)
    array_text = extract_raw_features_array(text)
    items = []
    for idx, obj in enumerate(split_object_literals(array_text), start=1):
        raw_id = ts_value(obj, "id")
        feature_id = str(raw_id or idx).strip()
        if feature_id.isdigit():
            feature_id = feature_id.zfill(3)
        progress = as_int(ts_value(obj, "percentage"))
        name = str(ts_value(obj, "name") or feature_id)
        points = ts_value(obj, "points")
        items.append(
            {
                "project_name": project_name,
                "source_path": str(path),
                "external_source": f"{project_name.lower().replace('_', '-').replace(' ', '-')}-roadmap",
                "external_id": f"{project_name}:{feature_id}",
                "feature_id": feature_id,
                "name": name,
                "progress": progress,
                "status": status_from_progress(progress),
                "phase": normalize_phase(ts_value(obj, "phase")),
                "points": points,
                "category": ts_value(obj, "category"),
                "located": ts_value(obj, "locatedPage") or "",
            }
        )
    return {"source_path": str(path), "project_name": project_name, "adapter": "roadmap-ts", "items": items}


def find_sources(root: Path) -> list[Path]:
    ignored = {".git", "node_modules", ".next", "dist", "build"}
    found = []
    for path in root.rglob("*"):
        if any(part in ignored for part in path.parts):
            continue
        if path.name == "config.json" and path.parent.name == ".project-manager":
            found.append(path)
        elif path.name == "roadmap.ts" and "data" in path.parts:
            found.append(path)
    return sorted(found)


def main() -> int:
    parser = argparse.ArgumentParser(description="Normalize local progress sources for Plane sync planning.")
    parser.add_argument("--root", default=".", help="Repository/workspace root to scan.")
    parser.add_argument("--json", action="store_true", help="Print full normalized JSON.")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    results = []
    for source in find_sources(root):
        if source.parent.name == ".project-manager":
            results.append(normalize_project_manager_config(source))
        elif source.name == "roadmap.ts":
            results.append(normalize_roadmap_ts(source))

    if args.json:
        print(json.dumps({"root": str(root), "sources": results}, ensure_ascii=False, indent=2))
    else:
        for result in results:
            print(f"{result['project_name']}: {len(result['items'])} items from {result['source_path']} ({result['adapter']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
