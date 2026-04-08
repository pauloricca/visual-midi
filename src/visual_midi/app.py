from __future__ import annotations

import argparse
import base64
import errno
import io
import json
import socket
import tkinter as tk
import webbrowser
from dataclasses import dataclass
from html import escape
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from tkinter import ttk
from typing import Any

import mido
import qrcode
import yaml


STATE_DIR = Path.home() / ".visual-midi" / "states"
CONFIG_DIR = Path.cwd() / "configs"
DEFAULT_WEB_PORT = 8765
RELOAD_POLL_MS = 1000


@dataclass(frozen=True)
class SliderConfig:
    name: str
    channel: int
    control: int
    default: int = 0
    minimum: int = 0
    maximum: int = 127

    @property
    def state_key(self) -> str:
        return f"ch{self.channel}:cc{self.control}:{self.name}"


@dataclass(frozen=True)
class AppConfig:
    title: str
    output: str
    sliders: list[SliderConfig]
    width: int = 960
    height: int = 420


def main() -> None:
    args = parse_args()
    profile = args.config_name
    config_path = CONFIG_DIR / f"{profile}.yaml"
    state_path = STATE_DIR / f"{profile}.json"

    runtime = RuntimeState(config_path=config_path, state_path=state_path)
    runtime.send_all_states()

    try:
        if args.web:
            run_web_app(runtime=runtime)
        else:
            run_tk_app(runtime=runtime)
    finally:
        runtime.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="visual-midi",
        description="Render a MIDI controller UI from a YAML file.",
    )
    parser.add_argument("config_name", help="YAML config name without the .yaml suffix")
    parser.add_argument(
        "--web",
        action="store_true",
        help="Serve the controller as a local web app and open it in the default browser.",
    )
    return parser.parse_args()


def run_tk_app(*, runtime: "RuntimeState") -> None:
    root = tk.Tk()
    MidiControllerTkApp(root=root, runtime=runtime)
    root.mainloop()


def run_web_app(*, runtime: "RuntimeState") -> None:
    server = build_web_server(runtime=runtime)
    _, port = server.server_address
    browser_url = f"http://127.0.0.1:{port}/"
    lan_ip = detect_local_ip_address()
    external_url = f"http://{lan_ip}:{port}/" if lan_ip else browser_url
    print(f"Serving {runtime.current_config().title} at {browser_url}")
    if external_url != browser_url:
        print(f"LAN access: {external_url}")
    webbrowser.open(browser_url, new=1)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def build_web_server(*, runtime: "RuntimeState") -> ThreadingHTTPServer:
    class MidiWebHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path == "/" or self.path == "/?noqr":
                payload = render_web_ui(
                    runtime=runtime,
                    port=self.server.server_address[1],
                    hide_qr_panel=self.path.endswith("?noqr"),
                )
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return

            if self.path == "/api/version":
                payload = json.dumps({"version": runtime.version()}).encode("utf-8")
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return

            self.send_error(HTTPStatus.NOT_FOUND, "Not found")

        def do_POST(self) -> None:
            if self.path != "/api/slider":
                self.send_error(HTTPStatus.NOT_FOUND, "Not found")
                return

            content_length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(content_length)
            try:
                body = json.loads(raw.decode("utf-8"))
                state_key = str(body["key"])
                value = int(body["value"])
                updated = runtime.update_slider_by_key(state_key, value)
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
                self.send_error(HTTPStatus.BAD_REQUEST, str(exc))
                return

            payload = json.dumps(
                {"key": updated.state_key, "value": runtime.get_slider_value(updated)}
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: Any) -> None:
            return

    try:
        return ThreadingHTTPServer(("0.0.0.0", DEFAULT_WEB_PORT), MidiWebHandler)
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE:
            raise
        return ThreadingHTTPServer(("0.0.0.0", 0), MidiWebHandler)


