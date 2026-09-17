"""Attach Karate BGM notes to their original GBA PCM samples."""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = ROOT / "reference" / "rhythmtengoku-upstream"
OUT = ROOT / "assets" / "gba"


def instrument_samples(bank: int) -> dict[int, int]:
    text = (UPSTREAM / "audio" / "instruments" / f"instruments_bank{bank:02d}.inc.c").read_text()
    return {int(i): int(s) for i, s in re.findall(r"instrument_pcm_(\d+).*?&sample_(\d+)_data", text, re.S)}


def bank_entries(bank: int) -> list[int | None]:
    text = (UPSTREAM / "audio" / "instrument_banks.inc.c").read_text()
    section = re.search(rf"union Instrument inst_bank_{bank:02d}\[\].*?\n\}};", text, re.S).group()
    return [int(value) if value else None for value in re.findall(r"\.pcm = &instrument_pcm_(\d+)|\bNULL\b", section)]


def main() -> None:
    pcm47, pcm50 = instrument_samples(47), instrument_samples(50)
    bank47, bank50 = bank_entries(47), bank_entries(50)
    direct = {0: 1, 1: 2, 2: 2, 3: 3, 5: 4, 7: 5, 8: 6, 10: 7, 11: 8, 39: 10, 41: 5, 119: 11}
    used = set()
    note_count = 0
    for filename in ("karate_bgm_events.json", "karate_fan_events.json"):
        notes_path = OUT / filename
        notes = json.loads(notes_path.read_text())
        note_count += len(notes)
        for event in notes:
            program, key = event["program"], event["note"]
            sample, fixed = direct.get(program), False
            if program in (125, 127):
                entries, samples = (bank50, pcm50) if program == 125 else (bank47, pcm47)
                index = key - 36
                instrument = entries[index] if 0 <= index < len(entries) else None
                sample, fixed = samples.get(instrument) if instrument else None, True
            if sample is not None:
                event["sample"], event["fixed"] = sample, fixed
                used.add(sample)
        notes_path.write_text(json.dumps(notes, separators=(",", ":")))
    for number in used:
        source = UPSTREAM / "audio" / "samples" / f"sample_{number:03d}.wav"
        shutil.copy2(source, OUT / "samples" / source.name)
    print(f"Resolved {len(used)} PCM samples for {note_count} Karate music notes")


if __name__ == "__main__":
    main()
