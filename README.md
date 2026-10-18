# Nuvola Diary

A local-first journaling PWA and desktop application for Windows, macOS, and Linux.

## Pages

- `index.html` — Nuvola's landing page and interactive book preview.
- `landing.html` — the journal application.
- `app.html` — compatibility copy of the journal application for older links.

## Run the web app

Service workers and module workers do not work reliably from `file://`, so serve the directory over HTTP:

```sh
python -m http.server 8080
```

Open `http://localhost:8080/index.html` for the landing page or `http://localhost:8080/landing.html` for the journal.

## Run the desktop app

Install Node.js 22 or newer, then run:

```sh
npm install
npm start
```

Electron opens the landing page first. The journal opens from the landing page's primary button. The desktop wrapper disables Node integration in page content. The current application loads some libraries and optional AI runtime/model files from CDNs, so an internet connection is needed for first load/model download. Diary data stays in the local app profile. Export your backup before removing the app or its profile.

## Build installers locally

Run each target on its supported OS (especially macOS, which should be built on macOS):

```sh
npm run dist:win    # Windows MSI + NSIS setup EXE + portable EXE
npm run dist:mac    # macOS DMG + ZIP
npm run dist:linux  # Linux AppImage + DEB
```

Output is written to `release/`. The Windows MSI is configured for per-user installation. Keep the MSI `upgradeCode` stable between releases. macOS signing/notarization and Windows code signing are not configured; unsigned builds may show OS security warnings.

## Build all platforms with GitHub Actions

This repository includes `.github/workflows/desktop-build.yml`. Push the source to GitHub, then either run **Actions → Build desktop installers → Run workflow**, or push a version tag:

```sh
git tag v1.0.1
git push origin v1.0.1
```

The workflow builds on Windows, macOS, and Linux runners and uploads the resulting installer files as workflow artifacts. When triggered by a version tag, it also attaches those files to a GitHub Release. The source ZIP does **not** contain precompiled `.msi`, `.dmg`, `.AppImage`, or `.deb` binaries; these need to be produced by the OS build runners. Download them from the Actions run or the Release page after the workflow completes.

## Optional on-device AI

The journal works without AI. In **You → Local coach**, users can opt into a smaller Qwen2.5 0.5B model or Llama 3.2 1B. Model weights are fetched only after opt-in and run on-device through WebGPU when supported. Download sizes vary with quantization/runtime/cache. The app does not send diary text to a Nuvola backend.

## Storage and privacy

Entries and mood check-ins are stored in IndexedDB via Dexie. Appearance and coach preferences are stored in localStorage. Browser and desktop profiles are separate, so use the JSON backup/export feature to move entries between them. Cloud sync is not included.

## Publish the web app

Deploy this directory as a static site on Vercel. Set `index.html` as the default landing page. `app.html` remains as a compatibility entry point for the journal.
