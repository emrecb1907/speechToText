import type { AppErrorInfo, AssetStatus, Job } from "./types";

export function normalizeError(error: unknown, fallbackStage = "ui"): AppErrorInfo {
  if (isAppError(error)) return error;

  if (error instanceof Error) {
    const parsed = parseJsonError(error.message);
    if (parsed) return parsed;
    return {
      code: "NS-UI-UNHANDLED",
      stage: fallbackStage,
      title: "Arayüz işlemi tamamlanamadı",
      message: error.message,
      timestamp: new Date().toISOString(),
      hint: "Bu debug paketini geliştiriciye iletin."
    };
  }

  return {
    code: "NS-UI-UNKNOWN",
    stage: fallbackStage,
    title: "Bilinmeyen arayüz hatası",
    message: String(error),
    timestamp: new Date().toISOString(),
    hint: "Bu debug paketini geliştiriciye iletin."
  };
}

export function jobError(job?: Job): AppErrorInfo | null {
  if (!job?.error) return null;
  if (isAppError(job.error)) return job.error;
  const parsed = parseJsonError(job.error);
  if (parsed) return parsed;
  return {
    code: "NS-JOB-LEGACY",
    stage: job.status,
    title: "İşlem tamamlanamadı",
    message: job.error,
    timestamp: job.updated_at,
    job_id: job.id
  };
}

export function buildDebugText(error: AppErrorInfo, job?: Job, assets?: AssetStatus | null) {
  return JSON.stringify(
    {
      debug_type: "neon_subtitle_studio_error",
      error,
      job: job
        ? {
            id: job.id,
            status: job.status,
            progress: job.progress,
            source_language: job.source_language,
            target_language: job.target_language,
            outputs: job.outputs,
            created_at: job.created_at,
            updated_at: job.updated_at
          }
        : null,
      assets: assets
        ? {
            ready: assets.ready,
            items: assets.items.map((item) => ({
              id: item.id,
              label: item.label,
              required: item.required,
              exists: item.exists,
              ok: item.ok
            }))
          }
        : null,
      app_time: new Date().toISOString()
    },
    null,
    2
  );
}

function parseJsonError(message: string): AppErrorInfo | null {
  try {
    const parsed = JSON.parse(message);
    return isAppError(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isAppError(value: unknown): value is AppErrorInfo {
  return Boolean(
    value &&
      typeof value === "object" &&
      "code" in value &&
      "stage" in value &&
      "message" in value &&
      "timestamp" in value
  );
}
