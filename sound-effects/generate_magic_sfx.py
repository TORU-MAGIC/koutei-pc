#!/usr/bin/env python3
"""Generate the bundled Magic Show Cue sound effects as low-latency PCM WAV files."""

from __future__ import annotations

import argparse
import math
import random
import struct
import wave
from pathlib import Path


SAMPLE_RATE = 48_000
OUTPUT_DIRECTORY = Path(__file__).resolve().parent


def db_to_amplitude(db: float) -> float:
    return 10.0 ** (db / 20.0)


def smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def make_buffer(duration: float) -> list[float]:
    return [0.0] * int(round(duration * SAMPLE_RATE))


def add_bell(
    samples: list[float],
    start: float,
    duration: float,
    frequency: float,
    amplitude: float,
    decay: float,
) -> None:
    start_index = int(start * SAMPLE_RATE)
    sample_count = min(int(duration * SAMPLE_RATE), len(samples) - start_index)
    phase_offsets = (0.0, 0.19, 0.41, 0.73)
    partials = ((1.0, 1.0), (2.01, 0.22), (3.98, 0.09), (6.08, 0.035))

    for offset in range(max(0, sample_count)):
        time = offset / SAMPLE_RATE
        attack = smoothstep(time / 0.0025)
        release = 1.0 - smoothstep((time - (duration - 0.045)) / 0.045)
        envelope = attack * math.exp(-time / decay) * release
        value = 0.0
        for (ratio, level), phase_offset in zip(partials, phase_offsets):
            value += level * math.sin(2.0 * math.pi * frequency * ratio * time + phase_offset)
        samples[start_index + offset] += amplitude * envelope * value


def add_brass_tone(
    samples: list[float],
    start: float,
    duration: float,
    frequency: float,
    amplitude: float,
    release: float,
) -> None:
    start_index = int(start * SAMPLE_RATE)
    sample_count = min(int(duration * SAMPLE_RATE), len(samples) - start_index)
    release_start = max(0.03, duration - release)

    for offset in range(max(0, sample_count)):
        time = offset / SAMPLE_RATE
        attack = smoothstep(time / 0.008)
        release_envelope = 1.0 - smoothstep((time - release_start) / release)
        vibrato_phase = 0.0032 * math.sin(2.0 * math.pi * 5.2 * time)
        phase = 2.0 * math.pi * frequency * time + vibrato_phase
        tone = (
            math.sin(phase)
            + 0.34 * math.sin(2.0 * phase + 0.12)
            + 0.14 * math.sin(3.0 * phase + 0.31)
            + 0.055 * math.sin(4.0 * phase + 0.48)
        )
        samples[start_index + offset] += amplitude * attack * release_envelope * tone


def add_linear_chirp(
    samples: list[float],
    start: float,
    duration: float,
    frequency_start: float,
    frequency_end: float,
    amplitude: float,
    decay: float | None = None,
) -> None:
    start_index = int(start * SAMPLE_RATE)
    sample_count = min(int(duration * SAMPLE_RATE), len(samples) - start_index)

    for offset in range(max(0, sample_count)):
        time = offset / SAMPLE_RATE
        progress = time / duration
        phase = 2.0 * math.pi * (
            frequency_start * time
            + 0.5 * (frequency_end - frequency_start) * time * time / duration
        )
        envelope = math.sin(math.pi * progress) ** 1.2
        if decay is not None:
            envelope *= math.exp(-time / decay)
        samples[start_index + offset] += amplitude * envelope * math.sin(phase)


def generate_correct_pingpong() -> list[float]:
    samples = make_buffer(0.90)
    add_bell(samples, 0.000, 0.34, 987.77, 0.78, 0.115)
    add_bell(samples, 0.180, 0.70, 659.25, 0.84, 0.255)
    return samples


def generate_wrong_buzzer() -> list[float]:
    duration = 0.72
    samples = make_buffer(duration)
    rng = random.Random(20_260_823)
    lowpass_noise = 0.0
    phases = [0.0, 0.0]

    for index in range(len(samples)):
        time = index / SAMPLE_RATE
        progress = time / duration
        attack = smoothstep(time / 0.003)
        release = 1.0 - smoothstep((time - 0.60) / 0.12)
        envelope = attack * release
        modulation = 0.82 + 0.18 * math.sin(2.0 * math.pi * 24.0 * time)
        base_frequency = 196.0 - 18.0 * smoothstep(progress)
        frequencies = (base_frequency, base_frequency * 0.944)
        buzz = 0.0

        for voice, frequency in enumerate(frequencies):
            phases[voice] += 2.0 * math.pi * frequency / SAMPLE_RATE
            saw = sum(math.sin(harmonic * phases[voice]) / harmonic for harmonic in range(1, 8))
            buzz += saw * (0.68 if voice == 0 else 0.42)

        white_noise = rng.uniform(-1.0, 1.0)
        lowpass_noise += 0.09 * (white_noise - lowpass_noise)
        samples[index] = envelope * modulation * (0.62 * buzz + 0.055 * lowpass_noise)

    return samples


def generate_magic_sparkle_reveal() -> list[float]:
    duration = 1.15
    samples = make_buffer(duration)
    chord = (
        (0.000, 523.25, 0.48),
        (0.090, 659.25, 0.47),
        (0.180, 783.99, 0.46),
        (0.300, 1046.50, 0.58),
    )
    for start, frequency, amplitude in chord:
        add_bell(samples, start, duration - start - 0.01, frequency, amplitude, 0.31)

    rng = random.Random(8_231_504)
    for sparkle_index in range(13):
        start = 0.16 + sparkle_index * 0.052 + rng.uniform(-0.012, 0.012)
        frequency = rng.uniform(2_900.0, 6_200.0)
        add_bell(samples, start, 0.18, frequency, rng.uniform(0.025, 0.052), 0.045)

    return samples


