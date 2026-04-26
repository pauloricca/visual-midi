from __future__ import annotations

import argparse
import base64
import errno
import io
import json
import math
import mimetypes
import random
import re
import socket
import time
import webbrowser
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Condition, Lock, Thread
from typing import Any, Callable, Union
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
NOTE_PATTERN = re.compile(r"^\s*([A-Ga-g])([#b]*)(-?\d+)\s*$")
NOTE_BASES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
SUBDIVISION_PATTERN = re.compile(r"^\s*(\d+)\s*/\s*(\d+)\s*$")
LFO_WAVEFORMS = ("sine", "triangle", "square", "saw", "ramp", "random", "s&h")
LFO_SHAPE_CONTROLS = ("waveform", "jitter")
SCALE_PATTERNS = {
    "major": (0, 2, 4, 5, 7, 9, 11),
    "ionian": (0, 2, 4, 5, 7, 9, 11),
    "natural_minor": (0, 2, 3, 5, 7, 8, 10),
    "minor": (0, 2, 3, 5, 7, 8, 10),
    "aeolian": (0, 2, 3, 5, 7, 8, 10),
    "harmonic_minor": (0, 2, 3, 5, 7, 8, 11),
    "melodic_minor": (0, 2, 3, 5, 7, 9, 11),
    "dorian": (0, 2, 3, 5, 7, 9, 10),
    "phrygian": (0, 1, 3, 5, 7, 8, 10),
    "lydian": (0, 2, 4, 6, 7, 9, 11),
    "mixolydian": (0, 2, 4, 5, 7, 9, 10),
    "locrian": (0, 1, 3, 5, 6, 8, 10),
    "major_pentatonic": (0, 2, 4, 7, 9),
    "minor_pentatonic": (0, 3, 5, 7, 10),
    "blues": (0, 3, 5, 6, 7, 10),
    "chromatic": (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11),
    "whole_tone": (0, 2, 4, 6, 8, 10),
    "diminished_half_whole": (0, 1, 3, 4, 6, 7, 9, 10),
    "diminished_whole_half": (0, 2, 3, 5, 6, 8, 9, 11),
}


@dataclass(frozen=True)
class SizeSpec:
    value: float
    unit: str


@dataclass(frozen=True)
class LayoutDefaults:
    output: str = ""
    channel: int = 1
    default: int = 0
    minimum: int = 0
    maximum: int = 127
    steps: int | None = None
    speed: float = 1.0
    curve: float = 0.0
    quantize_speed_to_tempo_divisions: bool = False
    orientation: str = "vertical"
    color: str = "#d26a2e"
    show_label: bool = True


@dataclass(frozen=True)
class SliderConfig:
    name: str
    output: str
    channel: int
    control: int
    control_type: str = "slider"
    complex: bool = False
    max_speed: float = 12.0
    quantize_speed_to_tempo_divisions: bool = False
    lfo_waveforms: tuple[str, ...] = LFO_WAVEFORMS
    lfo_shape_control: str = "waveform"
    default: int = 0
    minimum: int = 0
    maximum: int = 127
    steps: int | None = None
    speed: float = 1.0
    curve: float = 0.0
    orientation: str = "vertical"
    color: str = "#d26a2e"
    show_label: bool = True
    width: SizeSpec | None = None
    height: SizeSpec | None = None
    osc: "OscRouteConfig | None" = None

    @property
    def state_key(self) -> str:
        return f"ch{self.channel}:cc{self.control}:{self.name}"


@dataclass(frozen=True)
class KeyboardConfig:
    name: str
    output: str
    channel: int
    start: int = 60
    size: int = 12
    scale: str | None = None
    root: int | None = None
    color: str = "#d26a2e"
    show_label: bool = True
    width: SizeSpec | None = None
    height: SizeSpec | None = None

    @property
    def state_key(self) -> str:
        return f"keyboard:{self.channel}:{self.start}:{self.size}:{self.name}"


@dataclass(frozen=True)
class ButtonConfig:
    name: str
    output: str
    channel: int
    control: int
    color: str = "#d26a2e"
    show_label: bool = True
    width: SizeSpec | None = None
    height: SizeSpec | None = None
    osc: "OscRouteConfig | None" = None

    @property
    def state_key(self) -> str:
        return f"ch{self.channel}:cc{self.control}:{self.name}"


@dataclass(frozen=True)
class CurveConfig:
    name: str
    output: str
    channel: int
    control: int
    length: float
    mode: str = "loop"
    default: int = 0
    minimum: int = 0
    maximum: int = 127
    color: str = "#d26a2e"
    show_label: bool = True
    width: SizeSpec | None = None
    height: SizeSpec | None = None
    osc: "OscRouteConfig | None" = None

    @property
    def state_key(self) -> str:
        return f"curve:ch{self.channel}:cc{self.control}:{self.name}"


@dataclass(frozen=True)
class TempoConfig:
    name: str
    output: str
    default: float = 120.0
    minimum: float = 20.0
    maximum: float = 300.0
    color: str = "#d26a2e"
    show_label: bool = True
    width: SizeSpec | None = None
    height: SizeSpec | None = None

    @property
    def state_key(self) -> str:
        return f"tempo:{self.name}"


@dataclass(frozen=True)
class SequencerConfig:
    name: str
    output: str
    mode: str
    size: int
    subdivision_label: str
    subdivision_beats: float
    channel: int
    control: int | None = None
    minimum: int = 0
    maximum: int = 127
    root: int | None = None
    scale: str | None = None
    velocity_row: bool = False
    gate_row: bool = False
    timing_row: bool = False
    default_velocity: int = 127
    default_gate: float = 1.0
    default_timing: float = 0.0
    max_gate_steps: float = 1.0
    color: str = "#d26a2e"
    show_label: bool = True
    width: SizeSpec | None = None
    height: SizeSpec | None = None
    osc: "OscRouteConfig | None" = None

    @property
    def state_key(self) -> str:
        return f"sequencer:{self.name}"

    @property
    def ticks_per_step(self) -> float:
        return self.subdivision_beats * 24.0


@dataclass(frozen=True)
class GroupConfig:
    kind: str
    children: list["LayoutNode"]
    name: str | None = None
    width: SizeSpec | None = None
    height: SizeSpec | None = None


@dataclass(frozen=True)
class TabConfig:
    name: str
    content: "LayoutNode"


@dataclass(frozen=True)
class TabsConfig:
    tabs: list[TabConfig]
    name: str | None = None
    width: SizeSpec | None = None
    height: SizeSpec | None = None


@dataclass(frozen=True)
class MemoryConfig:
    name: str
    target: str
    slots: int
    transition: float = 0.0
    color: str = "#d26a2e"
    show_label: bool = True
    width: SizeSpec | None = None
    height: SizeSpec | None = None

    @property
    def state_key(self) -> str:
        return f"memory:{self.name}"


@dataclass(frozen=True)
class MutatorConfig:
    name: str
    target: str
    default: float = 0.5
    mutate_sequencer_note: bool = True
    mutate_sequencer_step: bool = True
    mutate_sequencer_velocity: bool = True
    mutate_sequencer_gate: bool = True
    mutate_sequencer_timing: bool = True
    color: str = "#d26a2e"
    show_label: bool = True
    width: SizeSpec | None = None
    height: SizeSpec | None = None

    @property
    def state_key(self) -> str:
        return f"mutator:{self.name}"


ControlConfig = Union[
    SliderConfig,
    KeyboardConfig,
    ButtonConfig,
    CurveConfig,
    TempoConfig,
    SequencerConfig,
    MemoryConfig,
    MutatorConfig,
]
LayoutNode = Union[
    SliderConfig,
    KeyboardConfig,
    ButtonConfig,
    CurveConfig,
    TempoConfig,
    SequencerConfig,
    MemoryConfig,
    MutatorConfig,
    GroupConfig,
    TabsConfig,
]


@dataclass(frozen=True)
class AppConfig:
    title: str | None
    output: str
    bpm: float
    inertia: float
    layout: LayoutNode
    sliders: list[SliderConfig]
    curves: list[CurveConfig] | None = None
    tempo: TempoConfig | None = None
    sequencers: list[SequencerConfig] | None = None
    memories: list[MemoryConfig] | None = None
    mutators: list[MutatorConfig] | None = None
    osc: "OscOutputConfig | None" = None


@dataclass
class SequencerStepState:
    enabled: bool
    value: int
    velocity: int = 127
    gate: float = 1.0
    timing: float = 0.0


@dataclass
class ActiveSequencerNote:
    state_key: str
    note: int
    remaining_ticks: int


@dataclass
class ScheduledSequencerNote:
    state_key: str
    note: int
    velocity: int
    gate_ticks: int
    remaining_ticks: int


