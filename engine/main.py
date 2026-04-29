#!/usr/bin/env python3
from __future__ import annotations

import argparse
import platform
import shutil
import hashlib
import json
import os
import sqlite3
import subprocess
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
                outputs TEXT NOT NULL,
                status TEXT NOT NULL,
                progress INTEGER NOT NULL,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
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
    return [json.loads(row["payload"]) for row in rows]


def update_job(job_id: str, status: str, progress: int, error: str | dict[str, Any] | None = None) -> None:
    error_value = json.dumps(error, ensure_ascii=False) if isinstance(error, dict) else error
    with db() as conn:
        conn.execute(
            "UPDATE jobs SET status = ?, progress = ?, error = ?, updated_at = ? WHERE id = ?",
            (status, progress, error_value, now(), job_id),
        )


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

        video_path = row["video_path"]
        wav_path = CHUNK_DIR / f"{job_id}.wav"
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
            completed = subprocess.run(
                [str(ffmpeg), "-y", "-i", video_path, "-vn", "-ac", "1", "-ar", "16000", str(wav_path)],
                check=True,
                capture_output=True,
                text=True,
            )
            if completed.stderr:
                print(f"[NEON_STAGE] audio_extract stderr={completed.stderr[-1200:]}", flush=True)
        except subprocess.CalledProcessError as exc:
            error = error_payload(
                "NS-AUDIO-EXTRACT-FAILED",
                "extracting_audio",
                "Videodan ses ayrılamadı",
                "Video dosyası okunamadı veya ses parçası çıkarılamadı.",
                (exc.stderr or exc.stdout or str(exc))[-3000:],
                "Video bozuk olabilir, codec desteklenmiyor olabilir veya dosya izni yoktur.",
                job_id=job_id,
                context={**system_context(), "video_path": video_path, "ffmpeg": str(ffmpeg)},
            )
            log_error(error)
            update_job(job_id, "failed", 15, error)
            return
        except AppError as exc:
            error = {**exc.payload, "job_id": job_id}
            log_error(error)
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

        update_job(job_id, "transcribing", 55)
        time.sleep(0.9)

        segments = [
            {
                **DEFAULT_SEGMENTS[0],
                "id": "seg-1",
                "source_language": row["source_language"],
                "target_language": row["target_language"],
            },
            {
                "id": "seg-2",
                "start_ms": 3900,
                "end_ms": 7600,
                "source_text": "Yerel altyazı motoru bağlandığında bu alan gerçek zaman kodlu çıktı ile dolacak.",
                "translated_text": "When the local subtitle engine is bundled, this area will contain timestamped output.",
                "source_language": row["source_language"],
                "target_language": row["target_language"],
                "speaker_label": "Konuşmacı 1",
                "confidence": 0.72,
                "locked": False,
            },
        ]
        save_segments(job_id, segments)

        update_job(job_id, "translating", 78)
        time.sleep(0.5)
        update_job(job_id, "ready_for_edit", 100)
    except AppError as exc:
        error = {**exc.payload, "job_id": job_id}
        log_error(error)
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


def export_subtitles(job_id: str) -> list[str]:
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
    files = []
    srt = []
    vtt = ["WEBVTT", ""]
    for index, segment in enumerate(segments, start=1):
        text = segment.get("translated_text") or segment.get("source_text", "")
        srt.append(f"{index}\n{srt_timestamp(segment['start_ms'])} --> {srt_timestamp(segment['end_ms'])}\n{text}\n")
        vtt.append(f"{vtt_timestamp(segment['start_ms'])} --> {vtt_timestamp(segment['end_ms'])}\n{text}\n")

    srt_path = EXPORT_DIR / f"{job_id}.srt"
    vtt_path = EXPORT_DIR / f"{job_id}.vtt"
    try:
        srt_path.write_text("\n".join(srt), encoding="utf-8")
        vtt_path.write_text("\n".join(vtt), encoding="utf-8")
    except Exception as exc:
        raise AppError(
            "NS-EXPORT-WRITE-FAILED",
            "exporting",
            "Export dosyası yazılamadı",
            "Altyazı çıktı dosyaları diske kaydedilemedi.",
            repr(exc),
            "Disk alanı, klasör izni veya dosya kilidi kontrol edilmeli.",
            job_id=job_id,
            context={**system_context(), "export_dir": str(EXPORT_DIR)},
        ) from exc
    files.extend([str(srt_path), str(vtt_path)])
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

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_OPTIONS(self) -> None:
        self.send_json({"ok": True})

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
                        (id, video_path, source_language, target_language, outputs, status, progress, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            job_id,
                            body["video_path"],
                            body.get("source_language", "auto"),
                            body.get("target_language", "en"),
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
            if path.endswith("/export") and path.startswith("/jobs/"):
                job_id = path.split("/")[2]
                update_job(job_id, "exporting", 90)
                files = export_subtitles(job_id)
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dev", action="store_true")
    parser.parse_args()
    init_db()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Neon Subtitle Studio engine listening on http://127.0.0.1:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
