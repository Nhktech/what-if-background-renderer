#!/usr/bin/env python3
"""Project-independent sound generator for What If Studio.

GLM decides which events reuse library sounds and which require generation.
This script only executes those decisions.
"""

import argparse
import json
import os
import re
import shutil
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

API_URL = "https://api.elevenlabs.io/v1/sound-generation"
MODEL_ID = "eleven_text_to_sound_v3"


def safe_name(value):
    return re.sub(r"[^a-zA-Z0-9_-]+", "_", str(value)).strip("_")


def load_key(env_file):
    if not env_file.exists():
        raise RuntimeError("ElevenLabs configuration file was not found.")

    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line.startswith("ELEVENLABS_API_KEY="):
            key = line.split("=", 1)[1].strip().strip("'\"")
            if key:
                return key

    raise RuntimeError("ELEVENLABS_API_KEY is missing.")


def find_library_sound(name, folders):
    """Find exact sound names, including hashed library filenames."""
    target = safe_name(name).lower()

    for folder in folders:
        if not folder.exists():
            continue

        for file in folder.iterdir():
            if not file.is_file() or file.suffix.lower() not in (".mp3", ".wav"):
                continue

            stem = file.stem.lower()
            normalized = re.sub(r"-[a-f0-9]{8}$", "", stem)

            if stem == target or normalized == target:
                return file

    return None


def generate_sound(key, prompt, duration, destination):
    payload = json.dumps({
        "text": prompt,
        "duration_seconds": float(duration),
        "model_id": MODEL_ID,
        "prompt_influence": 0.55
    }).encode()

    request = urllib.request.Request(
        API_URL,
        data=payload,
        headers={
            "xi-api-key": key,
            "Content-Type": "application/json"
        },
        method="POST"
    )

    for attempt in range(1, 5):
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                data = response.read()

            if len(data) < 500:
                raise RuntimeError("ElevenLabs returned an unexpectedly small file.")

            temporary = destination.with_suffix(destination.suffix + ".part")
            temporary.write_bytes(data)
            temporary.replace(destination)
            return

        except urllib.error.HTTPError as error:
            details = error.read(300).decode(errors="replace")

            if error.code in (400, 401, 403, 422):
                raise RuntimeError(
                    f"ElevenLabs rejected the request (HTTP {error.code}). "
                    "Check the request settings and account access."
                ) from None

            print(f"Attempt {attempt}/4: HTTP {error.code}: {details}")

        except Exception as error:
            print(f"Attempt {attempt}/4: {type(error).__name__}: {error}")

        if attempt < 4:
            time.sleep(attempt * 5)

    raise RuntimeError("Sound generation failed after four attempts.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", default="sound-plan.json")
    parser.add_argument("--sfx-dir", default="sound-effects")
    parser.add_argument(
        "--library-dir",
        default="../what-if/what-if-studio/library/sfx"
    )
    parser.add_argument("--env", default=".env")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent.parent
    plan_file = (root / args.plan).resolve()
    sfx_dir = (root / args.sfx_dir).resolve()
    library_dir = (root / args.library_dir).resolve()
    env_file = (root / args.env).resolve()

    if not plan_file.exists():
        sys.exit(f"Plan not found: {plan_file}")

    plan = json.loads(plan_file.read_text())
    events = plan.get("sound_events")

    if not isinstance(events, list):
        sys.exit("Invalid plan: sound_events must be a list.")

    # Validate the entire plan before generating anything.
    for index, event in enumerate(events):
        if not isinstance(event, dict) or not event.get("id"):
            sys.exit(f"Invalid sound event at position {index}: missing id.")

        if not isinstance(event.get("start"), (int, float)):
            sys.exit(f"Invalid start time for event: {event['id']}")

        if float(event["start"]) < 0:
            sys.exit(f"Negative start time for event: {event['id']}")

        if not isinstance(event.get("duration"), (int, float)) or event["duration"] <= 0:
            sys.exit(f"Invalid duration for event: {event['id']}")

        if not isinstance(event.get("volume"), (int, float)) or event["volume"] < 0:
            sys.exit(f"Invalid volume for event: {event['id']}")

    sfx_dir.mkdir(parents=True, exist_ok=True)
    search_folders = [sfx_dir, root / 'sound-effects', library_dir]

    key = None if args.dry_run else load_key(env_file)
    generated = set()
    copied = set()
    failures = []

    print(f"Project: {plan.get('project', 'Untitled')}")
    print(f"Events: {len(events)}")

    for event in events:
        event_id = safe_name(event["id"])
        reuse = event.get("reuse")
        prompt = str(event.get("prompt", "")).strip()
        duration = float(event["duration"])

        # ElevenLabs sound generation requires at least 0.5 seconds.
        # Shorter events still keep their plan timing; the mixer trims.
        generation_duration = max(0.5, duration)

        if reuse:
            source = find_library_sound(reuse, search_folders)

            if source:
                destination = sfx_dir / f"{safe_name(reuse)}{source.suffix.lower()}"

                if not args.dry_run:
                    if source.resolve() != destination.resolve() and not destination.exists():
                        shutil.copy2(source, destination)

                copied.add(reuse)
                print(f"LIBRARY  {event_id} -> {source.name}")
                continue

            # If the requested library sound is missing, generation is
            # allowed only when GLM supplied a genuine generation prompt.
            if not prompt or prompt.lower().startswith("reuse "):
                failures.append(f"{event_id}: library sound '{reuse}' missing")
                print(f"MISSING  {event_id}: {reuse}")
                continue

            output_name = safe_name(reuse)
        else:
            # Reuse an exact existing asset before considering generation.
            existing = find_library_sound(event_id, search_folders)

            if existing:
                destination = sfx_dir / f"{event_id}{existing.suffix.lower()}"

                if existing.resolve() != destination.resolve() and not destination.exists():
                    if not args.dry_run:
                        shutil.copy2(existing, destination)
                        copied.add(event_id)

                print(f"LIBRARY  {event_id} -> {existing.name}")
                continue

            if not prompt or prompt.lower().startswith("reuse "):
                failures.append(f"{event_id}: missing generation prompt")
                print(f"NO PROMPT  {event_id}")
                continue

            output_name = event_id

        destination = sfx_dir / f"{output_name}.mp3"

        if destination.exists() and destination.stat().st_size > 1000:
            print(f"EXISTS   {event_id} -> {destination.name}")
            continue

        if output_name in generated:
            print(f"REUSED   {event_id} -> {destination.name}")
            continue

        print(f"GENERATE {event_id} ({duration}s)")

        if args.dry_run:
            print(f"         Prompt: {prompt}")
            generated.add(output_name)
            continue

        try:
            generate_sound(key, prompt, generation_duration, destination)
            generated.add(output_name)
            print(f"         Saved: {destination.name}")
        except Exception as error:
            failures.append(f"{event_id}: {error}")
            print(f"FAILED   {event_id}: {error}")

    print("\n===== SUMMARY =====")
    print(f"Library sounds used: {len(copied)}")
    print(f"New sound files: {len(generated)}")
    print(f"Failures: {len(failures)}")

    if failures:
        for failure in failures:
            print(" -", failure)
        sys.exit(1)

    print("Sound generation stage completed.")


if __name__ == "__main__":
    main()
