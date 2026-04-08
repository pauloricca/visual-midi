from __future__ import annotations

import argparse
import base64
import errno
import io
import json
import mimetypes
import socket
import webbrowser
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from typing import Any, Union
from urllib.parse import parse_qs, urlparse

import mido
import qrcode
import yaml


STATE_DIR = Path.home() / ".visual-midi" / "states"
CONFIG_DIR = Path.cwd() / "configs"
STATIC_DIR = Path(__file__).with_name("web")
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
    orientation: str = "horizontal"
    color: str = "#d26a2e"
    width: int | None = None
    height: int | None = None

    @property
    def state_key(self) -> str:
        return f"ch{self.channel}:cc{self.control}:{self.name}"


@dataclass(frozen=True)
class GroupConfig:
    kind: str
    gap: int
    children: list["LayoutNode"]


LayoutNode = Union[SliderConfig, GroupConfig]


@dataclass(frozen=True)
class AppConfig:
    title: str
    output: str
    layout: GroupConfig
    sliders: list[SliderConfig]


def main() -> None:
    args = parse_args()
    profile = args.config_name
    config_path = CONFIG_DIR / f"{profile}.yaml"
    state_path = STATE_DIR / f"{profile}.json"

    runtime = RuntimeState(config_path=config_path, state_path=state_path)
    runtime.send_all_states()

    try:
        run_web_app(runtime=runtime)
    finally:
        runtime.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="visual-midi",
        description="Run the web-based MIDI controller for a YAML config.",
    )
    parser.add_argument("config_name", help="YAML config name without the .yaml suffix")
    return parser.parse_args()


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
            parsed = urlparse(self.path)

            if parsed.path == "/api/config":
                query = parse_qs(parsed.query)
                hide_qr_panel = "noqr" in query
                payload = json.dumps(
                    runtime.frontend_payload(
                        hide_qr_panel=hide_qr_panel,
                        port=self.server.server_address[1],
                    )
                ).encode("utf-8")
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return

            if parsed.path == "/api/version":
                payload = json.dumps({"version": runtime.version()}).encode("utf-8")
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return

            if parsed.path == "/" or parsed.path == "/index.html":
                self.serve_static_file("index.html")
                return

            if parsed.path.startswith("/assets/"):
                self.serve_static_file(parsed.path.removeprefix("/assets/"))
                return

            self.send_error(HTTPStatus.NOT_FOUND, "Not found")

        def do_POST(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path != "/api/slider":
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

        def serve_static_file(self, relative_path: str) -> None:
            file_path = (STATIC_DIR / relative_path).resolve()
            if not str(file_path).startswith(str(STATIC_DIR.resolve())) or not file_path.exists():
                self.send_error(HTTPStatus.NOT_FOUND, "Not found")
                return

            payload = file_path.read_bytes()
            content_type, _ = mimetypes.guess_type(file_path.name)
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type or "application/octet-stream")
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

    if isinstance(raw.get("layout"), dict):
        layout = parse_group(config_path=config_path, path="layout", raw=raw["layout"])
    else:
        slider_items = raw.get("sliders")
        if not isinstance(slider_items, list) or not slider_items:
            raise SystemExit(
                f"Config {config_path} must define either 'layout' or a non-empty 'sliders' list"
            )
        layout = GroupConfig(
            kind="column",
            gap=12,
            children=[
                parse_slider(item, config_path=config_path, path=f"sliders[{index}]")
                for index, item in enumerate(slider_items)
            ],
        )

    sliders = collect_sliders(layout)
    if not sliders:
        raise SystemExit(f"Config {config_path} must contain at least one slider")

    return AppConfig(title=title, output=output.strip(), layout=layout, sliders=sliders)


def parse_group(*, config_path: Path, path: str, raw: dict[str, Any]) -> GroupConfig:
    kind = str(raw.get("type", "column"))
    if kind not in {"row", "column"}:
        raise SystemExit(f"{config_path} {path}.type must be 'row' or 'column'")

    gap = int(raw.get("gap", 12))
    children_raw = raw.get("children")
    if not isinstance(children_raw, list) or not children_raw:
        raise SystemExit(f"{config_path} {path}.children must be a non-empty list")

    children: list[LayoutNode] = []
    for index, item in enumerate(children_raw):
        child_path = f"{path}.children[{index}]"
        if not isinstance(item, dict):
            raise SystemExit(f"{config_path} {child_path} must be a mapping")
        child_type = item.get("type", "slider")
        if child_type in {"row", "column"}:
            children.append(parse_group(config_path=config_path, path=child_path, raw=item))
        else:
            children.append(parse_slider(item, config_path=config_path, path=child_path))
    return GroupConfig(kind=kind, gap=gap, children=children)


