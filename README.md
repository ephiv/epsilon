# epsilon

Deterministic osu!mania replay renderer with shared simulation, stateless preview rendering, and offline video export.

## What changed

- Replay playback now runs through a typed core simulator instead of fake autoplay state.
- `.osu` and `.osr` parsing are shared by both the browser preview and the CLI exporter.
- Stable-style judgements, combo, score, accuracy, LN state, Mirror, DT/HT timing, BPM+SV scroll, replay-driven key states, life graph, and hitsound events all feed the renderer.
- Export is offline and analytical: exact frame stepping, optional shutter sampling, song audio muxing, and beatmap or skin hitsound mixing.

## Commands

- `npm run dev`
- `npm run build`
- `npm test`
- `npm run export:video -- --osu <map.osu> --osr <replay.osr> --out <render.mp4>`

`ffmpeg` must be installed and available on `PATH` for background video export.

## Export options

`npm run export:video -- --help`

Supported flags:

- `--audio <file>`
- `--bg <file>`
- `--skin-dir <dir>`
- `--font <file>`
- `--settings <file>`
- `--width <n>`
- `--height <n>`
- `--fps <n>`
- `--lead-in-ms <n>`
- `--tail-pad-ms <n>`
- `--out <file>`

Common output formats are selected by the `--out` extension:

- `.mp4`
- `.mov`
- `.webm`
- `.mkv`

## Structure

- `src/core`: beatmap parsing, replay parsing, judgement and scoring logic, scroll integration, hitsound extraction, immutable replay timeline
- `src/render`: stateless canvas renderer and noteskin helpers
- `src/web`: worker-backed preview path
- `src/cli`: deterministic offline exporter
- `noteskin_assets.js`: bundled default noteskin art
