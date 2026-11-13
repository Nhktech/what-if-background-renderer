#!/data/data/com.termux/files/usr/bin/python3
"""
Generate sound effects with the ElevenLabs Sound Effects API.
Reads ELEVENLABS_API_KEY from .env. Never prints the key.
Skips generation when the target file already exists (safe to re-run).
Retries with backoff on HTTP 429/5xx/network errors.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "sound-effects")
PLAN = os.path.join(ROOT, "sound-plan.json")
API_URL = "https://api.elevenlabs.io/v1/sound-generation"
MODEL_ID = "eleven_text_to_sound_v3"

# Sound library: each distinct sound is generated ONCE and can be reused
# by multiple events in the plan (see "reuse" key).
LIBRARY = [
    # (filename, prompt, duration_seconds)
    ("night_ambience.mp3", "quiet nighttime outdoor city park ambience, soft crickets, gentle breeze, very distant low traffic hum, calm and sparse", 7.5),
    ("hallway_ambience.mp3", "quiet empty school hallway room tone, soft fluorescent light hum, very faint distant echo, calm", 6.5),
    ("title_riser.mp3", "soft airy cinematic riser swell, gentle mysterious buildup, warm and light, no drums", 2.4),
    ("word_pop.mp3", "single gentle soft paper tick, quiet delicate film flick sound", 0.5),
    ("transition_whoosh.mp3", "short soft airy whoosh transition, smooth and subtle, no impact", 1.2),
    ("dribble.mp3", "single basketball dribble bounce on outdoor asphalt court, close mic", 0.6),
    ("shot_whoosh.mp3", "soft whoosh of a basketball flying through the air, gentle airy arc, brief", 1.3),
    ("rim_clank.mp3", "basketball hitting metal hoop rim, sharp metallic clank with brief ring, outdoor court", 1.2),
    ("net_swish.mp3", "basketball swishing through the net, soft fabric rope swish, satisfying", 0.9),
    ("chatter.mp3", "brief soft muffled cartoon character chatter murmur, two small cheerful voices, unintelligible", 1.8),
    ("fist_bump.mp3", "soft friendly fist bump impact, cushioned fleshy thud, single hit", 0.7),
    ("sparkle.mp3", "tiny magical sparkle shimmer, brief twinkle, bright and cute", 1.0),
    ("chuckle.mp3", "two short light warm cartoon chuckles, brief soft ha-ha, friendly and small, not loud", 2.0),
    ("bubble_pop.mp3", "single cheerful cartoon pop, soft bubbly blip, cute and quick", 0.6),
]


def load_key():
    env_path = os.path.join(ROOT, ".env")
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("ELEVENLABS_API_KEY="):
                key = line.split("=", 1)[1].strip().strip("'\"")
                if key:
                    return key
    raise SystemExit("ERROR: ELEVENLABS_API_KEY not found in .env")


def request_sound(key, prompt, duration, dest, max_attempts=4):
    payload = json.dumps({
        "text": prompt,
        "duration_seconds": duration,
        "model_id": MODEL_ID,
        "prompt_influence": 0.55,
    }).encode()
    headers = {"xi-api-key": key, "Content-Type": "application/json"}

    for attempt in range(1, max_attempts + 1):
        try:
            req = urllib.request.Request(API_URL, data=payload, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=120) as resp:
                if resp.status != 200:
                    raise urllib.error.HTTPError(resp.url, resp.status, "bad status", resp.headers, None)
                data = resp.read()
            if len(data) < 500:
                raise RuntimeError(f"response too small ({len(data)} bytes)")
            tmp = dest + ".part"
            with open(tmp, "wb") as fh:
                fh.write(data)
            os.replace(tmp, dest)
            return True
        except urllib.error.HTTPError as e:
            body = e.read()[:300].decode(errors="replace") if e.fp else ""
            if e.code == 422 or e.code == 400:
                print(f"    FATAL 422 for '{prompt[:50]}': {body}")
                return False  # do not retry bad requests
            wait = 5 * attempt
            print(f"    HTTP {e.code} (attempt {attempt}/{max_attempts}), retrying in {wait}s: {body}")
            time.sleep(wait)
        except Exception as e:
            wait = 5 * attempt
            print(f"    {type(e).__name__}: {e} (attempt {attempt}/{max_attempts}), retrying in {wait}s")
            time.sleep(wait)
    return False


def main():
    only = set(sys.argv[1:])
    key = load_key()
    os.makedirs(OUT_DIR, exist_ok=True)

    # Which files are actually needed by the plan?
    plan = json.load(open(PLAN))
    needed = {rid for ev in plan["sound_events"] if "reuse" in ev for rid in [ev["reuse"]]}
    targets = [t for t in LIBRARY if not only or t[0].rsplit(".", 1)[0] in only]

    failures = []
    for fname, prompt, dur in targets:
        dest = os.path.join(OUT_DIR, fname)
        stem = fname.rsplit(".", 1)[0]
        if stem not in needed and not only:
            # keep files previously generated that are still referenced;
            # skip unreferenced ones only if they don't exist yet
            if not os.path.exists(dest):
                continue
        if os.path.exists(dest) and os.path.getsize(dest) > 1000:
            print(f"SKIP  {fname} (exists)")
            continue
        print(f"GEN   {fname} ({dur}s): {prompt[:70]}...")
        ok = request_sound(key, prompt, dur, dest)
        if ok:
            print(f"  ok -> {os.path.getsize(dest)} bytes")
        else:
            failures.append(fname)
            print(f"  FAILED: {fname}")

    if failures:
        print(f"\nFAILED: {', '.join(failures)}")
        sys.exit(1)
    print("\nAll required sounds ready.")


if __name__ == "__main__":
    main()
