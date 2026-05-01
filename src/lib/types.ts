export type LanguageCode = "auto" | "tr" | "en" | "de" | "fr" | "es" | "ar";

export type JobStatus =
  | "queued"
  | "extracting_audio"
  | "transcribing"
  | "translating"
  | "ready_for_edit"
  | "exporting"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused";

export interface AssetItem {
  id: string;
  label: string;
  required: boolean;
  path: string;
  exists: boolean;
  sha256?: string;
  actual_sha256?: string;
  required_on?: string[];
  contains?: string;
  ok: boolean;
}

export interface AssetStatus {
  ready: boolean;
  items: AssetItem[];
}

export interface AppErrorInfo {
  code: string;
  stage: string;
  title: string;
  message: string;
  detail?: string;
  hint?: string;
  timestamp: string;
  job_id?: string;
  context?: Record<string, unknown>;
}

export interface SubtitleSegment {
  id: string;
  start_ms: number;
  end_ms: number;
  source_text: string;
  translated_text: string;
  source_language: LanguageCode;
  target_language: LanguageCode;
  speaker_label: string;
  confidence: number;
  locked: boolean;
  timing_offset_ms?: number;
}

export interface SubtitleStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  stroke: number;
  shadow: number;
  bottom: number;
  align: string;
}

export interface AudioTrack {
  index: number;
  display_index: number;
  language: string;
  title: string;
  codec: string;
  channels: number;
  channel_layout: string;
  label: string;
}

export interface ProcessingOptions {
  audio_track_index: number;
  adjust_timing: boolean;
  post_process: boolean;
  fix_short_duration: boolean;
  fix_casing: boolean;
  add_punctuation: boolean;
  merge_short_segments: boolean;
  split_long_lines: boolean;
  max_chars_per_line: number;
  max_lines: number;
  min_duration_ms: number;
}

export interface Job {
  id: string;
  video_path: string;
  source_language: LanguageCode;
  target_language: LanguageCode;
  translation_enabled: boolean;
  audio_track_index: number;
  processing_options: ProcessingOptions;
  outputs: string[];
  status: JobStatus;
  progress: number;
  created_at: string;
  updated_at: string;
  error?: string | AppErrorInfo;
}

export interface CreateJobPayload {
  video_path: string;
  source_language: LanguageCode;
  target_language: LanguageCode;
  translation_enabled: boolean;
  audio_track_index: number;
  processing_options: ProcessingOptions;
  outputs: string[];
}

export interface ExportJobPayload {
  outputs: string[];
  output_dir?: string;
  base_name?: string;
  style?: SubtitleStyle;
  allow_long_webm?: boolean;
}