def render_web_ui(*, runtime: "RuntimeState", port: int, hide_qr_panel: bool) -> bytes:
    config = runtime.current_config()
    lan_ip = detect_local_ip_address()
    external_url = f"http://{lan_ip}:{port}/" if lan_ip else f"http://127.0.0.1:{port}/"
    qr_target_url = f"{external_url}?noqr"
    qr_code_data_url = generate_qr_code_data_url(qr_target_url)
    page_version = runtime.version()

    slider_rows: list[str] = []
    for slider in config.sliders:
        value = runtime.get_slider_value(slider)
        slider_rows.append(
            f"""
            <section class="slider-row">
              <div class="slider-header">
                <label class="slider-label" for="{escape(slider.state_key)}" data-key="{escape(slider.state_key)}">
                  {escape(runtime.format_slider_label(slider, value))}
                </label>
                <div class="slider-meta">CH {slider.channel} CC {slider.control}</div>
              </div>
              <input
                id="{escape(slider.state_key)}"
                class="slider-input"
                type="range"
                min="{slider.minimum}"
                max="{slider.maximum}"
                step="1"
                value="{value}"
                data-key="{escape(slider.state_key)}"
                data-name="{escape(slider.name)}"
              />
            </section>
            """
        )

    document = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{escape(config.title)}</title>
  <style>
    :root {{
      color-scheme: light;
      --bg: #f4f2ec;
      --panel: #fffdf8;
      --text: #1f1d1a;
      --muted: #726a5f;
      --border: #ddd4c6;
      --accent: #d26a2e;
    }}
    * {{
      box-sizing: border-box;
    }}
    body {{
      margin: 0;
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      background: linear-gradient(180deg, #f7f4ee 0%, var(--bg) 100%);
      color: var(--text);
    }}
    main {{
      max-width: 960px;
      margin: 0 auto;
      padding: 24px 16px 40px;
    }}
    h1 {{
      margin: 0 0 18px;
      font-size: 2rem;
      line-height: 1.1;
    }}
    .stack {{
      display: grid;
      gap: 12px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px 16px 16px;
      box-shadow: 0 8px 20px rgba(65, 44, 22, 0.06);
    }}
    .slider-row + .slider-row {{
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }}
    .slider-header {{
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 8px;
    }}
    .slider-label {{
      font-size: 1rem;
      font-weight: 600;
    }}
    .slider-meta {{
      color: var(--muted);
      font-size: 0.95rem;
      white-space: nowrap;
    }}
    .slider-input {{
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: 44px;
      background: transparent;
      margin: 0;
    }}
    .slider-input:focus {{
      outline: none;
    }}
    .slider-input::-webkit-slider-runnable-track {{
      height: 10px;
      background: #d8cdbd;
      border-radius: 999px;
    }}
    .slider-input::-webkit-slider-thumb {{
      -webkit-appearance: none;
      appearance: none;
      width: 34px;
      height: 34px;
      margin-top: -12px;
      border-radius: 50%;
      border: 2px solid #b04c17;
      background: var(--accent);
      box-shadow: 0 4px 10px rgba(210, 106, 46, 0.35);
    }}
    .slider-input::-moz-range-track {{
      height: 10px;
      background: #d8cdbd;
      border-radius: 999px;
    }}
    .slider-input::-moz-range-thumb {{
      width: 34px;
      height: 34px;
      border: 2px solid #b04c17;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 4px 10px rgba(210, 106, 46, 0.35);
    }}
    .slider-input::-moz-range-progress {{
      height: 10px;
      background: #e3996b;
      border-radius: 999px;
    }}
    .qr-panel {{
      margin-top: 24px;
      padding: 18px 16px;
      background: rgba(255, 253, 248, 0.72);
      border: 1px solid var(--border);
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }}
    .qr-copy {{
      min-width: 0;
    }}
    .qr-copy h2 {{
      margin: 0 0 8px;
      font-size: 1rem;
    }}
    .qr-copy p {{
      margin: 0;
      color: var(--muted);
      line-height: 1.45;
      word-break: break-all;
    }}
    .qr-image {{
      width: 108px;
      height: 108px;
      display: block;
      border-radius: 10px;
      background: white;
      padding: 8px;
      border: 1px solid var(--border);
    }}
    @media (max-width: 640px) {{
      .qr-panel {{
        flex-direction: column;
        align-items: flex-start;
      }}
    }}
  </style>
</head>
  <body>
  <main>
    <h1>{escape(config.title)}</h1>
    <div class="stack">
      {"".join(slider_rows)}
    </div>
    <section class="qr-panel" style="{ 'display:none;' if hide_qr_panel else '' }">
      <div class="qr-copy">
        <h2>Open On Your Phone</h2>
        <p>Scan this QR code on the same local network:</p>
        <p><a href="{escape(qr_target_url)}">{escape(qr_target_url)}</a></p>
      </div>
      <img class="qr-image" src="{qr_code_data_url}" alt="QR code for {escape(qr_target_url)}" />
    </section>
  </main>
  <script>
    let pageVersion = {page_version};
    const sliderLabels = new Map(
      Array.from(document.querySelectorAll('.slider-label')).map((node) => [node.dataset.key, node])
    );

    for (const input of document.querySelectorAll('.slider-input')) {{
      input.addEventListener('input', async (event) => {{
        const slider = event.currentTarget;
        const key = slider.dataset.key;
        const value = Number(slider.value);
        const label = sliderLabels.get(key);
        if (label) {{
          label.textContent = `${{slider.dataset.name}}: ${{value}}`;
        }}

        try {{
          await fetch('/api/slider', {{
            method: 'POST',
            headers: {{ 'Content-Type': 'application/json' }},
            body: JSON.stringify({{ key, value }})
          }});
        }} catch (_error) {{
        }}
      }});
    }}

    setInterval(async () => {{
      try {{
        const response = await fetch('/api/version', {{ cache: 'no-store' }});
        const data = await response.json();
        if (data.version !== pageVersion) {{
          window.location.reload();
        }}
      }} catch (_error) {{
      }}
    }}, {RELOAD_POLL_MS});
  </script>
</body>
</html>
"""
    return document.encode("utf-8")


def detect_local_ip_address() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            ip_address = sock.getsockname()[0]
    except OSError:
        return None

    if ip_address.startswith("127."):
        return None
    return ip_address


def generate_qr_code_data_url(url: str) -> str:
    image = qrcode.make(url)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def load_config(config_path: Path) -> AppConfig:
    if not config_path.exists():
        raise SystemExit(f"Config not found: {config_path}")

    with config_path.open("r", encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or {}

    title = str(raw.get("title") or config_path.stem)
    output = raw.get("output")
    if not isinstance(output, str) or not output.strip():
        raise SystemExit(f"Config {config_path} must define a non-empty 'output'")

    window = raw.get("window") or {}
    width = int(window.get("width", 960))
    height = int(window.get("height", 420))

    slider_items = raw.get("sliders")
    if not isinstance(slider_items, list) or not slider_items:
        raise SystemExit(f"Config {config_path} must define a non-empty 'sliders' list")

    sliders: list[SliderConfig] = []
    for index, item in enumerate(slider_items, start=1):
        if not isinstance(item, dict):
            raise SystemExit(f"Slider #{index} in {config_path} must be a mapping")

        try:
            slider = SliderConfig(
                name=str(item["name"]),
                channel=validate_range(int(item["channel"]), 1, 16, "channel", index),
                control=validate_range(int(item["control"]), 0, 127, "control", index),
                default=validate_range(int(item.get("default", 0)), 0, 127, "default", index),
                minimum=validate_range(int(item.get("min", 0)), 0, 127, "min", index),
                maximum=validate_range(int(item.get("max", 127)), 0, 127, "max", index),
            )
        except KeyError as exc:
            missing = exc.args[0]
            raise SystemExit(f"Slider #{index} in {config_path} is missing '{missing}'") from exc

        if slider.minimum > slider.maximum:
            raise SystemExit(f"Slider #{index} in {config_path} has min greater than max")
        if not slider.minimum <= slider.default <= slider.maximum:
            raise SystemExit(
                f"Slider #{index} in {config_path} has default outside min/max range"
            )
        sliders.append(slider)

    return AppConfig(
        title=title,
        output=output.strip(),
        sliders=sliders,
        width=width,
        height=height,
    )


def validate_range(value: int, minimum: int, maximum: int, field: str, index: int) -> int:
    if minimum <= value <= maximum:
        return value
    raise SystemExit(f"Slider #{index} field '{field}' must be between {minimum} and {maximum}")


def load_state(state_path: Path) -> dict[str, int]:
    if not state_path.exists():
        return {}

    try:
        with state_path.open("r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}

    state: dict[str, int] = {}
    for key, value in raw.items():
        if isinstance(value, int) and 0 <= value <= 127:
            state[key] = value
    return state


class RuntimeState:
    def __init__(self, *, config_path: Path, state_path: Path) -> None:
        self.config_path = config_path
        self.state_path = state_path
        self.lock = Lock()
        self._file_mtime_ns = -1
        self._version = 1
        self._last_reload_error: str | None = None

        config = load_config(config_path)
        midi_out = self._open_midi_output(config.output)
        self._config = config
        self._midi_out = midi_out
        self._state = load_state(state_path)
        self._reconcile_state()
        self._file_mtime_ns = self._read_mtime_ns()

    def close(self) -> None:
        with self.lock:
            self._midi_out.close()

    def current_config(self) -> AppConfig:
        self.reload_if_needed()
        with self.lock:
            return self._config

    def version(self) -> int:
        self.reload_if_needed()
        with self.lock:
            return self._version

    def get_slider_value(self, slider: SliderConfig) -> int:
        self.reload_if_needed()
        with self.lock:
            return self._state.get(slider.state_key, slider.default)

    def update_slider_by_key(self, state_key: str, value: int) -> SliderConfig:
        self.reload_if_needed()
        with self.lock:
            slider = next(
                (item for item in self._config.sliders if item.state_key == state_key),
                None,
            )
            if slider is None:
                raise ValueError(f"Unknown slider key: {state_key}")
            self._update_slider_locked(slider, value)
            return slider

    def send_all_states(self) -> None:
        self.reload_if_needed()
        with self.lock:
            for slider in self._config.sliders:
                self._update_slider_locked(
                    slider, self._state.get(slider.state_key, slider.default)
                )

    def reload_if_needed(self) -> bool:
        try:
            current_mtime_ns = self._read_mtime_ns()
        except FileNotFoundError:
            return False

        with self.lock:
            if current_mtime_ns == self._file_mtime_ns:
                return False

        try:
            new_config = load_config(self.config_path)
        except SystemExit as exc:
            self._last_reload_error = str(exc)
            print(f"Config reload failed: {exc}")
            return False

        new_midi_out = None
        with self.lock:
            old_config = self._config
            if new_config.output != old_config.output:
                try:
                    new_midi_out = self._open_midi_output(new_config.output)
                except SystemExit as exc:
                    self._last_reload_error = str(exc)
                    print(f"Config reload failed: {exc}")
                    return False

            old_midi_out = self._midi_out
            if new_midi_out is not None:
                self._midi_out = new_midi_out
            self._config = new_config
            self._reconcile_state()
            self._file_mtime_ns = current_mtime_ns
            self._version += 1
            self._last_reload_error = None
            for slider in self._config.sliders:
                self._update_slider_locked(
                    slider, self._state.get(slider.state_key, slider.default)
                )

        if new_midi_out is not None:
            old_midi_out.close()
        return True

    def _reconcile_state(self) -> None:
        live_state: dict[str, int] = {}
        for slider in self._config.sliders:
            value = self._state.get(slider.state_key, slider.default)
            live_state[slider.state_key] = max(slider.minimum, min(slider.maximum, value))
        self._state = live_state
        self._save_state_locked()

    def _update_slider_locked(self, slider: SliderConfig, value: int) -> None:
        bounded = max(slider.minimum, min(slider.maximum, value))
        self._state[slider.state_key] = bounded
        self._save_state_locked()
        message = mido.Message(
            "control_change",
            channel=slider.channel - 1,
            control=slider.control,
            value=bounded,
        )
        self._midi_out.send(message)

    def _save_state_locked(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        with self.state_path.open("w", encoding="utf-8") as handle:
            json.dump(self._state, handle, indent=2, sort_keys=True)

    def _open_midi_output(self, output_name: str) -> mido.ports.BaseOutput:
        try:
            return mido.open_output(output_name)
        except OSError as exc:
            available = ", ".join(mido.get_output_names()) or "none"
            raise SystemExit(
                f"Could not open MIDI output '{output_name}'. "
                f"Available outputs: {available}"
            ) from exc

    def _read_mtime_ns(self) -> int:
        return self.config_path.stat().st_mtime_ns

    @staticmethod
    def format_slider_label(slider: SliderConfig, value: int) -> str:
        return f"{slider.name}: {value}"


class MidiControllerTkApp:
    def __init__(self, *, root: tk.Tk, runtime: RuntimeState) -> None:
        self.root = root
        self.runtime = runtime
        self.container = ttk.Frame(self.root, padding=16)
        self.container.pack(fill="both", expand=True)
        self.variables: dict[str, tk.IntVar] = {}
        self.label_variables: dict[str, tk.StringVar] = {}
        self.content_frame: ttk.Frame | None = None
        self.render()
        self.schedule_reload_check()

    def render(self) -> None:
        config = self.runtime.current_config()
        self.root.title(config.title)
        self.root.geometry(f"{config.width}x{config.height}")
        self.root.minsize(600, 280)

        if self.content_frame is not None:
            self.content_frame.destroy()

        self.content_frame = ttk.Frame(self.container)
        self.content_frame.pack(fill="both", expand=True)
        self.variables = {}
        self.label_variables = {}

        title = ttk.Label(self.content_frame, text=config.title, font=("Helvetica", 20, "bold"))
        title.pack(anchor="w", pady=(0, 12))

        sliders_frame = ttk.Frame(self.content_frame)
        sliders_frame.pack(fill="both", expand=True)
        sliders_frame.columnconfigure(0, weight=1)

        for row, slider in enumerate(config.sliders):
            current_value = self.runtime.get_slider_value(slider)
            value_var = tk.IntVar(value=current_value)
            self.variables[slider.state_key] = value_var
            label_var = tk.StringVar(
                value=self.runtime.format_slider_label(slider, current_value)
            )
            self.label_variables[slider.state_key] = label_var

            card = ttk.Frame(sliders_frame, padding=(12, 10))
            card.grid(row=row, column=0, sticky="ew", pady=6)
            card.columnconfigure(0, weight=1)

            header = ttk.Frame(card)
            header.grid(row=0, column=0, sticky="ew", pady=(0, 8))
            header.columnconfigure(0, weight=1)

            label = ttk.Label(header, textvariable=label_var, anchor="w", font=("Helvetica", 13))
            label.grid(row=0, column=0, sticky="w")

            meta = ttk.Label(
                header,
                text=f"CH {slider.channel}  CC {slider.control}",
                foreground="#666666",
            )
            meta.grid(row=0, column=1, sticky="e")

            scale = tk.Scale(
                card,
                from_=slider.minimum,
                to=slider.maximum,
                orient=tk.HORIZONTAL,
                variable=value_var,
                resolution=1,
                showvalue=False,
                command=lambda raw, slider=slider: self.on_slider_change(slider, raw),
                length=720,
                sliderlength=28,
                width=24,
            )
            scale.grid(row=1, column=0, sticky="ew")

    def on_slider_change(self, slider: SliderConfig, raw_value: Any) -> None:
        value = int(float(raw_value))
        self.runtime.update_slider_by_key(slider.state_key, value)
        self.label_variables[slider.state_key].set(
            self.runtime.format_slider_label(slider, value)
        )

    def schedule_reload_check(self) -> None:
        if self.runtime.reload_if_needed():
            self.render()
        self.root.after(RELOAD_POLL_MS, self.schedule_reload_check)
