# Offline Asset Layout

This app is designed to ship as a full offline installer. The large binary assets are not checked into this repository.

Place production files at these paths before packaging:

- `assets/models/whisper/ggml-large-v3-turbo-q8_0.bin`
- `assets/translate/argos/*.argosmodel`
- `assets/ffmpeg/macos/ffmpeg`
- `src-tauri/binaries/neon-engine-{target-triple}` after freezing `engine/main.py`, or a packaged sidecar that can run the bundled `engine` resource

Update `assets/manifest.json` with the SHA-256 of required files. Leave `sha256` empty only for development placeholders.

For Tauri sidecars, the packaged binary names must include the target triple, for example:

- `neon-engine-aarch64-apple-darwin`
- `neon-engine-x86_64-apple-darwin`
- `neon-engine-x86_64-pc-windows-msvc.exe` (required before enabling Windows bundle targets)
