#!/usr/bin/env python3
"""Project-independent FFmpeg sound mixer for What If Studio."""

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


def safe_name(value):
    return re.sub(r"[^a-zA-Z0-9_-]+", "_", str(value)).strip("_")


def probe_duration(path):
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(path)
        ],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr)
    return float(result.stdout.strip())


def find_audio(name, folders):
    extensions = (".mp3", ".wav", ".m4a", ".aac")
    filename = safe_name(name)

    for folder in folders:
        if not folder.exists():
            continue

        for extension in extensions:
            candidate = folder / f"{filename}{extension}"
            if candidate.is_file():
                return candidate

            # Support Audio Library filenames with hashed suffixes.
            matches = sorted(folder.glob(f"{filename}-*{extension}"))
            for match in matches:
                if match.is_file():
                    return match

    raise FileNotFoundError(f"Audio asset not found: {name}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", default="sound-plan.json")
    parser.add_argument("--input")
    parser.add_argument("--sfx-dir", default="sound-effects")
    parser.add_argument("--output")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent.parent
    plan_file = (root / args.plan).resolve()

    if not plan_file.exists():
        sys.exit(f"Plan not found: {plan_file}")

    plan = json.loads(plan_file.read_text())
    events = plan.get("sound_events", [])

    input_video = Path(args.input or plan.get("source_video", ""))
    if not input_video.is_absolute():
        input_video = (root / input_video).resolve()

    if not input_video.exists():
        sys.exit(f"Input video not found: {input_video}")

    sfx_dir = (root / args.sfx_dir).resolve()

    audio_folders = [
        sfx_dir,
        root / "sound-effects",
        root.parent / "what-if" / "what-if-studio" / "library" / "sfx",
    ]

    project = safe_name(plan.get("project", "project"))
    output = Path(args.output or f"output/{project}_Preview.mp4")

    if not output.is_absolute():
        output = (root / output).resolve()

    duration = float(
        plan.get("video_properties", {}).get("duration_seconds")
        or probe_duration(input_video)
    )

    files = []
    resolved = []

    for event in events:
        asset_name = event.get("reuse") or event.get("id")
        asset = find_audio(asset_name, audio_folders)

        start = float(event["start"])
        length = float(event["duration"])
        volume = float(event["volume"])

        if start < 0 or length <= 0 or volume < 0:
            sys.exit(f"Invalid timing or volume: {event['id']}")

        if start >= duration:
            print(f"SKIP event beyond video: {event['id']}")
            continue

        if asset not in files:
            files.append(asset)

        resolved.append((event, asset))

    if not resolved:
        sys.exit("No usable sound events found.")

    input_args = []
    for asset in files:
        input_args.extend(["-i", str(asset)])

    chains = []
    labels = []

    for index, (event, asset) in enumerate(resolved):
        source_index = files.index(asset)
        start = float(event["start"])
        length = min(float(event["duration"]), duration - start)
        volume = float(event["volume"])

        fade_in = float(event.get("fade_in", 0) or 0)
        fade_out = float(event.get("fade_out", 0) or 0)
        pan = max(-1.0, min(1.0, float(event.get("pan", 0) or 0)))

        fade_in = min(fade_in, length)
        fade_out = min(fade_out, length)

        chain = (
            f"[{source_index + 1}:a]"
            f"aresample=48000,"
            f"aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"atrim=duration={length:.4f},"
            "asetpts=PTS-STARTPTS"
        )

        if fade_in > 0:
            chain += f",afade=t=in:st=0:d={fade_in:.4f}"

        if fade_out > 0:
            fade_start = max(0, length - fade_out)
            chain += f",afade=t=out:st={fade_start:.4f}:d={fade_out:.4f}"

        if pan < -0.01:
            # Pan towards the left: attenuate the right channel.
            chain += f",pan=stereo|c0=c0|c1={1.0 + pan:.4f}*c1"
        elif pan > 0.01:
            # Pan towards the right: attenuate the left channel.
            chain += f",pan=stereo|c0={1.0 - pan:.4f}*c0|c1=c1"

        delay = round(start * 1000)
        chain += (
            f",volume={volume:.4f},"
            f"adelay={delay}|{delay}[e{index}]"
        )

        chains.append(chain)
        labels.append(f"[e{index}]")

    filter_graph = ";".join(chains)
    filter_graph += (
        f";{''.join(labels)}"
        f"amix=inputs={len(labels)}:normalize=0:dropout_transition=0,"
        f"alimiter=limit=0.95,"
        f"apad=whole_dur={duration:.4f},"
        f"atrim=duration={duration:.4f}[mix]"
    )

    command = [
        "ffmpeg", "-y", "-v", "error",
        "-i", str(input_video),
        *input_args,
        "-filter_complex", filter_graph,
        "-map", "0:v:0",
        "-map", "[mix]",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-t", f"{duration:.4f}",
        "-movflags", "+faststart",
        str(output)
    ]

    print(f"Project: {project}")
    print(f"Video duration: {duration:.3f}s")
    print(f"Sound events: {len(resolved)}")
    print(f"Unique audio files: {len(files)}")
    print(f"Output: {output}")

    if args.dry_run:
        print("\nDRY RUN: FFmpeg was not executed.")
        print("Command prepared successfully.")
        return

    output.parent.mkdir(parents=True, exist_ok=True)

    result = subprocess.run(command, capture_output=True, text=True)

    if result.returncode:
        print(result.stderr[-4000:])
        sys.exit("FFmpeg mixing failed.")

    print("\nPreview created:", output)
    print("Original video file was not modified.")


if __name__ == "__main__":
    main()
