#!/usr/bin/env python3
from __future__ import annotations

import argparse
import mimetypes
import platform
import shutil
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("NEON_STUDIO_DATA", ROOT / ".neon-data"))
DB_PATH = DATA_DIR / "studio.sqlite3"
EXPORT_DIR = DATA_DIR / "exports"
CHUNK_DIR = DATA_DIR / "chunks"
ASSET_MANIFEST = ROOT / "assets" / "manifest.json"
PORT = int(os.environ.get("NEON_STUDIO_PORT", "43187"))
WHISPER_MODEL = ROOT / "assets" / "models" / "whisper" / "ggml-large-v3-turbo-q8_0.bin"
SILERO_VAD_MODEL = ROOT / "assets" / "models" / "vad" / "ggml-silero-v6.2.0.bin"
SUPPORTED_LANGUAGES = {"tr", "en", "de", "fr", "es", "ar"}
VAD_MIN_SPEECH_MS = 350
VAD_MIN_SILENCE_MS = 550
VAD_MAX_SPEECH_SECONDS = 28
VAD_SPEECH_PAD_MS = 850
VAD_SAMPLES_OVERLAP_SECONDS = 0.25
HALLUCINATION_BLOCKLIST = {
    "altyazi mk",
    "altyazi m k",
    "altyazi m.k",
    "altyazı mk",
    "altyazı m k",
    "altyazı m.k",
    "ceviri ve altyazi mk",
    "ceviri ve altyazi m k",
    "çeviri ve altyazı mk",
    "çeviri ve altyazı m k",
    "çeviri ve altyazı m.k",
    "music",
    "musical",
    "applause",
    "laughter",
    "silence",
    "background music",
    "gunshot",
    "car horn",
    "muzik",
    "müzik",
    "alkış",
    "kahkaha",
    "sessizlik",
    "silah sesi",
    "araba sesi",
    "i have trouble",
    "i dont know",
    "i don t know",
    "i m sorry",
    "im sorry",
    "i m going to go",
    "im going to go",
    "lets go",
    "let s go",
    "thank you",
    "good evening",
    "come on sir",
    "come on",
    "hello nevzat",
}
SPEECH_CONFIDENCE_FLOOR = 0.28
ENGLISH_FILLER_WORDS = {
    "i",
    "m",
    "am",
    "you",
    "your",
    "we",
    "they",
    "go",
    "going",
    "know",
    "sorry",
    "thank",
    "thanks",
    "look",
    "there",
    "time",
    "save",
    "name",
    "have",
    "trouble",
    "wait",
    "meal",
    "anything",
    "hello",
    "come",
    "on",
    "sir",
    "good",
    "evening",
    "did",
    "hear",
    "it",
    "do",
    "will",
    "change",
    "our",
    "team",
    "from",
    "office",
}
TURKISH_SIGNAL_WORDS = {
    "bir",
    "ve",
    "bu",
    "su",
    "icin",
    "mi",
    "mı",
    "mu",
    "mü",
    "var",
    "yok",
    "lutfen",
    "lütfen",
    "efendim",
    "peki",
    "bekleyelim",
    "bekleyin",
    "sorun",
    "merhaba",
    "hos",
    "hoş",
    "geldiniz",
    "arzu",
    "ettiginiz",
    "ettiğiniz",
    "sey",
    "şey",
    "ben",
    "sen",
}


