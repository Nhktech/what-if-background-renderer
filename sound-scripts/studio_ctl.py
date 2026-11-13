#!/usr/bin/env python3
"""studio_ctl - controlled production operations for What If Studio.

This is the ONLY command line surface the Chief AI Agent (GLM) is permitted to
use through the application. Every operation is scoped to a single project
directory under ~/video-sound-designer/projects and never touches source media.

Usage:
  python3 scripts/studio_ctl.py <command> <project> [args]

Commands:
  status      <project>          Project snapshot as JSON
  plan-get    <project>          Full sound plan as JSON
  plan-apply  <project> '<json>' Validate + normalize + write a full plan
  plan-events <project> '<json>' Replace only sound_events, keep the rest of the plan
  normalize   <project>          Re-normalize the existing plan in place
  assets      <project>          List generated audio assets (with durations)
  library-search <query...>      Search the local sound library by name
  generate    <project> [--dry-run]   Run sound generation for the plan
  mix         <project> [--dry-run]   Run the FFmpeg mixer, new preview version
  validate    <project>          Check every event resolves to an audio asset
  history     <project>          Show recent production history

There is deliberately NO approve or export command. Final approval is a user
action performed inside the What If Studio application.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import plan_tools  # noqa: E402

ROOT = plan_tools.ROOT
LIBRARY_DIR = ROOT.parent / "what-if" / "what-if-studio" / "library" / "sfx"


def out(data):
    print(json.dumps(data, indent=2, ensure_ascii=False, default=str))


def probe_duration(path):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True,
    )
    if result.returncode != 0 or not result.stdout.strip():
        return None
    try:
        return float(result.stdout.strip())
    except ValueError:
        return None


def read_manifest(project):
    return json.loads((project / "project.json").read_text(encoding="utf-8"))


def write_manifest(project, manifest):
    manifest["updated_at"] = plan_tools.datetime.now(plan_tools.timezone.utc).isoformat()
    (project / "project.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )


def next_version_path(project, base):
    import re

    output_dir = project / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"(_v\d+)+$", "", base.stem)
    candidate = output_dir / f"{stem}{base.suffix}"
    version = 1
    while candidate.exists():
        version += 1
        candidate = output_dir / f"{stem}_v{version}{base.suffix}"
    return candidate


def plan_paths(project):
    return (
        "projects/" + project.name + "/sound-plan.json",
        "projects/" + project.name + "/sound-effects",
    )


def run_generation(project, dry_run):
    plan_rel, sfx_rel = plan_paths(project)
    args = [
        "python3", "scripts/generate_sfx_v2.py",
        "--plan", plan_rel,
        "--sfx-dir", sfx_rel,
        "--library-dir", str(LIBRARY_DIR),
        "--env", ".env",
    ]
    if dry_run:
        args.append("--dry-run")
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=900)
    return result


def run_mix(project, dry_run):
    manifest = read_manifest(project)
    plan_rel, sfx_rel = plan_paths(project)
    input_video = project / manifest.get("source_video") or "input/source-video.mp4"
    base_name = manifest.get("preview_output") or f"output/{project.name}_Preview.mp4"
    base = project / base_name
    if base.exists():
        target = next_version_path(project, base)
    else:
        target = base

    args = [
        "python3", "scripts/build_mix_v2.py",
        "--plan", plan_rel,
        "--input", str(input_video),
        "--sfx-dir", sfx_rel,
        "--output", str(target),
    ]
    if dry_run:
        args.append("--dry-run")
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=600)

    if result.returncode == 0 and not dry_run:
        if not target.exists() or target.stat().st_size < 1000:
            return result, target, "Output file missing or too small after mixing."
        manifest["preview_output"] = str(target.relative_to(project))
        manifest["status"] = "preview-ready"
        write_manifest(project, manifest)
        plan_tools.append_history(project, "mix", f"Preview created: {target.name}")
    return result, target, None


def collect_assets(project):
    sfx_dir = project / "sound-effects"
    assets = []
    if sfx_dir.is_dir():
        for file in sorted(sfx_dir.iterdir()):
            if file.is_file() and file.suffix.lower() in (".mp3", ".wav", ".m4a", ".aac"):
                assets.append({
                    "file": file.name,
                    "bytes": file.stat().st_size,
                    "duration_seconds": probe_duration(file),
                })
    return assets


def event_asset_status(project, plan):
    """Check which events resolve to an audio asset without generating."""
    import re as _re

    def find_audio(name, folders):
        filename = plan_tools.safe_name(name)
        for folder in folders:
            if not folder.is_dir():
                continue
            for extension in (".mp3", ".wav", ".m4a", ".aac"):
                candidate = folder / f"{filename}{extension}"
                if candidate.is_file():
                    return candidate
                matches = sorted(folder.glob(f"{filename}-*{extension}"))
                if matches:
                    return matches[0]
        return None

    folders = [project / "sound-effects", ROOT / "sound-effects", LIBRARY_DIR]
    status = []
    for event in plan.get("sound_events", []):
        name = event.get("reuse") or event.get("id")
        asset = find_audio(name, folders)
        status.append({
            "id": event.get("id"),
            "track": event.get("track"),
            "asset": asset.name if asset else None,
            "ready": asset is not None,
        })
    return status


def main():
    parser = argparse.ArgumentParser(add_help=True, description=__doc__)
    parser.add_argument("command", choices=[
        "status", "plan-get", "plan-apply", "plan-events", "normalize", "assets",
        "library-search", "generate", "mix", "validate", "history",
    ])
    parser.add_argument("project", nargs="?")
    parser.add_argument("rest", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    if args.command == "library-search":
        query = " ".join(args.rest).lower().strip()
        if not query:
            sys.exit("Provide a search query.")
        matches = []
        for folder in (LIBRARY_DIR, ROOT / "sound-effects"):
            if not folder.is_dir():
                continue
            for file in sorted(folder.iterdir()):
                stem = _re_sub_hash(file.stem)
                if query in file.stem.lower() or query in stem:
                    matches.append({"library": folder.name, "file": file.name})
        out({"query": query, "matches": matches[:50], "count": len(matches)})
        return

    if not args.project:
        sys.exit(f"Command '{args.command}' requires a project directory.")

    try:
        project = plan_tools.resolve_project(args.project)
    except RuntimeError as error:
        sys.exit(str(error))

    if args.command == "status":
        manifest = read_manifest(project)
        plan = None
        plan_error = None
        try:
            plan = plan_tools.load_plan(project)
            plan, errors, warnings = plan_tools.normalize_plan(plan)
            if errors:
                plan_error = "; ".join(errors)
            else:
                plan_error = ("; ".join(warnings) if warnings else None)
        except RuntimeError as error:
            plan_error = str(error)
        preview = project / (manifest.get("preview_output") or "output/none.mp4")
        final = project / (manifest.get("final_output") or "output/none.mp4")
        approval = manifest.get("approval") or {}
        out({
            "project": manifest,
            "plan_error": plan_error,
            "event_count": len(plan.get("sound_events", [])) if plan else 0,
            "events": [
                {
                    "id": e.get("id"), "track": e.get("track"),
                    "start": e.get("start"), "duration": e.get("duration"),
                    "volume": e.get("volume"), "pan": e.get("pan"),
                    "reuse": e.get("reuse"),
                    "prompt": (e.get("prompt") or "")[:160] or None,
                }
                for e in (plan.get("sound_events", []) if plan else [])
            ],
            "assets": collect_assets(project),
            "asset_status": event_asset_status(project, plan) if plan else [],
            "preview": {
                "path": manifest.get("preview_output"),
                "exists": preview.is_file(),
                "bytes": preview.stat().st_size if preview.is_file() else 0,
            },
            "final": {
                "path": manifest.get("final_output"),
                "exists": final.is_file(),
                "bytes": final.stat().st_size if final.is_file() else 0,
            },
            "approval": {
                "approved": bool(approval.get("approved")),
                "approved_at": approval.get("approved_at"),
            },
            "history": read_history(project, 8),
        })
        return

    if args.command == "plan-get":
        plan = plan_tools.load_plan(project)
        normalized, errors, warnings = plan_tools.normalize_plan(plan)
        if errors:
            # Plan is not yet producible; show it raw plus the blockers.
            print(json.dumps({
                "plan_status": "invalid",
                "errors": errors,
                "warnings": warnings,
                "plan": plan,
            }, indent=2, ensure_ascii=False, default=str))
            return
        print(json.dumps(normalized, indent=2, ensure_ascii=False, default=str))
        return

    if args.command == "plan-apply":
        raw = args.rest[0] if args.rest else ""
        if not raw.strip():
            sys.exit("plan-apply requires the new plan as a JSON string argument.")
        try:
            plan = json.loads(raw)
        except json.JSONDecodeError as error:
            sys.exit(f"Argument is not valid JSON: {error}")
        plan["project"] = plan.get("project") or project.name
        normalized, errors, warnings = plan_tools.normalize_plan(plan)
        if errors:
            sys.exit("Plan rejected:\n- " + "\n- ".join(errors[:12]))
        if warnings:
            print("Warnings:\n- " + "\n- ".join(warnings[:12]))
        backup = plan_tools.save_plan_atomic(project, normalized)
        plan_tools.append_history(project, "plan-update",
                                  f"Plan written ({len(normalized['sound_events'])} events). Backup: {backup.name}")
        out({"ok": True, "events": len(normalized["sound_events"]),
             "backup": backup.name})
        return

    if args.command == "plan-events":
        raw = args.rest[0] if args.rest else ""
        if not raw.strip():
            sys.exit("plan-events requires the event list as a JSON array string.")
        try:
            events = json.loads(raw)
        except json.JSONDecodeError as error:
            sys.exit(f"Argument is not valid JSON: {error}")
        if not isinstance(events, list):
            sys.exit("Event list must be a JSON array.")
        current = plan_tools.load_plan(project)
        current["sound_events"] = events
        current["project"] = current.get("project") or project.name
        normalized, errors, warnings = plan_tools.normalize_plan(current)
        if errors:
            sys.exit("Plan rejected:\n- " + "\n- ".join(errors[:12]))
        if warnings:
            print("Warnings:\n- " + "\n- ".join(warnings[:12]))
        backup = plan_tools.save_plan_atomic(project, normalized)
        plan_tools.append_history(project, "plan-events",
                                  f"Event list replaced by editor ({len(normalized['sound_events'])} events). "
                                  f"Backup: {backup.name}")
        out({"ok": True, "events": len(normalized["sound_events"]),
             "backup": backup.name})
        return

    if args.command == "normalize":
        plan = plan_tools.load_plan(project)
        normalized, errors, warnings = plan_tools.normalize_plan(plan)
        if errors:
            sys.exit("Plan has errors that normalization cannot fix:\n- " + "\n- ".join(errors[:12]))
        if warnings:
            print("Warnings:\n- " + "\n- ".join(warnings[:12]))
        backup = plan_tools.save_plan_atomic(project, normalized)
        plan_tools.append_history(project, "normalize", f"Plan normalized. Backup: {backup.name}")
        out({"ok": True, "events": len(normalized["sound_events"]), "backup": backup.name})
        return

    if args.command == "assets":
        out({"assets": collect_assets(project)})
        return

    if args.command == "validate":
        plan = plan_tools.load_plan(project)
        plan, errors, warnings = plan_tools.normalize_plan(plan)
        if errors:
            sys.exit("Plan errors: " + "; ".join(errors[:10]))
        status = event_asset_status(project, plan)
        missing = [s["id"] for s in status if not s["ready"]]
        out({"events": len(status), "ready": len(status) - len(missing),
             "missing": missing})
        return

    if args.command == "history":
        for entry in read_history(project, 30):
            print(json.dumps(entry, ensure_ascii=False))
        return

    if args.command == "generate":
        dry_run = "--dry-run" in args.rest
        result = run_generation(project, dry_run)
        sys.stdout.write(result.stdout[-6000:])
        sys.stderr.write(result.stderr[-3000:])
        if not dry_run and result.returncode == 0:
            plan_tools.append_history(project, "generate",
                                      "Sound generation completed. Assets: " +
                                      str(len(collect_assets(project))))
        sys.exit(result.returncode)

    if args.command == "mix":
        dry_run = "--dry-run" in args.rest
        result, target, problem = run_mix(project, dry_run)
        sys.stdout.write(result.stdout[-6000:])
        sys.stderr.write(result.stderr[-3000:])
        if problem:
            sys.exit("MIX WARNING: " + problem)
        sys.exit(result.returncode)


def _re_sub_hash(stem):
    import re
    return re.sub(r"-[a-f0-9]{8}$", "", stem)


def read_history(project, limit):
    history_file = project / "history.jsonl"
    if not history_file.exists():
        return []
    lines = history_file.read_text(encoding="utf-8").splitlines()
    entries = []
    for line in lines[-limit:]:
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return entries


if __name__ == "__main__":
    main()
