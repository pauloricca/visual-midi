# visual-midi

`visual-midi` is a web server `uv` Python app with a typescript frontend. It loads a YAML controller definition, opens the configured MIDI output, optionally opens an OSC output, restores saved state, sends all values on startup, and serves a browser UI that hot-reloads when the YAML changes.

## Run

```bash
uv sync
uv run visual-midi demo
```

The CLI argument is the config name without `.yaml`, so `demo` loads `configs/demo.yaml`.

The server prefers port `8765` on each run and falls back to a random free port if that one is busy. It opens the default browser automatically and exposes the UI on your local network. The QR code at the bottom points to a `?noqr` URL so the phone view hides the QR panel.

## Config format

Configs stay in YAML, but the backend normalizes them into JSON for the browser UI. Layout is defined as nested `rows`, `columns`, and `tabs` containers. A node is a container if it has `rows:`, `columns:`, or `tabs:`. Otherwise it is treated as a control. Controls may declare `type`, and if omitted they default to `slider`.

Container children can carry sizing fields and shared slider defaults next to their layout key. Slider defaults cascade down to descendant sliders unless a child overrides them. `channel` defaults to `1` if nothing sets it. For example, if a `rows` child is a `columns` container, put `height`, `channel`, `color`, or `steps` on the same mapping as `columns`:

```yaml
rows:
  - height: 70%
    channel: 1
    color: sand
    steps: 25
    columns:
      - name: 1
        control: 1
        default: 0
      - name: 2
        control: 2
        default: 0
  - columns:
      - name: 3
        control: 3
        color: moss
```

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
  - tabs:
      - tab:
          name: Tabbed Content A
          rows:
            - name: Env A
              channel: 1
              control: 76
              default: 48
      - tab:
          name: Tabbed Content B
          rows:
            - name: Env B
              channel: 1
              control: 77
              default: 48
```

The layout fills the available UI area as a mosaic:

- children inside `rows` split the available height equally by default
- children inside `columns` split the available width equally by default
- children inside `tabs` render as one visible panel at a time with clickable tab labels
- explicit `width` or `height` values can be set with `%` or `px`
- any remaining space is distributed evenly across siblings without an explicit size

Supported control fields:

- `type`: optional, `slider`, `lfo`, `keyboard`, `button`, `tempo`, or `sequencer`, defaults to `slider`
- `name`
- `color`: any CSS color string or a name from the root `palette`, optional when inherited from a parent container
- `width`, `height`: optional `%` or `px` sizes for the control tile

Controls that send channel messages use:

- `channel` from `1` to `16`, optional when inherited from a parent container, defaults to `1`

Supported slider fields:

- `control` from `0` to `127`
- `default`, `min`, `max`: optional, may be inherited from a parent container
- `steps`: optional integer `>= 2` that snaps the slider to a fixed number of positions between `min` and `max`, inclusive, may be inherited from a parent container
- `speed`: optional positive number, where `1` keeps the current feel, smaller values move faster, and larger values require more drag/scroll movement for smaller value changes, may be inherited from a parent container
- `orientation`: `horizontal` or `vertical`, may be inherited from a parent container
- `osc`: optional per-slider OSC mapping
- `osc.path`: OSC address to send when the slider changes
- `osc.min`, `osc.max`: output range for the OSC value after mapping from the slider's `min`/`max`

Supported LFO fields:

- `type: lfo`
- uses the same `control`, `channel`, `min`, `max`, `steps`, `color`, `width`, `height`, and optional `osc` mapping as a slider
- `complex`: optional boolean, defaults to `true`; set `false` to use the simpler single-surface LFO UI
- `max_speed`: optional non-negative number, defaults to `12`; the speed control ranges from `0` to `max_speed`, and `0` stops all motion
- if `default` is omitted, the control starts centered between `min` and `max`
- the browser animates the output continuously around the center point
- vertical drag or scroll changes depth, horizontal drag or scroll changes rate
- depth/rate are remembered in browser storage per control key
- in `complex: true` mode, the top-left panel sets the LFO midpoint and shows live movement, top-right controls depth, bottom-left controls speed, and bottom-right controls jitter
- jitter blends between the sine LFO shape and a smoothed random motion, where `0` is pure LFO and `1` is pure jitter

Supported keyboard fields:

- `type: keyboard`
- `start`: optional MIDI note number or note name like `C2`, `D6`, or `B#2`, defaults to `60` / middle C
- `size`: optional number of keys to render, defaults to `12`
- `scale`: optional scale name; when paired with `root`, the keyboard renders as a single row containing only notes in that scale
- `root`: required when `scale` is set; accepts MIDI note number or note name like `C2` or `Bb3`