class AppError(Exception):
    def __init__(
        self,
        code: str,
        stage: str,
        title: str,
        message: str,
        detail: str | None = None,
        hint: str | None = None,
        job_id: str | None = None,
        context: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.payload = {
            "code": code,
            "stage": stage,
            "title": title,
            "message": message,
            "detail": detail,
            "hint": hint,
            "timestamp": now(),
            "job_id": job_id,
            "context": context or {},
        }


def error_payload(
    code: str,
    stage: str,
    title: str,
    message: str,
    detail: str | None = None,
    hint: str | None = None,
    job_id: str | None = None,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "code": code,
        "stage": stage,
        "title": title,
        "message": message,
        "detail": detail,
        "hint": hint,
        "timestamp": now(),
        "job_id": job_id,
        "context": context or {},
    }


def log_error(error: dict[str, Any]) -> None:
    print(f"[NEON_ERROR] {json.dumps(error, ensure_ascii=False)}", flush=True)


def system_context() -> dict[str, Any]:
    return {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "root": str(ROOT),
        "data_dir": str(DATA_DIR),
    }

DEFAULT_SEGMENTS = [
    {
        "id": "seg-1",
        "start_ms": 0,
        "end_ms": 3600,
        "source_text": "Offline motor hazır. Gerçek transkripsiyon için gömülü kaynak dosyalarını ekleyin.",
        "translated_text": "Offline engine is ready. Add bundled resource files for real transcription.",
        "source_language": "tr",
        "target_language": "en",
        "speaker_label": "Konuşmacı 1",
        "confidence": 0.75,
        "locked": False,
    }
]


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_db() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    EXPORT_DIR.mkdir(exist_ok=True)
    CHUNK_DIR.mkdir(exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                video_path TEXT NOT NULL,
                source_language TEXT NOT NULL,
                target_language TEXT NOT NULL,
                translation_enabled INTEGER NOT NULL DEFAULT 0,
                outputs TEXT NOT NULL,
                status TEXT NOT NULL,
                progress INTEGER NOT NULL,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        columns = {row[1] for row in conn.execute("PRAGMA table_info(jobs)").fetchall()}
        if "translation_enabled" not in columns:
            conn.execute("ALTER TABLE jobs ADD COLUMN translation_enabled INTEGER NOT NULL DEFAULT 0")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS segments (
                job_id TEXT NOT NULL,
                segment_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                PRIMARY KEY (job_id, segment_id)
            )
            """
        )


def rows_to_jobs(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    jobs = []
    for row in rows:
        jobs.append(
            {
                "id": row["id"],
                "video_path": row["video_path"],
                "source_language": row["source_language"],
                "target_language": row["target_language"],
                "translation_enabled": bool(row["translation_enabled"]),
                "outputs": json.loads(row["outputs"]),
                "status": row["status"],
                "progress": row["progress"],
                "error": json.loads(row["error"]) if row["error"] and row["error"].strip().startswith("{") else row["error"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
        )
    return jobs


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def manifest_items() -> list[dict[str, Any]]:
    if not ASSET_MANIFEST.exists():
        return []
    return json.loads(ASSET_MANIFEST.read_text())["assets"]


def asset_status() -> dict[str, Any]:
    items = []
    for item in manifest_items():
        asset_path = ROOT / item["path"]
        exists = asset_path.exists()
        actual = sha256(asset_path) if exists and item.get("sha256") else None
        ok = exists and (not item.get("sha256") or actual == item.get("sha256"))
        items.append({**item, "exists": exists, "actual_sha256": actual, "ok": ok})
    required = [item for item in items if item.get("required", True)]
    return {"ready": bool(required) and all(item["ok"] for item in required), "items": items}


def save_segments(job_id: str, segments: list[dict[str, Any]]) -> None:
    with db() as conn:
        conn.execute("DELETE FROM segments WHERE job_id = ?", (job_id,))
        conn.executemany(
            "INSERT INTO segments (job_id, segment_id, payload) VALUES (?, ?, ?)",
            [(job_id, segment["id"], json.dumps(segment, ensure_ascii=False)) for segment in segments],
        )


def load_segments(job_id: str) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute("SELECT payload FROM segments WHERE job_id = ? ORDER BY segment_id", (job_id,)).fetchall()
    segments = [json.loads(row["payload"]) for row in rows]
    return sorted(segments, key=lambda segment: (int(segment.get("start_ms", 0)), int(segment.get("end_ms", 0))))


def update_job(job_id: str, status: str, progress: int, error: str | dict[str, Any] | None = None) -> None:
    error_value = json.dumps(error, ensure_ascii=False) if isinstance(error, dict) else error
    with db() as conn:
        conn.execute(
            "UPDATE jobs SET status = ?, progress = ?, error = ?, updated_at = ? WHERE id = ?",
            (status, progress, error_value, now(), job_id),
        )


def current_job_status(job_id: str) -> str | None:
    with db() as conn:
        row = conn.execute("SELECT status FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return row["status"] if row else None


def is_cancelled(job_id: str) -> bool:
    return current_job_status(job_id) == "cancelled"


def ensure_not_cancelled(job_id: str, stage: str) -> None:
    if is_cancelled(job_id):
        raise AppError(
            "NS-JOB-CANCELLED",
            stage,
            "İşlem iptal edildi",
            "Kullanıcı işlemi iptal etti.",
            job_id=job_id,
            context=system_context(),
        )


def job_video_path(job_id: str) -> Path:
    with db() as conn:
        row = conn.execute("SELECT video_path FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if row is None:
        raise AppError(
            "NS-JOB-NOT-FOUND",
            "media_preview",
            "Video onizleme isi bulunamadi",
            "Video onizleme icin is kaydi bulunamadi.",
            job_id=job_id,
            hint="Videoyu yeniden secip islemi tekrar baslatin.",
            context=system_context(),
        )
    path = Path(row["video_path"])
    if not path.exists():
        raise AppError(
            "NS-MEDIA-VIDEO-NOT-FOUND",
            "media_preview",
            "Video onizleme dosyasi bulunamadi",
            "Secilen video dosyasi artik erisilebilir degil.",
            str(path),
            "Video tasinmis veya izin degismis olabilir.",
            job_id=job_id,
            context=system_context(),
        )
    return path


def ffmpeg_binary() -> Path:
    candidates = [
        ROOT / "assets" / "ffmpeg" / "macos" / "ffmpeg",
        ROOT / "assets" / "ffmpeg" / "windows" / "ffmpeg.exe",
        Path(shutil.which("ffmpeg") or "ffmpeg"),
    ]
    for candidate in candidates:
        if candidate.is_absolute() and candidate.exists():
            return candidate
    raise AppError(
        "NS-AUDIO-FFMPEG-MISSING",
        "extracting_audio",
        "Video sesi okunamadı",
        "Ses işleme bileşeni bulunamadı.",
        "Beklenen paket dosyası kurulum kaynakları içinde yok.",
        "Offline paket tekrar hazırlanmalı veya kurulum dosyası doğrulanmalı.",
        context=system_context(),
    )


def run_command(
    job_id: str,
    command: list[str],
    stage: str,
    title: str,
    message: str,
    hint: str,
    context: dict[str, Any] | None = None,
) -> subprocess.CompletedProcess[str]:
    ensure_not_cancelled(job_id, stage)
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    while process.poll() is None:
        if is_cancelled(job_id):
            process.terminate()
            try:
                stdout, stderr = process.communicate(timeout=4)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate()
            raise AppError(
                "NS-JOB-CANCELLED",
                stage,
                "İşlem iptal edildi",
                "Kullanıcı işlemi iptal etti; çalışan yerel işlem durduruldu.",
                (stderr or stdout or "")[-3000:] or None,
                "Yeni video ile devam edebilirsiniz.",
                job_id=job_id,
                context={**system_context(), **(context or {}), "command": command},
            )
        time.sleep(0.25)
    stdout, stderr = process.communicate()
    if process.returncode != 0:
        raise AppError(
            f"NS-{stage.upper().replace('-', '_')}-COMMAND-FAILED",
            stage,
            title,
            message,
            (stderr or stdout or f"exit_code={process.returncode}")[-4000:],
            hint,
            job_id=job_id,
            context={**system_context(), **(context or {}), "command": command},
        )
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def whisper_binary() -> Path:
    candidates = [
        ROOT / "assets" / "whispercpp" / "macos" / "whisper-cli",
        ROOT / "assets" / "whispercpp" / "windows" / "whisper-cli.exe",
        Path(shutil.which("whisper-cli") or "whisper-cli"),
    ]
    for candidate in candidates:
        if candidate.is_absolute() and candidate.exists():
            return candidate
    raise AppError(
        "NS-STT-WHISPER-BINARY-MISSING",
        "transcribing",
        "Transkripsiyon calistiricisi bulunamadi",
        "Yerel konusma tanima binary dosyasi kurulum kaynaklari icinde yok.",
        "Beklenen dosya assets/whispercpp altinda bulunamadi.",
        "Offline paket tekrar hazirlanmali veya kurulum dosyasi dogrulanmali.",
        context=system_context(),
    )


def require_vad_model(job_id: str) -> Path:
    if SILERO_VAD_MODEL.exists():
        return SILERO_VAD_MODEL
    raise AppError(
        "NS-VAD-MODEL-MISSING",
        "transcribing",
        "Konusma ayirma modeli bulunamadi",
        "Konusma olmayan bolumleri ayirmak icin gereken yerel model dosyasi yok.",
        str(SILERO_VAD_MODEL),
        "Offline paket tekrar hazirlanmali veya model dosyasi dogrulanmali.",
        job_id=job_id,
        context=system_context(),
    )


def timestamp_to_ms(value: Any) -> int:
    if isinstance(value, (int, float)):
        return int(value)
    if not isinstance(value, str):
        return 0
    cleaned = value.strip().replace(",", ".")
    if not cleaned:
        return 0
    parts = cleaned.split(":")
    try:
        if len(parts) == 3:
            hours = int(parts[0])
            minutes = int(parts[1])
            seconds = float(parts[2])
        elif len(parts) == 2:
            hours = 0
            minutes = int(parts[0])
            seconds = float(parts[1])
        else:
            hours = 0
            minutes = 0
            seconds = float(parts[0])
        return int(((hours * 60 + minutes) * 60 + seconds) * 1000)
    except ValueError:
        return 0


def normalize_transcript_text(value: str) -> str:
    lowered = value.lower().strip()
    replacements = str.maketrans({
        "ı": "i",
        "ğ": "g",
        "ü": "u",
        "ş": "s",
        "ö": "o",
        "ç": "c",
    })
    cleaned = lowered.translate(replacements)
    for char in "\n\r\t.,;:!?()[]{}'\"":
        cleaned = cleaned.replace(char, " ")
    return " ".join(cleaned.split())


def contains_cjk(text: str) -> bool:
    return any(
        "\u3400" <= char <= "\u4dbf"
        or "\u4e00" <= char <= "\u9fff"
        or "\uf900" <= char <= "\ufaff"
        or "\u3040" <= char <= "\u30ff"
        or "\uac00" <= char <= "\ud7af"
        for char in text
    )


def contains_turkish_letters(text: str) -> bool:
    return any(char in "çğıöşüÇĞİÖŞÜ" for char in text)


def language_mismatch_hallucination(text: str, expected_language: str) -> bool:
    if expected_language != "tr":
        return False
    normalized = normalize_transcript_text(text)
    words = normalized.split()
    if not words:
        return True
    english_hits = sum(1 for word in words if word in ENGLISH_FILLER_WORDS)
    turkish_hits = sum(1 for word in words if word in TURKISH_SIGNAL_WORDS)
    if contains_turkish_letters(text) or turkish_hits > 0:
        return False
    return english_hits >= 2


def clean_transcript_for_language(text: str, expected_language: str) -> str:
    if expected_language != "tr":
        return text
    return re.sub(r"\s*,?\s*(sir|madam)\.?\s*$", "", text, flags=re.IGNORECASE).strip()


def token_confidence(item: dict[str, Any]) -> tuple[float, int]:
    values: list[float] = []
    for token in item.get("tokens") or []:
        token_text = str(token.get("text") or "").strip()
        if not token_text or token_text.startswith("[_"):
            continue
        probability = token.get("p")
        if isinstance(probability, (int, float)):
            values.append(float(probability))
    if not values:
        return 1.0, 0
    return sum(values) / len(values), len(values)


def looks_like_hallucination(
    text: str,
    duration_ms: int,
    previous_text: str | None,
    confidence: float,
    token_count: int,
    expected_language: str,
) -> bool:
    if "\ufffd" in text:
        return True
    if contains_cjk(text):
        return True
    normalized = normalize_transcript_text(text)
    if not normalized:
        return True
    if normalized in HALLUCINATION_BLOCKLIST:
        return True
    if language_mismatch_hallucination(text, expected_language):
        return True
    if token_count > 0 and confidence < SPEECH_CONFIDENCE_FLOOR:
        return True
    if previous_text and normalized == normalize_transcript_text(previous_text):
        return True
    word_count = len(normalized.split())
    words = normalized.split()
    if len(words) >= 4:
        dominant_count = max(words.count(word) for word in set(words))
        if dominant_count / len(words) > 0.65:
            return True
    if token_count > 0 and word_count <= 2 and duration_ms > 2500 and confidence < 0.62:
        return True
    if token_count > 0 and duration_ms < 900 and confidence < 0.50:
        return True
    if duration_ms > 9000 and word_count <= 4:
        return True
    if word_count <= 2 and duration_ms > 5000:
        return True
    return False


def clamp_segment_end(start_ms: int, end_ms: int, text: str) -> int:
    duration_ms = max(500, end_ms - start_ms)
    expected_ms = max(1300, min(8500, len(text.strip()) * 85))
    if duration_ms > expected_ms + 1800:
        return start_ms + expected_ms
    return end_ms


def load_whisper_json(json_path: Path) -> tuple[dict[str, Any], bool]:
    raw = json_path.read_bytes()
    text = raw.decode("utf-8", errors="replace")
    return json.loads(text), "\ufffd" in text


def detect_silence_intervals(job_id: str, wav_path: Path) -> list[tuple[int, int]]:
    ffmpeg = ffmpeg_binary()
    try:
        completed = run_command(
            job_id,
            [
                str(ffmpeg),
                "-hide_banner",
                "-nostats",
                "-i",
                str(wav_path),
                "-af",
                "silencedetect=n=-42dB:d=0.35",
                "-f",
                "null",
                "-",
            ],
            "transcribing",
            "Ses aralıkları analiz edilemedi",
            "Konuşma dışı sessizlik aralıkları ölçülemedi.",
            "Bu ek analiz başarısız olursa transkripsiyon yine devam eder.",
            {"wav_path": str(wav_path)},
        )
    except Exception as exc:
        print(f"[NEON_STAGE] silence_detect_skipped error={str(exc)[-300:]}", flush=True)
        return []

    intervals: list[tuple[int, int]] = []
    active_start: float | None = None
    for line in completed.stderr.splitlines():
        start_match = re.search(r"silence_start:\s*([0-9.]+)", line)
        if start_match:
            active_start = float(start_match.group(1))
            continue
        end_match = re.search(r"silence_end:\s*([0-9.]+)", line)
        if end_match and active_start is not None:
            end_value = float(end_match.group(1))
            if end_value > active_start:
                intervals.append((int(active_start * 1000), int(end_value * 1000)))
            active_start = None
    return intervals


def filter_segments_by_silence(segments: list[dict[str, Any]], silence_intervals: list[tuple[int, int]]) -> list[dict[str, Any]]:
    if not silence_intervals:
        return segments
    filtered = []
    for segment in segments:
        start_ms = int(segment.get("start_ms", 0))
        end_ms = int(segment.get("end_ms", start_ms))
        midpoint = start_ms + max(0, end_ms - start_ms) // 2
        if any(start <= midpoint <= end for start, end in silence_intervals):
            continue
        filtered.append({**segment, "id": f"seg-{len(filtered) + 1:05d}"})
    return filtered


def parse_whisper_segments(json_path: Path, requested_language: str, target_language: str) -> tuple[list[dict[str, Any]], str]:
    payload, had_decode_replacements = load_whisper_json(json_path)
    detected_language = payload.get("result", {}).get("language") or requested_language
    if requested_language in SUPPORTED_LANGUAGES:
        resolved_language = requested_language
    elif detected_language in SUPPORTED_LANGUAGES:
        resolved_language = detected_language
    else:
        resolved_language = "tr"
    if had_decode_replacements:
        print(f"[NEON_STAGE] whisper_json_decode_replacements path={json_path}", flush=True)
    raw_segments = payload.get("transcription") or payload.get("segments") or []
    segments = []
    previous_text: str | None = None
    for index, item in enumerate(raw_segments, start=1):
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        text = clean_transcript_for_language(text, resolved_language)
        if not text:
            continue
        offsets = item.get("offsets") or {}
        timestamps = item.get("timestamps") or {}
        start_ms = offsets.get("from")
        end_ms = offsets.get("to")
        if start_ms is None:
            start_ms = item.get("start") or timestamps.get("from")
        if end_ms is None:
            end_ms = item.get("end") or timestamps.get("to")
        start_value = timestamp_to_ms(start_ms)
        end_value = max(timestamp_to_ms(end_ms), start_value + 500)
        if end_value - start_value < 420:
            continue
        confidence, token_count = token_confidence(item)
        if looks_like_hallucination(text, end_value - start_value, previous_text, confidence, token_count, resolved_language):
            continue
        end_value = clamp_segment_end(start_value, end_value, text)
        segments.append(
            {
                "id": f"seg-{len(segments) + 1:05d}",
                "start_ms": start_value,
                "end_ms": end_value,
                "source_text": text,
                "translated_text": text,
                "source_language": resolved_language,
                "target_language": target_language,
                "speaker_label": "Konusmaci 1",
                "confidence": round(confidence, 4),
                "locked": False,
            }
        )
        previous_text = text
    return segments, detected_language


def transcribe_audio(job_id: str, wav_path: Path, source_language: str, target_language: str, translation_enabled: bool) -> list[dict[str, Any]]:
    if not WHISPER_MODEL.exists():
        raise AppError(
            "NS-STT-MODEL-MISSING",
            "transcribing",
            "Transkripsiyon modeli bulunamadi",
            "Yerel model dosyasi kurulum kaynaklari icinde yok.",
            str(WHISPER_MODEL),
            "Offline paket tekrar hazirlanmali veya model dosyasi dogrulanmali.",
            job_id=job_id,
            context=system_context(),
        )

    whisper = whisper_binary()
    vad_model = require_vad_model(job_id)
    print(
        f"[NEON_STAGE] vad_chunking_ready path={vad_model} pad_ms={VAD_SPEECH_PAD_MS} max_s={VAD_MAX_SPEECH_SECONDS}",
        flush=True,
    )
    threads = max(2, min(os.cpu_count() or 4, 8))

    def run_whisper(language: str, suffix: str, use_vad: bool = True) -> tuple[list[dict[str, Any]], str, Path]:
        output_base = CHUNK_DIR / f"{job_id}-whisper-{suffix}"
        json_path = output_base.with_suffix(".json")
        if json_path.exists():
            json_path.unlink()

        def build_command(no_gpu: bool) -> list[str]:
            command = [
                str(whisper),
                "-m",
                str(WHISPER_MODEL),
                "-f",
                str(wav_path),
                "-oj",
                "-ojf",
                "-of",
                str(output_base),
                "-l",
                language,
                "-t",
                str(threads),
                "-np",
                "-sns",
                "-sow",
                "-mc",
                "0",
                "-ml",
                "96",
                "-nth",
                "0.35",
                "-wt",
                "0.08",
                "-et",
                "2.20",
                "-lpt",
                "-0.80",
            ]
            if use_vad:
                command.extend(
                    [
                        "--vad",
                        "-vm",
                        str(vad_model),
                        "-vt",
                        "0.42",
                        "-vspd",
                        str(VAD_MIN_SPEECH_MS),
                        "-vsd",
                        str(VAD_MIN_SILENCE_MS),
                        "-vmsd",
                        str(VAD_MAX_SPEECH_SECONDS),
                        "-vp",
                        str(VAD_SPEECH_PAD_MS),
                        "-vo",
                        str(VAD_SAMPLES_OVERLAP_SECONDS),
                    ]
                )
            if no_gpu:
                command.append("-ng")
            return command

        command = build_command(no_gpu=False)
        try:
            try:
                completed = run_command(
                    job_id,
                    command,
                    "transcribing",
                    "Konusma yazıya dokulemedi",
                    "Yerel konusma tanima islemi hata ile durdu.",
                    "Video sesi cok bozuk olabilir, kaynak dil yanlış olabilir veya sistem belleği yetmemis olabilir.",
                    {"wav_path": str(wav_path), "language": language, "timeline_mode": "vad_chunks" if use_vad else "full_audio"},
                )
            except AppError as exc:
                if exc.payload.get("code") == "NS-JOB-CANCELLED":
                    raise
                if json_path.exists():
                    json_path.unlink()
                command = build_command(no_gpu=True)
                print("[NEON_STAGE] vad_gpu_failed_retrying_cpu", flush=True)
                completed = run_command(
                    job_id,
                    command,
                    "transcribing",
                    "Konusma yazıya dokulemedi",
                    "Yerel konusma tanima GPU modunda calismadi; CPU yedek modunda da hata alindi.",
                    "Video sesi cok bozuk olabilir, kaynak dil yanlış olabilir veya sistem belleği yetmemis olabilir.",
                    {"wav_path": str(wav_path), "language": language, "timeline_mode": "vad_chunks" if use_vad else "full_audio", "no_gpu": True},
                )
            if completed.stderr:
                print(f"[NEON_STAGE] whisper stderr={completed.stderr[-1600:]}", flush=True)
        except AppError:
            raise
        except Exception as exc:
            raise AppError(
                "NS-STT-WHISPER-FAILED",
                "transcribing",
                "Konusma yazıya dokulemedi",
                "Yerel konusma tanima islemi hata ile durdu.",
                str(exc)[-4000:],
                "Video sesi cok bozuk olabilir, model/binary uyumsuz olabilir veya sistem belleği yetmemis olabilir.",
                job_id=job_id,
                context={**system_context(), "command": command},
            ) from exc

        if not json_path.exists():
            raise AppError(
                "NS-STT-JSON-MISSING",
                "transcribing",
                "Transkripsiyon ciktisi bulunamadi",
                "Yerel konusma tanima tamamlandi ama JSON cikti dosyasi olusmadi.",
                str(json_path),
                "Debug paketini iletin; whisper cikti yolu kontrol edilmeli.",
                job_id=job_id,
                context={**system_context(), "command": command},
            )

        try:
            segments, detected_language = parse_whisper_segments(json_path, language, target_language)
        except json.JSONDecodeError as exc:
            raise AppError(
                "NS-STT-JSON-DECODE-FAILED",
                "transcribing",
                "Transkripsiyon ciktisi okunamadi",
                "Yerel konusma tanima JSON ciktisi bozuk veya eksik olustu.",
                str(exc),
                "Ayni video ile kaynak dili manuel secip tekrar deneyin; devam ederse debug paketini iletin.",
                job_id=job_id,
                context={**system_context(), "json_path": str(json_path), "language": language},
            ) from exc
        return segments, detected_language, json_path

    requested_language = source_language if source_language and source_language != "auto" else "auto"
    if requested_language == "auto" and not translation_enabled and target_language in SUPPORTED_LANGUAGES:
        requested_language = target_language
        print(f"[NEON_STAGE] auto_language_pinned_to_target language={requested_language}", flush=True)
    segments, detected_language, json_path = run_whisper(requested_language, f"vad-{requested_language}")
    if requested_language == "auto" and detected_language not in SUPPORTED_LANGUAGES:
        fallback_language = target_language if target_language in SUPPORTED_LANGUAGES else "tr"
        print(
            f"[NEON_STAGE] unsupported_auto_language detected={detected_language} retry={fallback_language}",
            flush=True,
        )
        segments, detected_language, json_path = run_whisper(fallback_language, f"vad-retry-{fallback_language}")

    # ffmpeg silencedetect is too brittle on action/noisy scenes after denoise: it can mark
    # quiet dialogue as silence and remove valid subtitles. Keep the full Whisper timeline and
    # rely on text/language hallucination filters instead.
    if not segments:
        raise AppError(
            "NS-STT-NO-SPEECH",
            "transcribing",
            "Konusma bulunamadi",
            "Videonun sesinde altyaziya dokulecek konusma tespit edilemedi.",
            f"detected_language={detected_language}",
            "Kaynak dil ayarini manuel secip tekrar deneyin veya ses seviyesini kontrol edin.",
            job_id=job_id,
            context={**system_context(), "json_path": str(json_path)},
        )
    return segments


def run_pipeline(job_id: str) -> None:
    try:
        status = asset_status()
        if not status["ready"]:
            missing = [
                {"id": item["id"], "exists": item["exists"], "ok": item["ok"]}
                for item in status["items"]
                if item.get("required", True) and not item["ok"]
            ]
            error = error_payload(
                "NS-ASSET-VERIFY-FAILED",
                "startup_check",
                "Offline kaynak doğrulaması başarısız",
                "Kurulum içindeki zorunlu kaynaklardan biri eksik veya doğrulama geçemedi.",
                "Bu hata genelde eksik/yarım kurulum, bozuk dosya veya yanlış paketleme yüzünden oluşur.",
                "Debug paketini iletin; eksik kaynak listesine göre installer tekrar hazırlanmalı.",
                job_id=job_id,
                context={**system_context(), "missing": missing},
            )
            log_error(error)
            update_job(job_id, "failed", 0, error)
            return

        update_job(job_id, "extracting_audio", 15)
        time.sleep(0.7)

        with db() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            error = error_payload(
                "NS-JOB-NOT-FOUND",
                "loading_job",
                "İş kaydı bulunamadı",
                "Başlatılan işlem veritabanında bulunamadı.",
                "Job kaydı silinmiş veya autosave veritabanı tutarsız olabilir.",
                "Uygulamayı yeniden başlatıp aynı videoyu tekrar deneyin.",
                job_id=job_id,
                context=system_context(),
            )
            log_error(error)
            return

        ensure_not_cancelled(job_id, "extracting_audio")
        video_path = row["video_path"]
        wav_path = CHUNK_DIR / f"{job_id}.wav"
        speech_wav_path = CHUNK_DIR / f"{job_id}-speech-48k.wav"
        ffmpeg = ffmpeg_binary()

        if not Path(video_path).exists():
            error = error_payload(
                "NS-IMPORT-VIDEO-NOT-FOUND",
                "import_video",
                "Video dosyası bulunamadı",
                "Seçilen video yolu artık erişilebilir değil.",
                video_path,
                "Videoyu tekrar seçin veya dosyanın taşınmadığını kontrol edin.",
                job_id=job_id,
                context=system_context(),
            )
            log_error(error)
            update_job(job_id, "failed", 5, error)
            return

        try:
            completed = run_command(
                job_id,
                [
                    str(ffmpeg),
                    "-y",
                    "-i",
                    video_path,
                    "-vn",
                    "-af",
                    "highpass=f=70,lowpass=f=12000",
                    "-ac",
                    "1",
                    "-ar",
                    "48000",
                    str(speech_wav_path),
                ],
                "extracting_audio",
                "Videodan ses ayrılamadı",
                "Video dosyası okunamadı veya ses parçası çıkarılamadı.",
                "Video bozuk olabilir, codec desteklenmiyor olabilir veya dosya izni yoktur.",
                {"video_path": video_path, "ffmpeg": str(ffmpeg)},
            )
            if completed.stderr:
                print(f"[NEON_STAGE] audio_extract stderr={completed.stderr[-1200:]}", flush=True)
            ensure_not_cancelled(job_id, "extracting_audio")
            print("[NEON_STAGE] audio_enhancement using=ffmpeg_filters_only", flush=True)
            completed = run_command(
                job_id,
                [
                    str(ffmpeg),
                    "-y",
                    "-i",
                    str(speech_wav_path),
                    "-vn",
                    "-af",
                    "highpass=f=80,lowpass=f=7600,loudnorm=I=-20:TP=-1.5:LRA=11",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    str(wav_path),
                ],
                "extracting_audio",
                "Ses Whisper için hazırlanamadı",
                "Temizlenen ses konuşma tanıma formatına dönüştürülemedi.",
                "Debug paketini iletin; ses dönüştürme aşaması kontrol edilmeli.",
                {"input": str(speech_wav_path), "ffmpeg": str(ffmpeg), "enhancement": "ffmpeg_filters_only"},
            )
            if completed.stderr:
                print(f"[NEON_STAGE] audio_prepare stderr={completed.stderr[-1200:]}", flush=True)
        except AppError as exc:
            error = {**exc.payload, "job_id": job_id}
            log_error(error)
            if exc.payload.get("code") == "NS-JOB-CANCELLED":
                update_job(job_id, "cancelled", 0, error)
            else:
                update_job(job_id, "failed", 15, error)
            return
        except Exception as exc:
            error = error_payload(
                "NS-AUDIO-UNKNOWN",
                "extracting_audio",
                "Ses hazırlığında bilinmeyen hata",
                str(exc),
                repr(exc),
                "Debug paketini iletin; bu beklenmeyen bir ses hazırlama hatasıdır.",
                job_id=job_id,
                context={**system_context(), "video_path": video_path},
            )
            log_error(error)
            update_job(job_id, "failed", 15, error)
            return

        ensure_not_cancelled(job_id, "transcribing")
        update_job(job_id, "transcribing", 55)
        segments = transcribe_audio(
            job_id,
            wav_path,
            row["source_language"],
            row["target_language"],
            bool(row["translation_enabled"]),
        )
        save_segments(job_id, segments)

        if row["translation_enabled"]:
            ensure_not_cancelled(job_id, "translating")
            update_job(job_id, "translating", 78)
        update_job(job_id, "ready_for_edit", 100)
    except AppError as exc:
        error = {**exc.payload, "job_id": job_id}
        log_error(error)
        if exc.payload.get("code") == "NS-JOB-CANCELLED":
            update_job(job_id, "cancelled", 0, error)
        else:
            update_job(job_id, "failed", 0, error)
    except Exception as exc:
        error = error_payload(
            "NS-PIPELINE-UNHANDLED",
            "pipeline",
            "İşlem beklenmeyen şekilde durdu",
            str(exc),
            repr(exc),
            "Bu debug paketini geliştiriciye iletin.",
            job_id=job_id,
            context=system_context(),
        )
        log_error(error)
        update_job(job_id, "failed", 0, error)


def srt_timestamp(ms: int) -> str:
    seconds, millis = divmod(ms, 1000)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02}:{minutes:02}:{seconds:02},{millis:03}"


def vtt_timestamp(ms: int) -> str:
    return srt_timestamp(ms).replace(",", ".")


def ass_timestamp(ms: int) -> str:
    seconds, millis = divmod(ms, 1000)
    centis = millis // 10
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours}:{minutes:02}:{seconds:02}.{centis:02}"


def clean_base_name(value: str | None, fallback: str) -> str:
    name = (value or fallback).strip() or fallback
    cleaned = "".join("-" if char in '\\/:*?"<>|' else char for char in name)
    return cleaned.strip(" .") or fallback


def ffmpeg_filter_path(path: Path) -> str:
    value = str(path)
    return value.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def verify_video_output(job_id: str, output_path: Path) -> None:
    ffmpeg_path = ffmpeg_binary()
    ffprobe = ffmpeg_path.with_name("ffprobe.exe" if ffmpeg_path.name.endswith(".exe") else "ffprobe")
    if ffprobe.exists() or shutil.which("ffprobe"):
        if not ffprobe.exists():
            ffprobe = Path(shutil.which("ffprobe") or "ffprobe")
        command = [
            str(ffprobe),
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "json",
            str(output_path),
        ]
        completed = run_command(
            job_id,
            command,
            "exporting",
            "Video çıktısı doğrulanamadı",
            "FFmpeg çıktı üretti ama dosya video olarak okunamadı.",
            "Çıktı klasörü, disk alanı veya codec desteği kontrol edilmeli.",
            {"output_path": str(output_path)},
        )
        try:
            payload = json.loads(completed.stdout or "{}")
        except json.JSONDecodeError as exc:
            raise AppError(
                "NS-EXPORT-VIDEO-PROBE-INVALID",
                "exporting",
                "Video çıktısı doğrulanamadı",
                "FFprobe sonucu okunamadı.",
                completed.stdout[-1000:] if completed.stdout else repr(exc),
                "Debug bilgisini iletin; video doğrulama çıktısı incelenmeli.",
                job_id=job_id,
                context={**system_context(), "output_path": str(output_path)},
            ) from exc
        if not payload.get("streams"):
            raise AppError(
                "NS-EXPORT-VIDEO-NO-STREAM",
                "exporting",
                "Video çıktısı bozuk görünüyor",
                "Üretilen dosyada okunabilir video stream bulunamadı.",
                str(output_path),
                "Bu dosya kullanıcıya teslim edilmedi; export ayarları yeniden denenmeli.",
                job_id=job_id,
                context={**system_context(), "probe": payload},
            )
        return

    run_command(
        job_id,
        [str(ffmpeg_path), "-v", "error", "-i", str(output_path), "-map", "0:v:0", "-f", "null", "-"],
        "exporting",
        "Video çıktısı doğrulanamadı",
        "FFmpeg çıktı üretti ama dosya tekrar okunamadı.",
        "Çıktı klasörü, disk alanı veya codec desteği kontrol edilmeli.",
        {"output_path": str(output_path)},
    )


def burn_video(job_id: str, source_video: Path, ass_path: Path, output_path: Path, output_format: str) -> None:
    ffmpeg = ffmpeg_binary()
    temp_output = output_path.with_name(f".{output_path.stem}.tmp{output_path.suffix}")
    if temp_output.exists():
        temp_output.unlink()
    if output_format == "webm":
        codec_args = ["-map", "0:v:0", "-map", "0:a?", "-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-c:a", "libopus", "-shortest"]
    else:
        codec_args = ["-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-shortest"]
    command = [
        str(ffmpeg),
        "-y",
        "-i",
        str(source_video),
        "-vf",
        f"subtitles='{ffmpeg_filter_path(ass_path)}'",
        *codec_args,
        str(temp_output),
    ]
    try:
        completed = run_command(
            job_id,
            command,
            "exporting",
            "Altyazili video kaydedilemedi",
            "FFmpeg video export islemi hata ile durdu.",
            "Video codec destegi, dosya izni veya secilen cikti formatini kontrol edin.",
            {"source_video": str(source_video), "output_path": str(output_path)},
        )
        if completed.stderr:
            print(f"[NEON_STAGE] video_export stderr={completed.stderr[-1600:]}", flush=True)
        verify_video_output(job_id, temp_output)
        temp_output.replace(output_path)
    except AppError:
        if temp_output.exists():
            temp_output.unlink()
        raise
    except Exception as exc:
        if temp_output.exists():
            temp_output.unlink()
        raise AppError(
            "NS-EXPORT-VIDEO-BURN-FAILED",
            "exporting",
            "Altyazili video kaydedilemedi",
            "FFmpeg video export islemi hata ile durdu.",
            str(exc)[-4000:],
            "Video codec destegi, dosya izni veya secilen cikti formatini kontrol edin.",
            job_id=job_id,
            context={**system_context(), "command": command},
        ) from exc


def export_subtitles(
    job_id: str,
    outputs: list[str] | None = None,
    output_dir: str | None = None,
    base_name: str | None = None,
) -> list[str]:
    segments = load_segments(job_id)
    if not segments:
        raise AppError(
            "NS-EXPORT-NO-SEGMENTS",
            "exporting",
            "Export için altyazı yok",
            "Bu işte dışa aktarılacak segment bulunamadı.",
            "Transkripsiyon tamamlanmadan export denenmiş olabilir.",
            "İşlem tamamlandıktan sonra yeniden export alın.",
            job_id=job_id,
            context=system_context(),
        )
    with db() as conn:
        job_row = conn.execute("SELECT translation_enabled FROM jobs WHERE id = ?", (job_id,)).fetchone()
    translation_enabled = bool(job_row["translation_enabled"]) if job_row else False
    selected_outputs = {item.lower() for item in (outputs or ["srt", "vtt"])}
    source_video = job_video_path(job_id)
    export_dir = Path(output_dir).expanduser() if output_dir else EXPORT_DIR
    safe_base_name = clean_base_name(base_name, source_video.stem or job_id)
    export_dir.mkdir(parents=True, exist_ok=True)
    files = []
    srt = []
    vtt = ["WEBVTT", ""]
    ass = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "PlayResX: 1920",
        "PlayResY: 1080",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Default,Arial,52,&H00FFFFFF,&H0000FFFF,&H00000000,&H99000000,-1,0,0,0,100,100,0,0,1,3,1,2,70,70,76,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for index, segment in enumerate(segments, start=1):
        text = (segment.get("translated_text") if translation_enabled else segment.get("source_text")) or segment.get("source_text", "")
        srt.append(f"{index}\n{srt_timestamp(segment['start_ms'])} --> {srt_timestamp(segment['end_ms'])}\n{text}\n")
        vtt.append(f"{vtt_timestamp(segment['start_ms'])} --> {vtt_timestamp(segment['end_ms'])}\n{text}\n")
        ass_text = str(text).replace("\n", "\\N").replace(",", "،")
        ass.append(f"Dialogue: 0,{ass_timestamp(segment['start_ms'])},{ass_timestamp(segment['end_ms'])},Default,,0,0,0,,{ass_text}")

    try:
        if "srt" in selected_outputs or not selected_outputs:
            srt_path = export_dir / f"{safe_base_name}.srt"
            srt_path.write_text("\n".join(srt), encoding="utf-8")
            files.append(str(srt_path))
        if "vtt" in selected_outputs:
            vtt_path = export_dir / f"{safe_base_name}.vtt"
            vtt_path.write_text("\n".join(vtt), encoding="utf-8")
            files.append(str(vtt_path))
        needs_ass_file = "ass" in selected_outputs or any(item in selected_outputs for item in {"mp4", "mov", "webm"})
        ass_path = export_dir / f"{safe_base_name}.ass"
        if needs_ass_file:
            ass_path.write_text("\n".join(ass), encoding="utf-8")
            if "ass" in selected_outputs:
                files.append(str(ass_path))
        for video_format in ("mp4", "mov", "webm"):
            if video_format in selected_outputs:
                output_path = export_dir / f"{safe_base_name}.{video_format}"
                burn_video(job_id, source_video, ass_path, output_path, video_format)
                files.append(str(output_path))
    except AppError:
        raise
    except Exception as exc:
        raise AppError(
            "NS-EXPORT-WRITE-FAILED",
            "exporting",
            "Export dosyası yazılamadı",
            "Altyazı çıktı dosyaları diske kaydedilemedi.",
            repr(exc),
            "Disk alanı, klasör izni veya dosya kilidi kontrol edilmeli.",
            job_id=job_id,
            context={**system_context(), "export_dir": str(export_dir)},
        ) from exc
    if not files:
        raise AppError(
            "NS-EXPORT-FORMAT-NOT-READY",
            "exporting",
            "Secilen export formati henuz hazir degil",
            "Bu asamada SRT, VTT ve ASS ciktilari uretiliyor. Video burn-in sonraki adimda baglanacak.",
            f"requested={sorted(selected_outputs)}",
            "SRT, VTT, ASS veya desteklenen video formatlarindan birini secerek yeniden export alin.",
            job_id=job_id,
            context=system_context(),
        )
    return files


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *args: Any) -> None:
        return

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_media(self, path: Path, head_only: bool = False) -> None:
        file_size = path.stat().st_size
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        range_header = self.headers.get("Range")
        start = 0
        end = file_size - 1
        status = 200
        if range_header and range_header.startswith("bytes="):
            status = 206
            requested = range_header.removeprefix("bytes=").split(",", 1)[0]
            start_text, _, end_text = requested.partition("-")
            if start_text:
                start = max(0, int(start_text))
            if end_text:
                end = min(file_size - 1, int(end_text))
        chunk_size = max(0, end - start + 1)
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(chunk_size))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.end_headers()
        if head_only:
            return
        with path.open("rb") as handle:
            handle.seek(start)
            remaining = chunk_size
            while remaining > 0:
                data = handle.read(min(1024 * 1024, remaining))
                if not data:
                    break
                self.wfile.write(data)
                remaining -= len(data)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_OPTIONS(self) -> None:
        self.send_json({"ok": True})

    def do_HEAD(self) -> None:
        try:
            path = urlparse(self.path).path
            if path.endswith("/media") and path.startswith("/jobs/"):
                job_id = path.split("/")[2]
                self.send_media(job_video_path(job_id), head_only=True)
                return
            self.send_response(404)
            self.end_headers()
        except Exception:
            self.send_response(500)
            self.end_headers()

    def do_GET(self) -> None:
        try:
            path = urlparse(self.path).path
            if path == "/health":
                self.send_json({"ok": True, "mode": "dev"})
                return
            if path == "/assets/status":
                self.send_json(asset_status())
                return
            if path == "/jobs":
                with db() as conn:
                    rows = conn.execute("SELECT * FROM jobs ORDER BY updated_at DESC").fetchall()
                self.send_json({"jobs": rows_to_jobs(rows)})
                return
            if path.endswith("/segments") and path.startswith("/jobs/"):
                job_id = path.split("/")[2]
                self.send_json({"segments": load_segments(job_id)})
                return
            if path.endswith("/media") and path.startswith("/jobs/"):
                job_id = path.split("/")[2]
                self.send_media(job_video_path(job_id))
                return
            self.send_json({"error": "Not found"}, 404)
        except Exception as exc:
            self.send_app_error(
                error_payload(
                    "NS-API-GET-FAILED",
                    "api_get",
                    "Veri okunamadı",
                    str(exc),
                    repr(exc),
                    "Debug paketini iletin.",
                    context=system_context(),
                )
            )

    def do_POST(self) -> None:
        try:
            path = urlparse(self.path).path
            if path == "/jobs":
                body = self.read_json()
                if not body.get("video_path"):
                    raise AppError(
                        "NS-IMPORT-PATH-EMPTY",
                        "import_video",
                        "Video seçilmedi",
                        "İş oluşturmak için video yolu gerekli.",
                        None,
                        "Videoyu seçip yeniden deneyin.",
                        context=system_context(),
                    )
                job_id = str(uuid.uuid4())
                timestamp = now()
                with db() as conn:
                    conn.execute(
                        """
                        INSERT INTO jobs
                        (id, video_path, source_language, target_language, translation_enabled, outputs, status, progress, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            job_id,
                            body["video_path"],
                            body.get("source_language", "auto"),
                            body.get("target_language", "en"),
                            1 if body.get("translation_enabled") else 0,
                            json.dumps(body.get("outputs", ["srt", "vtt", "mp4"])),
                            "queued",
                            0,
                            timestamp,
                            timestamp,
                        ),
                    )
                    row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
                save_segments(job_id, [])
                self.send_json({"job": rows_to_jobs([row])[0]}, 201)
                return
            if path.endswith("/start") and path.startswith("/jobs/"):
                job_id = path.split("/")[2]
                update_job(job_id, "queued", 0)
                threading.Thread(target=run_pipeline, args=(job_id,), daemon=True).start()
                with db() as conn:
                    row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
                self.send_json({"job": rows_to_jobs([row])[0]})
                return
            if path.endswith("/cancel") and path.startswith("/jobs/"):
                job_id = path.split("/")[2]
                error = error_payload(
                    "NS-JOB-CANCELLED",
                    "cancel",
                    "İşlem iptal edildi",
                    "Kullanıcı işlemi iptal etti.",
                    job_id=job_id,
                    context=system_context(),
                )
                update_job(job_id, "cancelled", 0, error)
                with db() as conn:
                    row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
                if row is None:
                    raise AppError(
                        "NS-JOB-NOT-FOUND",
                        "cancel",
                        "İptal edilecek iş bulunamadı",
                        "İş kaydı bulunamadı.",
                        job_id=job_id,
                        context=system_context(),
                    )
                self.send_json({"job": rows_to_jobs([row])[0]})
                return
            if path.endswith("/export") and path.startswith("/jobs/"):
                job_id = path.split("/")[2]
                ensure_not_cancelled(job_id, "exporting")
                body = self.read_json()
                update_job(job_id, "exporting", 90)
                files = export_subtitles(job_id, body.get("outputs"), body.get("output_dir"), body.get("base_name"))
                update_job(job_id, "completed", 100)
                with db() as conn:
                    row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
                self.send_json({"job": rows_to_jobs([row])[0], "files": files})
                return
            self.send_json({"error": "Not found"}, 404)
        except AppError as exc:
            self.send_app_error(exc.payload)
        except Exception as exc:
            self.send_app_error(
                error_payload(
                    "NS-API-POST-FAILED",
                    "api_post",
                    "İstek tamamlanamadı",
                    str(exc),
                    repr(exc),
                    "Debug paketini iletin.",
                    context=system_context(),
                )
            )

    def do_PUT(self) -> None:
        try:
            path = urlparse(self.path).path
            if path.endswith("/segments") and path.startswith("/jobs/"):
                job_id = path.split("/")[2]
                save_segments(job_id, self.read_json().get("segments", []))
                self.send_json({"ok": True})
                return
            self.send_json({"error": "Not found"}, 404)
        except Exception as exc:
            self.send_app_error(
                error_payload(
                    "NS-API-PUT-FAILED",
                    "api_put",
                    "Kayıt güncellenemedi",
                    str(exc),
                    repr(exc),
                    "Debug paketini iletin.",
                    context=system_context(),
                )
            )

    def send_app_error(self, error: dict[str, Any], status: int = 500) -> None:
        log_error(error)
        self.send_json({"error": error}, status)


class QuietThreadingHTTPServer(ThreadingHTTPServer):
    def handle_error(self, request: Any, client_address: Any) -> None:
        error_type, error, _traceback = sys.exc_info()
        if error_type is ConnectionResetError or isinstance(error, (ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dev", action="store_true")
    parser.parse_args()
    init_db()
    server = QuietThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Neon Subtitle Studio engine listening on http://127.0.0.1:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
