# Neon Subtitle Studio

Full offline desktop subtitle studio for macOS and Windows.

## What is implemented

- Tauri 2 project scaffold.
- React + TypeScript + Vite frontend.
- Dark professional studio UI with neon blue, green, yellow, and pink action accents.
- Dashboard, Import, Studio, Export History, Settings, and offline engine status surfaces.
- Python sidecar engine with local HTTP API.
- SQLite autosave/job database.
- Offline asset manifest and health checks.
- Chunk/resume-ready job status flow.
- SRT/VTT export path from editable subtitle segments.

## Local development

Install dependencies:

```bash
npm install
```

Run the Python engine in one terminal:

```bash
npm run dev:engine
```

Run the UI in another terminal:

```bash
npm run dev
```

Open `http://localhost:1420`.

## Tauri build prerequisites

Rust/Cargo must be installed before running Tauri commands. This machine currently needs Rust installed before `npm run tauri dev` or `npm run tauri build` can work.

```bash
npm run tauri dev
```

## Offline production assets

Large binaries are intentionally not committed. Before production packaging, add:

- `assets/models/whisper/ggml-large-v3-turbo-q8_0.bin`
- Argos Translate packages under `assets/translate/argos`
- FFmpeg binaries under `assets/ffmpeg`
- Frozen Python sidecar binaries under `src-tauri/binaries`

See `docs/offline-assets.md`.
