#!/usr/bin/env python3
import argparse
import json
import re
import shutil
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROJECTS = ROOT / "projects"

def slugify(value):
    value = re.sub(r"[^a-zA-Z0-9_-]+", "-", value).strip("-_").lower()
    return value or "untitled-video"

def probe_video(path):
    result = subprocess.run(
        ["ffprobe", "-v", "error",
         "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise RuntimeError("Could not read video properties: " + result.stderr[-500:])
    return float(result.stdout.strip())

def main():
    parser = argparse.ArgumentParser(description="Create an isolated What If Studio sound project.")
    parser.add_argument("--video", required=True, help="Path to rendered MP4")
    parser.add_argument("--tsx", help="Optional source TSX file")
    parser.add_argument("--title", required=True, help="Project title")
    args = parser.parse_args()

    video = Path(args.video).expanduser().resolve()
    tsx = Path(args.tsx).expanduser().resolve() if args.tsx else None

    if not video.is_file():
        raise SystemExit(f"Video not found: {video}")
    if tsx and not tsx.is_file():
        raise SystemExit(f"TSX not found: {tsx}")

    duration = probe_video(video)
    project_id = slugify(args.title) + "-" + uuid.uuid4().hex[:8]
    folder = PROJECTS / project_id

    if folder.exists():
        raise SystemExit("Project folder already exists. Nothing was overwritten.")

    for name in ("input", "sound-effects", "output", "analysis"):
        (folder / name).mkdir(parents=True, exist_ok=True)

    video_name = "source-video" + video.suffix.lower()
    shutil.copy2(video, folder / "input" / video_name)

    tsx_name = None
    if tsx:
        tsx_name = "source-video.tsx"
        shutil.copy2(tsx, folder / "input" / tsx_name)

    now = datetime.now(timezone.utc).isoformat()

    manifest = {
        "project_id": project_id,
        "title": args.title,
        "status": "created",
        "created_at": now,
        "updated_at": now,
        "source_video": f"input/{video_name}",
        "source_tsx": f"input/{tsx_name}" if tsx_name else None,
        "duration_seconds": duration,
        "sound_plan": "sound-plan.json",
        "preview_output": f"output/{project_id}_Preview.mp4",
        "final_output": f"output/{project_id}_SoundDesigned.mp4"
    }

    (folder / "project.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )

    plan = {
        "project": project_id,
        "source_video": f"input/{video_name}",
        "video_properties": {
            "duration_seconds": duration
        },
        "sound_events": []
    }

    (folder / "sound-plan.json").write_text(
        json.dumps(plan, indent=2), encoding="utf-8"
    )

    print("PROJECT CREATED")
    print("ID:", project_id)
    print("Folder:", folder)
    print("Duration:", f"{duration:.3f}s")
    print("TSX:", "Included" if tsx_name else "Not supplied")
    print("Original source files were not modified.")

if __name__ == "__main__":
    main()
