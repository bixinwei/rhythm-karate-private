# TimingAccuracy source-driven port — best effort, not certified native parity

Reference revision: `c0be354cf74806fb90f8c3ab6cc101f7fbcd827a`.
Target: TimingAccuracy's Just00/Just01, **not SkillStar**.

## Reproducible source evidence

Run `python tools/export_heaven_timing.py --check` and
`node tools/verify_heaven_timing_values.mjs` from the web repository.
The exporter follows controller object references to ParticleSystems and their
birth subemitters. It preserves active serialized modules, material references,
precise string file IDs and source texture/shader bytes with SHA256 provenance.
The evaluator tests check numerical results, not code-string presence.

## Confirmed defects in the previous game.js implementation

- Polygon stars and a drawn shadow replace the actual `main.png` alpha texture.
- Eight hand-selected palette colors replace the real 32-pixel bilinear palette.
- Palette time uses particle age; AceColorCycle.shader uses global `_Time.y`.
- Just00 ClampVelocityModule is omitted (limit 1, dampen .07).
- Infinite curve tangents incorrectly become linear transitions.
- Birth subemitters are omitted, including inheritance and their own lifetimes.
- Just01 uses the prefab scale instead of the controller's `1-frac/2` scale.
- Just01 rotation, size, velocity and alpha curves are not preserved separately.
- Particle size and position use inconsistent pixel-per-unit factors.
- Existing string-based VFX assertions cannot establish visual correctness.

## Implemented browser revision

User authorized a best-effort implementation for their own visual validation.
`heaven-timing-runtime.js` now consumes the exported source and the tested curve
and gradient evaluators. The game uses original sprite alpha, palette, global
shader time, distinct Just00/Just01 curves, inherited birth subparticles, and
particle-specific lifetimes. A single world-to-screen scale is shared by size
and position. Source MIT notice is included with extracted assets.

Browser checks: the real game starts without console errors; the dedicated
preview renders both variants at .025, .1, .2, .3, .4 and .65 seconds. All three
existing game audit commands pass, as do numerical particle checks. This is
functional verification, not proof of pixel-identical Unity rendering.

## What remains unverified

Native Unity integration ordering, velocity clamp
semantics, subemitter position inheritance and emission timing require a runtime
reference. Current approximation damps persistent launch velocity using a
60-Hz-normalized factor, applies radial velocity each step, rotates launch
direction with the orbit, and integrates at 120 Hz. Birth child emitters follow
the parent during its lifetime, then their particles remain stationary and fade.
These native-engine semantics have not been verified against Unity.
Texture import resizing, GPU color space, rendering projection and
the overlay's final screen transform also need rendered comparison.

The C# source and prefab specify these settings but do not contain Unity's C++
particle simulator. Copying the numeric settings is insufficient to prove that
a new JavaScript integration scheme behaves identically.

No Unity executable was found in usual installation paths or checked registry
locations. The original GitHub release API returned HTTP 451 (repository blocked).
Do not substitute an unverified unofficial executable or claim visual parity.

## Next acceptance procedure

Use Unity 2021.3.21f1 (the repository's version) with the original prefab and
dependencies. Fix random seeds and clock origin; capture both particle state and
rendered frames at 60 Hz through all child-particle deaths. Record position,
size, color, rotation, lifetime and emitter identity. Reproduce the same inputs
in a browser fixture, compare states numerically and alpha/color images after
the same camera/display transform. Then compare the full captured lifecycle in
`captures-frames/frame_057.png` through `frame_062.png`. Allow random variation
only where the source explicitly enables it. Never use screenshot-driven
trajectory tuning as a substitute for the source simulation.

No gameplay cue timing, music, judgement windows or source game sprites changed.