Built-in scale names include:

- `major`, `minor`, `natural_minor`, `harmonic_minor`, `melodic_minor`
- `ionian`, `dorian`, `phrygian`, `lydian`, `mixolydian`, `aeolian`, `locrian`
- `major_pentatonic`, `minor_pentatonic`, `blues`, `chromatic`, `whole_tone`
- `diminished_half_whole`, `diminished_whole_half`

Supported button fields:

- `type: button`
- `control`: required MIDI CC number from `0` to `127`
- `osc`: optional OSC route
- button press sends MIDI CC `127` and button release sends MIDI CC `0`
- if `osc` is present, button press sends `1` and release sends `0`

Supported tempo fields:

- `type: tempo`
- only one tempo control is currently supported per config
- `default`: optional BPM, defaults to `120.0`
- `min`, `max`: optional BPM range, defaults to `20.0` and `300.0`
- tempo values are quantized to `0.1` BPM
- play sends MIDI real-time `start`, stop sends MIDI real-time `stop`
- while playing, the backend emits MIDI real-time `clock` at `24 PPQN` using the configured BPM
- the same BPM also updates the app's global transport/timing state for future sequencer features

Supported sequencer fields:

- `type: sequencer`
- `mode`: `notes` or `cc`
- `size`: required number of steps, `>= 1`
- `subdivision`: required step timing as a note fraction like `1/16` or a positive beat value
- `channel`: MIDI channel from `1` to `16`
- `min`, `max`: optional value range, defaults to `0..127`
- `root`, `scale`: optional for `notes`; when both are present, step values are quantized to that scale and `root` becomes the default value when enabling a step
- `control`: optional for `cc`; required unless an `osc` route is present
- `osc`: optional for `cc`; if present, the step value is mapped through `osc.min`/`osc.max` like a slider
- sequencers require a tempo control somewhere in the same config
- note sequencers send one note per active step and release the previous note on the next step or when transport stops
- cc sequencers emit their step value on each active step and skip disabled steps

Supported layout group fields:

- `rows`
- `columns`
- `tabs`
- `channel`, `default`, `min`, `max`, `steps`, `speed`, `orientation`, `color`: optional inherited defaults for descendant sliders and sequencers where relevant
- `width`, `height`: optional `%` or `px` sizes for the container tile

Supported tab item fields:

- `tab`
- `tab.name`
- exactly one of `tab.rows`, `tab.columns`, or `tab.tabs`

Optional root fields:

- `inertia`: global multiplier for release throw, where `1.0` is the default feel and `0` disables inertia
- `osc.host`, `osc.port`: optional UDP destination used by slider `osc` routes
- `palette`: a mapping of color names to CSS color strings

## Notes

- Slider state is saved in `~/.visual-midi/states/<config-name>.json`
- Slider state is tracked internally as a float, which is especially useful with low `speed` values and OSC mappings
- If `steps` is set, slider values are quantized across that many evenly spaced positions between `min` and `max`
- MIDI sends the nearest CC value for the current slider position and skips repeats when float changes round to the same CC
- Keyboard controls send `note_on` while a key is held and `note_off` on release, and support polyphonic multi-touch
- Tempo controls persist their BPM in the same state file and drive the shared transport clock
- Sequencer step state is persisted in the same state file alongside slider and tempo values
- OSC sends the current float slider position mapped into the configured `osc.min`/`osc.max` range
- YAML edits are watched and trigger UI reload plus MIDI/OSC state resend
- The frontend is served from separate static files under [src/visual_midi/web](/Users/pauloricca/Desktop/projects/visual-midi/src/visual_midi/web)
- The backend exposes normalized config/state data over JSON endpoints instead of building HTML in Python
- The frontend is intentionally framework-free for now, but the repo is pinned to `pnpm` if you decide to add TypeScript tooling later
