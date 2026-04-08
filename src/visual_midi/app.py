from __future__ import annotations

import argparse
import base64
import errno
import io
import json
import math
import mimetypes
import re
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
from pythonosc.udp_client import SimpleUDPClient


STATE_DIR = Path.home() / ".visual-midi" / "states"
CONFIG_DIR = Path.cwd() / "configs"
STATIC_DIR = Path(__file__).with_name("web")
DEFAULT_WEB_PORT = 8765
RELOAD_POLL_MS = 1000
SIZE_PATTERN = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(%|px)\s*$")


@dataclass(frozen=True)
class SizeSpec:
    value: float
    unit: str


@dataclass(frozen=True)
class SliderConfig:
    name: str
    channel: int
    control: int
    default: int = 0
    minimum: int = 0
    maximum: int = 127
    speed: float = 1.0
    orientation: str = "vertical"
    color: str = "#d26a2e"
    width: SizeSpec | None = None
    height: SizeSpec | None = None
    osc: "OscRouteConfig | None" = None

    @property
    def state_key(self) -> str:
        return f"ch{self.channel}:cc{self.control}:{self.name}"


@dataclass(frozen=True)
class GroupConfig:
    kind: str
    children: list["LayoutNode"]
    width: SizeSpec | None = None
    height: SizeSpec | None = None


LayoutNode = Union[SliderConfig, GroupConfig]


@dataclass(frozen=True)
class AppConfig:
    title: str | None
    output: str
    inertia: float
    layout: GroupConfig
    sliders: list[SliderConfig]
    osc: "OscOutputConfig | None" = None


@dataclass(frozen=True)
class OscOutputConfig:
    host: str
    port: int


