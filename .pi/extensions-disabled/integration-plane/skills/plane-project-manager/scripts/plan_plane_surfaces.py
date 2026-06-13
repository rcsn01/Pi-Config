#!/usr/bin/env python3
"""Plan Plane Modules, Views, Pages, Cycles, and Intake from local repo data.

This script is read-only. It does not call Plane.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import re
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from normalize_progress_sources import (  # noqa: E402
    find_sources,
    normalize_project_manager_config,
    normalize_roadmap_ts,
)


IGNORED_DIRS = {".git", "node_modules", ".next", "dist", "build"}


def load_normalized_sources(root: Path) -> list[dict[str, Any]]:
    results = []
    for source in find_sources(root):
        if source.parent.name == ".project-manager":
            results.append(normalize_project_manager_config(source))
        elif source.name == "roadmap.ts":
            results.append(normalize_roadmap_ts(source))
    return results


def module_status(items: list[dict[str, Any]]) -> str:
    if items and all(int(item.get("progress") or 0) >= 100 for item in items):
        return "completed"
    if any(int(item.get("progress") or 0) > 0 for item in items):
        return "in-progress"
    return "planned"


def module_candidates(source: dict[str, Any]) -> list[dict[str, Any]]:
    items = source["items"]
    by_category: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    by_located: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for item in items:
        category = str(item.get("category") or "").strip()
        located = str(item.get("located") or "").strip()
        if category:
            by_category[category].append(item)
        if located:
            by_located[located].append(item)

    candidates = []
    for name, grouped in sorted(by_category.items()):
        if len(grouped) >= 2:
            candidates.append(
                {
                    "name": name,
                    "source": "category",
                    "work_item_count": len(grouped),
                    "status": module_status(grouped),
                    "external_id": f"{source['project_name']}:module:category:{slug(name)}",
                }
            )
    for name, grouped in sorted(by_located.items()):
        if len(grouped) >= 3:
            candidates.append(
                {
                    "name": name,
                    "source": "located",
                    "work_item_count": len(grouped),
                    "status": module_status(grouped),
                    "external_id": f"{source['project_name']}:module:located:{slug(name)}",
                }
            )
    return candidates


def view_candidates(source: dict[str, Any]) -> list[dict[str, Any]]:
    project = source["project_name"]
    phases = sorted({str(item.get("phase") or "development") for item in source["items"]})
    views = [
        {"name": "PM - In Progress", "filter": {"state_group": "started"}},
        {"name": "PM - Done", "filter": {"state_group": "completed"}},
        {"name": "PM - Backlog", "filter": {"state_group": "backlog"}},
        {"name": "PM - High Priority", "filter": {"priority": "high"}},
        {"name": "PM - Needs Docs", "filter": {"labels": ["needs-docs"]}},
        {"name": "PM - Needs Test Evidence", "filter": {"labels": ["needs-test-evidence"]}},
        {"name": "PM - Recently Updated", "filter": {"order_by": "-updated_at"}},
    ]
    for phase in phases:
        label = {
            "development": "Development",
            "testing": "E2E Testing",
            "e2e_testing": "E2E Testing",
            "deployment": "Deployment",
            "operations": "Operations",
        }.get(phase, phase.replace("_", " ").title())
        views.insert(0, {"name": f"PM - {label}", "filter": {"custom_property": {"PM Phase": label}}})
    for view in views:
        view["external_id"] = f"{project}:view:{slug(view['name'])}"
    return views


def page_candidates(root: Path, project_name: str) -> list[dict[str, str]]:
    page_paths = []
    for relative in [
        "README.md",
        "docs/architecture/README.md",
        "docs/architecture/architecture-overview.md",
        "docs/engineering/README.md",
        "docs/product/README.md",
        "docs/guides/index.md",
        "docs/engineering/verification-runbook.md",
        "docs/engineering/update-project-progress-dashboard-guide.md",
    ]:
        path = root / relative
        if path.exists():
            page_paths.append(path)

    feature_root = root / ".project-manager" / "features"
    if feature_root.exists():
        for path in sorted(feature_root.glob("*/README.md")):
            page_paths.append(path)
        for name in ["feature-spec.md", "tdd-spec.md", "debug-retro.md", "test-scenarios.md", "dev-log.md"]:
            page_paths.extend(sorted(feature_root.glob(f"*/{name}")))

    pages = []
    for path in page_paths:
        rel = path.relative_to(root)
        title = page_title_from_path(rel)
        pages.append(
            {
                "name": title,
                "source_path": str(path),
                "external_id": f"{project_name}:page:{slug(str(rel))}",
            }
        )
    return pages


def cycle_candidates(root: Path, project_name: str) -> list[dict[str, Any]]:
    process_dir = root / "docs" / "project-process"
    dates = []
    if process_dir.exists():
        for path in process_dir.glob("*.md"):
            match = re.match(r"(\d{4})-(\d{2})-(\d{2})-", path.name)
            if match:
                year, month, day = map(int, match.groups())
                dates.append(dt.date(year, month, day))
    if not dates:
        return []

    latest = max(dates)
    iso_year, iso_week, _ = latest.isocalendar()
    return [
        {
            "name": f"{iso_year}-W{iso_week:02d} Planning",
            "source": "docs/project-process dated docs",
            "requires_user_confirmation": True,
            "external_id": f"{project_name}:cycle:{iso_year}-w{iso_week:02d}",
        }
    ]


def intake_policy(project_name: str) -> dict[str, Any]:
    return {
        "external_id": f"{project_name}:intake-policy",
        "use_for": [
            "untriaged AddRowModal custom rows",
            "new GitHub issues awaiting acceptance",
            "stakeholder requests",
            "external bug reports",
        ],
        "do_not_use_for": ["authoritative .project-manager/config.json features", "approved roadmap.ts features"],
    }


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "item"


def page_title_from_path(path: Path) -> str:
    parts = list(path.parts)
    if parts[:2] == ["docs", "architecture"]:
        return "Architecture / " + path.stem.replace("-", " ").title()
    if parts[:2] == ["docs", "engineering"]:
        return "Engineering / " + path.stem.replace("-", " ").title()
    if parts[:2] == ["docs", "product"]:
        return "Product / " + path.stem.replace("-", " ").title()
    if parts[:2] == ["docs", "guides"]:
        return "Guide / " + path.stem.replace("-", " ").title()
    if ".project-manager" in parts and "features" in parts:
        idx = parts.index("features")
        feature_id = parts[idx + 1] if idx + 1 < len(parts) else "Feature"
        return f"Feature / {feature_id} / {path.stem.replace('-', ' ').title()}"
    return path.stem.replace("-", " ").title()


def project_root_for_source(source_path: Path) -> Path:
    parts = source_path.parts
    if ".project-manager" in parts:
        return Path(*parts[: parts.index(".project-manager")])
    if "apps" in parts:
        return Path(*parts[: parts.index("apps")])
    return source_path.parent


def main() -> int:
    parser = argparse.ArgumentParser(description="Plan Plane project surfaces from local progress sources.")
    parser.add_argument("--root", default=".", help="Workspace root to scan.")
    parser.add_argument("--json", action="store_true", help="Print full JSON plan.")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    sources = load_normalized_sources(root)
    plans = []
    for source in sources:
        source_path = Path(source["source_path"])
        project_root = project_root_for_source(source_path)
        project_name = source["project_name"]
        plans.append(
            {
                "project_name": project_name,
                "source_path": str(source_path),
                "modules": module_candidates(source),
                "views": view_candidates(source),
                "pages": page_candidates(project_root, project_name),
                "cycles": cycle_candidates(project_root, project_name),
                "intake": intake_policy(project_name),
            }
        )

    if args.json:
        print(json.dumps({"root": str(root), "plans": plans}, ensure_ascii=False, indent=2))
    else:
        for plan in plans:
            print(
                f"{plan['project_name']}: "
                f"{len(plan['modules'])} modules, "
                f"{len(plan['views'])} views, "
                f"{len(plan['pages'])} pages, "
                f"{len(plan['cycles'])} cycle candidates, "
                "1 intake policy"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
