"""Turn the decomp's local Karate MIDI sequence into a browser event timeline.

The source MIDI is retained as the authoritative composition; this small JSON
contains only note timing/program/velocity so Web Audio can schedule it against
the same beat clock as gameplay.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Karate's effect sequences (s_f_boxing_*) are exported by
# tools/export_game_audio.py, which attaches each note's original PCM sample,
# instrument bank and SongHeader volume.  Only the two music tracks stay here;
# they still need their bank-47/50 sample mapping re-attached afterwards.
SEQUENCES = {
    "tweezers_bgm_events": "s_datumo_bgm.mid",
    "karate_bgm_events": "s_karate_bgm.mid",
    "karate_fan_events": "s_karate_fan.mid",
}
SEQUENCE_DIR = ROOT / "reference" / "rhythmtengoku-upstream" / "audio" / "sequences"
OUT_DIR = ROOT / "assets" / "gba"


def vlq(data, pos):
    value = 0
    while True:
        byte = data[pos]; pos += 1
        value = (value << 7) | (byte & 0x7F)
        if not byte & 0x80:
            return value, pos


def parse_track(data):
    pos = 0; tick = 0; running = None; program = [0] * 16; active = {}; out = []
    while pos < len(data):
        delta, pos = vlq(data, pos); tick += delta
        value = data[pos]
        if value < 0x80:
            status = running
        else:
            status = value; pos += 1; running = status
        if status == 0xFF:
            pos += 1; size, pos = vlq(data, pos); pos += size; continue
        if status in (0xF0, 0xF7):
            size, pos = vlq(data, pos); pos += size; continue
        count = 1 if 0xC0 <= status <= 0xDF else 2
        if value < 0x80:
            message = [value, *data[pos:pos + count - 1]]; pos += count - 1
        else:
            message = list(data[pos:pos + count]); pos += count
        channel, kind = status & 15, status & 0xF0
        if kind == 0xC0:
            program[channel] = message[0]
        elif kind == 0x90 and message[1]:
            active.setdefault((channel, message[0]), []).append((tick, message[1], program[channel]))
        elif kind in (0x80, 0x90):
            key = (channel, message[0])
            if active.get(key):
                start, velocity, instrument = active[key].pop(0)
                out.append({"beat": start / 24, "length": max(1, tick - start) / 24, "note": message[0], "velocity": velocity, "program": instrument, "channel": channel})
    return out


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for output, filename in SEQUENCES.items():
        data = (SEQUENCE_DIR / filename).read_bytes()
        tracks, pos = int.from_bytes(data[10:12], "big"), 14
        notes = []
        for _ in range(tracks):
            assert data[pos:pos + 4] == b"MTrk"
            length = int.from_bytes(data[pos + 4:pos + 8], "big")
            notes.extend(parse_track(data[pos + 8:pos + 8 + length])); pos += 8 + length
        notes.sort(key=lambda item: item["beat"])
        target = OUT_DIR / f"{output}.json"
        target.write_text(json.dumps(notes, separators=(",", ":")))
        print(f"Exported {len(notes)} original-sequence notes to {target}")
    # Re-attach the bank-47/50 PCM mapping.  Without this step every
    # karate_bgm/karate_fan note loses its `sample` field and the web build
    # silently drops the whole Karate Man soundtrack.
    from export_karate_bgm_samples import main as attach_karate_samples
    attach_karate_samples()


if __name__ == "__main__":
    main()