@dataclass
class MemorySlotState:
    numeric: dict[str, float]
    sequencers: dict[str, list[SequencerStepState]]


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
            if parsed.path == "/api/slider":
                self.handle_slider_post()
                return

            if parsed.path == "/api/curve":
                self.handle_curve_post()
                return

            if parsed.path == "/api/keyboard":
                self.handle_keyboard_post()
                return

            if parsed.path == "/api/button":
                self.handle_button_post()
                return

            if parsed.path == "/api/tempo":
                self.handle_tempo_post()
                return

            if parsed.path == "/api/sequencer":
                self.handle_sequencer_post()
                return

            if parsed.path == "/api/memory":
                self.handle_memory_post()
                return

            if parsed.path == "/api/mutator":
                self.handle_mutator_post()
                return

            if parsed.path == "/api/transport":
                self.handle_transport_post()
                return

            self.send_error(HTTPStatus.NOT_FOUND, "Not found")

        def handle_slider_post(self) -> None:
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

        def handle_curve_post(self) -> None:
            content_length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(content_length)
            try:
                body = json.loads(raw.decode("utf-8"))
                state_key = str(body["key"])
                value = float(body["value"])
                updated = runtime.send_curve_value_by_key(state_key, value)
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
                self.send_error(HTTPStatus.BAD_REQUEST, str(exc))
                return

            payload = json.dumps(
                {
                    "key": updated.state_key,
                    "value": normalize_numeric_value(quantize_curve_value(updated, value)),
                }
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def handle_keyboard_post(self) -> None:
            content_length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(content_length)
            try:
                body = json.loads(raw.decode("utf-8"))
                state_key = str(body["key"])
                note = validate_range(int(body["note"]), 0, 127, "keyboard.note", Path("request"))
                gate = bool(body["gate"])
                runtime.send_keyboard_gate(state_key=state_key, note=note, gate=gate)
            except (json.JSONDecodeError, KeyError, TypeError, ValueError, SystemExit) as exc:
                self.send_error(HTTPStatus.BAD_REQUEST, str(exc))
                return

            payload = json.dumps({"key": state_key, "note": note, "gate": gate}).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def handle_button_post(self) -> None:
            content_length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(content_length)
            try:
                body = json.loads(raw.decode("utf-8"))
                state_key = str(body["key"])
                gate = bool(body["gate"])
                runtime.send_button_gate(state_key=state_key, gate=gate)
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
                self.send_error(HTTPStatus.BAD_REQUEST, str(exc))
                return

            payload = json.dumps({"key": state_key, "gate": gate}).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def handle_tempo_post(self) -> None:
            content_length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(content_length)
            try:
                body = json.loads(raw.decode("utf-8"))
                value = float(body["value"])
                updated = runtime.update_tempo(value)
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
                self.send_error(HTTPStatus.BAD_REQUEST, str(exc))
                return

            payload = json.dumps(
                {
                    "key": updated.state_key,
                    "value": normalize_numeric_value(runtime.get_tempo_value(updated)),
                    "playing": runtime.is_transport_playing(),
                }
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def handle_sequencer_post(self) -> None:
            content_length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(content_length)
            try:
                body = json.loads(raw.decode("utf-8"))
                state_key = str(body["key"])
                raw_steps = body["steps"]
                if not isinstance(raw_steps, list):
                    raise ValueError("steps must be a list")
                sequencer, steps = runtime.update_sequencer_by_key(state_key, raw_steps)
            except (json.JSONDecodeError, KeyError, TypeError, ValueError, SystemExit) as exc:
                self.send_error(HTTPStatus.BAD_REQUEST, str(exc))
                return

            payload = json.dumps(
                {
                    "key": sequencer.state_key,
                    "steps": serialize_sequencer_steps(steps),
                    "currentStep": runtime.get_sequencer_position(sequencer.state_key),
                }
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def handle_transport_post(self) -> None:
            content_length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(content_length)
            try:
                body = json.loads(raw.decode("utf-8"))
                playing = bool(body["playing"])
                runtime.set_transport_playing(playing)
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
                self.send_error(HTTPStatus.BAD_REQUEST, str(exc))
                return

            payload = json.dumps({"playing": runtime.is_transport_playing()}).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def handle_memory_post(self) -> None:
            parsed = urlparse(self.path)
            content_length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(content_length)
            try:
                body = json.loads(raw.decode("utf-8"))
                state_key = str(body["key"])
                slot = int(body["slot"])
                action = str(body["action"])
                runtime.apply_memory_slot(state_key=state_key, slot=slot, action=action)
            except (json.JSONDecodeError, KeyError, TypeError, ValueError, SystemExit) as exc:
                self.send_error(HTTPStatus.BAD_REQUEST, str(exc))
                return

            payload = json.dumps(
                runtime.frontend_payload(
                    hide_qr_panel="noqr" in parse_qs(parsed.query, keep_blank_values=True),
                    port=self.server.server_address[1],
                )
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def handle_mutator_post(self) -> None:
            parsed = urlparse(self.path)
            content_length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(content_length)
            try:
                body = json.loads(raw.decode("utf-8"))
                state_key = str(body["key"])
                action = str(body["action"])
                degree = float(body.get("degree", 0.0))
                runtime.apply_mutator(state_key=state_key, degree=degree, action=action)
            except (json.JSONDecodeError, KeyError, TypeError, ValueError, SystemExit) as exc:
                self.send_error(HTTPStatus.BAD_REQUEST, str(exc))
                return

            payload = json.dumps(
                runtime.frontend_payload(
                    hide_qr_panel="noqr" in parse_qs(parsed.query, keep_blank_values=True),
                    port=self.server.server_address[1],
                )
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
    output = parse_output_name(raw.get("output"), config_path=config_path, path="output")
    bpm = parse_root_bpm(raw.get("bpm", 120.0), config_path=config_path, path="bpm")
    inertia = parse_inertia(raw.get("inertia", 1.0), config_path=config_path, path="inertia")
    osc = parse_osc_output(raw.get("osc"), config_path=config_path)

    palette = parse_palette(raw.get("palette"), config_path=config_path)
    layout = parse_root_layout(raw=raw, config_path=config_path, palette=palette, root_bpm=bpm)
    sliders = collect_sliders(layout)
    curves = collect_curves(layout)
    tempo = collect_tempo(layout)
    sequencers = collect_sequencers(layout)
    memories = collect_memories(layout)
    mutators = collect_mutators(layout)
    if count_controls(layout) == 0:
        raise SystemExit(f"Config {config_path} must contain at least one control")
    if layout_has_osc_routes(layout) and osc is None:
        raise SystemExit(
            f"Config {config_path} defines control osc routes but is missing the root 'osc' output"
        )
    validate_memory_targets(layout, memories, config_path=config_path)
    validate_mutator_targets(layout, mutators, config_path=config_path)

    return AppConfig(
        title=title,
        output=output.strip(),
        bpm=bpm,
        inertia=inertia,
        layout=layout,
        sliders=sliders,
        curves=curves,
        tempo=tempo,
        sequencers=sequencers,
        memories=memories,
        mutators=mutators,
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
    *, raw: dict[str, Any], config_path: Path, palette: dict[str, str], root_bpm: float
) -> LayoutNode:
    container_keys = [key for key in ("rows", "columns", "tabs") if key in raw]
    if len(container_keys) != 1:
        raise SystemExit(
            f"Config {config_path} must define exactly one of 'rows', 'columns', or 'tabs'"
        )
    return parse_container(
        key=container_keys[0],
        children_raw=raw[container_keys[0]],
        config_path=config_path,
        path=container_keys[0],
        raw=raw,
        palette=palette,
        root_bpm=root_bpm,
        defaults=parse_layout_defaults(
            raw,
            inherited=LayoutDefaults(
                output=parse_output_name(raw.get("output"), config_path=config_path, path="output")
            ),
            config_path=config_path,
            path="root",
            palette=palette,
        ),
    )


def parse_container(
    *,
    key: str,
    children_raw: Any,
    config_path: Path,
    path: str,
    raw: dict[str, Any],
    palette: dict[str, str],
    root_bpm: float,
    defaults: LayoutDefaults,
) -> LayoutNode:
    if key == "tabs":
        return parse_tabs(
            tabs_raw=children_raw,
            config_path=config_path,
            path=path,
            raw=raw,
            palette=palette,
            root_bpm=root_bpm,
            defaults=defaults,
        )
    return parse_group(
        kind="row" if key == "rows" else "column",
        children_raw=children_raw,
        config_path=config_path,
        path=path,
        raw=raw,
        palette=palette,
        root_bpm=root_bpm,
        defaults=defaults,
    )


def parse_group(
    *,
    kind: str,
    children_raw: Any,
    config_path: Path,
    path: str,
    raw: dict[str, Any],
    palette: dict[str, str],
    root_bpm: float,
    defaults: LayoutDefaults,
) -> GroupConfig:
    if not isinstance(children_raw, list) or not children_raw:
        raise SystemExit(f"{config_path} {path} must be a non-empty list")

    children: list[LayoutNode] = []
    for index, item in enumerate(children_raw):
        child_path = f"{path}[{index}]"
        if not isinstance(item, dict):
            raise SystemExit(f"{config_path} {child_path} must be a mapping")

        child_container_keys = [key for key in ("rows", "columns", "tabs") if key in item]
        if len(child_container_keys) > 1:
            raise SystemExit(
                f"{config_path} {child_path} must not define more than one of 'rows', 'columns', or 'tabs'"
            )

        if child_container_keys:
            child_key = child_container_keys[0]
            child_defaults = parse_layout_defaults(
                item,
                inherited=defaults,
                config_path=config_path,
                path=child_path,
                palette=palette,
            )
            children.append(
                parse_container(
                    key=child_key,
                    children_raw=item[child_key],
                    config_path=config_path,
                    path=f"{child_path}.{child_key}",
                    raw=item,
                    palette=palette,
                    root_bpm=root_bpm,
                    defaults=child_defaults,
                )
            )
        else:
            children.append(
                parse_control(
                    item,
                    config_path=config_path,
                    path=child_path,
                    palette=palette,
                    root_bpm=root_bpm,
                    defaults=defaults,
                )
            )

    return GroupConfig(
        kind=kind,
        children=children,
        name=parse_optional_name(raw.get("name"), config_path=config_path, path=f"{path}.name"),
        width=parse_size(raw.get("width"), config_path=config_path, path=f"{path}.width"),
        height=parse_size(raw.get("height"), config_path=config_path, path=f"{path}.height"),
    )


def parse_tabs(
    *,
    tabs_raw: Any,
    config_path: Path,
    path: str,
    raw: dict[str, Any],
    palette: dict[str, str],
    root_bpm: float,
    defaults: LayoutDefaults,
) -> TabsConfig:
    if not isinstance(tabs_raw, list) or not tabs_raw:
        raise SystemExit(f"{config_path} {path} must be a non-empty list")

    tabs: list[TabConfig] = []
    for index, item in enumerate(tabs_raw):
        tab_path = f"{path}[{index}]"
        if not isinstance(item, dict):
            raise SystemExit(f"{config_path} {tab_path} must be a mapping")
        if set(item.keys()) != {"tab"}:
            raise SystemExit(f"{config_path} {tab_path} must define exactly one 'tab' mapping")
        tabs.append(
            parse_tab(
                item["tab"],
                config_path=config_path,
                path=f"{tab_path}.tab",
                palette=palette,
                root_bpm=root_bpm,
                defaults=defaults,
            )
        )

    return TabsConfig(
        tabs=tabs,
        name=parse_optional_name(raw.get("name"), config_path=config_path, path=f"{path}.name"),
        width=parse_size(raw.get("width"), config_path=config_path, path=f"{path}.width"),
        height=parse_size(raw.get("height"), config_path=config_path, path=f"{path}.height"),
    )


def parse_tab(
    raw: Any,
    *,
    config_path: Path,
    path: str,
    palette: dict[str, str],
    root_bpm: float,
    defaults: LayoutDefaults,
) -> TabConfig:
    if not isinstance(raw, dict):
        raise SystemExit(f"{config_path} {path} must be a mapping")

    name = raw.get("name")
    if not isinstance(name, str) or not name.strip():
        raise SystemExit(f"{config_path} {path}.name must be a non-empty string")

    container_keys = [key for key in ("rows", "columns", "tabs") if key in raw]
    if len(container_keys) != 1:
        raise SystemExit(
            f"{config_path} {path} must define exactly one of 'rows', 'columns', or 'tabs'"
        )

    key = container_keys[0]
    tab_defaults = parse_layout_defaults(
        raw, inherited=defaults, config_path=config_path, path=path, palette=palette
    )
    return TabConfig(
        name=name.strip(),
        content=parse_container(
            key=key,
            children_raw=raw[key],
            config_path=config_path,
            path=f"{path}.{key}",
            raw=raw,
            palette=palette,
            root_bpm=root_bpm,
            defaults=tab_defaults,
        ),
    )


def parse_control(
    raw: dict[str, Any],
    *,
    config_path: Path,
    path: str,
    palette: dict[str, str],
    root_bpm: float,
    defaults: LayoutDefaults,
) -> ControlConfig:
    control_type = str(raw.get("type", "slider")).strip() or "slider"
    if control_type in {"slider", "lfo"}:
        return parse_slider(
            raw,
            config_path=config_path,
            path=path,
            palette=palette,
            defaults=defaults,
            control_type=control_type,
        )
    if control_type == "keyboard":
        return parse_keyboard(
            raw,
            config_path=config_path,
            path=path,
            palette=palette,
            defaults=defaults,
        )
    if control_type == "button":
        return parse_button(
            raw,
            config_path=config_path,
            path=path,
            palette=palette,
            defaults=defaults,
        )
    if control_type == "curve":
        return parse_curve_control(
            raw,
            config_path=config_path,
            path=path,
            palette=palette,
            defaults=defaults,
        )
    if control_type == "tempo":
        return parse_tempo(
            raw,
            config_path=config_path,
            path=path,
            palette=palette,
            root_bpm=root_bpm,
            defaults=defaults,
        )
    if control_type == "sequencer":
        return parse_sequencer(
            raw,
            config_path=config_path,
            path=path,
            palette=palette,
            defaults=defaults,
        )
    if control_type == "memory":
        return parse_memory(
            raw,
            config_path=config_path,
            path=path,
            palette=palette,
            defaults=defaults,
        )
    if control_type == "mutator":
        return parse_mutator(
            raw,
            config_path=config_path,
            path=path,
            palette=palette,
            defaults=defaults,
        )
    raise SystemExit(
        f"{config_path} {path}.type must be 'slider', 'lfo', 'keyboard', 'button', 'curve', 'tempo', 'sequencer', 'memory', or 'mutator'"
    )


def parse_slider(
    raw: dict[str, Any],
    *,
    config_path: Path,
    path: str,
    palette: dict[str, str],
    defaults: LayoutDefaults,
    control_type: str = "slider",
) -> SliderConfig:
    try:
        minimum = validate_range(
            int(raw.get("min", defaults.minimum)), 0, 127, f"{path}.min", config_path
        )
        maximum = validate_range(
            int(raw.get("max", defaults.maximum)), 0, 127, f"{path}.max", config_path
        )
        default_value = raw.get("default", defaults.default)
        if control_type == "lfo" and "default" not in raw:
            default_value = int(round((minimum + maximum) / 2))
        slider = SliderConfig(
            output=parse_output_name(
                raw.get("output", defaults.output),
                config_path=config_path,
                path=f"{path}.output",
            ),
            control_type=control_type,
            complex=parse_boolean(
                raw.get("complex", True),
                config_path=config_path,
                path=f"{path}.complex",
            ),
            max_speed=parse_nonnegative_speed(
                raw.get("max_speed", 12.0), config_path=config_path, path=f"{path}.max_speed"
            ),
            quantize_speed_to_tempo_divisions=parse_boolean(
                raw.get("quantize_speed", defaults.quantize_speed_to_tempo_divisions),
                config_path=config_path,
                path=f"{path}.quantize_speed",
            ),
            lfo_waveforms=parse_lfo_waveforms(
                raw.get("waveforms", LFO_WAVEFORMS),
                config_path=config_path,
                path=f"{path}.waveforms",
            ),
            lfo_shape_control=parse_lfo_shape_control(
                raw.get("shape_control", "waveform"),
                config_path=config_path,
                path=f"{path}.shape_control",
            ),
            name=str(raw["name"]),
            channel=validate_range(
                int(raw.get("channel", defaults.channel)), 1, 16, f"{path}.channel", config_path
            ),
            control=validate_range(int(raw["control"]), 0, 127, f"{path}.control", config_path),
            default=validate_range(
                int(default_value), 0, 127, f"{path}.default", config_path
            ),
            minimum=minimum,
            maximum=maximum,
            steps=parse_steps(
                raw.get("steps", defaults.steps), config_path=config_path, path=f"{path}.steps"
            ),
            speed=parse_speed(
                raw.get("speed", defaults.speed), config_path=config_path, path=f"{path}.speed"
            ),
            curve=parse_curve(
                raw.get("curve", defaults.curve), config_path=config_path, path=f"{path}.curve"
            ),
            orientation=str(raw.get("orientation", defaults.orientation)),
            color=resolve_color(
                raw.get("color", defaults.color),
                palette=palette,
                config_path=config_path,
                path=f"{path}.color",
            ),
            show_label=parse_boolean(
                raw.get("show_label", defaults.show_label),
                config_path=config_path,
                path=f"{path}.show_label",
            ),
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


def parse_keyboard(
    raw: dict[str, Any],
    *,
    config_path: Path,
    path: str,
    palette: dict[str, str],
    defaults: LayoutDefaults,
) -> KeyboardConfig:
    try:
        keyboard = KeyboardConfig(
            name=str(raw["name"]),
            output=parse_output_name(
                raw.get("output", defaults.output),
                config_path=config_path,
                path=f"{path}.output",
            ),
            channel=validate_range(
                int(raw.get("channel", defaults.channel)), 1, 16, f"{path}.channel", config_path
            ),
            start=parse_midi_note(raw.get("start", 60), config_path=config_path, path=f"{path}.start"),
            size=parse_keyboard_size(raw.get("size", 12), config_path=config_path, path=f"{path}.size"),
            scale=parse_scale_name(raw.get("scale"), config_path=config_path, path=f"{path}.scale"),
            root=parse_optional_midi_note(raw.get("root"), config_path=config_path, path=f"{path}.root"),
            color=resolve_color(
                raw.get("color", defaults.color),
                palette=palette,
                config_path=config_path,
                path=f"{path}.color",
            ),
            show_label=parse_boolean(
                raw.get("show_label", defaults.show_label),
                config_path=config_path,
                path=f"{path}.show_label",
            ),
            width=parse_size(raw.get("width"), config_path=config_path, path=f"{path}.width"),
            height=parse_size(raw.get("height"), config_path=config_path, path=f"{path}.height"),
        )
    except KeyError as exc:
        missing = exc.args[0]
        raise SystemExit(f"{config_path} {path} is missing '{missing}'") from exc

    if (keyboard.scale is None) != (keyboard.root is None):
        raise SystemExit(f"{config_path} {path} must define both scale and root together")
    validate_keyboard_range(keyboard, config_path=config_path, path=path)
    return keyboard


def parse_button(
    raw: dict[str, Any],
    *,
    config_path: Path,
    path: str,
    palette: dict[str, str],
    defaults: LayoutDefaults,
) -> ButtonConfig:
    try:
        return ButtonConfig(
            name=str(raw["name"]),
            output=parse_output_name(
                raw.get("output", defaults.output),
                config_path=config_path,
                path=f"{path}.output",
            ),
            channel=validate_range(
                int(raw.get("channel", defaults.channel)), 1, 16, f"{path}.channel", config_path
            ),
            control=validate_range(int(raw["control"]), 0, 127, f"{path}.control", config_path),
            color=resolve_color(
                raw.get("color", defaults.color),
                palette=palette,
                config_path=config_path,
                path=f"{path}.color",
            ),
            show_label=parse_boolean(
                raw.get("show_label", defaults.show_label),
                config_path=config_path,
                path=f"{path}.show_label",
            ),
            width=parse_size(raw.get("width"), config_path=config_path, path=f"{path}.width"),
            height=parse_size(raw.get("height"), config_path=config_path, path=f"{path}.height"),
            osc=parse_osc_route(raw.get("osc"), config_path=config_path, path=f"{path}.osc"),
        )
    except KeyError as exc:
        missing = exc.args[0]
        raise SystemExit(f"{config_path} {path} is missing '{missing}'") from exc


def parse_curve_control(
    raw: dict[str, Any],
    *,
    config_path: Path,
    path: str,
    palette: dict[str, str],
    defaults: LayoutDefaults,
) -> CurveConfig:
    try:
        minimum = validate_range(
            int(raw.get("min", defaults.minimum)), 0, 127, f"{path}.min", config_path
        )
        maximum = validate_range(
            int(raw.get("max", defaults.maximum)), 0, 127, f"{path}.max", config_path
        )
        default = validate_range(
            int(raw.get("default", raw.get("initial", defaults.default))),
            0,
            127,
            f"{path}.default",
            config_path,
        )
        curve = CurveConfig(
            name=str(raw["name"]),
            output=parse_output_name(
                raw.get("output", defaults.output),
                config_path=config_path,
                path=f"{path}.output",
            ),
            channel=validate_range(
                int(raw.get("channel", defaults.channel)), 1, 16, f"{path}.channel", config_path
            ),
            control=validate_range(int(raw["control"]), 0, 127, f"{path}.control", config_path),
            length=parse_positive_duration(
                raw.get("length", 1.0), config_path=config_path, path=f"{path}.length"
            ),
            mode=parse_curve_mode(raw.get("mode", "loop"), config_path=config_path, path=f"{path}.mode"),
            default=default,
            minimum=minimum,
            maximum=maximum,
            color=resolve_color(
                raw.get("color", defaults.color),
                palette=palette,
                config_path=config_path,
                path=f"{path}.color",
            ),
            show_label=parse_boolean(
                raw.get("show_label", defaults.show_label),
                config_path=config_path,
                path=f"{path}.show_label",
            ),
            width=parse_size(raw.get("width"), config_path=config_path, path=f"{path}.width"),
            height=parse_size(raw.get("height"), config_path=config_path, path=f"{path}.height"),
            osc=parse_osc_route(raw.get("osc"), config_path=config_path, path=f"{path}.osc"),
        )
    except KeyError as exc:
        missing = exc.args[0]
        raise SystemExit(f"{config_path} {path} is missing '{missing}'") from exc

    if curve.minimum > curve.maximum:
        raise SystemExit(f"{config_path} {path} has min greater than max")
    if not curve.minimum <= curve.default <= curve.maximum:
        raise SystemExit(f"{config_path} {path} has default outside min/max range")
    return curve


def parse_tempo(
    raw: dict[str, Any],
    *,
    config_path: Path,
    path: str,
    palette: dict[str, str],
    root_bpm: float,
    defaults: LayoutDefaults,
) -> TempoConfig:
    try:
        tempo = TempoConfig(
            name=str(raw["name"]),
            output=parse_output_name(
                raw.get("output", defaults.output),
                config_path=config_path,
                path=f"{path}.output",
            ),
            default=parse_numeric_value(raw.get("default", root_bpm), config_path=config_path, path=f"{path}.default"),
            minimum=parse_numeric_value(raw.get("min", 20.0), config_path=config_path, path=f"{path}.min"),
            maximum=parse_numeric_value(raw.get("max", 300.0), config_path=config_path, path=f"{path}.max"),
            color=resolve_color(
                raw.get("color", defaults.color),
                palette=palette,
                config_path=config_path,
                path=f"{path}.color",
            ),
            show_label=parse_boolean(
                raw.get("show_label", defaults.show_label),
                config_path=config_path,
                path=f"{path}.show_label",
            ),
            width=parse_size(raw.get("width"), config_path=config_path, path=f"{path}.width"),
            height=parse_size(raw.get("height"), config_path=config_path, path=f"{path}.height"),
        )
    except KeyError as exc:
        missing = exc.args[0]
        raise SystemExit(f"{config_path} {path} is missing '{missing}'") from exc

    if tempo.minimum > tempo.maximum:
        raise SystemExit(f"{config_path} {path} has min greater than max")
    if not tempo.minimum <= tempo.default <= tempo.maximum:
        raise SystemExit(f"{config_path} {path} has default outside min/max range")
    return tempo


def parse_sequencer(
    raw: dict[str, Any],
    *,
    config_path: Path,
    path: str,
    palette: dict[str, str],
    defaults: LayoutDefaults,
) -> SequencerConfig:
    try:
        mode = str(raw["mode"]).strip().lower()
        max_gate_steps = parse_positive_numeric_alias(
            raw,
            keys=("max_gate_steps", "max_gate", "gate_max"),
            default=1.0,
            config_path=config_path,
            path=path,
        )
        sequencer = SequencerConfig(
            name=str(raw["name"]),
            output=parse_output_name(
                raw.get("output", defaults.output),
                config_path=config_path,
                path=f"{path}.output",
            ),
            mode=mode,
            size=parse_keyboard_size(raw["size"], config_path=config_path, path=f"{path}.size"),
            subdivision_label=normalize_subdivision_label(raw["subdivision"]),
            subdivision_beats=parse_subdivision(
                raw["subdivision"], config_path=config_path, path=f"{path}.subdivision"
            ),
            channel=validate_range(
                int(raw.get("channel", defaults.channel)), 1, 16, f"{path}.channel", config_path
            ),
            control=parse_optional_range(
                raw.get("control"), 0, 127, f"{path}.control", config_path
            ),
            minimum=validate_range(
                int(raw.get("min", defaults.minimum)), 0, 127, f"{path}.min", config_path
            ),
            maximum=validate_range(
                int(raw.get("max", defaults.maximum)), 0, 127, f"{path}.max", config_path
            ),
            root=parse_optional_midi_note(raw.get("root"), config_path=config_path, path=f"{path}.root"),
            scale=parse_scale_name(raw.get("scale"), config_path=config_path, path=f"{path}.scale"),
            velocity_row=parse_optional_boolean_alias(
                raw,
                keys=("velocity_row", "show_velocity"),
                default=False,
                config_path=config_path,
                path=path,
            ),
            gate_row=parse_optional_boolean_alias(
                raw,
                keys=("gate_row", "show_gate"),
                default=False,
                config_path=config_path,
                path=path,
            ),
            timing_row=parse_optional_boolean_alias(
                raw,
                keys=("timing_row", "show_timing"),
                default=False,
                config_path=config_path,
                path=path,
            ),
            default_velocity=parse_optional_velocity_alias(
                raw,
                keys=("velocity",),
                default=127,
                config_path=config_path,
                path=path,
            ),
            default_gate=parse_positive_numeric_alias(
                raw,
                keys=("gate",),
                default=1.0,
                config_path=config_path,
                path=path,
            ),
            default_timing=parse_optional_timing_alias(
                raw,
                keys=("timing",),
                default=0.0,
                config_path=config_path,
                path=path,
            ),
            max_gate_steps=max_gate_steps,
            color=resolve_color(
                raw.get("color", defaults.color),
                palette=palette,
                config_path=config_path,
                path=f"{path}.color",
            ),
            show_label=parse_boolean(
                raw.get("show_label", defaults.show_label),
                config_path=config_path,
                path=f"{path}.show_label",
            ),
            width=parse_size(raw.get("width"), config_path=config_path, path=f"{path}.width"),
            height=parse_size(raw.get("height"), config_path=config_path, path=f"{path}.height"),
            osc=parse_osc_route(raw.get("osc"), config_path=config_path, path=f"{path}.osc"),
        )
    except KeyError as exc:
        missing = exc.args[0]
        raise SystemExit(f"{config_path} {path} is missing '{missing}'") from exc

    if sequencer.minimum > sequencer.maximum:
        raise SystemExit(f"{config_path} {path} has min greater than max")
    if sequencer.mode not in {"notes", "cc"}:
        raise SystemExit(f"{config_path} {path}.mode must be 'notes' or 'cc'")
    if sequencer.scale is not None and sequencer.root is None:
        raise SystemExit(f"{config_path} {path} must define root when scale is set")
    if sequencer.root is not None and sequencer.scale is None:
        raise SystemExit(f"{config_path} {path} must define scale when root is set")
    if sequencer.max_gate_steps < 1:
        raise SystemExit(f"{config_path} {path}.max_gate_steps must be at least 1")
    if sequencer.default_gate > sequencer.max_gate_steps:
        raise SystemExit(f"{config_path} {path}.gate must be no greater than max_gate_steps")
    if sequencer.mode == "notes":
        if sequencer.control is not None:
            raise SystemExit(f"{config_path} {path}.control is only valid for cc sequencers")
        if sequencer.osc is not None:
            raise SystemExit(f"{config_path} {path}.osc is only valid for cc sequencers")
    else:
        if sequencer.velocity_row:
            raise SystemExit(f"{config_path} {path}.velocity_row is only valid for note sequencers")
        if sequencer.gate_row:
            raise SystemExit(f"{config_path} {path}.gate_row is only valid for note sequencers")
        if sequencer.timing_row:
            raise SystemExit(f"{config_path} {path}.timing_row is only valid for note sequencers")
        if sequencer.default_velocity != 127:
            raise SystemExit(f"{config_path} {path}.velocity is only valid for note sequencers")
        if sequencer.default_gate != 1.0:
            raise SystemExit(f"{config_path} {path}.gate is only valid for note sequencers")
        if sequencer.default_timing != 0.0:
            raise SystemExit(f"{config_path} {path}.timing is only valid for note sequencers")
        if sequencer.max_gate_steps != 1.0:
            raise SystemExit(f"{config_path} {path}.max_gate_steps is only valid for note sequencers")
        if sequencer.control is None and sequencer.osc is None:
            raise SystemExit(f"{config_path} {path} cc sequencers require control and/or osc")
        if sequencer.root is not None or sequencer.scale is not None:
            raise SystemExit(f"{config_path} {path} root/scale are only valid for note sequencers")
    return sequencer


def parse_memory(
    raw: dict[str, Any],
    *,
    config_path: Path,
    path: str,
    palette: dict[str, str],
    defaults: LayoutDefaults,
) -> MemoryConfig:
    try:
        target = parse_optional_name(raw["target"], config_path=config_path, path=f"{path}.target")
        if target is None:
            raise SystemExit(f"{config_path} {path}.target must be a non-empty string")
        return MemoryConfig(
            name=str(raw["name"]),
            target=target,
            slots=parse_keyboard_size(raw["slots"], config_path=config_path, path=f"{path}.slots"),
            transition=parse_inertia(
                raw.get("transition", 0.0),
                config_path=config_path,
                path=f"{path}.transition",
            ),
            color=resolve_color(
                raw.get("color", defaults.color),
                palette=palette,
                config_path=config_path,
                path=f"{path}.color",
            ),
            show_label=parse_boolean(
                raw.get("show_label", defaults.show_label),
                config_path=config_path,
                path=f"{path}.show_label",
            ),
            width=parse_size(raw.get("width"), config_path=config_path, path=f"{path}.width"),
            height=parse_size(raw.get("height"), config_path=config_path, path=f"{path}.height"),
        )
    except KeyError as exc:
        missing = exc.args[0]
        raise SystemExit(f"{config_path} {path} is missing '{missing}'") from exc


def parse_mutator(
    raw: dict[str, Any],
    *,
    config_path: Path,
    path: str,
    palette: dict[str, str],
    defaults: LayoutDefaults,
) -> MutatorConfig:
    try:
        target = parse_optional_name(raw["target"], config_path=config_path, path=f"{path}.target")
        if target is None:
            raise SystemExit(f"{config_path} {path}.target must be a non-empty string")
        return MutatorConfig(
            name=str(raw["name"]),
            target=target,
            default=parse_unit_interval(
                raw.get("default", 0.5), config_path=config_path, path=f"{path}.default"
            ),
            mutate_sequencer_note=parse_optional_boolean_alias(
                raw,
                keys=("note",),
                default=True,
                config_path=config_path,
                path=path,
            ),
            mutate_sequencer_step=parse_optional_boolean_alias(
                raw,
                keys=("step",),
                default=True,
                config_path=config_path,
                path=path,
            ),
            mutate_sequencer_velocity=parse_optional_boolean_alias(
                raw,
                keys=("velocity",),
                default=True,
                config_path=config_path,
                path=path,
            ),
            mutate_sequencer_gate=parse_optional_boolean_alias(
                raw,
                keys=("gate",),
                default=True,
                config_path=config_path,
                path=path,
            ),
            mutate_sequencer_timing=parse_optional_boolean_alias(
                raw,
                keys=("timing",),
                default=True,
                config_path=config_path,
                path=path,
            ),
            color=resolve_color(
                raw.get("color", defaults.color),
                palette=palette,
                config_path=config_path,
                path=f"{path}.color",
            ),
            show_label=parse_boolean(
                raw.get("show_label", defaults.show_label),
                config_path=config_path,
                path=f"{path}.show_label",
            ),
            width=parse_size(raw.get("width"), config_path=config_path, path=f"{path}.width"),
            height=parse_size(raw.get("height"), config_path=config_path, path=f"{path}.height"),
        )
    except KeyError as exc:
        missing = exc.args[0]
        raise SystemExit(f"{config_path} {path} is missing '{missing}'") from exc


def parse_layout_defaults(
    raw: dict[str, Any],
    *,
    inherited: LayoutDefaults,
    config_path: Path,
    path: str,
    palette: dict[str, str],
) -> LayoutDefaults:
    output = inherited.output
    if "output" in raw:
        output = parse_output_name(raw["output"], config_path=config_path, path=f"{path}.output")

    channel = inherited.channel
    if "channel" in raw:
        channel = validate_range(int(raw["channel"]), 1, 16, f"{path}.channel", config_path)

    default = inherited.default
    if "default" in raw:
        default = validate_range(int(raw["default"]), 0, 127, f"{path}.default", config_path)

    minimum = inherited.minimum
    if "min" in raw:
        minimum = validate_range(int(raw["min"]), 0, 127, f"{path}.min", config_path)

    maximum = inherited.maximum
    if "max" in raw:
        maximum = validate_range(int(raw["max"]), 0, 127, f"{path}.max", config_path)

    steps = inherited.steps
    if "steps" in raw:
        steps = parse_steps(raw["steps"], config_path=config_path, path=f"{path}.steps")

    speed = inherited.speed
    if "speed" in raw:
        speed = parse_speed(raw["speed"], config_path=config_path, path=f"{path}.speed")

    curve = inherited.curve
    if "curve" in raw:
        curve = parse_curve(raw["curve"], config_path=config_path, path=f"{path}.curve")

    quantize_speed_to_tempo_divisions = inherited.quantize_speed_to_tempo_divisions
    if "quantize_speed" in raw:
        quantize_speed_to_tempo_divisions = parse_boolean(
            raw["quantize_speed"], config_path=config_path, path=f"{path}.quantize_speed"
        )

    orientation = inherited.orientation
    if "orientation" in raw:
        orientation = str(raw["orientation"])

    color = inherited.color
    if "color" in raw:
        color = resolve_color(
            raw["color"], palette=palette, config_path=config_path, path=f"{path}.color"
        )

    show_label = inherited.show_label
    if "show_label" in raw:
        show_label = parse_boolean(
            raw["show_label"], config_path=config_path, path=f"{path}.show_label"
        )

    return LayoutDefaults(
        output=output,
        channel=channel,
        default=default,
        minimum=minimum,
        maximum=maximum,
        steps=steps,
        speed=speed,
        curve=curve,
        quantize_speed_to_tempo_divisions=quantize_speed_to_tempo_divisions,
        orientation=orientation,
        color=color,
        show_label=show_label,
    )


def parse_output_name(raw: Any, *, config_path: Path, path: str) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise SystemExit(f"Config {config_path} must define a non-empty '{path}'")
    return raw.strip()


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


def parse_unit_interval(raw: Any, *, config_path: Path, path: str) -> float:
    if isinstance(raw, bool):
        raise SystemExit(f"{config_path} {path} must be a number between 0 and 1")
    value = parse_numeric_value(raw, config_path=config_path, path=path)
    if not 0 <= value <= 1:
        raise SystemExit(f"{config_path} {path} must be between 0 and 1")
    return value


def parse_root_bpm(raw: Any, *, config_path: Path, path: str) -> float:
    if isinstance(raw, bool):
        raise SystemExit(f"{config_path} {path} must be a number")
    value = parse_numeric_value(raw, config_path=config_path, path=path)
    if value <= 0:
        raise SystemExit(f"{config_path} {path} must be greater than 0")
    return round(value * 10.0) / 10.0


def parse_speed(raw: Any, *, config_path: Path, path: str) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise SystemExit(f"{config_path} {path} must be a number") from exc
    if value <= 0:
        raise SystemExit(f"{config_path} {path} must be greater than 0")
    return value


def parse_curve(raw: Any, *, config_path: Path, path: str) -> float:
    if isinstance(raw, bool):
        raise SystemExit(f"{config_path} {path} must be a number")
    value = parse_numeric_value(raw, config_path=config_path, path=path)
    if not math.isfinite(value):
        raise SystemExit(f"{config_path} {path} must be a finite number")
    return value


def parse_positive_duration(raw: Any, *, config_path: Path, path: str) -> float:
    if isinstance(raw, bool):
        raise SystemExit(f"{config_path} {path} must be a number")
    value = parse_numeric_value(raw, config_path=config_path, path=path)
    if value <= 0:
        raise SystemExit(f"{config_path} {path} must be greater than 0")
    return value


def parse_curve_mode(raw: Any, *, config_path: Path, path: str) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise SystemExit(f"{config_path} {path} must be 'loop' or 'trigger'")
    value = raw.strip().lower()
    if value not in {"loop", "trigger"}:
        raise SystemExit(f"{config_path} {path} must be 'loop' or 'trigger'")
    return value


def parse_nonnegative_speed(raw: Any, *, config_path: Path, path: str) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise SystemExit(f"{config_path} {path} must be a number") from exc
    if value < 0:
        raise SystemExit(f"{config_path} {path} must be 0 or greater")
    return value


def parse_lfo_waveforms(raw: Any, *, config_path: Path, path: str) -> tuple[str, ...]:
    if not isinstance(raw, (list, tuple)) or not raw:
        raise SystemExit(
            f"{config_path} {path} must be a non-empty list of: {', '.join(LFO_WAVEFORMS)}"
        )

    waveforms: list[str] = []
    for index, item in enumerate(raw):
        if not isinstance(item, str) or not item.strip():
            raise SystemExit(f"{config_path} {path}[{index}] must be a non-empty string")
        waveform = item.strip().lower().replace("-", "_").replace(" ", "_")
        if waveform not in LFO_WAVEFORMS:
            raise SystemExit(
                f"{config_path} {path}[{index}] must be one of: {', '.join(LFO_WAVEFORMS)}"
            )
        if waveform not in waveforms:
            waveforms.append(waveform)
    return tuple(waveforms)


def parse_lfo_shape_control(raw: Any, *, config_path: Path, path: str) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise SystemExit(f"{config_path} {path} must be 'waveform' or 'jitter'")
    value = raw.strip().lower().replace("-", "_").replace(" ", "_")
    if value not in LFO_SHAPE_CONTROLS:
        raise SystemExit(f"{config_path} {path} must be 'waveform' or 'jitter'")
    return value


def parse_steps(raw: Any, *, config_path: Path, path: str) -> int | None:
    if raw is None:
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise SystemExit(f"{config_path} {path} must be an integer") from exc
    if value < 2:
        raise SystemExit(f"{config_path} {path} must be 2 or greater")
    return value


def parse_optional_range(
    raw: Any, minimum: int, maximum: int, path: str, config_path: Path
) -> int | None:
    if raw is None:
        return None
    return validate_range(int(raw), minimum, maximum, path, config_path)


def parse_keyboard_size(raw: Any, *, config_path: Path, path: str) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise SystemExit(f"{config_path} {path} must be an integer") from exc
    if value < 1:
        raise SystemExit(f"{config_path} {path} must be 1 or greater")
    return value


def parse_optional_midi_note(raw: Any, *, config_path: Path, path: str) -> int | None:
    if raw is None:
        return None
    return parse_midi_note(raw, config_path=config_path, path=path)


def parse_midi_note(raw: Any, *, config_path: Path, path: str) -> int:
    if isinstance(raw, bool):
        raise SystemExit(f"{config_path} {path} must be a MIDI note number or note name")
    if isinstance(raw, int):
        return validate_range(raw, 0, 127, path, config_path)
    if isinstance(raw, float) and raw.is_integer():
        return validate_range(int(raw), 0, 127, path, config_path)
    if not isinstance(raw, str) or not raw.strip():
        raise SystemExit(f"{config_path} {path} must be a MIDI note number or note name")

    match = NOTE_PATTERN.match(raw)
    if match is None:
        raise SystemExit(f"{config_path} {path} must be a MIDI note number or note name")

    letter, accidentals, octave_text = match.groups()
    semitone = NOTE_BASES[letter.upper()]
    for accidental in accidentals:
        semitone += 1 if accidental == "#" else -1
    octave = int(octave_text)
    midi_note = ((octave + 1) * 12) + semitone
    return validate_range(midi_note, 0, 127, path, config_path)


def parse_scale_name(raw: Any, *, config_path: Path, path: str) -> str | None:
    if raw is None:
        return None
    if not isinstance(raw, str) or not raw.strip():
        raise SystemExit(f"{config_path} {path} must be a non-empty scale name")
    normalized = normalize_scale_name(raw)
    if normalized not in SCALE_PATTERNS:
        raise SystemExit(f"{config_path} {path} must be one of: {', '.join(sorted(SCALE_PATTERNS))}")
    return normalized


def parse_optional_name(raw: Any, *, config_path: Path, path: str) -> str | None:
    if raw is None:
        return None
    if not isinstance(raw, str) or not raw.strip():
        raise SystemExit(f"{config_path} {path} must be a non-empty string")
    return raw.strip()


def normalize_scale_name(value: str) -> str:
    return value.strip().lower().replace("-", "_").replace(" ", "_")


def parse_subdivision(raw: Any, *, config_path: Path, path: str) -> float:
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        value = float(raw)
        if value <= 0:
            raise SystemExit(f"{config_path} {path} must be greater than 0")
        return value
    if not isinstance(raw, str) or not raw.strip():
        raise SystemExit(
            f"{config_path} {path} must be a positive beat value or note fraction like '1/16'"
        )

    match = SUBDIVISION_PATTERN.match(raw)
    if match is None:
        raise SystemExit(
            f"{config_path} {path} must be a positive beat value or note fraction like '1/16'"
        )
    numerator = int(match.group(1))
    denominator = int(match.group(2))
    if numerator <= 0 or denominator <= 0:
        raise SystemExit(f"{config_path} {path} must be greater than 0")
    return (numerator * 4.0) / denominator


def normalize_subdivision_label(raw: Any) -> str:
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return str(raw)


def validate_keyboard_range(keyboard: KeyboardConfig, *, config_path: Path, path: str) -> None:
    if keyboard.scale is None and keyboard.start + keyboard.size - 1 > 127:
        raise SystemExit(f"{config_path} {path} start + size must stay within MIDI note range")


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
    if isinstance(node, (KeyboardConfig, ButtonConfig, CurveConfig, TempoConfig, SequencerConfig, MemoryConfig, MutatorConfig)):
        return []
    if isinstance(node, TabsConfig):
        sliders: list[SliderConfig] = []
        for tab in node.tabs:
            sliders.extend(collect_sliders(tab.content))
        return sliders

    sliders: list[SliderConfig] = []
    for child in node.children:
        sliders.extend(collect_sliders(child))
    return sliders


def collect_curves(node: LayoutNode) -> list[CurveConfig]:
    if isinstance(node, CurveConfig):
        return [node]
    if isinstance(node, (SliderConfig, KeyboardConfig, ButtonConfig, TempoConfig, SequencerConfig, MemoryConfig, MutatorConfig)):
        return []
    if isinstance(node, TabsConfig):
        curves: list[CurveConfig] = []
        for tab in node.tabs:
            curves.extend(collect_curves(tab.content))
        return curves

    curves: list[CurveConfig] = []
    for child in node.children:
        curves.extend(collect_curves(child))
    return curves


def collect_buttons_by_key(node: LayoutNode) -> dict[str, ButtonConfig]:
    if isinstance(node, ButtonConfig):
        return {node.state_key: node}
    if isinstance(node, (SliderConfig, KeyboardConfig, CurveConfig, TempoConfig, SequencerConfig, MemoryConfig, MutatorConfig)):
        return {}
    if isinstance(node, TabsConfig):
        buttons: dict[str, ButtonConfig] = {}
        for tab in node.tabs:
            buttons.update(collect_buttons_by_key(tab.content))
        return buttons

    buttons: dict[str, ButtonConfig] = {}
    for child in node.children:
        buttons.update(collect_buttons_by_key(child))
    return buttons


def find_keyboard_by_key(node: LayoutNode, state_key: str) -> KeyboardConfig | None:
    if isinstance(node, KeyboardConfig):
        return node if node.state_key == state_key else None
    if isinstance(node, (SliderConfig, ButtonConfig, CurveConfig, TempoConfig, SequencerConfig, MemoryConfig, MutatorConfig)):
        return None
    if isinstance(node, TabsConfig):
        for tab in node.tabs:
            found = find_keyboard_by_key(tab.content, state_key)
            if found is not None:
                return found
        return None

    for child in node.children:
        found = find_keyboard_by_key(child, state_key)
        if found is not None:
            return found
    return None


def collect_tempo(node: LayoutNode) -> TempoConfig | None:
    if isinstance(node, TempoConfig):
        return node
    if isinstance(node, (SliderConfig, KeyboardConfig, ButtonConfig, CurveConfig, SequencerConfig, MemoryConfig, MutatorConfig)):
        return None
    if isinstance(node, TabsConfig):
        found: TempoConfig | None = None
        for tab in node.tabs:
            child = collect_tempo(tab.content)
            if child is None:
                continue
            if found is not None:
                raise SystemExit("Config may define at most one tempo control")
            found = child
        return found

    found: TempoConfig | None = None
    for child_node in node.children:
        child = collect_tempo(child_node)
        if child is None:
            continue
        if found is not None:
            raise SystemExit("Config may define at most one tempo control")
        found = child
    return found


def collect_sequencers(node: LayoutNode) -> list[SequencerConfig]:
    if isinstance(node, SequencerConfig):
        return [node]
    if isinstance(node, (SliderConfig, KeyboardConfig, ButtonConfig, CurveConfig, TempoConfig, MemoryConfig, MutatorConfig)):
        return []
    if isinstance(node, TabsConfig):
        sequencers: list[SequencerConfig] = []
        for tab in node.tabs:
            sequencers.extend(collect_sequencers(tab.content))
        return sequencers

    sequencers: list[SequencerConfig] = []
    for child in node.children:
        sequencers.extend(collect_sequencers(child))
    return sequencers


def collect_memories(node: LayoutNode) -> list[MemoryConfig]:
    if isinstance(node, MemoryConfig):
        return [node]
    if isinstance(node, (SliderConfig, KeyboardConfig, ButtonConfig, CurveConfig, TempoConfig, SequencerConfig, MutatorConfig)):
        return []
    if isinstance(node, TabsConfig):
        memories: list[MemoryConfig] = []
        for tab in node.tabs:
            memories.extend(collect_memories(tab.content))
        return memories

    memories: list[MemoryConfig] = []
    for child in node.children:
        memories.extend(collect_memories(child))
    return memories


def collect_mutators(node: LayoutNode) -> list[MutatorConfig]:
    if isinstance(node, MutatorConfig):
        return [node]
    if isinstance(node, (SliderConfig, KeyboardConfig, ButtonConfig, CurveConfig, TempoConfig, SequencerConfig, MemoryConfig)):
        return []
    if isinstance(node, TabsConfig):
        mutators: list[MutatorConfig] = []
        for tab in node.tabs:
            mutators.extend(collect_mutators(tab.content))
        return mutators

    mutators: list[MutatorConfig] = []
    for child in node.children:
        mutators.extend(collect_mutators(child))
    return mutators


def collect_midi_output_names(config: AppConfig) -> set[str]:
    names = {config.output}
    collect_layout_midi_output_names(config.layout, names)
    return names


def collect_layout_midi_output_names(node: LayoutNode, names: set[str]) -> None:
    if isinstance(node, (SliderConfig, KeyboardConfig, ButtonConfig, CurveConfig, TempoConfig, SequencerConfig)):
        names.add(node.output)
        return
    if isinstance(node, (MemoryConfig, MutatorConfig)):
        return
    if isinstance(node, TabsConfig):
        for tab in node.tabs:
            collect_layout_midi_output_names(tab.content, names)
        return
    for child in node.children:
        collect_layout_midi_output_names(child, names)


def count_controls(node: LayoutNode) -> int:
    if isinstance(node, (SliderConfig, KeyboardConfig, ButtonConfig, CurveConfig, TempoConfig, SequencerConfig, MemoryConfig, MutatorConfig)):
        return 1
    if isinstance(node, TabsConfig):
        return sum(count_controls(tab.content) for tab in node.tabs)
    return sum(count_controls(child) for child in node.children)


def layout_has_osc_routes(node: LayoutNode) -> bool:
    if isinstance(node, SliderConfig):
        return node.osc is not None
    if isinstance(node, ButtonConfig):
        return node.osc is not None
    if isinstance(node, CurveConfig):
        return node.osc is not None
    if isinstance(node, KeyboardConfig):
        return False
    if isinstance(node, TempoConfig):
        return False
    if isinstance(node, SequencerConfig):
        return node.osc is not None
    if isinstance(node, (MemoryConfig, MutatorConfig)):
        return False
    if isinstance(node, TabsConfig):
        return any(layout_has_osc_routes(tab.content) for tab in node.tabs)
    return any(layout_has_osc_routes(child) for child in node.children)


def validate_memory_targets(
    layout: LayoutNode, memories: list[MemoryConfig], *, config_path: Path
) -> None:
    for memory in memories:
        target = resolve_memory_target(layout, memory.target)
        if target is None:
            raise SystemExit(
                f"{config_path} memory '{memory.name}' target '{memory.target}' does not match any named control or container"
            )
        if not target_has_recallable_state(target):
            raise SystemExit(
                f"{config_path} memory '{memory.name}' target '{memory.target}' has no recallable controls"
            )


def validate_mutator_targets(
    layout: LayoutNode, mutators: list[MutatorConfig], *, config_path: Path
) -> None:
    for mutator in mutators:
        target = resolve_memory_target(layout, mutator.target)
        if target is None:
            raise SystemExit(
                f"{config_path} mutator '{mutator.name}' target '{mutator.target}' does not match any named control or container"
            )
        if not target_has_mutable_state(target, mutator):
            raise SystemExit(
                f"{config_path} mutator '{mutator.name}' target '{mutator.target}' has no mutable controls"
            )


def resolve_memory_target(node: LayoutNode, target: str) -> LayoutNode | None:
    matches: list[LayoutNode] = []
    collect_memory_target_matches(node, target.strip(), matches)
    if not matches:
        return None
    if len(matches) > 1:
        raise SystemExit(f"Memory target '{target}' is ambiguous; names must be unique")
    return matches[0]


def collect_memory_target_matches(node: LayoutNode, target: str, matches: list[LayoutNode]) -> None:
    if isinstance(node, (SliderConfig, KeyboardConfig, ButtonConfig, CurveConfig, TempoConfig, SequencerConfig, MemoryConfig, MutatorConfig)):
        if getattr(node, "name", None) == target:
            matches.append(node)
        return
    if isinstance(node, TabsConfig):
        if node.name == target:
            matches.append(node)
        for tab in node.tabs:
            collect_memory_target_matches(tab.content, target, matches)
        return
    if node.name == target:
        matches.append(node)
    for child in node.children:
        collect_memory_target_matches(child, target, matches)


def target_has_recallable_state(node: LayoutNode) -> bool:
    if isinstance(node, (SliderConfig, TempoConfig, SequencerConfig)):
        return True
    if isinstance(node, (KeyboardConfig, ButtonConfig, CurveConfig, MemoryConfig, MutatorConfig)):
        return False
    if isinstance(node, TabsConfig):
        return any(target_has_recallable_state(tab.content) for tab in node.tabs)
    return any(target_has_recallable_state(child) for child in node.children)


def target_has_mutable_state(node: LayoutNode, mutator: MutatorConfig) -> bool:
    if isinstance(node, (SliderConfig, TempoConfig)):
        return True
    if isinstance(node, SequencerConfig):
        return mutator_can_mutate_sequencer(mutator)
    if isinstance(node, (KeyboardConfig, ButtonConfig, CurveConfig, MemoryConfig, MutatorConfig)):
        return False
    if isinstance(node, TabsConfig):
        return any(target_has_mutable_state(tab.content, mutator) for tab in node.tabs)
    return any(target_has_mutable_state(child, mutator) for child in node.children)


def mutator_can_mutate_sequencer(mutator: MutatorConfig) -> bool:
    return any(
        (
            mutator.mutate_sequencer_note,
            mutator.mutate_sequencer_step,
            mutator.mutate_sequencer_velocity,
            mutator.mutate_sequencer_gate,
            mutator.mutate_sequencer_timing,
        )
    )


def validate_range(value: int, minimum: int, maximum: int, field: str, config_path: Path) -> int:
    if minimum <= value <= maximum:
        return value
    raise SystemExit(f"{config_path} {field} must be between {minimum} and {maximum}")


def parse_boolean(raw: Any, *, config_path: Path, path: str) -> bool:
    if isinstance(raw, bool):
        return raw
    raise SystemExit(f"{config_path} {path} must be true or false")


def parse_optional_boolean_alias(
    raw: dict[str, Any],
    *,
    keys: tuple[str, ...],
    default: bool,
    config_path: Path,
    path: str,
) -> bool:
    for key in keys:
        if key in raw:
            return parse_boolean(raw[key], config_path=config_path, path=f"{path}.{key}")
    return default


def parse_positive_numeric_alias(
    raw: dict[str, Any],
    *,
    keys: tuple[str, ...],
    default: float,
    config_path: Path,
    path: str,
) -> float:
    for key in keys:
        if key not in raw:
            continue
        if isinstance(raw[key], bool):
            raise SystemExit(f"{config_path} {path}.{key} must be a number")
        value = parse_numeric_value(raw[key], config_path=config_path, path=f"{path}.{key}")
        if value <= 0:
            raise SystemExit(f"{config_path} {path}.{key} must be greater than 0")
        return value
    return default


def parse_optional_velocity_alias(
    raw: dict[str, Any],
    *,
    keys: tuple[str, ...],
    default: int,
    config_path: Path,
    path: str,
) -> int:
    for key in keys:
        if key not in raw:
            continue
        if isinstance(raw[key], bool):
            raise SystemExit(f"{config_path} {path}.{key} must be a number")
        value = parse_numeric_value(raw[key], config_path=config_path, path=f"{path}.{key}")
        return validate_range(int(round(value)), 1, 127, f"{path}.{key}", config_path)
    return default


def parse_optional_timing_alias(
    raw: dict[str, Any],
    *,
    keys: tuple[str, ...],
    default: float,
    config_path: Path,
    path: str,
) -> float:
    for key in keys:
        if key not in raw:
            continue
        if isinstance(raw[key], bool):
            raise SystemExit(f"{config_path} {path}.{key} must be a number")
        value = parse_numeric_value(raw[key], config_path=config_path, path=f"{path}.{key}")
        return round(clamp_numeric_value(value, minimum=-1.0, maximum=1.0) * 100.0) / 100.0
    return default


def load_raw_state(state_path: Path) -> dict[str, Any]:
    if not state_path.exists():
        return {}

    try:
        with state_path.open("r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return raw


def load_numeric_state(raw_state: dict[str, Any]) -> dict[str, float]:
    state: dict[str, float] = {}
    for key, value in raw_state.items():
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)) and math.isfinite(value):
            state[key] = float(value)
    return state


def load_sequencer_state(raw_state: dict[str, Any]) -> dict[str, list[SequencerStepState]]:
    state: dict[str, list[SequencerStepState]] = {}
    for key, value in raw_state.items():
        if not isinstance(value, list):
            continue
        steps: list[SequencerStepState] = []
        valid = True
        for item in value:
            if not isinstance(item, dict):
                valid = False
                break
            enabled = bool(item.get("enabled", False))
            raw_value = item.get("value", 0)
            if isinstance(raw_value, bool) or not isinstance(raw_value, (int, float)):
                valid = False
                break
            raw_velocity = item.get("velocity", 127)
            raw_gate = item.get("gate", 1.0)
            raw_timing = item.get("timing", 0.0)
            if isinstance(raw_velocity, bool) or not isinstance(raw_velocity, (int, float)):
                valid = False
                break
            if isinstance(raw_gate, bool) or not isinstance(raw_gate, (int, float)):
                valid = False
                break
            if isinstance(raw_timing, bool) or not isinstance(raw_timing, (int, float)):
                valid = False
                break
            steps.append(
                SequencerStepState(
                    enabled=enabled,
                    value=int(raw_value),
                    velocity=int(raw_velocity),
                    gate=float(raw_gate),
                    timing=float(raw_timing),
                )
            )
        if valid:
            state[key] = steps
    return state


def load_memory_state(raw_state: dict[str, Any]) -> dict[str, list[MemorySlotState | None]]:
    state: dict[str, list[MemorySlotState | None]] = {}
    for key, value in raw_state.items():
        if not isinstance(value, dict):
            continue
        raw_slots = value.get("slots")
        if not isinstance(raw_slots, list):
            continue
        slots: list[MemorySlotState | None] = []
        valid = True
        for raw_slot in raw_slots:
            if raw_slot is None:
                slots.append(None)
                continue
            if not isinstance(raw_slot, dict):
                valid = False
                break
            raw_numeric = raw_slot.get("numeric", {})
            raw_sequencers = raw_slot.get("sequencers", {})
            if not isinstance(raw_numeric, dict) or not isinstance(raw_sequencers, dict):
                valid = False
                break

            numeric: dict[str, float] = {}
            for slot_key, slot_value in raw_numeric.items():
                if isinstance(slot_value, bool) or not isinstance(slot_value, (int, float)):
                    valid = False
                    break
                numeric[str(slot_key)] = float(slot_value)
            if not valid:
                break

            sequencers: dict[str, list[SequencerStepState]] = {}
            for sequencer_key, sequencer_steps in raw_sequencers.items():
                if not isinstance(sequencer_steps, list):
                    valid = False
                    break
                normalized_steps: list[SequencerStepState] = []
                for item in sequencer_steps:
                    if not isinstance(item, dict):
                        valid = False
                        break
                    raw_value = item.get("value", 0)
                    if isinstance(raw_value, bool) or not isinstance(raw_value, (int, float)):
                        valid = False
                        break
                    raw_velocity = item.get("velocity", 127)
                    raw_gate = item.get("gate", 1.0)
                    raw_timing = item.get("timing", 0.0)
                    if isinstance(raw_velocity, bool) or not isinstance(raw_velocity, (int, float)):
                        valid = False
                        break
                    if isinstance(raw_gate, bool) or not isinstance(raw_gate, (int, float)):
                        valid = False
                        break
                    if isinstance(raw_timing, bool) or not isinstance(raw_timing, (int, float)):
                        valid = False
                        break
                    normalized_steps.append(
                        SequencerStepState(
                            enabled=bool(item.get("enabled", False)),
                            value=int(raw_value),
                            velocity=int(raw_velocity),
                            gate=float(raw_gate),
                            timing=float(raw_timing),
                        )
                    )
                if not valid:
                    break
                sequencers[str(sequencer_key)] = normalized_steps
            if not valid:
                break
            slots.append(MemorySlotState(numeric=numeric, sequencers=sequencers))
        if valid:
            state[str(key)] = slots
    return state


class MidiTempoClock:
    def __init__(
        self,
        *,
        midi_out: mido.ports.BaseOutput,
        bpm: float,
        on_tick: Callable[[], None] | None = None,
    ) -> None:
        self._midi_out = midi_out
        self._bpm = max(1.0, bpm)
        self._playing = False
        self._closed = False
        self._condition = Condition()
        self._on_tick = on_tick
        self._thread = Thread(target=self._run, name="visual-midi-tempo-clock", daemon=True)
        self._thread.start()

    def set_output(self, midi_out: mido.ports.BaseOutput) -> None:
        with self._condition:
            self._midi_out = midi_out
            self._condition.notify_all()

    def set_bpm(self, bpm: float) -> None:
        with self._condition:
            self._bpm = max(1.0, bpm)
            self._condition.notify_all()

    def start(self) -> None:
        with self._condition:
            if self._playing or self._closed:
                return
            self._playing = True
            self._midi_out.send(mido.Message("start"))
            self._condition.notify_all()

    def stop(self) -> None:
        with self._condition:
            if not self._playing:
                return
            self._playing = False
            self._midi_out.send(mido.Message("stop"))
            self._condition.notify_all()

    def is_playing(self) -> bool:
        with self._condition:
            return self._playing

    def close(self) -> None:
        with self._condition:
            self._closed = True
            self._playing = False
            self._condition.notify_all()
        self._thread.join(timeout=1.0)

    def _run(self) -> None:
        next_tick_at = time.monotonic()
        while True:
            with self._condition:
                while not self._closed and not self._playing:
                    self._condition.wait()
                    next_tick_at = time.monotonic()
                if self._closed:
                    return
                bpm = self._bpm
                midi_out = self._midi_out

            tick_interval = 60.0 / (bpm * 24.0)
            now = time.monotonic()
            if now < next_tick_at:
                time.sleep(next_tick_at - now)
                continue

            midi_out.send(mido.Message("clock"))
            self._invoke_callback(self._on_tick)
            next_tick_at = max(next_tick_at + tick_interval, time.monotonic())

    @staticmethod
    def _invoke_callback(callback: Callable[[], None] | None) -> None:
        if callback is None:
            return
        try:
            callback()
        except Exception as exc:
            print(f"Transport callback failed: {exc}")


class RuntimeState:
    def __init__(self, *, config_path: Path, state_path: Path) -> None:
        self.config_path = config_path
        self.state_path = state_path
        self.lock = Lock()
        self._file_mtime_ns = -1
        self._version = 1
        self._last_reload_error: str | None = None

        config = load_config(config_path)
        midi_outputs = self._open_midi_outputs(collect_midi_output_names(config))
        try:
            osc_client = self._open_osc_output(config.osc)
        except SystemExit:
            close_midi_outputs(midi_outputs)
            raise
        self._config = config
        self._midi_outputs = midi_outputs
        self._osc_client = osc_client
        raw_state = load_raw_state(state_path)
        self._state = load_numeric_state(raw_state)
        self._sequencer_state = load_sequencer_state(raw_state)
        self._memory_state = load_memory_state(raw_state)
        self._last_midi_values: dict[str, int] = {}
        self._active_notes: dict[tuple[str, int, int], int] = {}
        self._active_buttons: dict[str, int] = {}
        self._sliders_by_key = {slider.state_key: slider for slider in config.sliders}
        self._curves = config.curves or []
        self._curves_by_key = {curve.state_key: curve for curve in self._curves}
        self._buttons_by_key = collect_buttons_by_key(config.layout)
        self._sequencers = config.sequencers or []
        self._sequencers_by_key = {sequencer.state_key: sequencer for sequencer in self._sequencers}
        self._memories = config.memories or []
        self._memories_by_key = {memory.state_key: memory for memory in self._memories}
        self._mutators = config.mutators or []
        self._mutators_by_key = {mutator.state_key: mutator for mutator in self._mutators}
        self._mutator_degrees = {
            mutator.state_key: mutator.default for mutator in self._mutators
        }
        self._mutator_undo_state: dict[str, MemorySlotState] = {}
        self._transition_generation: dict[str, int] = {}
        self._sequencer_positions = {sequencer.state_key: -1 for sequencer in self._sequencers}
        self._sequencer_tick_progress = {sequencer.state_key: 0.0 for sequencer in self._sequencers}
        self._active_sequencer_notes: dict[int, ActiveSequencerNote] = {}
        self._active_sequencer_note_id = 0
        self._scheduled_sequencer_notes: list[ScheduledSequencerNote] = []
        self._tempo = config.tempo
        self._tempo_bpm = config.bpm
        if self._tempo is not None:
            self._tempo_bpm = quantize_tempo_value(
                self._tempo,
                self._state.get(self._tempo.state_key, self._tempo.default),
            )
        self._transport = MidiTempoClock(
            midi_out=self._midi_outputs[self._transport_output_name(config)],
            bpm=self._tempo_bpm,
            on_tick=self._handle_transport_tick,
        )
        self._reconcile_state()
        self._file_mtime_ns = self._read_mtime_ns()

    def close(self) -> None:
        self._transport.stop()
        self._handle_transport_stop()
        with self.lock:
            self._silence_active_buttons_locked()
            self._silence_active_notes_locked()
        self._transport.close()
        with self.lock:
            close_midi_outputs(self._midi_outputs)

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

    def send_curve_value_by_key(self, state_key: str, value: float) -> CurveConfig:
        self.reload_if_needed()
        with self.lock:
            curve = self._curves_by_key.get(state_key)
            if curve is None:
                raise ValueError(f"Unknown curve key: {state_key}")
            self._send_curve_value_locked(curve, value)
            return curve

    def get_tempo_value(self, tempo: TempoConfig) -> float:
        self.reload_if_needed()
        with self.lock:
            if self._tempo is None or tempo.state_key != self._tempo.state_key:
                raise ValueError(f"Unknown tempo key: {tempo.state_key}")
            return self._tempo_bpm

    def update_tempo(self, value: float) -> TempoConfig:
        self.reload_if_needed()
        with self.lock:
            if self._tempo is None:
                raise ValueError("No tempo control configured")
            self._update_tempo_locked(value)
            return self._tempo

    def set_transport_playing(self, playing: bool) -> None:
        self.reload_if_needed()
        if playing:
            if self._transport.is_playing():
                return
            self._transport.start()
            self._handle_transport_start()
            return
        if not self._transport.is_playing():
            return
        self._transport.stop()
        self._handle_transport_stop()

    def is_transport_playing(self) -> bool:
        self.reload_if_needed()
        with self.lock:
            return self._transport.is_playing()

    def send_all_states(self) -> None:
        self.reload_if_needed()
        with self.lock:
            for slider in self._config.sliders:
                self._update_slider_locked(
                    slider, self._state.get(slider.state_key, float(slider.default)), force_midi=True
                )
            for curve in self._curves:
                self._send_curve_value_locked(curve, curve.default, force_midi=True)

    def send_keyboard_gate(self, *, state_key: str, note: int, gate: bool) -> None:
        self.reload_if_needed()
        with self.lock:
            keyboard = find_keyboard_by_key(self._config.layout, state_key)
            if keyboard is None:
                raise ValueError(f"Unknown keyboard key: {state_key}")
            self._send_note_gate_locked(
                output=keyboard.output, channel=keyboard.channel, note=note, gate=gate
            )

    def send_button_gate(self, *, state_key: str, gate: bool) -> None:
        self.reload_if_needed()
        with self.lock:
            button = self._buttons_by_key.get(state_key)
            if button is None:
                raise ValueError(f"Unknown button key: {state_key}")
            self._send_button_gate_locked(button=button, gate=gate)

    def update_sequencer_by_key(
        self, state_key: str, steps: list[dict[str, Any]]
    ) -> tuple[SequencerConfig, list[SequencerStepState]]:
        self.reload_if_needed()
        with self.lock:
            sequencer = self._sequencers_by_key.get(state_key)
            if sequencer is None:
                raise ValueError(f"Unknown sequencer key: {state_key}")
            normalized = normalize_sequencer_steps(
                sequencer,
                steps,
                config_path=self.config_path,
                path=Path("request"),
            )
            self._sequencer_state[sequencer.state_key] = normalized
            self._save_state_locked()
            return sequencer, normalized

    def get_sequencer_position(self, state_key: str) -> int:
        self.reload_if_needed()
        with self.lock:
            return self._sequencer_positions.get(state_key, -1)

    def apply_memory_slot(self, *, state_key: str, slot: int, action: str) -> None:
        self.reload_if_needed()
        with self.lock:
            memory = self._memories_by_key.get(state_key)
            if memory is None:
                raise ValueError(f"Unknown memory key: {state_key}")
            if not 0 <= slot < memory.slots:
                raise ValueError(f"Slot {slot} is out of range for memory '{memory.name}'")
            if action == "save":
                self._save_memory_slot_locked(memory, slot)
                return
            if action == "recall":
                self._recall_memory_slot_locked(memory, slot)
                return
            if action == "clear":
                self._clear_memory_slot_locked(memory, slot)
                return
            raise ValueError(f"Unsupported memory action: {action}")

    def apply_mutator(self, *, state_key: str, degree: float, action: str) -> None:
        self.reload_if_needed()
        with self.lock:
            mutator = self._mutators_by_key.get(state_key)
            if mutator is None:
                raise ValueError(f"Unknown mutator key: {state_key}")
            if action == "mutate":
                self._mutator_degrees[mutator.state_key] = degree
                self._mutate_target_locked(mutator, degree)
                return
            if action == "undo":
                self._mutator_degrees[mutator.state_key] = degree
                self._undo_mutator_locked(mutator)
                return
            raise ValueError(f"Unsupported mutator action: {action}")

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
            "transport": {
                "tempo": normalize_numeric_value(self._tempo_bpm),
                "playing": self.is_transport_playing(),
            },
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

        new_midi_outputs = None
        new_osc_client = None
        with self.lock:
            new_output_names = collect_midi_output_names(new_config)
            current_output_names = set(self._midi_outputs)
            if new_output_names != current_output_names:
                try:
                    new_midi_outputs = self._open_midi_outputs(new_output_names)
                except SystemExit as exc:
                    self._last_reload_error = str(exc)
                    print(f"Config reload failed: {exc}")
                    return False

            if new_config.osc != self._config.osc:
                try:
                    new_osc_client = self._open_osc_output(new_config.osc)
                except SystemExit as exc:
                    if new_midi_outputs is not None:
                        close_midi_outputs(new_midi_outputs)
                    self._last_reload_error = str(exc)
                    print(f"Config reload failed: {exc}")
                    return False

            old_midi_outputs = self._midi_outputs
            self._silence_active_buttons_locked()
            self._silence_active_sequencer_notes_locked()
            self._scheduled_sequencer_notes.clear()
            self._silence_active_notes_locked()
            if new_midi_outputs is not None:
                self._midi_outputs = new_midi_outputs
            self._transport.set_output(self._midi_outputs[self._transport_output_name(new_config)])
            if new_osc_client is not None or new_config.osc is None:
                self._osc_client = new_osc_client
            self._config = new_config
            if new_midi_outputs is not None:
                self._last_midi_values = {}
            self._sliders_by_key = {slider.state_key: slider for slider in new_config.sliders}
            self._curves = new_config.curves or []
            self._curves_by_key = {curve.state_key: curve for curve in self._curves}
            self._buttons_by_key = collect_buttons_by_key(new_config.layout)
            self._sequencers = new_config.sequencers or []
            self._sequencers_by_key = {
                sequencer.state_key: sequencer for sequencer in self._sequencers
            }
            self._memories = new_config.memories or []
            self._memories_by_key = {memory.state_key: memory for memory in self._memories}
            self._mutators = new_config.mutators or []
            self._mutators_by_key = {mutator.state_key: mutator for mutator in self._mutators}
            self._mutator_degrees = {
                mutator.state_key: self._mutator_degrees.get(mutator.state_key, mutator.default)
                for mutator in self._mutators
            }
            self._mutator_undo_state = {
                key: undo_state
                for key, undo_state in self._mutator_undo_state.items()
                if key in self._mutators_by_key
            }
            self._transition_generation = {
                key: generation
                for key, generation in self._transition_generation.items()
                if key in self._sliders_by_key
            }
            self._tempo = new_config.tempo
            self._active_buttons = {}
            self._reconcile_state()
            if self._tempo is not None:
                self._tempo_bpm = quantize_tempo_value(
                    self._tempo,
                    self._state.get(self._tempo.state_key, self._tempo.default),
                )
            else:
                self._tempo_bpm = new_config.bpm
            self._transport.set_bpm(self._tempo_bpm)
            self._file_mtime_ns = current_mtime_ns
            self._version += 1
            self._last_reload_error = None
            for slider in self._config.sliders:
                self._update_slider_locked(
                    slider,
                    self._state.get(slider.state_key, float(slider.default)),
                    force_midi=True,
                )
            for curve in self._curves:
                self._send_curve_value_locked(curve, curve.default, force_midi=True)

        if new_midi_outputs is not None:
            close_midi_outputs(old_midi_outputs)
        return True

    def _serialize_layout(self, node: LayoutNode) -> dict[str, Any]:
        if isinstance(node, SliderConfig):
            value = self.get_slider_value(node)
            return {
                "type": node.control_type,
                "key": node.state_key,
                "name": node.name,
                "complex": node.complex,
                "maxSpeed": normalize_numeric_value(node.max_speed),
                "quantizeSpeedToTempoDivisions": node.quantize_speed_to_tempo_divisions,
                "waveforms": list(node.lfo_waveforms),
                "shapeControl": node.lfo_shape_control,
                "value": value,
                "channel": node.channel,
                "control": node.control,
                "min": node.minimum,
                "max": node.maximum,
                "steps": node.steps,
                "speed": normalize_numeric_value(node.speed),
                "curve": normalize_numeric_value(node.curve),
                "orientation": node.orientation,
                "color": node.color,
                "showLabel": node.show_label,
                "width": serialize_size(node.width),
                "height": serialize_size(node.height),
                "osc": serialize_osc_route(node.osc),
                "label": self.format_slider_label(node, value),
            }
        if isinstance(node, KeyboardConfig):
            return {
                "type": "keyboard",
                "key": node.state_key,
                "name": node.name,
                "channel": node.channel,
                "start": node.start,
                "size": node.size,
                "scale": node.scale,
                "root": node.root,
                "color": node.color,
                "showLabel": node.show_label,
                "width": serialize_size(node.width),
                "height": serialize_size(node.height),
            }
        if isinstance(node, CurveConfig):
            return {
                "type": "curve",
                "key": node.state_key,
                "name": node.name,
                "mode": node.mode,
                "length": normalize_numeric_value(node.length),
                "default": node.default,
                "initial": node.default,
                "channel": node.channel,
                "control": node.control,
                "min": node.minimum,
                "max": node.maximum,
                "color": node.color,
                "showLabel": node.show_label,
                "width": serialize_size(node.width),
                "height": serialize_size(node.height),
                "osc": serialize_osc_route(node.osc),
            }
        if isinstance(node, TempoConfig):
            return {
                "type": "tempo",
                "key": node.state_key,
                "name": node.name,
                "value": self._tempo_bpm,
                "min": node.minimum,
                "max": node.maximum,
                "color": node.color,
                "showLabel": node.show_label,
                "width": serialize_size(node.width),
                "height": serialize_size(node.height),
                "playing": self._transport.is_playing(),
            }
        if isinstance(node, SequencerConfig):
            return {
                "type": "sequencer",
                "key": node.state_key,
                "name": node.name,
                "mode": node.mode,
                "channel": node.channel,
                "control": node.control,
                "size": node.size,
                "subdivision": node.subdivision_label,
                "subdivisionBeats": normalize_numeric_value(node.subdivision_beats),
                "min": node.minimum,
                "max": node.maximum,
                "root": node.root,
                "scale": node.scale,
                "velocityRow": node.velocity_row,
                "gateRow": node.gate_row,
                "timingRow": node.timing_row,
                "defaultVelocity": node.default_velocity,
                "defaultGate": normalize_numeric_value(node.default_gate),
                "defaultTiming": normalize_numeric_value(node.default_timing),
                "maxGateSteps": normalize_numeric_value(node.max_gate_steps),
                "color": node.color,
                "showLabel": node.show_label,
                "width": serialize_size(node.width),
                "height": serialize_size(node.height),
                "osc": serialize_osc_route(node.osc),
                "steps": serialize_sequencer_steps(self._sequencer_state.get(node.state_key, [])),
                "currentStep": self._sequencer_positions.get(node.state_key, -1),
            }
        if isinstance(node, ButtonConfig):
            return {
                "type": "button",
                "key": node.state_key,
                "name": node.name,
                "channel": node.channel,
                "control": node.control,
                "color": node.color,
                "showLabel": node.show_label,
                "width": serialize_size(node.width),
                "height": serialize_size(node.height),
                "osc": serialize_osc_route(node.osc),
            }
        if isinstance(node, MemoryConfig):
            slots = self._memory_state.get(node.state_key, [])
            return {
                "type": "memory",
                "key": node.state_key,
                "name": node.name,
                "target": node.target,
                "transition": normalize_numeric_value(node.transition),
                "slots": [slot is not None for slot in slots[: node.slots]] + [False] * max(0, node.slots - len(slots)),
                "color": node.color,
                "showLabel": node.show_label,
                "width": serialize_size(node.width),
                "height": serialize_size(node.height),
            }
        if isinstance(node, MutatorConfig):
            return {
                "type": "mutator",
                "key": node.state_key,
                "name": node.name,
                "target": node.target,
                "value": normalize_numeric_value(
                    self._mutator_degrees.get(node.state_key, node.default)
                ),
                "canUndo": node.state_key in self._mutator_undo_state,
                "color": node.color,
                "showLabel": node.show_label,
                "width": serialize_size(node.width),
                "height": serialize_size(node.height),
            }
        if isinstance(node, TabsConfig):
            return {
                "type": "tabs",
                "name": node.name,
                "width": serialize_size(node.width),
                "height": serialize_size(node.height),
                "tabs": [
                    {"name": tab.name, "content": self._serialize_layout(tab.content)} for tab in node.tabs
                ],
            }

        return {
            "type": "rows" if node.kind == "row" else "columns",
            "name": node.name,
            "width": serialize_size(node.width),
            "height": serialize_size(node.height),
            "children": [self._serialize_layout(child) for child in node.children],
        }

    def _reconcile_state(self) -> None:
        live_state: dict[str, float] = {}
        for slider in self._config.sliders:
            value = self._state.get(slider.state_key, float(slider.default))
            live_state[slider.state_key] = quantize_slider_value(slider, value)
        if self._tempo is not None:
            live_state[self._tempo.state_key] = quantize_tempo_value(
                self._tempo,
                self._state.get(self._tempo.state_key, self._tempo.default),
            )
        self._state = live_state
        live_sequences: dict[str, list[SequencerStepState]] = {}
        positions: dict[str, int] = {}
        progress: dict[str, float] = {}
        for sequencer in self._sequencers:
            live_sequences[sequencer.state_key] = normalize_sequencer_steps(
                sequencer,
                self._sequencer_state.get(sequencer.state_key, []),
                config_path=self.config_path,
                path=Path(sequencer.state_key),
            )
            previous_position = self._sequencer_positions.get(sequencer.state_key, -1)
            positions[sequencer.state_key] = (
                previous_position if previous_position < sequencer.size else -1
            )
            progress[sequencer.state_key] = self._sequencer_tick_progress.get(sequencer.state_key, 0.0)
        self._sequencer_state = live_sequences
        self._sequencer_positions = positions
        self._sequencer_tick_progress = progress
        live_memories: dict[str, list[MemorySlotState | None]] = {}
        for memory in self._memories:
            live_memories[memory.state_key] = self._normalize_memory_slots_locked(memory)
        self._memory_state = live_memories
        if self._tempo is not None:
            self._tempo_bpm = self._state[self._tempo.state_key]
        self._save_state_locked()

    def _update_slider_locked(self, slider: SliderConfig, value: float, *, force_midi: bool = False) -> None:
        self._transition_generation[slider.state_key] = (
            self._transition_generation.get(slider.state_key, 0) + 1
        )
        bounded = quantize_slider_value(slider, value)
        self._state[slider.state_key] = bounded
        self._save_state_locked()
        self._send_midi_value(slider, bounded, force=force_midi)
        self._send_osc_value(slider, bounded)

    def _send_curve_value_locked(self, curve: CurveConfig, value: float, *, force_midi: bool = False) -> None:
        bounded = quantize_curve_value(curve, value)
        self._send_midi_control_value(
            output=curve.output,
            state_key=curve.state_key,
            channel=curve.channel,
            control=curve.control,
            value=bounded,
            force=force_midi,
        )
        if curve.osc is None or self._osc_client is None:
            return
        osc_value = map_value(
            bounded,
            input_min=curve.minimum,
            input_max=curve.maximum,
            output_min=curve.osc.minimum,
            output_max=curve.osc.maximum,
        )
        self._osc_client.send_message(curve.osc.path, normalize_numeric_value(osc_value))

    def _update_tempo_locked(self, value: float) -> None:
        if self._tempo is None:
            raise ValueError("No tempo control configured")
        bounded = quantize_tempo_value(self._tempo, value)
        self._state[self._tempo.state_key] = bounded
        self._tempo_bpm = bounded
        self._save_state_locked()
        self._transport.set_bpm(bounded)

    def _handle_transport_start(self) -> None:
        with self.lock:
            self._scheduled_sequencer_notes.clear()
            for sequencer in self._sequencers:
                self._sequencer_positions[sequencer.state_key] = -1
                self._sequencer_tick_progress[sequencer.state_key] = 0.0
                self._advance_sequencer_locked(sequencer)

    def _handle_transport_stop(self) -> None:
        with self.lock:
            self._silence_active_sequencer_notes_locked()
            self._scheduled_sequencer_notes.clear()
            for sequencer in self._sequencers:
                self._sequencer_positions[sequencer.state_key] = -1
                self._sequencer_tick_progress[sequencer.state_key] = 0.0

    def _handle_transport_tick(self) -> None:
        with self.lock:
            self._tick_active_sequencer_notes_locked()
            self._tick_scheduled_sequencer_notes_locked()
            for sequencer in self._sequencers:
                if sequencer.size <= 0:
                    continue
                state_key = sequencer.state_key
                self._sequencer_tick_progress[state_key] = (
                    self._sequencer_tick_progress.get(state_key, 0.0) + 1.0
                )
                while self._sequencer_tick_progress[state_key] >= sequencer.ticks_per_step:
                    self._sequencer_tick_progress[state_key] -= sequencer.ticks_per_step
                    self._advance_sequencer_locked(sequencer)

    def _normalize_memory_slots_locked(self, memory: MemoryConfig) -> list[MemorySlotState | None]:
        slots = list(self._memory_state.get(memory.state_key, []))
        normalized = slots[: memory.slots]
        if len(normalized) < memory.slots:
            normalized.extend([None] * (memory.slots - len(normalized)))
        return normalized

    def _save_memory_slot_locked(self, memory: MemoryConfig, slot_index: int) -> None:
        target = resolve_memory_target(self._config.layout, memory.target)
        if target is None:
            raise ValueError(f"Unknown memory target: {memory.target}")
        slots = self._normalize_memory_slots_locked(memory)
        slots[slot_index] = self._capture_memory_slot_locked(target)
        self._memory_state[memory.state_key] = slots
        self._save_state_locked()

    def _recall_memory_slot_locked(self, memory: MemoryConfig, slot_index: int) -> None:
        slots = self._normalize_memory_slots_locked(memory)
        slot = slots[slot_index]
        if slot is None:
            return
        slider_transitions: list[tuple[SliderConfig, float, float, int]] = []
        for key, value in slot.numeric.items():
            slider = self._sliders_by_key.get(key)
            if slider is not None:
                current_value = self._state.get(slider.state_key, float(slider.default))
                bounded = quantize_slider_value(slider, value)
                if memory.transition > 0 and current_value != bounded:
                    self._state[slider.state_key] = bounded
                    generation = self._transition_generation.get(slider.state_key, 0) + 1
                    self._transition_generation[slider.state_key] = generation
                    slider_transitions.append((slider, current_value, bounded, generation))
                else:
                    self._transition_generation[slider.state_key] = (
                        self._transition_generation.get(slider.state_key, 0) + 1
                    )
                    self._update_slider_locked(slider, value, force_midi=True)
                continue
            if self._tempo is not None and key == self._tempo.state_key:
                self._update_tempo_locked(value)
        for key, steps in slot.sequencers.items():
            sequencer = self._sequencers_by_key.get(key)
            if sequencer is None:
                continue
            self._sequencer_state[key] = normalize_sequencer_steps(
                sequencer,
                steps,
                config_path=self.config_path,
                path=Path(key),
            )
        self._save_state_locked()
        if slider_transitions:
            self._start_slider_transition_locked(slider_transitions, duration=memory.transition)

    def _clear_memory_slot_locked(self, memory: MemoryConfig, slot_index: int) -> None:
        slots = self._normalize_memory_slots_locked(memory)
        slots[slot_index] = None
        self._memory_state[memory.state_key] = slots
        self._save_state_locked()

    def _mutate_target_locked(self, mutator: MutatorConfig, degree: float) -> None:
        if not 0 <= degree <= 1:
            raise ValueError("Mutator degree must be between 0 and 1")
        target = resolve_memory_target(self._config.layout, mutator.target)
        if target is None:
            raise ValueError(f"Unknown mutator target: {mutator.target}")
        before = self._capture_memory_slot_locked(target)
        mutated = self._mutated_slot_state_locked(mutator, target, before, degree)
        self._mutator_undo_state[mutator.state_key] = before
        self._apply_slot_state_locked(mutated)

    def _undo_mutator_locked(self, mutator: MutatorConfig) -> None:
        previous = self._mutator_undo_state.get(mutator.state_key)
        if previous is None:
            return
        self._apply_slot_state_locked(previous)
        del self._mutator_undo_state[mutator.state_key]

    def _apply_slot_state_locked(self, slot: MemorySlotState) -> None:
        for key, value in slot.numeric.items():
            slider = self._sliders_by_key.get(key)
            if slider is not None:
                self._update_slider_locked(slider, value, force_midi=True)
                continue
            if self._tempo is not None and key == self._tempo.state_key:
                self._update_tempo_locked(value)
        for key, steps in slot.sequencers.items():
            sequencer = self._sequencers_by_key.get(key)
            if sequencer is None:
                continue
            self._sequencer_state[key] = normalize_sequencer_steps(
                sequencer,
                steps,
                config_path=self.config_path,
                path=Path(key),
            )
        self._save_state_locked()

    def _mutated_slot_state_locked(
        self, mutator: MutatorConfig, target: LayoutNode, slot: MemorySlotState, degree: float
    ) -> MemorySlotState:
        numeric = dict(slot.numeric)
        sequencers = {
            key: [
                SequencerStepState(
                    enabled=step.enabled,
                    value=step.value,
                    velocity=step.velocity,
                    gate=step.gate,
                    timing=step.timing,
                )
                for step in steps
            ]
            for key, steps in slot.sequencers.items()
        }
        self._mutate_collected_state_locked(mutator, target, numeric, sequencers, degree)
        return MemorySlotState(numeric=numeric, sequencers=sequencers)

    def _mutate_collected_state_locked(
        self,
        mutator: MutatorConfig,
        node: LayoutNode,
        numeric: dict[str, float],
        sequencers: dict[str, list[SequencerStepState]],
        degree: float,
    ) -> None:
        if isinstance(node, SliderConfig):
            current = numeric.get(node.state_key, self._state.get(node.state_key, float(node.default)))
            target = random.uniform(node.minimum, node.maximum)
            numeric[node.state_key] = quantize_slider_value(
                node, current + ((target - current) * degree)
            )
            return
        if isinstance(node, TempoConfig):
            current = numeric.get(node.state_key, self._tempo_bpm)
            target = random.uniform(node.minimum, node.maximum)
            numeric[node.state_key] = quantize_tempo_value(
                node, current + ((target - current) * degree)
            )
            return
        if isinstance(node, SequencerConfig):
            steps = sequencers.get(node.state_key, [])
            sequencers[node.state_key] = [
                self._mutated_sequencer_step(mutator, node, step, degree) for step in steps
            ]
            return
        if isinstance(node, (KeyboardConfig, ButtonConfig, CurveConfig, MemoryConfig, MutatorConfig)):
            return
        if isinstance(node, TabsConfig):
            for tab in node.tabs:
                self._mutate_collected_state_locked(mutator, tab.content, numeric, sequencers, degree)
            return
        for child in node.children:
            self._mutate_collected_state_locked(mutator, child, numeric, sequencers, degree)

    def _mutated_sequencer_step(
        self, mutator: MutatorConfig, sequencer: SequencerConfig, step: SequencerStepState, degree: float
    ) -> SequencerStepState:
        value_target = random.randint(sequencer.minimum, sequencer.maximum)
        velocity_target = random.randint(1, 127)
        gate_target = random.uniform(0.01, sequencer.max_gate_steps)
        timing_target = random.uniform(-1.0, 1.0)
        enabled = (
            random.choice((True, False))
            if mutator.mutate_sequencer_step and random.random() < degree
            else step.enabled
        )
        return SequencerStepState(
            enabled=enabled,
            value=round(step.value + ((value_target - step.value) * degree))
            if mutator.mutate_sequencer_note
            else step.value,
            velocity=round(step.velocity + ((velocity_target - step.velocity) * degree))
            if mutator.mutate_sequencer_velocity
            else step.velocity,
            gate=step.gate + ((gate_target - step.gate) * degree)
            if mutator.mutate_sequencer_gate
            else step.gate,
            timing=step.timing + ((timing_target - step.timing) * degree)
            if mutator.mutate_sequencer_timing
            else step.timing,
        )

    def _start_slider_transition_locked(
        self,
        transitions: list[tuple[SliderConfig, float, float, int]],
        *,
        duration: float,
    ) -> None:
        transition_items = list(transitions)

        def run_transition() -> None:
            started_at = time.monotonic()
            frame_interval = 1.0 / 60.0
            while True:
                elapsed = time.monotonic() - started_at
                progress = min(1.0, elapsed / max(duration, 0.001))
                with self.lock:
                    for slider, start_value, end_value, generation in transition_items:
                        if self._transition_generation.get(slider.state_key) != generation:
                            continue
                        value = start_value + ((end_value - start_value) * progress)
                        quantized = quantize_slider_value(slider, value)
                        self._send_midi_value(slider, quantized, force=progress >= 1.0)
                        self._send_osc_value(slider, quantized)
                if progress >= 1.0:
                    return
                time.sleep(frame_interval)

        Thread(target=run_transition, name="visual-midi-memory-transition", daemon=True).start()

    def _capture_memory_slot_locked(self, node: LayoutNode) -> MemorySlotState:
        numeric: dict[str, float] = {}
        sequencers: dict[str, list[SequencerStepState]] = {}
        self._collect_recallable_state_locked(node, numeric, sequencers)
        return MemorySlotState(numeric=numeric, sequencers=sequencers)

    def _collect_recallable_state_locked(
        self,
        node: LayoutNode,
        numeric: dict[str, float],
        sequencers: dict[str, list[SequencerStepState]],
    ) -> None:
        if isinstance(node, SliderConfig):
            numeric[node.state_key] = self._state.get(node.state_key, float(node.default))
            return
        if isinstance(node, TempoConfig):
            numeric[node.state_key] = self._tempo_bpm
            return
        if isinstance(node, SequencerConfig):
            sequencers[node.state_key] = [
                SequencerStepState(
                    enabled=step.enabled,
                    value=step.value,
                    velocity=step.velocity,
                    gate=step.gate,
                    timing=step.timing,
                )
                for step in self._sequencer_state.get(node.state_key, [])
            ]
            return
        if isinstance(node, (KeyboardConfig, ButtonConfig, CurveConfig, MemoryConfig, MutatorConfig)):
            return
        if isinstance(node, TabsConfig):
            for tab in node.tabs:
                self._collect_recallable_state_locked(tab.content, numeric, sequencers)
            return
        for child in node.children:
            self._collect_recallable_state_locked(child, numeric, sequencers)

    def _save_state_locked(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        with self.state_path.open("w", encoding="utf-8") as handle:
            json.dump(
                {
                    **{key: normalize_numeric_value(value) for key, value in self._state.items()},
                    **{
                        key: serialize_sequencer_steps(steps)
                        for key, steps in self._sequencer_state.items()
                    },
                    **{
                        key: {
                            "slots": [
                                None
                                if slot is None
                                else {
                                    "numeric": {
                                        slot_key: normalize_numeric_value(slot_value)
                                        for slot_key, slot_value in slot.numeric.items()
                                    },
                                    "sequencers": {
                                        sequencer_key: serialize_sequencer_steps(sequencer_steps)
                                        for sequencer_key, sequencer_steps in slot.sequencers.items()
                                    },
                                }
                                for slot in slots
                            ]
                        }
                        for key, slots in self._memory_state.items()
                    },
                },
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

    def _open_midi_outputs(self, output_names: set[str]) -> dict[str, mido.ports.BaseOutput]:
        opened: dict[str, mido.ports.BaseOutput] = {}
        try:
            for output_name in sorted(output_names):
                opened[output_name] = self._open_midi_output(output_name)
        except SystemExit:
            close_midi_outputs(opened)
            raise
        return opened

    def _midi_output(self, output_name: str) -> mido.ports.BaseOutput:
        try:
            return self._midi_outputs[output_name]
        except KeyError as exc:
            raise ValueError(f"Unknown MIDI output: {output_name}") from exc

    def _transport_output_name(self, config: AppConfig) -> str:
        if config.tempo is not None:
            return config.tempo.output
        return config.output

    def _send_midi_value(self, slider: SliderConfig, value: float, *, force: bool = False) -> None:
        self._send_midi_control_value(
            output=slider.output,
            state_key=slider.state_key,
            channel=slider.channel,
            control=slider.control,
            value=value,
            force=force,
        )

    def _send_midi_control_value(
        self,
        *,
        output: str,
        state_key: str,
        channel: int,
        control: int,
        value: float,
        force: bool = False,
    ) -> None:
        midi_value = clamp_numeric_value(round(value), minimum=0, maximum=127)
        midi_value = int(midi_value)
        midi_key = f"{output}:{state_key}"
        previous_value = self._last_midi_values.get(midi_key)
        if not force and previous_value == midi_value:
            return
        message = mido.Message(
            "control_change",
            channel=channel - 1,
            control=control,
            value=midi_value,
        )
        self._midi_output(output).send(message)
        self._last_midi_values[midi_key] = midi_value

    def _send_note_gate_locked(self, *, output: str, channel: int, note: int, gate: bool) -> None:
        note_key = (output, channel, note)
        count = self._active_notes.get(note_key, 0)
        if gate:
            self._active_notes[note_key] = count + 1
            if count > 0:
                return
            message = mido.Message("note_on", channel=channel - 1, note=note, velocity=127)
            self._midi_output(output).send(message)
            return

        if count <= 0:
            return
        if count == 1:
            self._active_notes.pop(note_key, None)
            message = mido.Message("note_off", channel=channel - 1, note=note, velocity=0)
            self._midi_output(output).send(message)
            return
        self._active_notes[note_key] = count - 1

    def _send_note_on_locked(self, *, output: str, channel: int, note: int, velocity: int) -> None:
        note_key = (output, channel, note)
        count = self._active_notes.get(note_key, 0)
        self._active_notes[note_key] = count + 1
        if count > 0:
            return
        message = mido.Message(
            "note_on",
            channel=channel - 1,
            note=note,
            velocity=validate_range(velocity, 0, 127, "velocity", self.config_path),
        )
        self._midi_output(output).send(message)

    def _silence_active_notes_locked(self) -> None:
        for (output, channel, note), _count in list(self._active_notes.items()):
            message = mido.Message("note_off", channel=channel - 1, note=note, velocity=0)
            self._midi_output(output).send(message)
        self._active_notes.clear()

    def _advance_sequencer_locked(self, sequencer: SequencerConfig) -> None:
        state_key = sequencer.state_key
        previous_index = self._sequencer_positions.get(state_key, -1)
        next_index = (previous_index + 1) % sequencer.size
        self._sequencer_positions[state_key] = next_index
        steps = self._sequencer_state.get(state_key, [])
        if next_index >= len(steps):
            if sequencer.mode == "notes":
                self._send_sequencer_note_locked(sequencer, None)
            return

        step = steps[next_index]
        if sequencer.mode == "notes":
            if step.timing >= 0 or previous_index < 0:
                offset_ticks = 0 if previous_index < 0 and step.timing < 0 else step_timing_ticks(
                    sequencer, step.timing
                )
                self._schedule_sequencer_note_locked(sequencer, step, offset_ticks=offset_ticks)
            following_step = steps[(next_index + 1) % sequencer.size]
            if following_step.timing < 0:
                self._schedule_sequencer_note_locked(
                    sequencer,
                    following_step,
                    offset_ticks=step_timing_ticks(sequencer, following_step.timing + 1.0),
                )
            return
        if step.enabled:
            self._send_sequencer_cc_locked(sequencer, step.value)
            self._send_sequencer_osc_locked(sequencer, step.value)

    def _schedule_sequencer_note_locked(
        self, sequencer: SequencerConfig, step: SequencerStepState, *, offset_ticks: int
    ) -> None:
        if not step.enabled:
            return
        gate_ticks = sequencer_gate_ticks(sequencer, step.gate)
        if offset_ticks <= 0:
            self._send_sequencer_note_locked(sequencer, step.value, step.velocity, gate_ticks)
            return
        self._scheduled_sequencer_notes.append(
            ScheduledSequencerNote(
                state_key=sequencer.state_key,
                note=step.value,
                velocity=step.velocity,
                gate_ticks=gate_ticks,
                remaining_ticks=offset_ticks,
            )
        )

    def _tick_scheduled_sequencer_notes_locked(self) -> None:
        remaining: list[ScheduledSequencerNote] = []
        for scheduled in self._scheduled_sequencer_notes:
            scheduled.remaining_ticks -= 1
            if scheduled.remaining_ticks > 0:
                remaining.append(scheduled)
                continue
            sequencer = self._sequencers_by_key.get(scheduled.state_key)
            if sequencer is None:
                continue
            self._send_sequencer_note_locked(
                sequencer,
                scheduled.note,
                scheduled.velocity,
                scheduled.gate_ticks,
            )
        self._scheduled_sequencer_notes = remaining

    def _send_sequencer_note_locked(
        self,
        sequencer: SequencerConfig,
        note: int | None,
        velocity: int = 127,
        gate_ticks: int = 0,
    ) -> None:
        if note is None:
            return
        self._send_note_on_locked(
            output=sequencer.output, channel=sequencer.channel, note=note, velocity=velocity
        )
        self._active_sequencer_note_id += 1
        self._active_sequencer_notes[self._active_sequencer_note_id] = ActiveSequencerNote(
            state_key=sequencer.state_key,
            note=note,
            remaining_ticks=max(1, gate_ticks),
        )

    def _tick_active_sequencer_notes_locked(self) -> None:
        for note_id, active in list(self._active_sequencer_notes.items()):
            sequencer = self._sequencers_by_key.get(active.state_key)
            if sequencer is None:
                self._active_sequencer_notes.pop(note_id, None)
                continue
            active.remaining_ticks -= 1
            if active.remaining_ticks > 0:
                continue
            self._send_note_gate_locked(
                output=sequencer.output, channel=sequencer.channel, note=active.note, gate=False
            )
            self._active_sequencer_notes.pop(note_id, None)

    def _silence_active_sequencer_notes_locked(self) -> None:
        for _note_id, active in list(self._active_sequencer_notes.items()):
            sequencer = self._sequencers_by_key.get(active.state_key)
            if sequencer is None:
                continue
            self._send_note_gate_locked(
                output=sequencer.output, channel=sequencer.channel, note=active.note, gate=False
            )
        self._active_sequencer_notes.clear()

    def _silence_active_buttons_locked(self) -> None:
        for state_key in list(self._active_buttons):
            button = self._buttons_by_key.get(state_key)
            if button is None:
                continue
            self._send_button_cc_locked(button, 0)
            self._send_button_osc_locked(button, 0)
        self._active_buttons.clear()

    def _send_button_gate_locked(self, *, button: ButtonConfig, gate: bool) -> None:
        count = self._active_buttons.get(button.state_key, 0)
        if gate:
            self._active_buttons[button.state_key] = count + 1
            if count > 0:
                return
            self._send_button_cc_locked(button, 127)
            self._send_button_osc_locked(button, 1)
            return

        if count <= 0:
            return
        if count == 1:
            self._active_buttons.pop(button.state_key, None)
            self._send_button_cc_locked(button, 0)
            self._send_button_osc_locked(button, 0)
            return
        self._active_buttons[button.state_key] = count - 1

    def _send_button_cc_locked(self, button: ButtonConfig, value: int) -> None:
        message = mido.Message(
            "control_change",
            channel=button.channel - 1,
            control=button.control,
            value=value,
        )
        self._midi_output(button.output).send(message)

    def _send_sequencer_cc_locked(self, sequencer: SequencerConfig, value: int) -> None:
        if sequencer.control is None:
            return
        message = mido.Message(
            "control_change",
            channel=sequencer.channel - 1,
            control=sequencer.control,
            value=value,
        )
        self._midi_output(sequencer.output).send(message)

    def _send_button_osc_locked(self, button: ButtonConfig, value: int) -> None:
        if button.osc is None or self._osc_client is None:
            return
        self._osc_client.send_message(button.osc.path, value)

    def _send_sequencer_osc_locked(self, sequencer: SequencerConfig, value: int) -> None:
        if sequencer.osc is None or self._osc_client is None:
            return
        osc_value = map_value(
            value,
            input_min=sequencer.minimum,
            input_max=sequencer.maximum,
            output_min=sequencer.osc.minimum,
            output_max=sequencer.osc.maximum,
        )
        self._osc_client.send_message(sequencer.osc.path, normalize_numeric_value(osc_value))

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


def close_midi_outputs(outputs: dict[str, mido.ports.BaseOutput]) -> None:
    for midi_out in outputs.values():
        midi_out.close()


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


def quantize_slider_value(slider: SliderConfig, value: float) -> float:
    bounded = clamp_numeric_value(value, minimum=slider.minimum, maximum=slider.maximum)
    if slider.steps is None:
        return bounded

    if slider.maximum == slider.minimum:
        return float(slider.minimum)

    step_size = (slider.maximum - slider.minimum) / (slider.steps - 1)
    step_index = round((bounded - slider.minimum) / step_size)
    quantized = slider.minimum + (step_index * step_size)
    return clamp_numeric_value(quantized, minimum=slider.minimum, maximum=slider.maximum)


def quantize_curve_value(curve: CurveConfig, value: float) -> float:
    return clamp_numeric_value(value, minimum=curve.minimum, maximum=curve.maximum)


def quantize_tempo_value(tempo: TempoConfig, value: float) -> float:
    bounded = clamp_numeric_value(value, minimum=tempo.minimum, maximum=tempo.maximum)
    return round(bounded * 10.0) / 10.0


def normalize_sequencer_steps(
    sequencer: SequencerConfig,
    raw_steps: list[Any],
    *,
    config_path: Path,
    path: Path,
) -> list[SequencerStepState]:
    steps: list[SequencerStepState] = []
    for index in range(sequencer.size):
        raw_step = raw_steps[index] if index < len(raw_steps) else None
        default_value = default_sequencer_value(sequencer)
        if raw_step is None:
            steps.append(
                SequencerStepState(
                    enabled=False,
                    value=default_value,
                    velocity=sequencer.default_velocity,
                    gate=quantize_sequencer_gate(sequencer, sequencer.default_gate),
                    timing=quantize_sequencer_timing(sequencer.default_timing),
                )
            )
            continue
        if isinstance(raw_step, SequencerStepState):
            steps.append(
                SequencerStepState(
                    enabled=bool(raw_step.enabled),
                    value=quantize_sequencer_value(sequencer, float(raw_step.value)),
                    velocity=quantize_sequencer_velocity(raw_step.velocity),
                    gate=quantize_sequencer_gate(sequencer, raw_step.gate),
                    timing=quantize_sequencer_timing(raw_step.timing),
                )
            )
            continue
        if not isinstance(raw_step, dict):
            raise SystemExit(f"{config_path} {path}[{index}] must be a mapping")
        raw_value = raw_step.get("value", default_value)
        if isinstance(raw_value, bool) or not isinstance(raw_value, (int, float)):
            raise SystemExit(f"{config_path} {path}[{index}].value must be a number")
        raw_velocity = raw_step.get("velocity", sequencer.default_velocity)
        if isinstance(raw_velocity, bool) or not isinstance(raw_velocity, (int, float)):
            raise SystemExit(f"{config_path} {path}[{index}].velocity must be a number")
        raw_gate = raw_step.get("gate", sequencer.default_gate)
        if isinstance(raw_gate, bool) or not isinstance(raw_gate, (int, float)):
            raise SystemExit(f"{config_path} {path}[{index}].gate must be a number")
        raw_timing = raw_step.get("timing", sequencer.default_timing)
        if isinstance(raw_timing, bool) or not isinstance(raw_timing, (int, float)):
            raise SystemExit(f"{config_path} {path}[{index}].timing must be a number")
        steps.append(
            SequencerStepState(
                enabled=bool(raw_step.get("enabled", False)),
                value=quantize_sequencer_value(sequencer, float(raw_value)),
                velocity=quantize_sequencer_velocity(raw_velocity),
                gate=quantize_sequencer_gate(sequencer, raw_gate),
                timing=quantize_sequencer_timing(raw_timing),
            )
        )
    return steps


def default_sequencer_value(sequencer: SequencerConfig) -> int:
    if sequencer.mode == "notes":
        base = sequencer.root if sequencer.root is not None else 60
        return quantize_sequencer_value(sequencer, float(base))
    midpoint = (sequencer.minimum + sequencer.maximum) / 2.0
    return quantize_sequencer_value(sequencer, midpoint)


def quantize_sequencer_value(sequencer: SequencerConfig, value: float) -> int:
    bounded = int(round(clamp_numeric_value(value, minimum=sequencer.minimum, maximum=sequencer.maximum)))
    if sequencer.mode != "notes" or sequencer.scale is None or sequencer.root is None:
        return bounded

    allowed = SCALE_PATTERNS[sequencer.scale]
    best_note = bounded
    best_distance = float("inf")
    for note in range(sequencer.minimum, sequencer.maximum + 1):
        pitch_class = (note - sequencer.root) % 12
        if pitch_class not in allowed:
            continue
        distance = abs(note - bounded)
        if distance < best_distance or (distance == best_distance and note < best_note):
            best_note = note
            best_distance = distance
    return best_note


def quantize_sequencer_velocity(value: float) -> int:
    return int(round(clamp_numeric_value(value, minimum=1, maximum=127)))


def quantize_sequencer_gate(sequencer: SequencerConfig, value: float) -> float:
    bounded = clamp_numeric_value(value, minimum=0.05, maximum=sequencer.max_gate_steps)
    return round(bounded * 100.0) / 100.0


def quantize_sequencer_timing(value: float) -> float:
    return round(clamp_numeric_value(value, minimum=-1.0, maximum=1.0) * 100.0) / 100.0


def sequencer_gate_ticks(sequencer: SequencerConfig, gate: float) -> int:
    return max(1, int(round(quantize_sequencer_gate(sequencer, gate) * sequencer.ticks_per_step)))


def step_timing_ticks(sequencer: SequencerConfig, timing: float) -> int:
    return max(0, int(round(quantize_sequencer_timing(timing) * sequencer.ticks_per_step)))


def serialize_sequencer_steps(steps: list[SequencerStepState]) -> list[dict[str, Any]]:
    return [
        {
            "enabled": step.enabled,
            "value": normalize_numeric_value(step.value),
            "velocity": normalize_numeric_value(step.velocity),
            "gate": normalize_numeric_value(step.gate),
            "timing": normalize_numeric_value(step.timing),
        }
        for step in steps
    ]


def normalize_numeric_value(value: float) -> int | float:
    if float(value).is_integer():
        return int(value)
    return value
