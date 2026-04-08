# Architecture Notes

## Philosophy

- This project is web-first. Do not reintroduce Tk or any parallel desktop UI unless there is a very strong reason.
- YAML is the source format for humans. Keep configs pleasant to author by hand.
- The browser should consume normalized JSON, not server-rendered HTML assembled from YAML.
- Python owns device access, MIDI output, config loading, persistence, and runtime coordination.
- The frontend owns layout, interaction, rendering, and visual complexity.
- Prefer small, explicit systems over heavyweight abstractions until the UI genuinely needs them.

## Current Shape

- Backend entrypoint: [src/visual_midi/app.py](/Users/pauloricca/Desktop/projects/visual-midi/src/visual_midi/app.py)
- Static frontend files: [src/visual_midi/web](/Users/pauloricca/Desktop/projects/visual-midi/src/visual_midi/web)
- Human-authored controller configs: [configs](/Users/pauloricca/Desktop/projects/visual-midi/configs)

The backend:

- loads a YAML config
- opens the configured MIDI output
- restores saved slider state from `~/.visual-midi/states/<config>.json`
- sends all current values as MIDI CC on startup
- watches the YAML file for changes via mtime polling
- reloads config safely when valid
- serves JSON APIs and static frontend assets

The frontend:

- fetches normalized config/state from `/api/config`
- renders layout recursively from JSON
- sends slider updates to `/api/slider`
- polls `/api/version` and reloads when config changes
- shows a QR code for LAN access unless `?noqr` is present

## Architectural Rules

- Do not build large HTML strings in Python again.
- Do not make the frontend parse YAML directly.
- Do not couple UI structure to backend templates.
- Keep runtime MIDI behavior in Python unless there is a deliberate migration plan.
- Keep config normalization centralized in the backend so the frontend receives one stable schema.
- Preserve hot-reload behavior when changing config/runtime plumbing.
- Preserve saved slider state compatibility unless there is a migration plan.

## Config Model

YAML should remain ergonomic, but the runtime model should stay explicit.

Current concepts:

- `title`
- `output`
- `rows` / `columns`
- `slider`

Layout is a tree of:

- `rows`
- `columns`
- `slider`

Slider presentation fields may include:

- `orientation`
- `color`
- `width`
- `height`

Future additions should follow the same pattern:

- human-friendly YAML input
- normalized backend model
- simple frontend rendering contract

The current layout rule is mosaic-based:

- each `rows` container divides height among its children
- each `columns` container divides width among its children
- explicit `%` or `px` sizes are allowed
- unspecified siblings share the remaining space equally

## Frontend Direction

Right now the frontend is framework-free and served directly as static files. That is intentional.

If the UI grows further:

- use `pnpm` for frontend dependency management
- prefer a small toolchain like `Vite`
- prefer a light component model over ad hoc DOM code once complexity justifies it

If a framework is introduced:

- keep the backend JSON contract stable
- avoid moving MIDI/device logic into the frontend
- avoid tying config semantics to framework-specific concepts

## Backend Direction

Python remains the right place for:

- MIDI I/O
- YAML parsing and validation
- state persistence
- config reload coordination
- QR URL generation
- LAN/server lifecycle behavior

If backend complexity grows:

- move toward a small web framework
- keep the API surface narrow and explicit
- avoid overengineering background infrastructure unless needed

## Decision Filter

When making future changes, prefer the option that:

1. keeps YAML easy to write
2. keeps Python responsible for MIDI/runtime concerns
3. keeps the frontend responsible for presentation
4. preserves a clean JSON boundary between them
5. avoids duplicated UI implementations

If a change violates one of those, it needs a concrete reason.
