"""Thin wrapper around the `allin1` (All-In-One) MIR model.

allin1 predicts everything the stage-session workflow needs in one pass:

    bpm        tempo of the reference track
    downbeats  absolute times of beat 1 of every measure
    beats      absolute times of every beat
    segments    labelled section boundaries (intro / verse / chorus / ...)

We call it from a small local HTTP server so LibreTracks never has to ship a
Python runtime or a neural network inside the Tauri bundle.

Two practical concerns drive the shape of this module:

* **Load cost.** Importing allin1 pulls in torch, NATTEN and the model
  checkpoint — seconds to minutes, not milliseconds. The model is therefore
  imported lazily and kept alive in a module-level slot for the process
  lifetime.
* **Analysis cost.** On a CPU-only machine a single track can take a while, so
  every result is cached on disk keyed by (absolute path, mtime, model).
  Re-opening a Sunday session must not re-run the network.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

# The model is loaded on first use, not at import time: `server.py --check`
# must be able to start and report diagnostics without paying for it.
#
# Default to a single fold rather than `harmonix-all`: the ensemble averages
# all eight folds and is noticeably more accurate, but costs 8x the wall clock
# — on a CPU-only machine that is the difference between "a minute per song"
# and "a coffee break per song". Set LT_MIR_MODEL=harmonix-all when accuracy
# matters more than the wait.
_MODEL_NAME = os.environ.get("LT_MIR_MODEL", "harmonix-fold0")
_DEVICE = os.environ.get("LT_MIR_DEVICE", "cpu")

CACHE_DIR = Path(__file__).resolve().parent / "cache"

# Where ensure_ffmpeg_on_path() publishes a copy/symlink literally named
# `ffmpeg`. See that function for why the name matters.
SHIM_DIR = Path(__file__).resolve().parent / "bin"

# Non-WAV inputs are decoded to WAV here before analysis (see
# prepare_audio_for_analysis). Keyed by source mtime so re-recording a track
# re-decodes it, while re-analysing an unchanged one is free.
DECODED_DIR = Path(__file__).resolve().parent / "decoded"

# allin1's Harmonix label vocabulary. Mirrored here so the HTTP contract does
# not change if the model is swapped out.
HARMONIX_LABELS = [
    "start",
    "end",
    "intro",
    "outro",
    "break",
    "bridge",
    "inst",
    "solo",
    "verse",
    "chorus",
]


class AnalysisError(RuntimeError):
    """A user-facing analysis failure (bad file, model missing, timeout)."""


_loaded_state: dict[str, Any] = {}


def _import_allin1():
    """Import allin1, translating the dependency failures we actually hit."""
    try:
        import allin1  # noqa: PLC0415 - deliberate lazy import
    except ImportError as exc:  # pragma: no cover - depends on the venv
        missing = str(exc).split("'")[-2] if "'" in str(exc) else str(exc)
        raise AnalysisError(
            f"The analysis model is not installed ({missing}). "
            "Run install.bat inside analysis-service to set it up."
        ) from exc
    return allin1


def ensure_ffmpeg_on_path() -> str | None:
    """Expose a bundled ffmpeg so non-WAV reference tracks can be decoded.

    allin1 reads audio through Demucs, which falls back to launching a
    subprocess. Two traps on a bare Windows box:

    1. ffmpeg is not on PATH at all.
    2. Even with `imageio-ffmpeg` installed, its binary is named
       ``ffmpeg-win-x86_64-v7.1.exe`` — but demucs hardcodes the command
       ``['ffmpeg', '-y']`` (demucs/audio.py) and raises
       ``FileNotFoundError: FFmpeg is not installed.`` for anything that does
       not resolve to that exact name.

    So we publish a shim under ``bin/`` whose name IS ``ffmpeg``, as a hard
    link to imageio's binary (no duplicated ~30 MB, and pip's install stays
    byte-identical), and put that directory first on PATH.
    """
    try:
        import imageio_ffmpeg  # noqa: PLC0415
    except Exception:  # noqa: BLE001 - absence is not an error here
        return None

    try:
        exe = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        return None

    shim_name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    try:
        source = Path(exe).resolve()
        SHIM_DIR.mkdir(parents=True, exist_ok=True)
        shim = SHIM_DIR / shim_name
        if not shim.exists() or shim.stat().st_size != source.stat().st_size:
            shim.unlink(missing_ok=True)
            try:
                os.link(source, shim)
            except OSError:
                # Different volume, or a filesystem without hard links.
                shutil.copy2(source, shim)
    except Exception:  # noqa: BLE001 - fall back to the raw imageio path
        shim = Path(exe)

    entries = os.environ.get("PATH", "").split(os.pathsep)
    shim_dir = str(shim.parent)
    if shim_dir not in entries:
        os.environ["PATH"] = shim_dir + os.pathsep + os.environ.get("PATH", "")
    return str(shim)


def model_name() -> str:
    return _MODEL_NAME


def is_available() -> tuple[bool, str]:
    """Whether the model can run here, with a human-readable detail."""
    try:
        _import_allin1()
    except AnalysisError as exc:
        return False, str(exc)

    # NATTEN removed both the API allin1 calls and the CPU kernels it needs,
    # so a too-new (or too-old) install looks "present" but cannot execute.
    detail = f"allin1 ready (model={_MODEL_NAME}, device={_DEVICE})"
    missing = _check_natten()
    if missing:
        return False, missing
    return True, detail


def _check_natten() -> str | None:
    try:
        import natten.functional as functional  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        return f"NATTEN is not usable: {exc}"

    required = ("natten1dav", "natten1dqkrpb", "natten2dav", "natten2dqkrpb")
    missing = [name for name in required if not hasattr(functional, name)]
    if missing:
        return (
            "NATTEN version mismatch — allin1 needs the legacy ops "
            f"({', '.join(missing)}). Install natten==0.17.4."
        )
    return None


def _cache_key(path: Path, model: str) -> str:
    stat = path.stat()
    payload = f"{path}|{stat.st_mtime_ns}|{stat.st_size}|{model}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _load_from_cache(key: str) -> dict[str, Any] | None:
    cache_file = CACHE_DIR / f"{key}.json"
    if not cache_file.is_file():
        return None
    try:
        return json.loads(cache_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        # A corrupt cache entry must never break analysis; just recompute.
        return None


def _store_in_cache(key: str, payload: dict[str, Any]) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        (CACHE_DIR / f"{key}.json").write_text(
            json.dumps(payload), encoding="utf-8"
        )
    except OSError:
        # Caching is best-effort — the caller still gets the fresh result.
        pass


def prepare_audio_for_analysis(path: Path) -> Path:
    """Hand `analyze` something demucs can read without reaching for ffprobe.

    demucs reads WAV through `sphn`, but every other format falls back to its
    `AudioFile` helper, whose first act is to shell out to **ffprobe**
    (demucs/audio.py `_read_info`). `imageio-ffmpeg` ships ffmpeg and nothing
    else, so ffprobe raises FileNotFoundError — which demucs reports as the
    misleading "FFmpeg is not installed." That is why WAVs analysed fine while
    the Sunday m4a died.

    Decoding to WAV up front keeps the whole pipeline inside the single binary
    we actually have, and is fast (decode only, no re-encode of the model
    input — demucs resamples to its own rate anyway).
    """
    if path.suffix.lower() == ".wav":
        return path

    exe = ensure_ffmpeg_on_path()
    if not exe:
        raise AnalysisError(
            f"{path.name} is not WAV and no ffmpeg is available to decode it. "
            "Run install.bat inside analysis-service."
        )

    try:
        DECODED_DIR.mkdir(parents=True, exist_ok=True)
        stamp = path.stat().st_mtime_ns
    except OSError:
        return path

    out = DECODED_DIR / f"{path.stem}-{stamp}.wav"
    if out.is_file() and out.stat().st_size > 0:
        return out

    command = [exe, "-y", "-loglevel", "error", "-i", str(path), "-ac", "2", str(out)]
    try:
        subprocess.run(command, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        out.unlink(missing_ok=True)
        detail = (exc.stderr or "").strip() or str(exc)
        raise AnalysisError(f"Could not decode {path.name}: {detail}") from exc
    except OSError as exc:
        out.unlink(missing_ok=True)
        raise AnalysisError(f"Could not run ffmpeg to decode {path.name}: {exc}") from exc
    return out


def analyze(path_str: str, use_cache: bool = True) -> dict[str, Any]:
    """Run structure analysis on one audio file and return a plain dict."""
    path = Path(path_str).expanduser()
    if not path.is_file():
        raise AnalysisError(f"Audio file not found: {path}")
    if path.suffix.lower() not in ALLOWED_EXTENSIONS:
        raise AnalysisError(
            f"Unsupported audio type '{path.suffix}'. "
            f"Use one of: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
        )

    key = _cache_key(path, _MODEL_NAME)
    if use_cache:
        cached = _load_from_cache(key)
        if cached is not None:
            cached["cached"] = True
            # Entries written before the header fallback existed have no
            # duration. Fill it in (and persist) so every caller sees the same
            # shape regardless of when the song was first analysed.
            if not cached.get("durationSeconds"):
                duration = _file_duration(path)
                if duration:
                    cached["durationSeconds"] = duration
                    _store_in_cache(key, {k: v for k, v in cached.items() if k != "cached"})
            return cached

    ensure_ffmpeg_on_path()
    allin1 = _import_allin1()
    source = prepare_audio_for_analysis(path)

    started = time.perf_counter()
    try:
        result = allin1.analyze(str(source), model=_MODEL_NAME, device=_DEVICE)
    except Exception as exc:  # noqa: BLE001 - surfaced to the caller verbatim
        raise AnalysisError(f"Analysis failed: {exc}") from exc
    elapsed_ms = int((time.perf_counter() - started) * 1000)

    # allin1 returns a single result for a single path, but be defensive about
    # it returning a list if the call shape ever changes.
    if isinstance(result, (list, tuple)):
        if not result:
            raise AnalysisError("The model returned no result for this file")
        result = result[0]

    payload = {
        "path": str(path),
        "bpm": _as_number(getattr(result, "bpm", None)),
        "downbeats": [_as_number(v) for v in (getattr(result, "downbeats", None) or [])],
        "beats": [_as_number(v) for v in (getattr(result, "beats", None) or [])],
        "segments": [
            {
                "start": _as_number(segment.start),
                "end": _as_number(segment.end),
                "label": str(segment.label),
            }
            for segment in (getattr(result, "segments", None) or [])
            if getattr(segment, "start", None) is not None
        ],
        "durationSeconds": _as_number(getattr(result, "duration", None))
        or _file_duration(source)
        or _file_duration(path),
        "model": _MODEL_NAME,
        "labels": HARMONIX_LABELS,
        "analysisMillis": elapsed_ms,
        "cached": False,
    }

    _store_in_cache(key, payload)
    return payload


ALLOWED_EXTENSIONS = {
    ".mp3",
    ".wav",
    ".flac",
    ".m4a",
    ".ogg",
    ".aac",
    ".opus",
    ".aiff",
    ".aif",
    ".wma",
}


def _file_duration(path: Path) -> float | None:
    """Length of the audio from its header — no decoding, no model.

    allin1's result carries no duration, and the planner needs one to know
    where the NEXT song starts. Falling back to a header read keeps that
    decision independent of whether the model happened to label anything.
    """
    try:
        import soundfile  # noqa: PLC0415 - optional at import time

        info = soundfile.info(str(path))
        if info.samplerate:
            return round(info.frames / info.samplerate, 6)
    except Exception:  # noqa: BLE001 - fall through to librosa
        pass
    try:
        import librosa  # noqa: PLC0415

        return round(float(librosa.get_duration(path=str(path))), 6)
    except Exception:  # noqa: BLE001 - unknown length is not fatal
        return None


def _as_number(value: Any) -> float | None:
    """Coerce model output to JSON-safe numbers (numpy scalars, NaN, ...)."""
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    # Round away numpy/tensor float dust; microsecond precision is plenty.
    return round(number, 6)


def clear_cache() -> int:
    """Drop every cached analysis. Returns the number of files removed."""
    if not CACHE_DIR.is_dir():
        return 0
    removed = 0
    for entry in CACHE_DIR.glob("*.json"):
        try:
            entry.unlink()
            removed += 1
        except OSError:
            continue
    return removed


def cache_stats() -> dict[str, Any]:
    if not CACHE_DIR.is_dir():
        return {"entries": 0, "bytes": 0}
    entries = list(CACHE_DIR.glob("*.json"))
    return {
        "entries": len(entries),
        "bytes": sum(entry.stat().st_size for entry in entries),
        "path": str(CACHE_DIR),
    }


if __name__ == "__main__":  # pragma: no cover - manual smoke test
    if len(sys.argv) < 2:
        print("usage: python analyzer.py <audio-file>")
        raise SystemExit(2)
    ok, detail = is_available()
    print("available:", ok, "-", detail)
    if ok:
        print(json.dumps(analyze(sys.argv[1]), indent=2))
