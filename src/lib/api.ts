import type { AssetStatus, CreateJobPayload, Job, SubtitleSegment } from "./types";

const API_BASE = "http://127.0.0.1:43187";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.text();
    let message = body || `Request failed: ${response.status}`;
    try {
      const parsed = JSON.parse(body);
      message = parsed.error ? JSON.stringify(parsed.error, null, 2) : message;
    } catch {
      // Keep raw body.
    }
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<{ ok: boolean; mode: string }>("/health"),
  assets: () => request<AssetStatus>("/assets/status"),
  jobs: () => request<{ jobs: Job[] }>("/jobs"),
  createJob: (payload: CreateJobPayload) =>
    request<{ job: Job }>("/jobs", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  startJob: (jobId: string) =>
    request<{ job: Job }>(`/jobs/${jobId}/start`, {
      method: "POST"
    }),
  segments: (jobId: string) => request<{ segments: SubtitleSegment[] }>(`/jobs/${jobId}/segments`),
  saveSegments: (jobId: string, segments: SubtitleSegment[]) =>
    request<{ ok: boolean }>(`/jobs/${jobId}/segments`, {
      method: "PUT",
      body: JSON.stringify({ segments })
    }),
  exportJob: (jobId: string) =>
    request<{ job: Job; files: string[] }>(`/jobs/${jobId}/export`, {
      method: "POST"
    })
};
