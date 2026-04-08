# visual-midi

`visual-midi` is now a web-first `uv` Python app. It loads a YAML controller definition, opens the configured MIDI output, restores saved state, sends all slider values on startup, and serves a browser UI that hot-reloads when the YAML changes.

## Run

```bash
uv sync
uv run visual-midi demo
```

The CLI argument is the config name without `.yaml`, so `demo` loads `configs/demo.yaml`.

The server prefers port `8765` on each run and falls back to a random free port if that one is busy. It opens the default browser automatically and exposes the UI on your local network. The QR code at the bottom points to a `?noqr` URL so the phone view hides the QR panel.

## Config format

Configs stay in YAML, but the backend normalizes them into JSON for the browser UI. You can keep the old flat `sliders:` list, or use nested `layout` groups for rows and columns.

```yaml
title: Demo Controller
output: IAC Driver Bus 1
layout:
  type: column
  gap: 16
  children:
    - type: row
      gap: 16
      children:
        - name: Filter Cutoff
          channel: 1
          control: 74
          default: 64
          color: "#d26a2e"
        - name: Resonance
          channel: 1
          control: 71
          default: 32
          color: "#5f8f6b"
    - type: row
      gap: 20
      children:
        - name: Attack
          channel: 1
          control: 73
          default: 20
          orientation: vertical
          height: 260
        - name: Release
          channel: 1
          control: 72
          default: 80
          orientation: vertical
          height: 260
```

Supported slider fields:

- `name`
- `channel` from `1` to `16`
- `control` from `0` to `127`
- `default`, `min`, `max`
- `orientation`: `horizontal` or `vertical`
- `color`: any CSS color string
- `width`, `height`: optional pixel sizes for the control container

Supported layout group fields:

- `type`: `row` or `column`
- `gap`: spacing between children in pixels
- `children`: nested groups or sliders

## Notes

- Slider state is saved in `~/.visual-midi/states/<config-name>.json`
- YAML edits are watched and trigger UI reload plus MIDI state resend
- The frontend is served from separate static files under [src/visual_midi/web](/Users/pauloricca/Desktop/projects/visual-midi/src/visual_midi/web)
- The backend exposes normalized config/state data over JSON endpoints instead of building HTML in Python
- The frontend is intentionally framework-free for now, but the repo is pinned to `pnpm` if you decide to add TypeScript tooling later