def generate_magic_whoosh_appear() -> list[float]:
    duration = 0.82
    samples = make_buffer(duration)
    rng = random.Random(82_052)
    low_state = 0.0
    high_state = 0.0

    for index in range(int(0.59 * SAMPLE_RATE)):
        time = index / SAMPLE_RATE
        progress = time / 0.59
        center = 250.0 * ((6_500.0 / 250.0) ** progress)
        low_cutoff = max(80.0, center / 2.6)
        high_cutoff = min(11_000.0, center * 1.9)
        raw_noise = rng.uniform(-1.0, 1.0)

        low_alpha = 1.0 - math.exp(-2.0 * math.pi * low_cutoff / SAMPLE_RATE)
        low_state += low_alpha * (raw_noise - low_state)
        high_passed = raw_noise - low_state
        high_alpha = 1.0 - math.exp(-2.0 * math.pi * high_cutoff / SAMPLE_RATE)
        high_state += high_alpha * (high_passed - high_state)

        envelope = math.sin(math.pi * progress) ** 1.15
        samples[index] += 0.72 * envelope * high_state

    add_linear_chirp(samples, 0.54, 0.25, 130.0, 70.0, 0.55, decay=0.14)
    add_bell(samples, 0.575, 0.22, 1318.51, 0.16, 0.065)
    return samples


def generate_magic_vanish_poof() -> list[float]:
    duration = 0.65
    samples = make_buffer(duration)
    rng = random.Random(650_900)
    lowpass_state = 0.0

    for index in range(len(samples)):
        time = index / SAMPLE_RATE
        progress = time / duration
        cutoff = 2_500.0 * ((350.0 / 2_500.0) ** progress)
        alpha = 1.0 - math.exp(-2.0 * math.pi * cutoff / SAMPLE_RATE)
        lowpass_state += alpha * (rng.uniform(-1.0, 1.0) - lowpass_state)
        attack = smoothstep(time / 0.002)
        envelope = attack * math.exp(-time / 0.19)
        samples[index] += 0.95 * envelope * lowpass_state

    add_linear_chirp(samples, 0.000, 0.095, 920.0, 520.0, 0.52, decay=0.055)
    add_linear_chirp(samples, 0.012, 0.26, 170.0, 72.0, 0.44, decay=0.105)
    return samples


def generate_magic_tada_sting() -> list[float]:
    samples = make_buffer(1.35)

    for frequency in (392.00, 493.88, 587.33):
        add_brass_tone(samples, 0.000, 0.34, frequency, 0.21, 0.12)

    for frequency, amplitude in (
        (523.25, 0.24),
        (659.25, 0.21),
        (783.99, 0.20),
        (1046.50, 0.15),
    ):
        add_brass_tone(samples, 0.245, 1.08, frequency, amplitude, 0.46)

    add_bell(samples, 0.345, 0.78, 1567.98, 0.09, 0.24)
    return samples


SOUND_EFFECTS = (
    ("sfx_correct_pingpong.wav", generate_correct_pingpong, -6.0),
    ("sfx_wrong_buzzer.wav", generate_wrong_buzzer, -7.0),
    ("sfx_magic_sparkle_reveal.wav", generate_magic_sparkle_reveal, -7.0),
    ("sfx_magic_whoosh_appear.wav", generate_magic_whoosh_appear, -7.0),
    ("sfx_magic_vanish_poof.wav", generate_magic_vanish_poof, -8.0),
    ("sfx_magic_tada_sting.wav", generate_magic_tada_sting, -8.0),
)


def finalise(samples: list[float], peak_db: float) -> list[int]:
    if not samples:
        return []

    mean = sum(samples) / len(samples)
    samples = [sample - mean for sample in samples]

    edge_fade_samples = max(1, int(0.001 * SAMPLE_RATE))
    tail_fade_samples = max(1, int(0.025 * SAMPLE_RATE))
    for index in range(min(edge_fade_samples, len(samples))):
        samples[index] *= smoothstep(index / edge_fade_samples)
    for offset in range(min(tail_fade_samples, len(samples))):
        samples[-1 - offset] *= smoothstep(offset / tail_fade_samples)

    current_peak = max(abs(sample) for sample in samples) or 1.0
    target_peak = db_to_amplitude(peak_db)
    scale = target_peak / current_peak
    return [
        int(max(-1.0, min(1.0, sample * scale)) * 32_767.0)
        for sample in samples
    ]


def write_wav(path: Path, samples: list[int], force: bool) -> None:
    if path.exists() and not force:
        raise FileExistsError(f"Refusing to overwrite existing file: {path}")

    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(struct.pack(f"<{len(samples)}h", *samples))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="overwrite previously generated WAV files")
    arguments = parser.parse_args()

    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    for filename, generator, peak_db in SOUND_EFFECTS:
        integer_samples = finalise(generator(), peak_db)
        path = OUTPUT_DIRECTORY / filename
        write_wav(path, integer_samples, arguments.force)
        duration = len(integer_samples) / SAMPLE_RATE
        print(f"created {path.name}: {duration:.3f}s, 48kHz mono PCM16, peak {peak_db:.1f}dBFS")


if __name__ == "__main__":
    main()
