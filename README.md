# visual-midi

`visual-midi` is now a web-first `uv` Python app. It loads a YAML controller definition, opens the configured MIDI output, optionally opens an OSC output, restores saved state, sends all slider values on startup, and serves a browser UI that hot-reloads when the YAML changes.

## Run

```bash
uv sync
uv run visual-midi demo
```

The CLI argument is the config name without `.yaml`, so `demo` loads `configs/demo.yaml`.

The server prefers port `8765` on each run and falls back to a random free port if that one is busy. It opens the default browser automatically and exposes the UI on your local network. The QR code at the bottom points to a `?noqr` URL so the phone view hides the QR panel.

## Config format

Configs stay in YAML, but the backend normalizes them into JSON for the browser UI. Layout is now defined as nested `rows` and `columns` containers. Children do not declare their own type: a node is a container if it has `rows:` or `columns:`, otherwise it is treated as a control.

```yaml
title: Demo Controller
output: IAC Driver Bus 1
inertia: 1.2
osc:
  host: 127.0.0.1
  port: 8000
palette:
  orange: "#d26a2e"
  moss: "#5f8f6b"
columns:
  - rows:
      - name: Freq
        channel: 1
        control: 74
        default: 64
        color: orange
        height: 70%
        osc:
          path: /synth/freq
          min: 20
          max: 20000
      - name: LFO Freq
        channel: 1
        control: 75
        default: 32
        color: moss
  - rows:
      - name: Freq 2
        channel: 1
        control: 74
        default: 64
        color: orange
      - name: LFO Freq 2
        channel: 1
        control: 75
        default: 32
        color: moss
```

The layout fills the available UI area as a mosaic:

- children inside `rows` split the available height equally by default
- children inside `columns` split the available width equally by default
- explicit `width` or `height` values can be set with `%` or `px`
- any remaining space is distributed evenly across siblings without an explicit size

Supported slider fields:

- `name`
- `channel` from `1` to `16`
- `control` from `0` to `127`
- `default`, `min`, `max`
- `speed`: optional positive number, where `1` keeps the current feel, smaller values move faster, and larger values require more drag/scroll movement for smaller value changes
- `orientation`: `horizontal` or `vertical`
- `color`: any CSS color string or a name from the root `palette`
- `width`, `height`: optional `%` or `px` sizes for the control tile
- `osc`: optional per-slider OSC mapping
- `osc.path`: OSC address to send when the slider changes
- `osc.min`, `osc.max`: output range for the OSC value after mapping from the slider's `min`/`max`

Supported layout group fields:

- `rows`
- `columns`
- `width`, `height`: optional `%` or `px` sizes for the container tile

Optional root fields:

- `inertia`: global multiplier for release throw, where `1.0` is the default feel and `0` disables inertia
- `osc.host`, `osc.port`: optional UDP destination used by slider `osc` routes
- `palette`: a mapping of color names to CSS color strings

## Notes

- Slider state is saved in `~/.visual-midi/states/<config-name>.json`
- Slider state is tracked internally as a float, which is especially useful with low `speed` values and OSC mappings
- MIDI sends the nearest CC value for the current slider position and skips repeats when float changes round to the same CC
- OSC sends the current float slider position mapped into the configured `osc.min`/`osc.max` range
- YAML edits are watched and trigger UI reload plus MIDI/OSC state resend
- The frontend is served from separate static files under [src/visual_midi/web](/Users/pauloricca/Desktop/projects/visual-midi/src/visual_midi/web)
- The backend exposes normalized config/state data over JSON endpoints instead of building HTML in Python
- The frontend is intentionally framework-free for now, but the repo is pinned to `pnpm` if you decide to add TypeScript tooling later
