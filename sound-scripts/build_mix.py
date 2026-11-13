#!/data/data/com.termux/files/usr/bin/python3
"""
Build the final sound-designed video from sound-plan.json + sound-effects/.

- Positions, trims, fades and volume-balances every sound event with FFmpeg.
- Reused sounds are read once from the same input file (no duplicates generated).
- Copies the original video stream bit-for-bit (no re-encode, no resolution/fps change).
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLAN = os.path.join(ROOT, "sound-plan.json")
SFX = os.path.join(ROOT, "sound-effects")
INPUT = os.path.join(ROOT, "input", "OneVideoStory.mp4")
MIX_WAV = os.path.join(ROOT, "analysis", "mix.wav")
OUTPUT = os.path.join(ROOT, "output", "OneVideoStory_SoundDesigned.mp4")

SR = 48000

# Per-event audio shaping overrides: (trim_end_s, fade_in_s, fade_out_start_s, fade_out_dur_s)
SHAPING = {
    "riser":              (2.2, 0.0, 1.5, 0.7),
    "night_ambience":     (7.0, 0.8, 6.0, 1.0),
    "hallway_ambience":   (6.0, 0.8, 5.0, 1.0),
    "bench_chatter":      (0.7, 0.0, None, None),
    "chuckle":            (2.0, 0.2, 1.4, 0.6),
    "protagonist_chatter": (1.15, 0.0, 0.95, 0.2),
    "friend_chatter":     (1.4, 0.0, 1.2, 0.2),
}


def main():
    plan = json.load(open(PLAN))
    events = plan["sound_events"]

    # Unique source files in first-use order
    files = []
    for ev in events:
        src = ev.get("reuse", ev["id"])
        path = os.path.join(SFX, src + ".mp3")
        if not os.path.exists(path):
            raise SystemExit(f"MISSING sound file: {path}")
        if path not in files:
            files.append(path)

    parts, chains = [], []
    for i, path in enumerate(files):
        parts += ["-i", path]

    mix_labels = []
    for n, ev in enumerate(events):
        src = ev.get("reuse", ev["id"])
        idx = files.index(os.path.join(SFX, src + ".mp3"))
        vol = ev["volume"]
        delay_ms = int(round(ev["start"] * 1000))
        trim_end, fade_in, fade_out_start, fade_out_dur = SHAPING.get(ev["id"], (None, 0, None, None))

        f = f"[{idx}:a]aresample={SR},aformat=sample_fmts=fltp:channel_layouts=stereo"
        if trim_end:
            f += f",atrim=0:{trim_end}"
        if fade_in:
            f += f",afade=t=in:st=0:d={fade_in}"
        if fade_out_start is not None:
            f += f",afade=t=out:st={fade_out_start}:d={fade_out_dur}"
        f += f",volume={vol},adelay={delay_ms}|{delay_ms}[e{n}]"
        chains.append(f)
        mix_labels.append(f"[e{n}]")

    n_in = len(files)
    filter = ";".join(chains)
    filter += f";{''.join(mix_labels)}amix=inputs={len(mix_labels)}:normalize=0:dropout_transition=0[all]"
    filter += ";[all]alimiter=limit=0.95,aresample=48000[mix]"

    # Render the mix
    os.makedirs(os.path.dirname(MIX_WAV), exist_ok=True)
    cmd = ["ffmpeg", "-y", "-v", "error"] + parts + [
        "-filter_complex", filter,
        "-map", "[mix]", "-c:a", "pcm_s16le", MIX_WAV,
    ]
    print("Rendering audio mix...")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-3000:])
        sys.exit(1)

    # Mux: copy original video stream untouched, encode fresh AAC
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    print("Muxing with original video (video stream copied)...")
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-i", INPUT, "-i", MIX_WAV,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        "-shortest", OUTPUT,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-3000:])
        sys.exit(1)
    print(f"Written: {OUTPUT}")


if __name__ == "__main__":
    main()
