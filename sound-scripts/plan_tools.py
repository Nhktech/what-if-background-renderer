#!/usr/bin/env python3
"""Plan utilities for What If Studio.

Single source of truth for sound-plan.json validation and normalization.

The plan schema is author-friendly and supports legacy field names:
  start      (alias: time_s)          seconds, >= 0
  duration   (alias: duration_s)      seconds, > 0
  volume     (alias: gain)            linear gain, >= 0
  pan        (-1 .. 1, default 0)
  track      (sfx | ambience | music | narration)  derived from `type` when absent

Normalization is idempotent: canonical fields are added and aliases are kept
so that both the production scripts and human readers always see the same data.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROJECTS = ROOT / "projects"

TRACK_TYPES = {
    "sfx": "sfx",
    "sound_effect": "sfx",
    "sound_effects": "sfx",
    "effect": "sfx",
    "ambient": "ambience",
    "ambience": "ambience",
    "ambient_sounds": "ambience",
    "environment": "ambience",
    "atmos": "ambience",
    "music": "music",
    "score": "music",
    "narration": "narration",
    "voice": "narration",
    "voiceover": "narration",
}

ALIASES = {
    "start": ("time_s", "time", "time_seconds", "at_s", "at_seconds"),
    "duration": ("duration_s", "length_s", "length_seconds"),
    "volume": ("gain", "level"),
}

PROMPT_ALIASES = ("generation_prompt", "fallback_generation_prompt", "prompt_text")

# Faithful text conversions for values the plan states in prose (processed
# fields like "level ~ -12 dBFS" or "trim/fit to 0.9 s"). Every converted value
# records its source so nothing is silently invented.
import re

LEVEL_RE = re.compile(r"level\s*~?\s*(-?\d+(?:\.\d+)?)\s*dBFS", re.IGNORECASE)
DURATION_TEXT_RE = re.compile(
    r"(?:~|to|of|fit to|trim to)\s*(\d+(?:\.\d+)?)\s*s\b", re.IGNORECASE)
PAN_NUMERIC_RE = re.compile(r"pan\s*[:=]?\s*(-?\d+(?:\.\d+)?)", re.IGNORECASE)
PAN_LEFT_RE = re.compile(r"pan\s+(?:slightly\s+|hard\s+|mostly\s+)?left", re.IGNORECASE)
PAN_RIGHT_RE = re.compile(r"pan\s+(?:slightly\s+|hard\s+|mostly\s+)?right", re.IGNORECASE)
FADE_IN_RE = re.compile(r"(\d+(?:\.\d+)?)\s*s?\s*fade\s*in", re.IGNORECASE)
FADE_OUT_RE = re.compile(r"fade\s*out.*?(\d+(?:\.\d+)?)\s*s\b", re.IGNORECASE)
REUSE_FROM_RE = re.compile(r"reuses?\b[^.]*?\bfrom\s+([A-Za-z0-9_-]+)", re.IGNORECASE)
ASSET_PATH_RE = re.compile(r"^[\w/\\.-]+\.(mp3|wav|m4a|aac)$", re.IGNORECASE)


def safe_name(value):
    return re.sub(r"[^a-zA-Z0-9_-]+", "_", str(value)).strip("_")


def normalize_event(event):
    """Return (event, problems, warnings).

    Canonical fields come from structured values or faithful conversions of
    values the plan states itself (dBFS levels, stated seconds). Genuinely
    missing numerics are reported as problems, never defaulted silently.
    """
    if not isinstance(event, dict):
        return None, ["event is not an object"], []
    problems = []
    warnings = []
    out = dict(event)

    text = " ".join(str(out.get(key, "")) for key in ("processing", "description", "notes"))

    # --- start ---
    for canonical, aliases in ALIASES.items():
        if canonical not in out or not isinstance(out.get(canonical), (int, float)):
            for alias in aliases:
                if isinstance(out.get(alias), (int, float)):
                    out[canonical] = out[alias]
                    break

    # --- prompt (generation or library fallback) ---
    if not str(out.get("prompt") or "").strip():
        for alias in PROMPT_ALIASES:
            value = str(out.get(alias) or "").strip()
            if value and not value.lower().startswith("same as "):
                out["prompt"] = value
                break

    # --- reuse (library asset or explicit cross-event reuse) ---
    if not out.get("reuse"):
        asset = str(out.get("asset") or "").strip()
        if ASSET_PATH_RE.match(asset):
            out["reuse"] = Path(asset).stem
            out.setdefault("reuse_source", "asset path")
        else:
            match = REUSE_FROM_RE.search(asset)
            if match:
                out["reuse"] = safe_name(match.group(1))
                out.setdefault("reuse_source", f"stated reuse of event {match.group(1)}")

    # --- duration from end_time_seconds ---
    if not isinstance(out.get("duration"), (int, float)):
        end = out.get("end_time_seconds") or out.get("end_s") or out.get("end")
        if isinstance(end, (int, float)) and isinstance(out.get("start"), (int, float)):
            if end > out["start"]:
                out["duration"] = float(end) - float(out["start"])
                out.setdefault("duration_source", "end_time_seconds - start")
            else:
                problems.append("end_time_seconds must be after start")

    # --- faithful conversions from stated text ---
    if not isinstance(out.get("volume"), (int, float)):
        level = LEVEL_RE.search(text)
        if level:
            dbfs = float(level.group(1))
            out["volume"] = round(10 ** (dbfs / 20), 4)
            out.setdefault("volume_source", f"converted from stated {dbfs:g} dBFS")

    if not isinstance(out.get("duration"), (int, float)):
        stated = DURATION_TEXT_RE.search(text)
        if stated:
            out["duration"] = float(stated.group(1))
            out.setdefault("duration_source", f"converted from stated '{stated.group(0)}'")

    pan = out.get("pan")
    if isinstance(pan, (int, float)) and not isinstance(pan, bool):
        pan = float(pan)
    else:
        numeric = PAN_NUMERIC_RE.search(text)
        if numeric:
            pan = max(-1.0, min(1.0, float(numeric.group(1))))
            out.setdefault("pan_source", "converted from stated numeric pan")
        elif PAN_LEFT_RE.search(text):
            pan = None
            warnings.append(f"{out.get('id')}: pan stated as text ('slightly left'); needs explicit numeric pan")
        elif PAN_RIGHT_RE.search(text):
            pan = None
            warnings.append(f"{out.get('id')}: pan stated as text ('slightly right'); needs explicit numeric pan")
        else:
            pan = 0.0
            out.setdefault("pan_source", "not stated; centered")
    if pan is not None:
        out["pan"] = pan

    fades = out.get("fade_in", 0)
    if not fades:
        match = FADE_IN_RE.search(text)
        if match:
            out["fade_in"] = float(match.group(1))
    fades = out.get("fade_out", 0)
    if not fades:
        match = FADE_OUT_RE.search(text)
        if match:
            out["fade_out"] = float(match.group(1))

    event_id = out.get("id")
    if not isinstance(event_id, str) or not safe_name(event_id):
        problems.append("missing or invalid id")
        event_id = None

    for field in ("start", "duration", "volume"):
        value = out.get(field)
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            problems.append(f"missing numeric {field}")
        else:
            out[field] = float(value)

    if isinstance(out.get("start"), float) and out["start"] < 0:
        problems.append("start must be >= 0")
    if isinstance(out.get("duration"), float) and out["duration"] <= 0:
        problems.append("duration must be > 0")
    if isinstance(out.get("volume"), float) and out["volume"] < 0:
        problems.append("volume must be >= 0")

    track = out.get("track")
    if not isinstance(track, str) or track not in ("sfx", "ambience", "music", "narration"):
        event_type = str(out.get("type", out.get("category", "sfx"))).strip().lower()
        track = TRACK_TYPES.get(event_type, "sfx")
    out["track"] = track

    return out, problems, warnings


def normalize_plan(plan):
    """Validate and normalize a plan dictionary. Returns (plan, errors, warnings)."""
    if not isinstance(plan, dict):
        return None, ["plan is not a JSON object"], []

    events = plan.get("sound_events")
    if not isinstance(events, list) or not events:
        return None, ["plan must contain a non-empty sound_events list"], []

    errors = []
    warnings = []
    normalized = []
    seen_ids = set()

    for index, event in enumerate(events):
        fixed, problems, event_warnings = normalize_event(event)
        warnings.extend(event_warnings)
        if problems or fixed is None:
            errors.append(f"sound_events[{index}]: " + "; ".join(problems))
            continue
        key = safe_name(fixed["id"])
        if key in seen_ids:
            errors.append(f"sound_events[{index}]: duplicate id '{fixed['id']}'")
            continue
        seen_ids.add(key)
        fixed["id"] = key
        normalized.append(fixed)

    if errors:
        return None, errors, warnings

    plan = dict(plan)
    plan["sound_events"] = normalized
    plan["plan_schema"] = "what-if-studio/1"
    return plan, [], warnings


def load_plan(project_dir):
    plan_file = Path(project_dir) / "sound-plan.json"
    if not plan_file.exists():
        raise RuntimeError(f"sound-plan.json not found in {project_dir}")
    try:
        return json.loads(plan_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise RuntimeError(f"sound-plan.json is not valid JSON: {error}")


def save_plan_atomic(project_dir, plan):
    project_dir = Path(project_dir)
    plan_file = project_dir / "sound-plan.json"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup = project_dir / f"sound-plan.json.bak-{stamp}"
    if plan_file.exists():
        backup.write_bytes(plan_file.read_bytes())
    temporary = plan_file.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(plan, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, plan_file)
    return backup


def append_history(project_dir, action, detail):
    project_dir = Path(project_dir)
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "action": action,
        "detail": detail,
    }
    with (project_dir / "history.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


def resolve_project(value):
    project_dir = Path(value).expanduser()
    if not project_dir.is_absolute():
        project_dir = ROOT / value
    project_dir = project_dir.resolve()
    if PROJECTS.resolve() not in project_dir.parents and project_dir != PROJECTS.resolve():
        raise RuntimeError(f"Project must live under {PROJECTS}")
    if not (project_dir / "project.json").exists():
        raise RuntimeError(f"Not a sound project directory: {project_dir}")
    return project_dir