def parse_slider(raw: dict[str, Any], *, config_path: Path, path: str) -> SliderConfig:
    try:
        slider = SliderConfig(
            name=str(raw["name"]),
            channel=validate_range(int(raw["channel"]), 1, 16, f"{path}.channel", config_path),
            control=validate_range(int(raw["control"]), 0, 127, f"{path}.control", config_path),
            default=validate_range(int(raw.get("default", 0)), 0, 127, f"{path}.default", config_path),
            minimum=validate_range(int(raw.get("min", 0)), 0, 127, f"{path}.min", config_path),
            maximum=validate_range(int(raw.get("max", 127)), 0, 127, f"{path}.max", config_path),
            orientation=str(raw.get("orientation", "horizontal")),
            color=str(raw.get("color", "#d26a2e")),
            width=int(raw["width"]) if "width" in raw else None,
            height=int(raw["height"]) if "height" in raw else None,
        )
    except KeyError as exc:
        missing = exc.args[0]
        raise SystemExit(f"{config_path} {path} is missing '{missing}'") from exc

    if slider.minimum > slider.maximum:
        raise SystemExit(f"{config_path} {path} has min greater than max")
    if not slider.minimum <= slider.default <= slider.maximum:
        raise SystemExit(f"{config_path} {path} has default outside min/max range")
    if slider.orientation not in {"horizontal", "vertical"}:
        raise SystemExit(f"{config_path} {path}.orientation must be 'horizontal' or 'vertical'")
    return slider


def collect_sliders(node: LayoutNode) -> list[SliderConfig]:
    if isinstance(node, SliderConfig):
        return [node]

    sliders: list[SliderConfig] = []
    for child in node.children:
        sliders.extend(collect_sliders(child))
    return sliders


def validate_range(value: int, minimum: int, maximum: int, field: str, config_path: Path) -> int:
    if minimum <= value <= maximum:
        return value
    raise SystemExit(f"{config_path} {field} must be between {minimum} and {maximum}")


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
        self._sliders_by_key = {slider.state_key: slider for slider in config.sliders}
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
            slider = self._sliders_by_key.get(state_key)
            if slider is None:
                raise ValueError(f"Unknown slider key: {state_key}")
            self._update_slider_locked(slider, value)
            return slider

    def send_all_states(self) -> None:
        self.reload_if_needed()
        with self.lock:
            for slider in self._config.sliders:
                self._update_slider_locked(slider, self._state.get(slider.state_key, slider.default))

    def frontend_payload(self, *, hide_qr_panel: bool, port: int) -> dict[str, Any]:
        self.reload_if_needed()
        config = self.current_config()
        lan_ip = detect_local_ip_address()
        base_url = f"http://{lan_ip}:{port}/" if lan_ip else f"http://127.0.0.1:{port}/"
        qr_url = f"{base_url}?noqr"
        return {
            "title": config.title,
            "version": self.version(),
            "layout": self._serialize_layout(config.layout),
            "showQrPanel": not hide_qr_panel,
            "qr": {
                "url": qr_url,
                "image": generate_qr_code_data_url(qr_url),
            },
            "reloadPollMs": RELOAD_POLL_MS,
        }

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
            if new_config.output != self._config.output:
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
            self._sliders_by_key = {slider.state_key: slider for slider in new_config.sliders}
            self._reconcile_state()
            self._file_mtime_ns = current_mtime_ns
            self._version += 1
            self._last_reload_error = None
            for slider in self._config.sliders:
                self._update_slider_locked(slider, self._state.get(slider.state_key, slider.default))

        if new_midi_out is not None:
            old_midi_out.close()
        return True

    def _serialize_layout(self, node: LayoutNode) -> dict[str, Any]:
        if isinstance(node, SliderConfig):
            value = self.get_slider_value(node)
            return {
                "type": "slider",
                "key": node.state_key,
                "name": node.name,
                "value": value,
                "channel": node.channel,
                "control": node.control,
                "min": node.minimum,
                "max": node.maximum,
                "orientation": node.orientation,
                "color": node.color,
                "width": node.width,
                "height": node.height,
                "label": self.format_slider_label(node, value),
            }

        return {
            "type": node.kind,
            "gap": node.gap,
            "children": [self._serialize_layout(child) for child in node.children],
        }

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
                f"Could not open MIDI output '{output_name}'. Available outputs: {available}"
            ) from exc

    def _read_mtime_ns(self) -> int:
        return self.config_path.stat().st_mtime_ns

    @staticmethod
    def format_slider_label(slider: SliderConfig, value: int) -> str:
        return f"{slider.name}: {value}"
