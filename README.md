# visual-midi

A small `uv`-managed Python app that renders a slider-based MIDI controller UI from YAML files.

## What it does

- Loads a UI definition from `configs/<name>.yaml`
- Opens the configured MIDI output device
- Restores the last saved value for every slider
- Sends every current slider value as MIDI CC on startup
- Sends and persists changes whenever you move a slider

## Run

```bash
uv run visual-midi demo
```

```bash
uv run visual-midi demo --web
```

The argument is the YAML file name without the `.yaml` suffix. The app looks for:

```text
configs/demo.yaml
```

`--web` starts a local HTTP server, opens your default browser to it, and renders the same controller layout in the browser instead of Tk.
It also shows a QR code at the bottom of the page for the detected local network URL so you can open it from your phone on the same Wi-Fi network.
The web server reuses port `8765` across runs unless that port is already in use.

## Install dependencies

```bash
uv sync
```

## YAML format

```yaml
title: Demo Controller
window:
  width: 900
  height: 420
output: IAC Driver Bus 1
sliders:
  - name: Filter Cutoff
    channel: 1
    control: 74
    default: 64
  - name: Resonance
    channel: 1
    control: 71
    default: 32
```

## Notes

- `channel` is a standard MIDI channel number from `1` to `16`
- `control` is the MIDI CC number from `0` to `127`
- Slider values are saved in `~/.visual-midi/states/<config-name>.json`
- If the configured device cannot be opened, the app shows the available MIDI outputs in the error message
- Web mode binds on your local network so other devices on the same network can reach it
- Editing the YAML file triggers an automatic reload for both the Tk window and the web UI