@dataclass(frozen=True)
class OscRouteConfig:
    path: str
    minimum: float = 0.0
    maximum: float = 1.0


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
    print(f"Serving {runtime.current_config().title or 'visual-midi'} at {browser_url}")
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
                query = parse_qs(parsed.query, keep_blank_values=True)
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
                value = float(body["value"])
                updated = runtime.update_slider_by_key(state_key, value)
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
                self.send_error(HTTPStatus.BAD_REQUEST, str(exc))
                return

            payload = json.dumps(
                {
                    "key": updated.state_key,
                    "value": normalize_numeric_value(runtime.get_slider_value(updated)),
                }
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
            self.send_header("Cache-Control", "no-store, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
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

    raw_title = raw.get("title")
    if raw_title is None:
        title = None
    elif isinstance(raw_title, str):
        title = raw_title.strip() or None
    else:
        raise SystemExit(f"Config {config_path} title must be a string if provided")
    output = raw.get("output")
    if not isinstance(output, str) or not output.strip():
        raise SystemExit(f"Config {config_path} must define a non-empty 'output'")
    inertia = parse_inertia(raw.get("inertia", 1.0), config_path=config_path, path="inertia")
    osc = parse_osc_output(raw.get("osc"), config_path=config_path)

    palette = parse_palette(raw.get("palette"), config_path=config_path)
    layout = parse_root_layout(raw=raw, config_path=config_path, palette=palette)
    sliders = collect_sliders(layout)
    if not sliders:
        raise SystemExit(f"Config {config_path} must contain at least one slider")
    if any(slider.osc is not None for slider in sliders) and osc is None:
        raise SystemExit(
            f"Config {config_path} defines slider osc routes but is missing the root 'osc' output"
        )

    return AppConfig(
        title=title,
        output=output.strip(),
        inertia=inertia,
        layout=layout,
        sliders=sliders,
        osc=osc,
    )


def parse_palette(raw: Any, *, config_path: Path) -> dict[str, str]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise SystemExit(f"Config {config_path} palette must be a mapping of names to colors")

    palette: dict[str, str] = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not key.strip():
            raise SystemExit(f"Config {config_path} palette keys must be non-empty strings")
        if not isinstance(value, str) or not value.strip():
            raise SystemExit(f"Config {config_path} palette value for '{key}' must be a non-empty string")
        palette[key.strip()] = value.strip()
    return palette


def parse_osc_output(raw: Any, *, config_path: Path) -> OscOutputConfig | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise SystemExit(f"Config {config_path} osc must be a mapping")

    host = raw.get("host")
    if not isinstance(host, str) or not host.strip():
        raise SystemExit(f"Config {config_path} osc.host must be a non-empty string")

    try:
        port = int(raw.get("port"))
    except (TypeError, ValueError) as exc:
        raise SystemExit(f"Config {config_path} osc.port must be an integer") from exc

    return OscOutputConfig(
        host=host.strip(),
        port=validate_range(port, 1, 65535, "osc.port", config_path),
    )


def parse_root_layout(
    *, raw: dict[str, Any], config_path: Path, palette: dict[str, str]
) -> GroupConfig:
    container_keys = [key for key in ("rows", "columns") if key in raw]
    if len(container_keys) != 1:
        raise SystemExit(f"Config {config_path} must define exactly one of 'rows' or 'columns'")
    key = container_keys[0]
    return parse_group(
        kind="row" if key == "rows" else "column",
        children_raw=raw[key],
        config_path=config_path,
        path=key,
        raw=raw,
        palette=palette,
    )


def parse_group(
    *,
    kind: str,
    children_raw: Any,
    config_path: Path,
    path: str,
    raw: dict[str, Any],
    palette: dict[str, str],
) -> GroupConfig:
    if not isinstance(children_raw, list) or not children_raw:
        raise SystemExit(f"{config_path} {path} must be a non-empty list")

    children: list[LayoutNode] = []
    for index, item in enumerate(children_raw):
        child_path = f"{path}[{index}]"
        if not isinstance(item, dict):
            raise SystemExit(f"{config_path} {child_path} must be a mapping")

        child_container_keys = [key for key in ("rows", "columns") if key in item]
        if len(child_container_keys) > 1:
            raise SystemExit(
                f"{config_path} {child_path} must not define both 'rows' and 'columns'"
            )

        if child_container_keys:
            child_key = child_container_keys[0]
            children.append(
                parse_group(
                    kind="row" if child_key == "rows" else "column",
                    children_raw=item[child_key],
                    config_path=config_path,
                    path=f"{child_path}.{child_key}",
                    raw=item,
                    palette=palette,
                )
            )
        else:
            children.append(
                parse_slider(item, config_path=config_path, path=child_path, palette=palette)
            )

    return GroupConfig(
        kind=kind,
        children=children,
        width=parse_size(raw.get("width"), config_path=config_path, path=f"{path}.width"),
        height=parse_size(raw.get("height"), config_path=config_path, path=f"{path}.height"),
    )


def parse_slider(
    raw: dict[str, Any], *, config_path: Path, path: str, palette: dict[str, str]
) -> SliderConfig:
    try:
        slider = SliderConfig(
            name=str(raw["name"]),
            channel=validate_range(int(raw["channel"]), 1, 16, f"{path}.channel", config_path),
            control=validate_range(int(raw["control"]), 0, 127, f"{path}.control", config_path),
            default=validate_range(int(raw.get("default", 0)), 0, 127, f"{path}.default", config_path),
            minimum=validate_range(int(raw.get("min", 0)), 0, 127, f"{path}.min", config_path),
            maximum=validate_range(int(raw.get("max", 127)), 0, 127, f"{path}.max", config_path),
            speed=parse_speed(
                raw.get("speed", 1.0), config_path=config_path, path=f"{path}.speed"
            ),
            orientation=str(raw.get("orientation", "vertical")),
            color=resolve_color(raw.get("color", "#d26a2e"), palette=palette, config_path=config_path, path=f"{path}.color"),
            width=parse_size(raw.get("width"), config_path=config_path, path=f"{path}.width"),
            height=parse_size(raw.get("height"), config_path=config_path, path=f"{path}.height"),
            osc=parse_osc_route(raw.get("osc"), config_path=config_path, path=f"{path}.osc"),
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


def parse_osc_route(raw: Any, *, config_path: Path, path: str) -> OscRouteConfig | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise SystemExit(f"{config_path} {path} must be a mapping")

    osc_path = raw.get("path")
    if not isinstance(osc_path, str) or not osc_path.strip():
        raise SystemExit(f"{config_path} {path}.path must be a non-empty string")

    minimum = parse_numeric_value(raw.get("min", 0.0), config_path=config_path, path=f"{path}.min")
    maximum = parse_numeric_value(raw.get("max", 1.0), config_path=config_path, path=f"{path}.max")
    if minimum > maximum:
        raise SystemExit(f"{config_path} {path} has min greater than max")

    return OscRouteConfig(path=osc_path.strip(), minimum=minimum, maximum=maximum)


def resolve_color(
    raw: Any, *, palette: dict[str, str], config_path: Path, path: str
) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise SystemExit(f"{config_path} {path} must be a non-empty color string")
    color = raw.strip()
    return palette.get(color, color)


def parse_inertia(raw: Any, *, config_path: Path, path: str) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise SystemExit(f"{config_path} {path} must be a number") from exc
    if value < 0:
        raise SystemExit(f"{config_path} {path} must be 0 or greater")
    return value


def parse_speed(raw: Any, *, config_path: Path, path: str) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise SystemExit(f"{config_path} {path} must be a number") from exc
    if value <= 0:
        raise SystemExit(f"{config_path} {path} must be greater than 0")
    return value


def parse_numeric_value(raw: Any, *, config_path: Path, path: str) -> float:
    try:
        return float(raw)
    except (TypeError, ValueError) as exc:
        raise SystemExit(f"{config_path} {path} must be a number") from exc


def parse_size(value: Any, *, config_path: Path, path: str) -> SizeSpec | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return SizeSpec(value=float(value), unit="px")
    if not isinstance(value, str):
        raise SystemExit(f"{config_path} {path} must be a string like '70%' or '240px'")

    match = SIZE_PATTERN.match(value)
    if match is None:
        raise SystemExit(f"{config_path} {path} must be a string like '70%' or '240px'")
    return SizeSpec(value=float(match.group(1)), unit=match.group(2))


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


def load_state(state_path: Path) -> dict[str, float]:
    if not state_path.exists():
        return {}

    try:
        with state_path.open("r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}

    state: dict[str, float] = {}
    for key, value in raw.items():
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)) and math.isfinite(value):
            state[key] = float(value)
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
        try:
            osc_client = self._open_osc_output(config.osc)
        except SystemExit:
            midi_out.close()
            raise
        self._config = config
        self._midi_out = midi_out
        self._osc_client = osc_client
        self._state = load_state(state_path)
        self._last_midi_values: dict[str, int] = {}
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

    def get_slider_value(self, slider: SliderConfig) -> float:
        self.reload_if_needed()
        with self.lock:
            return self._state.get(slider.state_key, float(slider.default))

    def update_slider_by_key(self, state_key: str, value: float) -> SliderConfig:
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
                self._update_slider_locked(
                    slider, self._state.get(slider.state_key, float(slider.default)), force_midi=True
                )

    def frontend_payload(self, *, hide_qr_panel: bool, port: int) -> dict[str, Any]:
        self.reload_if_needed()
        config = self.current_config()
        lan_ip = detect_local_ip_address()
        base_url = f"http://{lan_ip}:{port}/" if lan_ip else f"http://127.0.0.1:{port}/"
        qr_url = f"{base_url}?noqr"
        return {
            "title": config.title,
            "inertia": config.inertia,
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
        new_osc_client = None
        with self.lock:
            if new_config.output != self._config.output:
                try:
                    new_midi_out = self._open_midi_output(new_config.output)
                except SystemExit as exc:
                    self._last_reload_error = str(exc)
                    print(f"Config reload failed: {exc}")
                    return False

            if new_config.osc != self._config.osc:
                try:
                    new_osc_client = self._open_osc_output(new_config.osc)
                except SystemExit as exc:
                    if new_midi_out is not None:
                        new_midi_out.close()
                    self._last_reload_error = str(exc)
                    print(f"Config reload failed: {exc}")
                    return False

            old_midi_out = self._midi_out
            if new_midi_out is not None:
                self._midi_out = new_midi_out
            if new_osc_client is not None or new_config.osc is None:
                self._osc_client = new_osc_client
            self._config = new_config
            if new_midi_out is not None:
                self._last_midi_values = {}
            self._sliders_by_key = {slider.state_key: slider for slider in new_config.sliders}
            self._reconcile_state()
            self._file_mtime_ns = current_mtime_ns
            self._version += 1
            self._last_reload_error = None
            for slider in self._config.sliders:
                self._update_slider_locked(
                    slider,
                    self._state.get(slider.state_key, float(slider.default)),
                    force_midi=True,
                )

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
                "speed": normalize_numeric_value(node.speed),
                "orientation": node.orientation,
                "color": node.color,
                "width": serialize_size(node.width),
                "height": serialize_size(node.height),
                "osc": serialize_osc_route(node.osc),
                "label": self.format_slider_label(node, value),
            }

        return {
            "type": "rows" if node.kind == "row" else "columns",
            "width": serialize_size(node.width),
            "height": serialize_size(node.height),
            "children": [self._serialize_layout(child) for child in node.children],
        }

    def _reconcile_state(self) -> None:
        live_state: dict[str, float] = {}
        for slider in self._config.sliders:
            value = self._state.get(slider.state_key, float(slider.default))
            live_state[slider.state_key] = clamp_numeric_value(
                value, minimum=slider.minimum, maximum=slider.maximum
            )
        self._state = live_state
        self._save_state_locked()

    def _update_slider_locked(self, slider: SliderConfig, value: float, *, force_midi: bool = False) -> None:
        bounded = clamp_numeric_value(value, minimum=slider.minimum, maximum=slider.maximum)
        self._state[slider.state_key] = bounded
        self._save_state_locked()
        self._send_midi_value(slider, bounded, force=force_midi)
        self._send_osc_value(slider, bounded)

    def _save_state_locked(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        with self.state_path.open("w", encoding="utf-8") as handle:
            json.dump(
                {key: normalize_numeric_value(value) for key, value in self._state.items()},
                handle,
                indent=2,
                sort_keys=True,
            )

    def _open_midi_output(self, output_name: str) -> mido.ports.BaseOutput:
        try:
            return mido.open_output(output_name)
        except OSError as exc:
            available = ", ".join(mido.get_output_names()) or "none"
            raise SystemExit(
                f"Could not open MIDI output '{output_name}'. Available outputs: {available}"
            ) from exc

    def _send_midi_value(self, slider: SliderConfig, value: float, *, force: bool = False) -> None:
        midi_value = clamp_numeric_value(round(value), minimum=0, maximum=127)
        midi_value = int(midi_value)
        previous_value = self._last_midi_values.get(slider.state_key)
        if not force and previous_value == midi_value:
            return
        message = mido.Message(
            "control_change",
            channel=slider.channel - 1,
            control=slider.control,
            value=midi_value,
        )
        self._midi_out.send(message)
        self._last_midi_values[slider.state_key] = midi_value

    def _open_osc_output(self, osc_config: OscOutputConfig | None) -> SimpleUDPClient | None:
        if osc_config is None:
            return None
        try:
            return SimpleUDPClient(osc_config.host, osc_config.port)
        except OSError as exc:
            raise SystemExit(
                f"Could not open OSC output '{osc_config.host}:{osc_config.port}'"
            ) from exc

    def _send_osc_value(self, slider: SliderConfig, value: float) -> None:
        if slider.osc is None or self._osc_client is None:
            return
        osc_value = map_value(
            value,
            input_min=slider.minimum,
            input_max=slider.maximum,
            output_min=slider.osc.minimum,
            output_max=slider.osc.maximum,
        )
        self._osc_client.send_message(slider.osc.path, normalize_numeric_value(osc_value))

    def _read_mtime_ns(self) -> int:
        return self.config_path.stat().st_mtime_ns

    @staticmethod
    def format_slider_label(slider: SliderConfig, value: float) -> str:
        return f"{slider.name}: {normalize_numeric_value(value)}"


def serialize_size(size: SizeSpec | None) -> str | None:
    if size is None:
        return None
    if size.unit == "px":
        return f"{int(size.value)}px"
    if size.value.is_integer():
        return f"{int(size.value)}%"
    return f"{size.value}%"


def serialize_osc_route(route: OscRouteConfig | None) -> dict[str, Any] | None:
    if route is None:
        return None
    return {
        "path": route.path,
        "min": normalize_numeric_value(route.minimum),
        "max": normalize_numeric_value(route.maximum),
    }


def map_value(
    value: float, *, input_min: float, input_max: float, output_min: float, output_max: float
) -> float:
    if input_max == input_min:
        return output_min
    ratio = (value - input_min) / (input_max - input_min)
    return output_min + (ratio * (output_max - output_min))


def clamp_numeric_value(value: float, *, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


def normalize_numeric_value(value: float) -> int | float:
    if float(value).is_integer():
        return int(value)
    return value
