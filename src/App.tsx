import {
  Captions,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Clock3,
  FileSearch,
  Download,
  FolderOpen,
  Maximize2,
  HelpCircle,
  HardDrive,
  Minimize2,
  Pause,
  Play,
  Replace,
  Scissors,
  Settings,
  SlidersHorizontal,
  Square,
  Type,
  Upload,
  Volume1,
  Volume2,
  VolumeX,
  Wand2,
  XCircle
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChangeEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./lib/api";
import { buildDebugText, jobError, normalizeError } from "./lib/errors";
import type { AssetStatus, AudioTrack, Job, LanguageCode, ProcessingOptions, SubtitleSegment, SubtitleStyle } from "./lib/types";
import { uiText, type AppLanguage, type AppText } from "./lib/i18n";

const languages: { code: LanguageCode; label: string }[] = [
  { code: "auto", label: "Auto" },
  { code: "tr", label: "Türkçe" },
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
  { code: "ar", label: "العربية" }
];

function languageLabel(code: LanguageCode) {
  return languages.find((language) => language.code === code)?.label ?? code.toUpperCase();
}

const storageKeys = {
  exportDirectory: "neon-studio.exportDirectory",
  appLanguage: "neon-studio.appLanguage",
  defaultSubtitleStyle: "neon-studio.subtitleStyle"
};

function readStoredAppLanguage(): AppLanguage {
  if (typeof window === "undefined") return "tr";
  return window.localStorage.getItem(storageKeys.appLanguage) === "en" ? "en" : "tr";
}

function readStoredExportDirectory() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(storageKeys.exportDirectory) ?? "";
}

const defaultProcessingOptions: ProcessingOptions = {
  audio_track_index: -1,
  adjust_timing: false,
  post_process: true,
  fix_short_duration: true,
  fix_casing: true,
  add_punctuation: true,
  merge_short_segments: true,
  split_long_lines: true,
  max_chars_per_line: 42,
  max_lines: 2,
  min_duration_ms: 800
};

const sampleSegments: SubtitleSegment[] = [
  {
    id: "seg-1",
    start_ms: 1240,
    end_ms: 4520,
    source_text: "Bu video için konuşma çözümlemesi hazırlanıyor.",
    translated_text: "Speech analysis is being prepared for this video.",
    source_language: "tr",
    target_language: "en",
    speaker_label: "Konuşmacı 1",
    confidence: 0.92,
    locked: false
  },
  {
    id: "seg-2",
    start_ms: 5120,
    end_ms: 9020,
    source_text: "Altyazılar düzenlenebilir segmentler halinde tutulur.",
    translated_text: "Subtitles are kept as editable segments.",
    source_language: "tr",
    target_language: "en",
    speaker_label: "Konuşmacı 1",
    confidence: 0.88,
    locked: false
  }
];

const initialJobs: Job[] = [
];

const previewJob: Job = {
  id: "preview-job",
  video_path: "preview-video.mp4",
  source_language: "auto",
  target_language: "en",
  translation_enabled: true,
  audio_track_index: -1,
  processing_options: defaultProcessingOptions,
  outputs: ["srt", "vtt", "ass", "mp4"],
  status: "ready_for_edit",
  progress: 72,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
};

const processingSteps: { status: Job["status"] }[] = [
  { status: "queued" },
  { status: "extracting_audio" },
  { status: "transcribing" },
  { status: "translating" }
];

const workflowItems: { key: keyof Pick<typeof uiText.tr, "setup" | "processing" | "editor" | "export" | "done" | "settings">; icon: typeof Upload }[] = [
  { key: "setup", icon: Upload },
  { key: "processing", icon: Wand2 },
  { key: "editor", icon: Scissors },
  { key: "export", icon: Download },
  { key: "done", icon: CheckCircle2 },
  { key: "settings", icon: Settings }
] as const;

const outputFormats = ["SRT", "VTT", "ASS", "MP4", "MOV", "M4V", "MKV", "WEBM"] as const;
type OutputFormat = (typeof outputFormats)[number];
const subtitleOutputFormats = ["SRT", "VTT", "ASS"] as const satisfies readonly OutputFormat[];
const videoOutputFormats = ["MP4", "MOV", "M4V", "MKV", "WEBM"] as const satisfies readonly OutputFormat[];

const outputFormatDetails: Record<AppLanguage, Record<OutputFormat, { title: string; description: string; extension: string; kind: "subtitle" | "video" }>> = {
  tr: {
    SRT: {
      title: "SRT altyazı dosyası",
      description: "Genel kullanım ve video platformları için sade zaman kodlu altyazı.",
      extension: "srt",
      kind: "subtitle"
    },
    VTT: {
      title: "WebVTT altyazı dosyası",
      description: "Web player ve HTML video oynatıcıları için altyazı çıktısı.",
      extension: "vtt",
      kind: "subtitle"
    },
    ASS: {
      title: "ASS stilli altyazı dosyası",
      description: "Tipografi, konum ve gölge bilgisini taşıyan gelişmiş altyazı formatı.",
      extension: "ass",
      kind: "subtitle"
    },
    MP4: {
      title: "MP4 altyazılı video",
      description: "Altyazı videoya gömülür; paylaşmaya hazır tek video dosyası üretir.",
      extension: "mp4",
      kind: "video"
    },
    MOV: {
      title: "MOV altyazılı video",
      description: "Kurgu ve Apple ekosistemi için altyazısı gömülü video çıktısı.",
      extension: "mov",
      kind: "video"
    },
    M4V: {
      title: "M4V altyazılı video",
      description: "Apple cihazları ve medya kütüphaneleri için altyazısı gömülü video çıktısı.",
      extension: "m4v",
      kind: "video"
    },
    MKV: {
      title: "MKV altyazılı video",
      description: "Esnek container isteyen arşiv ve player kullanımları için altyazısı gömülü video.",
      extension: "mkv",
      kind: "video"
    },
    WEBM: {
      title: "WEBM altyazılı video",
      description: "Web kullanımına uygun altyazısı gömülü video çıktısı.",
      extension: "webm",
      kind: "video"
    }
  },
  en: {
    SRT: {
      title: "SRT subtitle file",
      description: "Plain timecoded subtitles for general use and video platforms.",
      extension: "srt",
      kind: "subtitle"
    },
    VTT: {
      title: "WebVTT subtitle file",
      description: "Subtitle output for web players and HTML video.",
      extension: "vtt",
      kind: "subtitle"
    },
    ASS: {
      title: "Styled ASS subtitle file",
      description: "Advanced subtitle format with typography, position, and shadow data.",
      extension: "ass",
      kind: "subtitle"
    },
    MP4: {
      title: "MP4 video with subtitles",
      description: "Subtitles are burned into the video as a single share-ready file.",
      extension: "mp4",
      kind: "video"
    },
    MOV: {
      title: "MOV video with subtitles",
      description: "Burned-in subtitle video output for editing and Apple workflows.",
      extension: "mov",
      kind: "video"
    },
    M4V: {
      title: "M4V video with subtitles",
      description: "Burned-in subtitle video output for Apple devices and media libraries.",
      extension: "m4v",
      kind: "video"
    },
    MKV: {
      title: "MKV video with subtitles",
      description: "Burned-in subtitle video for flexible archive and player workflows.",
      extension: "mkv",
      kind: "video"
    },
    WEBM: {
      title: "WEBM video with subtitles",
      description: "Web-friendly video output with subtitles burned in.",
      extension: "webm",
      kind: "video"
    }
  }
};

type SubtitlePresetKey = "broadcast" | "modern" | "social" | "classic" | "mono";

const subtitleFontOptions = [
  "Arial",
  "Helvetica",
  "Verdana",
  "Tahoma",
  "Trebuchet MS",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "Inter"
] as const;

const subtitleFontFallbacks: Record<string, string> = {
  Arial: "Helvetica, sans-serif",
  Helvetica: "Arial, sans-serif",
  Verdana: "Arial, sans-serif",
  Tahoma: "Arial, sans-serif",
  "Trebuchet MS": "Arial, sans-serif",
  Georgia: "\"Times New Roman\", serif",
  "Times New Roman": "Georgia, serif",
  "Courier New": "monospace",
  Inter: "Arial, sans-serif"
};

const defaultStyle = {
  fontFamily: "Arial",
  fontSize: 42,
  color: "#ffffff",
  stroke: 4,
  shadow: 60,
  bottom: 12,
  align: "center"
} satisfies SubtitleStyle;

const subtitleStylePresets: Record<SubtitlePresetKey, SubtitleStyle> = {
  broadcast: defaultStyle,
  modern: {
    ...defaultStyle,
    fontFamily: "Helvetica",
    fontSize: 44,
    stroke: 4,
    shadow: 45
  },
  social: {
    ...defaultStyle,
    fontFamily: "Trebuchet MS",
    fontSize: 50,
    stroke: 5,
    shadow: 55,
    bottom: 10
  },
  classic: {
    ...defaultStyle,
    fontFamily: "Arial",
    color: "#fff45c",
    stroke: 4,
    shadow: 60
  },
  mono: {
    ...defaultStyle,
    fontFamily: "Courier New",
    fontSize: 40,
    stroke: 3,
    shadow: 40
  }
};

function readStoredDefaultSubtitleStyle(): SubtitleStyle {
  if (typeof window === "undefined") return defaultStyle;
  try {
    const stored = JSON.parse(window.localStorage.getItem(storageKeys.defaultSubtitleStyle) ?? "null") as Partial<SubtitleStyle> | null;
    if (!stored || typeof stored !== "object") return defaultStyle;
    return {
      fontFamily: typeof stored.fontFamily === "string" && stored.fontFamily.trim() ? stored.fontFamily : defaultStyle.fontFamily,
      fontSize: clamp(Number(stored.fontSize), 24, 72) || defaultStyle.fontSize,
      color: /^#[0-9a-fA-F]{6}$/.test(String(stored.color)) ? String(stored.color) : defaultStyle.color,
      stroke: clamp(Number(stored.stroke), 0, 12) || 0,
      shadow: clamp(Number(stored.shadow), 0, 100) || 0,
      bottom: clamp(Number(stored.bottom), 6, 28) || defaultStyle.bottom,
      align: ["left", "center", "right"].includes(String(stored.align)) ? String(stored.align) : defaultStyle.align
    };
  } catch {
    return defaultStyle;
  }
}

function sameSubtitleStyle(first: SubtitleStyle, second: SubtitleStyle) {
  return (
    first.fontFamily === second.fontFamily &&
    first.fontSize === second.fontSize &&
    first.color === second.color &&
    first.stroke === second.stroke &&
    first.shadow === second.shadow &&
    first.bottom === second.bottom &&
    first.align === second.align
  );
}

function subtitlePreviewFontStack(fontFamily: string) {
  const family = fontFamily.trim() || defaultStyle.fontFamily;
  return `${JSON.stringify(family)}, ${subtitleFontFallbacks[family] ?? "Arial, sans-serif"}`;
}

function subtitlePreviewShadow(style: SubtitleStyle, scale = 1) {
  const outline = Math.max(0, Math.round(style.stroke * scale));
  const shadowBlur = Math.max(0, (style.shadow / 10) * scale);
  const shadowOffset = style.shadow > 0 ? Math.max(1, Math.round(style.shadow / 28)) : 0;
  const outlineColor = "rgba(0,0,0,.96)";
  const shadows = outline > 0 ? [
    `${-outline}px 0 0 ${outlineColor}`,
    `${outline}px 0 0 ${outlineColor}`,
    `0 ${-outline}px 0 ${outlineColor}`,
    `0 ${outline}px 0 ${outlineColor}`,
    `${-outline}px ${-outline}px 0 ${outlineColor}`,
    `${outline}px ${-outline}px 0 ${outlineColor}`,
    `${-outline}px ${outline}px 0 ${outlineColor}`,
    `${outline}px ${outline}px 0 ${outlineColor}`
  ] : [];
  if (shadowBlur > 0) {
    shadows.push(`0 ${shadowOffset}px ${shadowBlur}px rgba(0,0,0,.88)`);
  }
  return shadows.join(", ");
}

function subtitlePreviewStyle(style: SubtitleStyle, scale = 0.58) {
  return {
    color: style.color,
    fontFamily: subtitlePreviewFontStack(style.fontFamily),
    fontSize: `${Math.max(12, Math.min(48, style.fontSize * scale))}px`,
    bottom: `${style.bottom}%`,
    textShadow: subtitlePreviewShadow(style, scale / 0.58),
    textAlign: style.align as "left" | "center" | "right"
  };
}

function defaultExportBaseName(fileName: string, language: AppLanguage) {
  const stem = stripExtension(fileName);
  const suffix = language === "tr" ? "-altyazili" : "-subtitled";
  return stem.endsWith(suffix) ? stem : `${stem}${suffix}`;
}

const TIMELINE_WINDOW_MS = 35000;
const TIMELINE_FOLLOW_RATIO = 0.38;
const WEBM_WARNING_MS = 3 * 60 * 1000;
const WEBM_SOFT_LIMIT_MS = 10 * 60 * 1000;
const STARTUP_TIMEOUT_MS = 60000;
const STARTUP_POLL_MS = 900;

type StartupStage = "starting_engine" | "checking_assets" | "loading_jobs" | "ready" | "failed";
type StartupState = {
  stage: StartupStage;
  attempts: number;
  startedAt: number;
  detail?: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatTime(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = ms % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function timeInputValue(ms: number) {
  return formatTime(ms);
}

function timeInputToMs(value: string) {
  const cleaned = value.trim().replace(",", ".");
  if (!cleaned) return null;
  if (!cleaned.includes(":")) {
    const seconds = Number(cleaned);
    if (!Number.isFinite(seconds)) return null;
    return Math.max(0, Math.round(seconds * 1000));
  }
  const parts = cleaned.split(":");
  if (parts.length > 3) return null;
  const secondsText = parts.pop() ?? "0";
  const seconds = Number(secondsText);
  const minutes = Number(parts.pop() ?? "0");
  const hours = Number(parts.pop() ?? "0");
  if (![seconds, minutes, hours].every(Number.isFinite)) return null;
  return Math.max(0, Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function balanceSubtitleLines(text: string, maxChars: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  const safeMaxChars = Math.max(8, Math.round(maxChars || defaultProcessingOptions.max_chars_per_line));
  if (clean.length <= safeMaxChars) return clean;
  const lines: string[] = [];
  let current = "";
  clean.split(" ").forEach((word) => {
    const nextLine = `${current} ${word}`.trim();
    if (current && nextLine.length > safeMaxChars) {
      lines.push(current);
      current = word;
    } else {
      current = nextLine;
    }
    if (current.length > safeMaxChars) {
      for (let index = 0; index < current.length; index += safeMaxChars) {
        lines.push(current.slice(index, index + safeMaxChars));
      }
      current = "";
    }
  });
  if (current) lines.push(current);
  return lines.join("\n");
}

function displaySubtitleText(text: string, options: ProcessingOptions) {
  if (!options.split_long_lines) return text;
  return balanceSubtitleLines(text, options.max_chars_per_line);
}

function isRunningStatus(status?: Job["status"]) {
  return Boolean(status && ["queued", "extracting_audio", "transcribing", "translating", "exporting"].includes(status));
}

function isProcessingStatus(status?: Job["status"]) {
  return Boolean(status && ["queued", "extracting_audio", "transcribing", "translating"].includes(status));
}

function progressSoftCap(status?: Job["status"]) {
  const caps: Partial<Record<Job["status"], number>> = {
    queued: 12,
    extracting_audio: 38,
    transcribing: 88,
    translating: 96,
    exporting: 99
  };
  return caps[status ?? "queued"] ?? 100;
}

function mergeFreshJobs(incomingJobs: Job[], currentJobs: Job[]) {
  const currentById = new Map(currentJobs.map((job) => [job.id, job]));
  return incomingJobs.map((incoming) => {
    const current = currentById.get(incoming.id);
    if (!current) return incoming;
    const localLooksNewer = Date.parse(current.updated_at) >= Date.parse(incoming.updated_at);
    if (current.status === "completed" && incoming.status === "exporting") return current;
    if (current.status === "completed" && localLooksNewer && incoming.status !== "completed") return current;
    return incoming;
  });
}

function App() {
  const isDesktopApp = isTauri();
  const [activeView, setActiveView] = useState("setup");
  const [assetStatus, setAssetStatus] = useState<AssetStatus | null>(null);
  const [jobs, setJobs] = useState<Job[]>(() => isDesktopApp ? initialJobs : [previewJob]);
  const [selectedJobId, setSelectedJobId] = useState(() => isDesktopApp ? "" : "preview-job");
  const [segments, setSegments] = useState<SubtitleSegment[]>(() => isDesktopApp ? [] : sampleSegments);
  const [segmentsLoadedJobId, setSegmentsLoadedJobId] = useState(() => isDesktopApp ? "" : "preview-job");
  const [engineOnline, setEngineOnline] = useState(false);
  const [videoPath, setVideoPath] = useState("");
  const [videoFileName, setVideoFileName] = useState("");
  const [sourceLanguage, setSourceLanguage] = useState<LanguageCode>("tr");
  const [targetLanguage, setTargetLanguage] = useState<LanguageCode>("tr");
  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [audioTracksLoading, setAudioTracksLoading] = useState(false);
  const [audioTracksLoadedFor, setAudioTracksLoadedFor] = useState("");
  const [processingOptions, setProcessingOptions] = useState<ProcessingOptions>(defaultProcessingOptions);
  const [message, setMessage] = useState("");
  const [lastError, setLastError] = useState<ReturnType<typeof normalizeError> | null>(null);
  const [dismissedErrorKey, setDismissedErrorKey] = useState("");
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [defaultSubtitleStyle, setDefaultSubtitleStyle] = useState<SubtitleStyle>(readStoredDefaultSubtitleStyle);
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>(() => defaultSubtitleStyle);
  const [subtitleStyleDirty, setSubtitleStyleDirty] = useState(false);
  const [workflowUnlocked, setWorkflowUnlocked] = useState(() => !isDesktopApp);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [selectedOutputFormat, setSelectedOutputFormat] = useState<OutputFormat>("SRT");
  const [lastExportFiles, setLastExportFiles] = useState<string[]>([]);
  const [exportDirectory, setExportDirectory] = useState(readStoredExportDirectory);
  const [appLanguage, setAppLanguage] = useState<AppLanguage>(readStoredAppLanguage);
  const [exportBaseName, setExportBaseName] = useState("");
  const [currentVideoMs, setCurrentVideoMs] = useState(0);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [videoMuted, setVideoMuted] = useState(false);
  const [videoVolume, setVideoVolume] = useState(0.9);
  const [exportingNow, setExportingNow] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [pendingExportPath, setPendingExportPath] = useState("");
  const [exportJobId, setExportJobId] = useState("");
  const [exportComplete, setExportComplete] = useState(false);
  const [startingJobId, setStartingJobId] = useState("");
  const [processingTick, setProcessingTick] = useState(0);
  const [displayProgress, setDisplayProgress] = useState(0);
  const [selectedSegmentId, setSelectedSegmentId] = useState("");
  const [videoDurationMs, setVideoDurationMs] = useState(0);
  const [timelineWindowStartMs, setTimelineWindowStartMs] = useState(0);
  const [timelineManualScroll, setTimelineManualScroll] = useState(false);
  const [segmentsOpen, setSegmentsOpen] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [startupRetryKey, setStartupRetryKey] = useState(0);
  const [startupState, setStartupState] = useState<StartupState>(() => ({
    stage: isDesktopApp ? "starting_engine" : "ready",
    attempts: 0,
    startedAt: Date.now()
  }));
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoStageRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const suppressTimelineClickRef = useRef(false);
  const text = uiText[appLanguage];

  const selectedJob = useMemo(() => jobs.find((job) => job.id === selectedJobId) ?? (!isDesktopApp ? previewJob : undefined), [isDesktopApp, jobs, selectedJobId]);
  const processingProgress = Math.max(0, Math.min(100, selectedJob?.progress ?? 0));
  const visibleProcessingProgress = Math.max(processingProgress, Math.round(displayProgress));
  const processingDots = ".".repeat((processingTick % 3) + 1);
  const hasActivePipeline = isProcessingStatus(selectedJob?.status);
  const startingJob = Boolean(startingJobId);
  const exportFlowActive = !exportComplete && (exportingNow || selectedJob?.status === "exporting" || Boolean(pendingExportPath));
  const hasLockedJob = startingJob || Boolean(selectedJob && selectedJob.id !== "preview-job" && (isRunningStatus(selectedJob.status) || exportingNow));
  const hasStartedJob = Boolean(selectedJob && selectedJob.id !== "preview-job" && workflowUnlocked);
  const currentOutput = outputFormatDetails[appLanguage][selectedOutputFormat];
  const fallbackExportBaseName = appLanguage === "tr" ? "ornek-video-altyazili" : "example-video-subtitled";
  const outputPreviewName = `${exportBaseName || fallbackExportBaseName}.${currentOutput.extension}`;
  const webmWarningActive = selectedOutputFormat === "WEBM" && videoDurationMs >= WEBM_WARNING_MS;
  const webmSoftBlocked = selectedOutputFormat === "WEBM" && videoDurationMs >= WEBM_SOFT_LIMIT_MS;
  const canCancelJob = Boolean(selectedJob && selectedJob.id !== "preview-job" && ["queued", "extracting_audio", "transcribing", "translating", "exporting"].includes(selectedJob.status));
  const translationActive = selectedJob?.translation_enabled ?? translationEnabled;
  const processingSourceLanguage = selectedJob?.source_language ?? sourceLanguage;
  const processingTargetLanguage = selectedJob?.target_language ?? targetLanguage;
  const translationSummary = translationActive
    ? `${text.on}: ${languageLabel(processingSourceLanguage)} → ${languageLabel(processingTargetLanguage)}`
    : text.off;
  const videoSource = useMemo(() => {
    if (!selectedJob || selectedJob.id === "preview-job" || !engineOnline) return "";
    return api.mediaUrl(selectedJob.id);
  }, [engineOnline, selectedJob?.id]);
  const canOpenEditor = !isDesktopApp || Boolean(
    workflowUnlocked &&
    selectedJob &&
    ["ready_for_edit", "completed"].includes(selectedJob.status) &&
    segments.length > 0 &&
    videoSource
  );
  const canOpenExport = !isDesktopApp || Boolean(
    workflowUnlocked &&
    selectedJob &&
    segments.length > 0 &&
    (["ready_for_edit", "completed", "exporting"].includes(selectedJob.status) || exportingNow)
  );
  const canOpenDone = !isDesktopApp || exportComplete || Boolean(selectedJob?.status === "completed");
  const activeSubtitle = useMemo(
    () => segments.find((segment) => currentVideoMs >= segment.start_ms && currentVideoMs <= segment.end_ms),
    [currentVideoMs, segments]
  );
  const selectedTimelineSegment = useMemo(
    () => segments.find((segment) => segment.id === selectedSegmentId) ?? activeSubtitle ?? segments[0],
    [activeSubtitle, selectedSegmentId, segments]
  );
  const timelineDurationMs = useMemo(
    () => Math.max(videoDurationMs, ...segments.map((segment) => segment.end_ms), 1000),
    [segments, videoDurationMs]
  );
  const timelineWindowDurationMs = Math.min(timelineDurationMs, TIMELINE_WINDOW_MS);
  const timelineMaxWindowStartMs = Math.max(0, timelineDurationMs - timelineWindowDurationMs);
  const timelineWindow = useMemo(() => {
    const start = clamp(timelineWindowStartMs, 0, timelineMaxWindowStartMs);
    return { start, end: start + timelineWindowDurationMs, duration: timelineWindowDurationMs };
  }, [timelineMaxWindowStartMs, timelineWindowDurationMs, timelineWindowStartMs]);
  const timelineVisibleSegments = useMemo(
    () => segments.filter((segment) => segment.end_ms >= timelineWindow.start && segment.start_ms <= timelineWindow.end),
    [segments, timelineWindow.end, timelineWindow.start]
  );
  const activeProcessingOptions = selectedJob?.processing_options ?? processingOptions;
  const rawPreviewText = activeSubtitle ? (translationActive ? activeSubtitle.translated_text : activeSubtitle.source_text) : "";
  const previewText = rawPreviewText ? displaySubtitleText(rawPreviewText, activeProcessingOptions) : "";
  const visibleNavItems = useMemo(() =>
    workflowItems.map((item) => ({
      ...item,
      label: text[item.key],
      enabled:
        (item.key === "setup" && !hasStartedJob && !hasLockedJob && !exportingNow) ||
        item.key === "settings" ||
        (!isDesktopApp && item.key !== "done") ||
        (item.key === "processing" && workflowUnlocked && (hasActivePipeline || startingJob) && !exportFlowActive) ||
        (item.key === "editor" && canOpenEditor) ||
        (item.key === "export" && canOpenExport) ||
        (item.key === "done" && canOpenDone)
    })),
  [canOpenDone, canOpenEditor, canOpenExport, exportFlowActive, exportingNow, hasActivePipeline, hasLockedJob, hasStartedJob, isDesktopApp, startingJob, text, workflowUnlocked]);
  const readyAssets = assetStatus?.ready ?? false;
  const activeError = lastError ?? jobError(selectedJob);
  const activeErrorKey = activeError ? `${activeError.code}:${activeError.stage}:${activeError.timestamp}:${activeError.job_id ?? ""}` : "";
  const visibleError = activeError && activeErrorKey !== dismissedErrorKey ? activeError : null;
  const startupReady = !isDesktopApp || startupState.stage === "ready";

  function changeSourceLanguage(language: LanguageCode) {
    setSourceLanguage(language);
    if (!translationEnabled && language !== "auto") {
      setTargetLanguage(language);
    }
  }

  function updateProcessingOption<K extends keyof ProcessingOptions>(key: K, value: ProcessingOptions[K]) {
    setProcessingOptions((current) => ({ ...current, [key]: value }));
  }

  async function loadAudioTracks(path: string) {
    if (!isDesktopApp || !path || !engineOnline) {
      setAudioTracks([]);
      setAudioTracksLoadedFor("");
      setProcessingOptions((current) => ({ ...current, audio_track_index: -1 }));
      return;
    }
    setAudioTracksLoading(true);
    try {
      const info = await api.mediaInfo(path);
      setAudioTracks(info.audio_tracks);
      setAudioTracksLoadedFor(path);
      setProcessingOptions((current) => ({
        ...current,
        audio_track_index: info.audio_tracks.length === 1 ? info.audio_tracks[0].index : -1
      }));
    } catch (error) {
      setAudioTracks([]);
      setAudioTracksLoadedFor(path);
      setProcessingOptions((current) => ({ ...current, audio_track_index: -1 }));
      setLastError(normalizeError(error, "media_info"));
    } finally {
      setAudioTracksLoading(false);
    }
  }

  async function refresh(preferredJobId?: string) {
    try {
      const [health, assets, jobList] = await Promise.all([api.health(), api.assets(), api.jobs()]);
      setEngineOnline(health.ok);
      setAssetStatus(assets);
      if (isDesktopApp) {
        setJobs((currentJobs) => mergeFreshJobs(jobList.jobs, currentJobs));
        setSelectedJobId((current) => {
          const preferred = preferredJobId ? jobList.jobs.find((job) => job.id === preferredJobId) : undefined;
          if (preferred) return preferred.id;
          if (!current) return "";

          const currentJob = jobList.jobs.find((job) => job.id === current);
          if (!currentJob) return "";
          return current;
        });
      }
      const messageJobId = preferredJobId ?? selectedJobId;
      if (!jobList.jobs.some((job) => job.id === messageJobId && isRunningStatus(job.status))) {
        setMessage(assets.ready ? "" : text.engineAssetsPreparing);
      }
    } catch {
      setEngineOnline(false);
      setMessage(text.localSystemWaiting);
    }
  }

  useEffect(() => {
    if (!startupReady) return;
    refresh();
    const timer = window.setInterval(refresh, hasActivePipeline ? 1000 : 4000);
    return () => window.clearInterval(timer);
  }, [hasActivePipeline, selectedJobId, startupReady]);

  useEffect(() => {
    if (!isDesktopApp) {
      setStartupState({ stage: "ready", attempts: 0, startedAt: Date.now() });
      return;
    }

    let stopped = false;
    const startedAt = Date.now();

    async function boot() {
      let attempts = 0;
      setStartupState({ stage: "starting_engine", attempts, startedAt });
      setEngineOnline(false);

      while (!stopped && Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
        attempts += 1;
        try {
          setStartupState({ stage: "starting_engine", attempts, startedAt });
          const health = await api.health();
          if (!health.ok) {
            throw new Error("health_not_ok");
          }

          setEngineOnline(true);
          setStartupState({ stage: "checking_assets", attempts, startedAt });
          const assets = await api.assets();
          if (stopped) return;
          setAssetStatus(assets);

          if (!assets.ready) {
            const missing = assets.items
              .filter((item) => item.required && !item.ok)
              .map((item) => item.label || item.id)
              .join(", ");
            setStartupState({
              stage: "failed",
              attempts,
              startedAt,
              detail: missing ? text.startupAssetsMissing(missing) : text.startupAssetsMissing(text.assetsTitle)
            });
            return;
          }

          setStartupState({ stage: "loading_jobs", attempts, startedAt });
          const jobList = await api.jobs();
          if (stopped) return;
          setJobs((currentJobs) => mergeFreshJobs(jobList.jobs, currentJobs));
          setSelectedJobId((current) => current && jobList.jobs.some((job) => job.id === current) ? current : "");
          setMessage("");
          setStartupState({ stage: "ready", attempts, startedAt });
          return;
        } catch (error) {
          if (stopped) return;
          setEngineOnline(false);
          setStartupState({
            stage: "starting_engine",
            attempts,
            startedAt,
            detail: error instanceof Error ? error.message : String(error)
          });
          await sleep(STARTUP_POLL_MS);
        }
      }

      if (!stopped) {
        setStartupState({
          stage: "failed",
          attempts,
          startedAt,
          detail: text.startupEngineTimeout
        });
      }
    }

    void boot();
    return () => {
      stopped = true;
    };
  }, [isDesktopApp, startupRetryKey, text]);

  useEffect(() => {
    if (videoPath && engineOnline && audioTracksLoadedFor !== videoPath && !audioTracksLoading) {
      loadAudioTracks(videoPath);
    }
  }, [audioTracksLoadedFor, audioTracksLoading, engineOnline, videoPath]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => {
      setMessage((current) => current === message ? "" : current);
    }, 3200);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (!hasActivePipeline) return;
    const timer = window.setInterval(() => setProcessingTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [hasActivePipeline]);

  useEffect(() => {
    if (!isDesktopApp || !selectedJob || !["cancelled", "failed"].includes(selectedJob.status)) return;
    setWorkflowUnlocked(false);
    setSegments([]);
    setSegmentsLoadedJobId("");
    setSelectedSegmentId("");
    setLastError(null);
    setExportingNow(false);
    setExportJobId("");
    setPendingExportPath("");
    setExportProgress(0);
    setExportComplete(false);
    if (!["setup", "settings"].includes(activeView)) {
      setActiveView("setup");
    }
  }, [activeView, isDesktopApp, selectedJob?.id, selectedJob?.status]);

  useEffect(() => {
    if (!startingJobId || !selectedJob || selectedJob.id !== startingJobId) return;
    if (isRunningStatus(selectedJob.status) || ["ready_for_edit", "completed", "failed", "cancelled"].includes(selectedJob.status)) {
      setStartingJobId("");
    }
  }, [selectedJob?.id, selectedJob?.status, startingJobId]);

  useEffect(() => {
    setDisplayProgress(processingProgress);
  }, [selectedJob?.id]);

  useEffect(() => {
    setDisplayProgress((current) => {
      if (!selectedJob) return 0;
      if (["ready_for_edit", "completed"].includes(selectedJob.status)) return 100;
      if (!isRunningStatus(selectedJob.status)) return processingProgress;
      return Math.max(current, processingProgress);
    });

    if (!selectedJob || !hasActivePipeline) return;
    const cap = progressSoftCap(selectedJob.status);
    const timer = window.setInterval(() => {
      setDisplayProgress((current) => Math.min(cap, Math.max(current, processingProgress) + 1));
    }, 1600);
    return () => window.clearInterval(timer);
  }, [hasActivePipeline, processingProgress, selectedJob?.id, selectedJob?.status]);

  useEffect(() => {
    if (!exportingNow || !selectedJob || selectedJob.id !== exportJobId || selectedJob.status !== "exporting") return;
    const exportSignalProgress = clamp((selectedJob.progress - 90) * 10, 0, 90);
    setExportProgress((current) => Math.max(current, exportSignalProgress));
  }, [exportJobId, exportingNow, selectedJob?.id, selectedJob?.progress, selectedJob?.status]);

  useEffect(() => {
    if (!exportingNow || !selectedJob || selectedJob.id !== exportJobId || selectedJob.status !== "exporting") return;
    const timer = window.setInterval(() => {
      setExportProgress((current) => {
        const currentBandStart = Math.floor(current / 10) * 10;
        const currentBandCap = currentBandStart + 9;
        if (current >= 90 || current >= currentBandCap) return current;
        return current + 1;
      });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [exportJobId, exportingNow, selectedJob?.id, selectedJob?.status]);

  useEffect(() => {
    if (!exportJobId || !selectedJob || selectedJob.id !== exportJobId || selectedJob.status !== "completed") return;
    setExportProgress(100);
    setLastExportFiles((current) => pendingExportPath ? [pendingExportPath] : current);
    setPendingExportPath("");
    setExportJobId("");
    setExportComplete(true);
    setActiveView("done");
    setMessage(text.exportDoneMessage(selectedOutputFormat));
    setExportingNow(false);
  }, [exportJobId, pendingExportPath, selectedJob?.id, selectedJob?.status]);

  useEffect(() => {
    if (!exportJobId || !selectedJob || selectedJob.id !== exportJobId || !["failed", "cancelled"].includes(selectedJob.status)) return;
    setExportingNow(false);
    setExportJobId("");
    setPendingExportPath("");
    setExportComplete(false);
    setExportProgress(0);
    setMessage(selectedJob.status === "cancelled" ? text.exportCancelled : text.exportFailed);
  }, [exportJobId, selectedJob?.id, selectedJob?.status]);

  useEffect(() => {
    if (!exportJobId || !selectedJob || selectedJob.id !== exportJobId || selectedJob.status !== "ready_for_edit") return;
    const exportError = jobError(selectedJob);
    if (exportError?.stage !== "exporting") return;
    setExportingNow(false);
    setExportJobId("");
    setPendingExportPath("");
    setExportComplete(false);
    setExportProgress(0);
    setLastError(exportError);
    setMessage(text.exportFailed);
  }, [exportJobId, selectedJob?.id, selectedJob?.status, selectedJob?.error, text]);

  useEffect(() => {
    if (!selectedJob || selectedJob.id === "preview-job" || !engineOnline) return;
    const shouldLoadSegments = ["ready_for_edit", "completed"].includes(selectedJob.status);
    if (!shouldLoadSegments) return;
    if (segmentsLoadedJobId === selectedJob.id) return;
    api.segments(selectedJob.id)
      .then((result) => {
        setSegments(result.segments);
        setSegmentsLoadedJobId(selectedJob.id);
        if (selectedJob.status === "ready_for_edit" && result.segments.length > 0 && !["editor", "export", "done", "settings"].includes(activeView)) {
          setActiveView("editor");
          setMessage(text.subtitlesReadyEditorOpened);
        }
      })
      .catch(() => undefined);
  }, [activeView, selectedJob?.id, selectedJob?.status, engineOnline, segmentsLoadedJobId]);

  useEffect(() => {
    if (!visibleNavItems.some((item) => item.key === activeView && item.enabled)) {
      setActiveView(exportFlowActive ? "export" : (hasActivePipeline || startingJob) ? "processing" : canOpenEditor ? "editor" : "setup");
    }
  }, [activeView, canOpenEditor, exportFlowActive, hasActivePipeline, startingJob, visibleNavItems]);

  useEffect(() => {
    if (!segmentsOpen || !segments.length) return;
    window.requestAnimationFrame(() => {
      const targetId = activeSubtitle?.id || selectedSegmentId || segments[segments.length - 1]?.id;
      const target = targetId ? document.querySelector<HTMLElement>(`[data-segment-id="${targetId}"]`) : null;
      target?.scrollIntoView({ block: activeSubtitle?.id || selectedSegmentId ? "start" : "end" });
    });
  }, [activeSubtitle?.id, segmentsOpen, selectedSegmentId, segments.length]);

  useEffect(() => {
    if (timelineManualScroll) {
      const insideWindow = currentVideoMs >= timelineWindow.start && currentVideoMs <= timelineWindow.end;
      if (insideWindow) return;
      setTimelineManualScroll(false);
    }
    const nextStart = clamp(
      currentVideoMs - Math.round(timelineWindowDurationMs * TIMELINE_FOLLOW_RATIO),
      0,
      timelineMaxWindowStartMs
    );
    setTimelineWindowStartMs((current) => Math.abs(current - nextStart) < 12 ? current : nextStart);
  }, [
    currentVideoMs,
    timelineManualScroll,
    timelineMaxWindowStartMs,
    timelineWindow.end,
    timelineWindow.start,
    timelineWindowDurationMs,
  ]);

  useEffect(() => {
    if (!videoPlaying || activeView !== "editor") return;
    let frame = 0;
    const syncVideoTime = () => {
      const video = videoRef.current;
      if (!video || video.paused || video.ended) {
        setVideoPlaying(false);
        return;
      }
      const nextMs = Math.round(video.currentTime * 1000);
      setCurrentVideoMs((current) => Math.abs(current - nextMs) < 8 ? current : nextMs);
      frame = window.requestAnimationFrame(syncVideoTime);
    };
    frame = window.requestAnimationFrame(syncVideoTime);
    return () => window.cancelAnimationFrame(frame);
  }, [activeView, videoPlaying]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod && event.code === "Space") {
        event.preventDefault();
        setMessage(text.playbackReady);
      }
      if (mod && event.key.toLowerCase() === "e") {
        event.preventDefault();
        exportCurrentJob();
      }
      if (mod && event.key.toLowerCase() === "f") {
        event.preventDefault();
        document.getElementById("find-text")?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    function blockContextMenu(event: MouseEvent) {
      event.preventDefault();
    }
    window.addEventListener("contextmenu", blockContextMenu);
    return () => window.removeEventListener("contextmenu", blockContextMenu);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(storageKeys.defaultSubtitleStyle, JSON.stringify(defaultSubtitleStyle));
  }, [defaultSubtitleStyle]);

  function updateEditorSubtitleStyle(nextStyle: SubtitleStyle) {
    setSubtitleStyle(nextStyle);
    setSubtitleStyleDirty(!sameSubtitleStyle(nextStyle, defaultSubtitleStyle));
  }

  function updateDefaultSubtitleStyle(nextStyle: SubtitleStyle, showToast = true) {
    const shouldPreserveEditorStyle = subtitleStyleDirty && !sameSubtitleStyle(subtitleStyle, defaultSubtitleStyle);
    setDefaultSubtitleStyle(nextStyle);
    setSubtitleStyle((current) => shouldPreserveEditorStyle ? current : nextStyle);
    setSubtitleStyleDirty(shouldPreserveEditorStyle);
    if (showToast) {
      setMessage(text.defaultSubtitleStyleUpdated);
    }
  }

  function saveEditorStyleAsDefault() {
    updateDefaultSubtitleStyle(subtitleStyle, false);
    setMessage(text.editorStyleSavedAsDefault);
  }

  async function openDesktopVideoFile() {
    try {
      setLastError(null);
      setMessage(text.filePickerOpening);
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          {
            name: text.videoFilterName,
            extensions: ["mp4", "mov", "mkv", "avi", "m4v", "webm"]
          }
        ]
      });
      if (typeof selected === "string") {
        setVideoPath(selected);
        const fileName = selected.split("/").pop() ?? selected;
        setVideoFileName(fileName);
        setAudioTracks([]);
        setAudioTracksLoadedFor("");
        setExportBaseName(defaultExportBaseName(fileName, appLanguage));
        setSubtitleStyle(defaultSubtitleStyle);
        setSubtitleStyleDirty(false);
        setProcessingOptions(defaultProcessingOptions);
        setMessage(text.videoSelected);
        await loadAudioTracks(selected);
      } else {
        setMessage(text.videoSelectionCancelled);
      }
    } catch (error) {
      console.info("[NEON_FILE_PICKER_ERROR]", error);
      setLastError(normalizeError(error, "import_video"));
      setMessage(text.filePickerFailed);
      fileInputRef.current?.click();
    }
  }

  async function chooseVideoFile() {
    if (hasLockedJob) {
      setMessage(text.activeJobChooseBlocked);
      return;
    }
    if (!isDesktopApp) {
      fileInputRef.current?.click();
      return;
    }
    await openDesktopVideoFile();
  }

  function chooseBrowserFile(event: ChangeEvent<HTMLInputElement>) {
    if (hasLockedJob) {
      event.target.value = "";
      setMessage(text.activeJobBrowserBlocked);
      return;
    }
    const file = event.target.files?.[0];
    if (!file) return;
    setVideoFileName(file.name);
    setExportBaseName(defaultExportBaseName(file.name, appLanguage));
    setVideoPath("");
    setAudioTracks([]);
    setAudioTracksLoadedFor("");
    setProcessingOptions(defaultProcessingOptions);
    setSubtitleStyle(defaultSubtitleStyle);
    setSubtitleStyleDirty(false);
    setMessage(text.browserVideoSelected);
  }

  async function chooseExportDirectory() {
    if (!isDesktopApp) {
      setMessage(text.folderDesktopOnly);
      return;
    }
    const selected = await open({
      multiple: false,
      directory: true
    });
    if (typeof selected === "string") {
      setExportDirectory(selected);
      window.localStorage.setItem(storageKeys.exportDirectory, selected);
      setMessage(text.exportLocationSelected);
    }
  }

  function updateAppLanguage(language: AppLanguage) {
    setAppLanguage(language);
    window.localStorage.setItem(storageKeys.appLanguage, language);
    setMessage(uiText[language].languageUpdated);
  }

  function clearDefaultExportDirectory() {
    setExportDirectory("");
    window.localStorage.removeItem(storageKeys.exportDirectory);
    setMessage(text.exportLocationCleared);
  }

  function resetCurrentWorkspace() {
    setSelectedJobId("");
    setSegments([]);
    setSegmentsLoadedJobId("");
    setSelectedSegmentId("");
    setCurrentVideoMs(0);
    setVideoDurationMs(0);
    setTimelineWindowStartMs(0);
    setTimelineManualScroll(false);
    setSegmentsOpen(false);
    setStyleOpen(false);
    setWorkflowUnlocked(false);
    setStartingJobId("");
    setExportingNow(false);
    setExportJobId("");
    setPendingExportPath("");
    setExportComplete(false);
    setExportProgress(0);
    setLastExportFiles([]);
    setLastError(null);
  }

  async function startNewVideoSelection() {
    if (hasLockedJob) {
      setMessage(text.activeJobChooseBlocked);
      return;
    }
    resetCurrentWorkspace();
    setActiveView("setup");
    await chooseVideoFile();
  }

  async function createAndStartJob() {
    if (hasLockedJob) {
      setMessage(text.alreadyActiveJob);
      setActiveView(hasActivePipeline || startingJob ? "processing" : "editor");
      return;
    }
    if (!videoPath) {
      setMessage(videoFileName ? text.browserPathMissing : text.chooseLocalVideoFirst);
      setActiveView("setup");
      return;
    }
    const payload = {
      video_path: videoPath,
      source_language: sourceLanguage,
      target_language: translationEnabled ? targetLanguage : sourceLanguage === "auto" ? "tr" : sourceLanguage,
      translation_enabled: translationEnabled,
      audio_track_index: processingOptions.audio_track_index,
      processing_options: processingOptions,
      outputs: [selectedOutputFormat.toLowerCase()]
    };

    if (!engineOnline) {
      setSegments([]);
      setSegmentsLoadedJobId("");
      setStartingJobId("");
      setWorkflowUnlocked(false);
      setActiveView("setup");
      setMessage(text.localSystemStartWaiting);
      return;
    }

    if (!window.confirm(text.confirmStart)) return;
    setStartingJobId("pending");
    setWorkflowUnlocked(true);
    setActiveView("processing");

    try {
      setLastError(null);
      setSegments([]);
      setSegmentsLoadedJobId("");
      const { job } = await api.createJob(payload);
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setSelectedJobId(job.id);
      setStartingJobId(job.id);
      setActiveView("processing");
      await api.startJob(job.id);
      await refresh(job.id);
    } catch (error) {
      setStartingJobId("");
      setLastError(normalizeError(error, "import_video"));
      setActiveView("setup");
    }
  }

  function updateSegment(id: string, patch: Partial<SubtitleSegment>) {
    setSegments((current) => current.map((segment) => (segment.id === id ? { ...segment, ...patch } : segment)));
  }

  function updateSegmentWindow(id: string, patch: Partial<Pick<SubtitleSegment, "start_ms" | "end_ms">>) {
    setSegments((current) =>
      current.map((segment) => {
        if (segment.id !== id) return segment;
        const minDuration = 220;
        const durationLimit = Math.max(timelineDurationMs, segment.end_ms + 1000);
        let start = patch.start_ms ?? segment.start_ms;
        let end = patch.end_ms ?? segment.end_ms;
        start = clamp(start, 0, Math.max(0, durationLimit - minDuration));
        end = clamp(end, start + minDuration, durationLimit);
        return { ...segment, start_ms: start, end_ms: end };
      })
    );
  }

  function updateSelectedTime(field: "start_ms" | "end_ms", value: string) {
    if (!selectedTimelineSegment) return;
    const nextMs = timeInputToMs(value);
    if (nextMs === null) return;
    updateSegmentWindow(selectedTimelineSegment.id, { [field]: nextMs });
  }

  function seekToMs(ms: number) {
    setCurrentVideoMs(ms);
    if (videoRef.current) {
      videoRef.current.currentTime = ms / 1000;
    }
  }

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) {
      void video.play();
    } else {
      video.pause();
    }
  }

  function stopPlayback() {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = 0;
    setCurrentVideoMs(0);
  }

  function stepPlayback(deltaMs: number) {
    const maxMs = videoDurationMs || Math.round((videoRef.current?.duration || 0) * 1000) || timelineDurationMs;
    seekToMs(clamp(currentVideoMs + deltaMs, 0, maxMs));
  }

  function updateVideoVolume(nextVolume: number) {
    const normalized = clamp(nextVolume, 0, 1);
    setVideoVolume(normalized);
    setVideoMuted(normalized === 0);
    if (videoRef.current) {
      videoRef.current.volume = normalized;
      videoRef.current.muted = normalized === 0;
    }
  }

  function toggleMute() {
    const video = videoRef.current;
    if (!video) return;
    const nextMuted = !videoMuted;
    video.muted = nextMuted;
    setVideoMuted(nextMuted);
  }

  function toggleFullscreen() {
    const stage = videoStageRef.current;
    if (!stage) return;
    void (async () => {
      try {
        if (isDesktopApp) {
          const appWindow = getCurrentWindow();
          const nextFullscreen = !(await appWindow.isFullscreen());
          try {
            await appWindow.setFullscreen(nextFullscreen);
          } catch {
            await appWindow.setSimpleFullscreen(nextFullscreen);
          }
          return;
        }
        if (document.fullscreenElement) {
          await document.exitFullscreen();
          return;
        }
        await stage.requestFullscreen();
      } catch (error) {
        console.error("Fullscreen failed", error);
        setMessage(text.fullscreenFailed);
      }
    })();
  }

  function selectTimelineSegment(segment: SubtitleSegment) {
    setSelectedSegmentId(segment.id);
    setTimelineManualScroll(false);
    seekToMs(segment.start_ms);
  }

  function openTimelineSegment(segment: SubtitleSegment) {
    selectTimelineSegment(segment);
    setSegmentsOpen(true);
    setStyleOpen(false);
  }

  function jumpSegment(direction: -1 | 1) {
    if (!segments.length) return;
    const currentIndex = Math.max(0, segments.findIndex((segment) => segment.id === selectedTimelineSegment?.id));
    const next = segments[clamp(currentIndex + direction, 0, segments.length - 1)];
    if (next) selectTimelineSegment(next);
  }

  function timelinePointToMs(clientX: number) {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return clamp(Math.round(timelineWindow.start + ratio * timelineWindow.duration), 0, timelineDurationMs);
  }

  function handleTimelineSeek(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startX = event.clientX;
    const initialWindowStart = timelineWindow.start;
    let moved = false;

    const onMove = (moveEvent: PointerEvent) => {
      const deltaMs = Math.round(((moveEvent.clientX - startX) / rect.width) * timelineWindow.duration);
      if (Math.abs(deltaMs) > 120) moved = true;
      setTimelineManualScroll(true);
      setTimelineWindowStartMs(clamp(initialWindowStart - deltaMs, 0, timelineMaxWindowStartMs));
    };

    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!moved) {
        seekToMs(timelinePointToMs(upEvent.clientX));
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function beginPlayheadDrag(event: ReactPointerEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    setTimelineManualScroll(false);
    seekToMs(timelinePointToMs(event.clientX));

    const onMove = (moveEvent: PointerEvent) => {
      seekToMs(timelinePointToMs(moveEvent.clientX));
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function beginSegmentDrag(event: ReactPointerEvent<HTMLElement>, id: string, mode: "move" | "start" | "end") {
    event.preventDefault();
    event.stopPropagation();
    const segment = segments.find((item) => item.id === id);
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!segment || !rect) return;
    setSelectedSegmentId(id);
    setTimelineManualScroll(true);
    const startX = event.clientX;
    const initialStart = segment.start_ms;
    const initialEnd = segment.end_ms;
    const initialDuration = Math.max(220, initialEnd - initialStart);
    const onMove = (moveEvent: PointerEvent) => {
      const deltaMs = Math.round(((moveEvent.clientX - startX) / rect.width) * timelineWindow.duration);
      if (Math.abs(deltaMs) > 12) {
        suppressTimelineClickRef.current = true;
      }
      if (mode === "start") {
        updateSegmentWindow(id, { start_ms: clamp(initialStart + deltaMs, 0, initialEnd - 220) });
        return;
      }
      if (mode === "end") {
        updateSegmentWindow(id, { end_ms: clamp(initialEnd + deltaMs, initialStart + 220, timelineDurationMs) });
        return;
      }
      const nextStart = clamp(initialStart + deltaMs, 0, Math.max(0, timelineDurationMs - initialDuration));
      updateSegmentWindow(id, { start_ms: nextStart, end_ms: nextStart + initialDuration });
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  async function cancelCurrentJob() {
    if (!selectedJob || selectedJob.id === "preview-job") return;
    if (!window.confirm(text.cancelConfirm)) return;
    try {
      setLastError(null);
      const result = await api.cancelJob(selectedJob.id);
      setJobs((current) => current.filter((job) => job.id !== result.job.id));
      resetCurrentWorkspace();
      setMessage(text.cancelDone);
      setActiveView("setup");
    } catch (error) {
      setLastError(normalizeError(error, "cancel"));
    }
  }

  async function exportCurrentJob(forceAllowLongWebm = false) {
    if (!exportDirectory.trim()) {
      setActiveView("export");
      setMessage(text.chooseSaveFolderFirst);
      return;
    }
    if (!exportBaseName.trim()) {
      setActiveView("export");
      setMessage(text.enterOutputNameFirst);
      return;
    }
    if (!selectedJob || !engineOnline) {
      setMessage(text.exportNeedsEngine);
      return;
    }
    const expectedExportPath = joinPath(exportDirectory, outputPreviewName);
    const sourcePath = videoPath || selectedJob.video_path;
    if (sourcePath && expectedExportPath === sourcePath) {
      setMessage(text.sourceOverwriteBlocked);
      return;
    }
    if (!forceAllowLongWebm && webmSoftBlocked && !window.confirm(text.webmLongVideoConfirm)) {
      return;
    }
    if (!window.confirm(text.exportConfirm(selectedOutputFormat, outputPreviewName))) return;
    let keepExportTracking = false;
    try {
      setLastError(null);
      if (selectedJob && engineOnline) {
        await api.saveSegments(selectedJob.id, segments);
      }
      setMessage(text.exportSavingMessage);
      setExportingNow(true);
      setExportComplete(false);
      setLastExportFiles([]);
      setExportProgress(0);
      setPendingExportPath(expectedExportPath);
      setExportJobId(selectedJob.id);
      setJobs((current) => current.map((job) => (job.id === selectedJob.id ? { ...job, status: "exporting", progress: 90 } : job)));
      const runExport = (allowLongWebm: boolean) => api.exportJob(selectedJob.id, {
        outputs: [selectedOutputFormat.toLowerCase()],
        output_dir: exportDirectory,
        base_name: exportBaseName,
        style: subtitleStyle,
        allow_long_webm: allowLongWebm
      });
      let allowLongWebm = selectedOutputFormat === "WEBM" && (webmSoftBlocked || forceAllowLongWebm);
      let result;
      try {
        result = await runExport(allowLongWebm);
      } catch (error) {
        const normalized = normalizeError(error, "exporting");
        const backendNeedsWebmConfirmation = selectedOutputFormat === "WEBM" && normalized.code === "NS-EXPORT-WEBM-LONG-DURATION" && !allowLongWebm;
        if (!backendNeedsWebmConfirmation || !window.confirm(text.webmLongVideoConfirm)) {
          throw error;
        }
        allowLongWebm = true;
        setLastError(null);
        setMessage(text.exportSavingMessage);
        setJobs((current) => current.map((job) => (job.id === selectedJob.id ? { ...job, status: "exporting", progress: 90 } : job)));
        result = await runExport(true);
      }
      const completedFiles = result.files.filter((file) => !file.includes(".tmp."));
      if (!completedFiles.length) {
        throw new Error(text.exportNoCompletedFiles);
      }
      setExportProgress(100);
      setPendingExportPath("");
      setExportJobId("");
      setExportComplete(true);
      setJobs((current) => current.map((job) => (job.id === result.job.id ? result.job : job)));
      setLastExportFiles(completedFiles);
      setActiveView("done");
      setMessage(text.exportDoneMessage(selectedOutputFormat));
    } catch (error) {
      const maybeTransportError = error instanceof Error && /load failed|failed to fetch|network/i.test(error.message);
      if (maybeTransportError) {
        keepExportTracking = true;
        setLastError(null);
        setMessage(text.exportStillRunning);
        await refresh(selectedJob.id);
        return;
      }
      setLastError(normalizeError(error, "exporting"));
      setMessage(text.exportFailed);
      setExportJobId("");
      setPendingExportPath("");
      setExportComplete(false);
      setExportProgress(0);
      await refresh(selectedJob.id);
    } finally {
      if (!keepExportTracking) {
        setExportingNow(false);
      }
    }
  }

  function applyReplaceAll() {
    if (!findText) return;
    if (!window.confirm(text.replaceAllConfirm(findText, replaceText))) return;
    setSegments((current) =>
      current.map((segment) => ({
        ...segment,
        source_text: replaceEvery(segment.source_text, findText, replaceText),
        translated_text: replaceEvery(segment.translated_text, findText, replaceText)
      }))
    );
    setMessage(text.replaceAllDone);
  }

  async function copyDebugInfo() {
    if (!activeError) return;
    const debugText = buildDebugText(activeError, selectedJob, assetStatus);
    try {
      await navigator.clipboard.writeText(debugText);
      setMessage(text.debugCopied);
    } catch {
      console.info("[NEON_DEBUG_COPY]", debugText);
      setMessage(text.debugLogged);
    }
  }

  async function retryStartup() {
    if (isDesktopApp) {
      try {
        await invoke("start_engine");
      } catch (error) {
        console.info("[NEON_ENGINE_RETRY]", error);
      }
    }
    setStartupRetryKey((value) => value + 1);
  }

  async function copyStartupDebug() {
    const payload = {
      stage: startupState.stage,
      attempts: startupState.attempts,
      detail: startupState.detail,
      engineOnline,
      assetsReady: assetStatus?.ready ?? false,
      assets: assetStatus?.items?.map((item) => ({
        id: item.id,
        label: item.label,
        required: item.required,
        exists: item.exists,
        ok: item.ok,
        path: item.path
      })) ?? []
    };
    const debugText = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(debugText);
      setMessage(text.debugCopied);
    } catch {
      console.info("[NEON_STARTUP_DEBUG]", debugText);
      setMessage(text.debugLogged);
    }
  }

  function resetForNewVideo(openPicker = false) {
    setVideoPath("");
    setVideoFileName("");
    setSegments(isDesktopApp ? [] : sampleSegments);
    setSegmentsLoadedJobId(isDesktopApp ? "" : "preview-job");
    setSelectedJobId(isDesktopApp ? "" : "preview-job");
    setWorkflowUnlocked(!isDesktopApp);
    setSourceLanguage("auto");
    setTargetLanguage("en");
    setTranslationEnabled(false);
    setAudioTracks([]);
    setAudioTracksLoadedFor("");
    setProcessingOptions(defaultProcessingOptions);
    setLastExportFiles([]);
    setExportProgress(0);
    setPendingExportPath("");
    setExportJobId("");
    setExportComplete(false);
    setLastError(null);
    setExportBaseName("");
    setSubtitleStyle(defaultSubtitleStyle);
    setSubtitleStyleDirty(false);
    setMessage(text.newVideoReady);
    setActiveView("setup");
    if (openPicker) {
      window.setTimeout(() => {
        if (isDesktopApp) {
          openDesktopVideoFile();
        } else {
          fileInputRef.current?.click();
        }
      }, 80);
    }
  }

  if (!startupReady) {
    return (
      <StartupScreen
        state={startupState}
        text={text}
        onRetry={retryStartup}
        onCopyDebug={copyStartupDebug}
      />
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header compact">
        <div className="brand compact-brand">
          <div className="brand-mark"><Captions size={18} /></div>
          <strong>Neon Studio</strong>
        </div>

        <nav className="nav-list top-tabs" aria-label="Main">
          {visibleNavItems.filter((item) => item.key !== "settings").map(({ key, label, icon: Icon, enabled }) => (
            <button
              key={key}
              className={activeView === key ? "nav-item top-tab active" : "nav-item top-tab"}
              disabled={!enabled}
              onClick={() => enabled && setActiveView(key)}
              title={!enabled ? text.stepLockedTitle : label}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="header-actions">
          <button
            className={activeView === "settings" ? "nav-item top-tab icon-only active" : "nav-item top-tab icon-only"}
            onClick={() => setActiveView("settings")}
            title={text.settings}
          >
            <Settings size={16} />
          </button>
          <button
            className="nav-item top-tab about-tab"
            title={text.about}
            onClick={() => setAboutOpen((value) => !value)}
          >
            <HelpCircle size={16} />
            <span>{text.about}</span>
          </button>
        </div>
      </header>

      <main className="workspace">
        <input ref={fileInputRef} className="hidden-file-input" type="file" accept="video/*,.mkv,.mov,.mp4,.avi,.m4v,.webm" onChange={chooseBrowserFile} />

        {(visibleError || message) && (
          <div className="toast-stack" aria-live="polite">
            {visibleError && (
              <section className="toast-card error-toast">
                <div>
                  <span className="toast-kicker">{visibleError.code} · {visibleError.stage}</span>
                  <strong>{appLanguage === "tr" ? visibleError.title : text.errorToastTitle}</strong>
                  <p>{appLanguage === "tr" ? visibleError.message : text.errorToastBody}</p>
                </div>
                <div className="toast-actions">
                  <button className="toast-action-button" onClick={copyDebugInfo}>
                    <Clipboard size={15} /> {text.debug}
                  </button>
                  <button className="toast-close" title={text.close} onClick={() => setDismissedErrorKey(activeErrorKey)}>
                    <XCircle size={16} />
                  </button>
                </div>
              </section>
            )}
            {message && (
              <section className="toast-card info-toast">
                <span>{message}</span>
                <button className="toast-close" title={text.close} onClick={() => setMessage("")}>
                  <XCircle size={16} />
                </button>
              </section>
            )}
          </div>
        )}

        {activeView === "setup" && (
          <section className="import-layout">
            <div className="panel import-panel">
              <h2>{text.setupTitle}</h2>
              <div className="file-picker">
                <div>
                  <span>{text.localVideoFile}</span>
                  <strong>{videoFileName || (videoPath ? videoPath.split("/").pop() : text.noVideoSelected)}</strong>
                </div>
                <button className="file-select-button" onClick={chooseVideoFile}>
                  <FileSearch size={20} />
                  <span>{text.chooseLocal}</span>
                </button>
              </div>
              <div className="form-grid">
                <label>
                  {text.sourceLanguage}
                  <select value={sourceLanguage} onChange={(event) => changeSourceLanguage(event.target.value as LanguageCode)}>
                    {languages.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}
                  </select>
                </label>
                <label className="toggle-field">
                  {text.translation}
                  <button className={translationEnabled ? "toggle-button active" : "toggle-button"} onClick={() => setTranslationEnabled((value) => !value)}>
                    {translationEnabled ? text.on : text.off}
                  </button>
                </label>
              </div>
              {translationEnabled && (
                <div className="form-grid single">
                  <label>
                    {text.targetLanguage}
                    <select value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value as LanguageCode)}>
                      {languages.filter((language) => language.code !== "auto").map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}
                    </select>
                  </label>
                </div>
              )}
              <div className="mode-note">
                {translationEnabled ? text.translationOnNote : text.translationOffNote}
              </div>
              <div className={qualityOpen ? "quality-panel open" : "quality-panel"}>
                <button className="quality-panel-toggle" type="button" onClick={() => setQualityOpen((value) => !value)} aria-expanded={qualityOpen}>
                  <h3>{text.qualitySettings}</h3>
                  <ChevronRight size={18} />
                </button>
                {qualityOpen && (
                  <div className="quality-panel-body">
                    <div className="form-grid">
                      <label>
                        {text.audioSource}
                        <select
                          value={processingOptions.audio_track_index}
                          onChange={(event) => updateProcessingOption("audio_track_index", Number(event.target.value))}
                          disabled={audioTracksLoading || audioTracks.length === 0}
                        >
                          <option value={-1}>{audioTracksLoading ? text.audioTracksLoading : text.autoAudioTrack}</option>
                          {audioTracks.map((track) => (
                            <option key={track.index} value={track.index}>{track.label}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        {text.maxCharsPerLine}
                        <input
                          type="number"
                          min={24}
                          max={90}
                          value={processingOptions.max_chars_per_line}
                          onChange={(event) => updateProcessingOption("max_chars_per_line", Number(event.target.value))}
                        />
                      </label>
                      <label>
                        {text.minDurationMs}
                        <input
                          type="number"
                          min={400}
                          max={3000}
                          step={50}
                          value={processingOptions.min_duration_ms}
                          onChange={(event) => updateProcessingOption("min_duration_ms", Number(event.target.value))}
                        />
                      </label>
                    </div>
                    {!audioTracksLoading && videoPath && audioTracks.length === 0 && (
                      <p className="field-caption">{text.audioTracksUnavailable}</p>
                    )}
                    <div className="quality-toggle-grid">
                      {([
                        ["adjust_timing", text.adjustTiming],
                        ["post_process", text.postProcess],
                        ["fix_short_duration", text.fixShortDuration],
                        ["fix_casing", text.fixCasing],
                        ["add_punctuation", text.addPunctuation],
                        ["merge_short_segments", text.mergeShortSegments],
                        ["split_long_lines", text.splitLongLines]
                      ] as const).map(([key, label]) => (
                        <label key={key} className="check-row">
                          <input
                            type="checkbox"
                            checked={Boolean(processingOptions[key])}
                            onChange={(event) => updateProcessingOption(key, event.target.checked)}
                          />
                          <span>{label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <p className="field-caption">{text.supportedInputFormats}</p>
              <div className="format-strip">
                {["MP4", "MOV", "MKV", "AVI", "WEBM", "M4V"].map((format) => <span key={format}>{format}</span>)}
              </div>
              {hasLockedJob && <div className="mode-note">{text.activeJobLocked}</div>}
              <button className="action-button neon-green" onClick={createAndStartJob} disabled={hasLockedJob || !videoPath}><Wand2 size={18} /> {text.startProcessing}</button>
            </div>
          </section>
        )}

        {activeView === "processing" && (
          <section className="panel processing-screen">
            <ProcessingRail job={selectedJob} text={text} />
            <div className="processing-center">
              <Wand2 size={38} className="neon-text-green" />
              <h2>{text.processingTitle}</h2>
              <div className="processing-percent">{visibleProcessingProgress}%</div>
              <p>{selectedJob ? (selectedJob.status === "transcribing" && selectedJob.translation_enabled ? text.processingDetails.transcribingWithTranslation : text.processingDetails[selectedJob.status]) : text.waitingForLocalEngine}</p>
              <div className="timeline wide"><div style={{ width: `${visibleProcessingProgress}%` }} /></div>
              <div className="processing-live">
                <span>{selectedJob ? text.statusLabels[selectedJob.status] : text.previewMode}{hasActivePipeline ? processingDots : ""}</span>
              </div>
              <div className="processing-meta-grid">
                <div>
                  <span>{text.activeStep}</span>
                  <strong>{selectedJob ? text.statusLabels[selectedJob.status] : text.preview}</strong>
                </div>
                <div>
                  <span>{text.progress}</span>
                  <strong>{visibleProcessingProgress}%</strong>
                </div>
                <div>
                  <span>{text.translation}</span>
                  <strong>{translationSummary}</strong>
                </div>
              </div>
              {canCancelJob && (
                <div className="tool-actions">
                  <button className="action-button neon-pink" onClick={cancelCurrentJob}><XCircle size={17} /> {text.cancel}</button>
                </div>
              )}
            </div>
          </section>
        )}

        {activeView === "editor" && (
          canOpenEditor ? (
          <section className={segmentsOpen || styleOpen ? "studio-layout side-panel-open" : "studio-layout side-panel-closed"}>
            <div className="video-panel panel">
              <div className="video-stage" ref={videoStageRef}>
                {videoSource ? (
                  <video
                    key={videoSource}
                    ref={videoRef}
                    className="studio-video"
                    src={videoSource}
                    preload="metadata"
                    onLoadedMetadata={(event) => {
                      setVideoDurationMs(Math.floor(event.currentTarget.duration * 1000));
                      setCurrentVideoMs(Math.round(event.currentTarget.currentTime * 1000));
                      event.currentTarget.volume = videoVolume;
                      event.currentTarget.muted = videoMuted;
                    }}
                    onPlay={() => setVideoPlaying(true)}
                    onPause={() => setVideoPlaying(false)}
                    onEnded={() => setVideoPlaying(false)}
                    onVolumeChange={(event) => {
                      setVideoMuted(event.currentTarget.muted);
                      setVideoVolume(event.currentTarget.volume);
                    }}
                    onTimeUpdate={(event) => setCurrentVideoMs(Math.round(event.currentTarget.currentTime * 1000))}
                    onSeeked={(event) => setCurrentVideoMs(Math.round(event.currentTarget.currentTime * 1000))}
                  />
                ) : (
                  <div className="video-placeholder">
                    <div className="play-orbit"><Play size={42} /></div>
                    <span>{isDesktopApp ? text.videoSourceWaiting : text.desktopPlaybackOnly}</span>
                  </div>
                )}
                {previewText && (
                  <div
                    className="subtitle-preview"
                    style={subtitlePreviewStyle(subtitleStyle)}
                  >
                    {previewText}
                  </div>
                )}
                {videoSource && (
                  <div className="video-controls-overlay">
                    <div className="video-controls-row">
                      <button className="video-control-button" title={videoPlaying ? text.pause : text.play} onClick={togglePlayback}>
                        {videoPlaying ? <Pause size={17} /> : <Play size={17} />}
                      </button>
                      <button className="video-control-button" title={text.stop} onClick={stopPlayback}><Square size={15} /></button>
                      <button className="video-control-button" title={text.rewind} onClick={() => stepPlayback(-10000)}><ChevronLeft size={18} /></button>
                      <button className="video-control-button" title={text.forward} onClick={() => stepPlayback(10000)}><ChevronRight size={18} /></button>
                      <span className="video-time">{formatTime(currentVideoMs)}</span>
                      <input
                        className="video-progress"
                        type="range"
                        min={0}
                        max={Math.max(1, videoDurationMs)}
                        step={100}
                        value={clamp(currentVideoMs, 0, Math.max(1, videoDurationMs))}
                        onChange={(event) => seekToMs(Number(event.target.value))}
                        aria-label={text.videoProgress}
                      />
                      <span className="video-time">{formatTime(videoDurationMs || timelineDurationMs)}</span>
                      <button className="video-control-button" title={videoMuted ? text.unmute : text.mute} onClick={toggleMute}>
                        {videoMuted || videoVolume === 0 ? <VolumeX size={17} /> : videoVolume < 0.55 ? <Volume1 size={17} /> : <Volume2 size={17} />}
                      </button>
                      <input
                        className="video-volume"
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={videoMuted ? 0 : videoVolume}
                        onChange={(event) => updateVideoVolume(Number(event.target.value))}
                        aria-label={text.volume}
                      />
                      <button className="video-control-button" title={text.fullscreen} onClick={toggleFullscreen}><Maximize2 size={17} /></button>
                    </div>
                  </div>
                )}
              </div>
              <div className="editor-timeline-panel">
                <div className="timeline-window-label">
                  <span>{formatTime(timelineWindow.start)}</span>
                  <strong>{text.visibleRange}</strong>
                  <span>{formatTime(timelineWindow.end)}</span>
                </div>
                <div className="subtitle-timeline" ref={timelineRef} onPointerDown={handleTimelineSeek}>
                  <div className="timeline-progress" style={{ width: `${clamp(((currentVideoMs - timelineWindow.start) / timelineWindow.duration) * 100, 0, 100)}%` }} />
                  <button
                    className="playhead"
                    style={{ left: `${clamp(((currentVideoMs - timelineWindow.start) / timelineWindow.duration) * 100, 0, 100)}%` }}
                    title={text.playheadTitle}
                    onPointerDown={beginPlayheadDrag}
                  >
                    <i />
                  </button>
                  {timelineVisibleSegments.map((segment) => {
                    const clippedStart = Math.max(segment.start_ms, timelineWindow.start);
                    const clippedEnd = Math.min(segment.end_ms, timelineWindow.end);
                    const start = ((clippedStart - timelineWindow.start) / timelineWindow.duration) * 100;
                    const width = Math.max(1.8, ((clippedEnd - clippedStart) / timelineWindow.duration) * 100);
                    const active = selectedTimelineSegment?.id === segment.id || activeSubtitle?.id === segment.id;
                    const timelineLabel = translationActive
                      ? segment.translated_text || segment.source_text
                      : segment.source_text || segment.translated_text;
                    return (
                      <button
                        key={segment.id}
                        className={active ? "timeline-segment active" : "timeline-segment"}
                        style={{ left: `${start}%`, width: `${width}%` }}
                        onClick={() => {
                          if (suppressTimelineClickRef.current) {
                            suppressTimelineClickRef.current = false;
                            return;
                          }
                          setSelectedSegmentId(segment.id);
                        }}
                        onDoubleClick={() => openTimelineSegment(segment)}
                        onPointerDown={(event) => beginSegmentDrag(event, segment.id, "move")}
                        title={`${formatTime(segment.start_ms)} - ${formatTime(segment.end_ms)}`}
                      >
                        <span className="segment-edge segment-edge-start" onPointerDown={(event) => beginSegmentDrag(event, segment.id, "start")} />
                        <b>{timelineLabel}</b>
                        <span className="segment-edge segment-edge-end" onPointerDown={(event) => beginSegmentDrag(event, segment.id, "end")} />
                      </button>
                    );
                  })}
                </div>
                {selectedTimelineSegment && (
                  <div className="timeline-editor">
                    <div className="transport">
                      <button className="icon-button neon-blue" title={text.previousSegment} onClick={() => jumpSegment(-1)}><ChevronLeft size={18} /></button>
                      <button className="icon-button neon-green" title={text.play} onClick={() => videoRef.current?.paused ? videoRef.current?.play() : videoRef.current?.pause()}><Play size={18} /></button>
                      <button className="icon-button neon-blue" title={text.nextSegment} onClick={() => jumpSegment(1)}><ChevronRight size={18} /></button>
                      <span>{formatTime(currentVideoMs)}</span>
                    </div>
                    <label>
                      {text.startTime}
                      <input
                        key={`${selectedTimelineSegment.id}-start-${selectedTimelineSegment.start_ms}`}
                        type="text"
                        inputMode="decimal"
                        defaultValue={timeInputValue(selectedTimelineSegment.start_ms)}
                        onBlur={(event) => updateSelectedTime("start_ms", event.target.value)}
                        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                      />
                    </label>
                    <label>
                      {text.endTime}
                      <input
                        key={`${selectedTimelineSegment.id}-end-${selectedTimelineSegment.end_ms}`}
                        type="text"
                        inputMode="decimal"
                        defaultValue={timeInputValue(selectedTimelineSegment.end_ms)}
                        onBlur={(event) => updateSelectedTime("end_ms", event.target.value)}
                        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                      />
                    </label>
                    <button className="action-button neon-pink editor-export-action" onClick={() => setActiveView("export")} disabled={!canOpenExport}>
                      <Download size={16} /> {text.export}
                    </button>
                  </div>
                )}
              </div>
            </div>

            <aside className="editor-side-rail">
              {styleOpen ? (
                <div className="drawer-panel">
                  <div className="panel-heading">
                    <h2>{text.subtitleStyle}</h2>
                    <button className="icon-button neon-blue" title={text.collapseSubtitleStyle} onClick={() => setStyleOpen(false)}><Minimize2 size={16} /></button>
                  </div>
                  <StyleEditor style={subtitleStyle} onChange={updateEditorSubtitleStyle} text={text} compact />
                  <div className="tool-actions">
                    <button className="action-button neon-blue" onClick={saveEditorStyleAsDefault}>
                      <CheckCircle2 size={16} /> {text.saveCurrentStyleAsDefault}
                    </button>
                  </div>
                </div>
              ) : (
                <button className="collapsed-panel-button icon-drawer-button" title={text.subtitleStyle} onClick={() => { setStyleOpen(true); setSegmentsOpen(false); }}>
                  <Type size={18} />
                </button>
              )}
              {segmentsOpen ? (
                <div className="segments-panel panel">
                  <div className="panel-heading">
                    <h2>{text.segments}</h2>
                    <button className="icon-button neon-blue" title={text.collapseSegments} onClick={() => setSegmentsOpen(false)}><Minimize2 size={16} /></button>
                  </div>
                  <div className="replace-bar">
                    <FileSearch size={16} />
                    <input id="find-text" value={findText} onChange={(event) => setFindText(event.target.value)} placeholder={text.find} />
                    <input value={replaceText} onChange={(event) => setReplaceText(event.target.value)} placeholder={text.replace} />
                    <button className="icon-button neon-blue" title={text.replaceAll} onClick={applyReplaceAll}><Replace size={16} /></button>
                  </div>
                  <div className="segment-list">
                    {segments.length === 0 && (
                      <div className="empty-state">
                        <Captions size={28} />
                        <strong>{text.noSegments}</strong>
                        <span>{text.noSegmentsHint}</span>
                      </div>
                    )}
                    {segments.map((segment) => (
                      <article data-segment-id={segment.id} className={selectedTimelineSegment?.id === segment.id || activeSubtitle?.id === segment.id ? "segment-row active" : "segment-row"} key={segment.id} onClick={() => setSelectedSegmentId(segment.id)}>
                        <div className="segment-time">
                          <Clock3 size={15} />
                          <span>{formatTime(segment.start_ms)} - {formatTime(segment.end_ms)}</span>
                        </div>
                        <textarea value={segment.source_text} onChange={(event) => updateSegment(segment.id, { source_text: event.target.value })} />
                        {translationActive && (
                          <textarea value={segment.translated_text} onChange={(event) => updateSegment(segment.id, { translated_text: event.target.value })} dir={segment.target_language === "ar" ? "rtl" : "ltr"} />
                        )}
                      </article>
                    ))}
                  </div>
                </div>
              ) : (
                <button className="collapsed-panel-button icon-drawer-button" title={text.segments} onClick={() => { setSegmentsOpen(true); setStyleOpen(false); }}>
                  <Captions size={18} />
                </button>
              )}
            </aside>
          </section>
          ) : (
            <section className="panel empty-workflow">
              <Upload size={34} />
              <h2>{text.editorEmptyTitle}</h2>
              <p>{text.editorEmptyBody}</p>
              <button className="action-button neon-blue" onClick={startNewVideoSelection}>
                <FileSearch size={18} /> {text.chooseVideo}
              </button>
            </section>
          )
        )}

        {activeView === "export" && (
          <section className="export-workflow">
            <div className="panel export-panel">
              <h2>{text.exportTitle}</h2>
              <div className="format-sections">
                <div className="format-section">
                  <h3>{text.subtitleFileFormats}</h3>
                  <div className="format-grid subtitle-format-grid">
                    {subtitleOutputFormats.map((format) => (
                      <button
                        key={format}
                        className={selectedOutputFormat === format ? "format-option active" : "format-option"}
                        disabled={exportingNow}
                        onClick={() => setSelectedOutputFormat(format)}
                        title={outputFormatDetails[appLanguage][format].title}
                      >
                        {format}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="format-section">
                  <h3>{text.videoFileFormats}</h3>
                  <div className="format-grid video-format-grid">
                    {videoOutputFormats.map((format) => (
                      <button
                        key={format}
                        className={selectedOutputFormat === format ? "format-option active" : "format-option"}
                        disabled={exportingNow}
                        onClick={() => setSelectedOutputFormat(format)}
                        title={format === "WEBM" && videoDurationMs >= WEBM_WARNING_MS ? text.webmLongVideoWarning : outputFormatDetails[appLanguage][format].title}
                      >
                        {format}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="export-detail">
                <div>
                  <span>{text.selectedOutput}</span>
                  <strong>{currentOutput.title}</strong>
                  <p>{currentOutput.description}</p>
                </div>
                <div>
                  <span>{text.outputFile}</span>
                  <code>{outputPreviewName}</code>
                </div>
              </div>
              {webmWarningActive && (
                <div className={webmSoftBlocked ? "export-format-warning strong" : "export-format-warning"}>
                  {text.webmLongVideoWarning}
                </div>
              )}
              <div className="export-location">
                <label>
                  {text.fileName}
                  <input value={exportBaseName} disabled={exportingNow} onChange={(event) => setExportBaseName(sanitizeBaseName(event.target.value))} placeholder={fallbackExportBaseName} />
                </label>
                <label>
                  {text.saveLocation}
                  <div className="path-picker">
                    <span>{exportDirectory || text.notSelected}</span>
                    <button className="icon-button neon-blue" title={text.chooseFolder} disabled={exportingNow} onClick={chooseExportDirectory}><FolderOpen size={17} /></button>
                  </div>
                </label>
              </div>
              <div className="export-actions">
                <button className="action-button neon-blue" onClick={() => setActiveView("editor")} disabled={exportingNow}>{text.backToEditor}</button>
                {canCancelJob && <button className="action-button neon-yellow" onClick={cancelCurrentJob}><XCircle size={17} /> {text.cancel}</button>}
                <button className="action-button neon-pink" onClick={() => exportCurrentJob()} disabled={exportingNow}>
                  <Download size={17} /> {exportingNow ? text.saving : text.saveExport}
                </button>
              </div>
              {exportingNow && (
                <div className="export-progress-panel">
                  <div>
                    <strong>{text.saving}</strong>
                    <span>{text.exportProgressBody}</span>
                  </div>
                  <b>{exportProgress}%</b>
                  <div className="timeline wide"><div style={{ width: `${exportProgress}%` }} /></div>
                </div>
              )}
              <div className="export-note-grid">
                <div>
                  <span>{text.exportLogic}</span>
                  <strong>{text.singleExport}</strong>
                  <p>{text.singleExportBody}</p>
                </div>
                <div>
                  <span>{text.fileBehavior}</span>
                  <strong>{text.saveToSelectedFolder}</strong>
                  <p>{text.saveToSelectedFolderBody}</p>
                </div>
              </div>
              {lastExportFiles.length > 0 && (
                <div className="export-result-panel">
                  <strong>{text.lastExports}</strong>
                  {lastExportFiles.map((file) => <code key={file}>{file}</code>)}
                  <div className="tool-actions">
                    <button className="action-button neon-green" onClick={() => resetForNewVideo(true)}>{text.newVideo}</button>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {activeView === "done" && (
          <section className="panel done-panel">
            <CheckCircle2 size={42} className="ok" />
            <h2>{text.doneTitle}</h2>
            <p>{text.doneBody}</p>
            {lastExportFiles.length > 0 && (
              <div className="export-file-list">
                {lastExportFiles.map((file) => <code key={file}>{file}</code>)}
              </div>
            )}
            <div className="top-actions">
              <button className="action-button neon-blue" onClick={() => setActiveView("editor")}>{text.backToEditor}</button>
              <button className="action-button neon-green" onClick={() => resetForNewVideo(true)}>{text.newVideo}</button>
            </div>
          </section>
        )}

        {activeView === "settings" && (
          <section className="settings-grid">
            <div className="panel settings-panel settings-hero">
              <h2>{text.settingsTitle}</h2>
              <p>{text.settingsSubtitle}</p>
            </div>
            <div className="panel settings-panel">
              <div className="panel-heading">
                <h2>{text.interfaceTitle}</h2>
                <SlidersHorizontal className="neon-text-yellow" size={20} />
              </div>
              <label>
                {text.interfaceLanguage}
                <select value={appLanguage} onChange={(event) => updateAppLanguage(event.target.value as AppLanguage)}>
                  <option value="tr">Türkçe</option>
                  <option value="en">English</option>
                </select>
              </label>
              <p className="settings-help">{text.interfaceLanguageHint}</p>
            </div>
            <div className="panel settings-panel">
              <div className="panel-heading">
                <h2>{text.defaultSaveTitle}</h2>
                <FolderOpen className="neon-text-blue" size={20} />
              </div>
              <div className="settings-path">
                <span>{text.currentDefault}</span>
                <code>{exportDirectory || text.notSelected}</code>
              </div>
              <div className="tool-actions">
                <button className="action-button neon-blue" onClick={chooseExportDirectory}>
                  <FolderOpen size={17} /> {text.chooseFolder}
                </button>
                <button className="action-button neon-yellow" onClick={clearDefaultExportDirectory} disabled={!exportDirectory}>
                  <XCircle size={17} /> {text.clearFolder}
                </button>
              </div>
              <p className="settings-help">{text.defaultSaveHint}</p>
            </div>
            <div className="panel settings-panel default-subtitle-style-panel">
              <div className="panel-heading">
                <h2>{text.defaultSubtitleStyleTitle}</h2>
                <Type className="neon-text-pink" size={20} />
              </div>
              <div className="settings-subtitle-style-layout">
                <div className="settings-subtitle-preview-stage">
                  <div
                    className="subtitle-preview settings-subtitle-preview"
                    style={subtitlePreviewStyle(defaultSubtitleStyle, 0.34)}
                  >
                    {text.subtitlePreviewSample}
                  </div>
                </div>
                <StyleEditor
                  style={defaultSubtitleStyle}
                  onChange={(nextStyle) => updateDefaultSubtitleStyle(nextStyle, false)}
                  text={text}
                  compact
                />
              </div>
              <p className="settings-help">{text.defaultSubtitleStyleHint}</p>
            </div>
          </section>
        )}
        {aboutOpen && <AboutPanel onClose={() => setAboutOpen(false)} text={text} />}
      </main>
    </div>
  );
}

function StartupScreen({
  state,
  text,
  onRetry,
  onCopyDebug
}: {
  state: StartupState;
  text: AppText;
  onRetry: () => void;
  onCopyDebug: () => void;
}) {
  const failed = state.stage === "failed";

  return (
    <div className="startup-shell">
      <section className={failed ? "startup-panel startup-panel-failed" : "startup-panel"}>
        <div className="startup-brand">
          <div className="brand-mark"><Captions size={20} /></div>
          <div>
            <strong>Neon Studio</strong>
            <span>{text.appVersion}</span>
          </div>
        </div>
        <div className="startup-spinner" aria-hidden="true">
          <span />
        </div>
        <div className="startup-copy">
          <p className="eyebrow">{failed ? text.startupFailedTitle : text.startupTitle}</p>
          <h1>{failed ? text.startupFailedBody : text.startupSubtitle}</h1>
          {failed && <span>{state.detail}</span>}
        </div>
        {failed && (
          <div className="startup-actions">
            <button className="action-button neon-green" onClick={onRetry}>
              <Wand2 size={17} /> {text.startupRetry}
            </button>
            <button className="action-button neon-blue" onClick={onCopyDebug}>
              <Clipboard size={17} /> {text.startupCopyDebug}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function ProcessingRail({ job, text }: { job?: Job; text: AppText }) {
  const steps = job?.translation_enabled ? processingSteps : processingSteps.filter((step) => step.status !== "translating");
  const currentIndex = steps.findIndex((step) => step.status === job?.status);
  const safeIndex = currentIndex === -1 ? ["ready_for_edit", "completed"].includes(job?.status ?? "") ? steps.length - 1 : 0 : currentIndex;
  return (
    <div className="processing-rail" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
      {steps.map((step, index) => (
        <div key={step.status} className={index <= safeIndex ? "process-step active" : "process-step"}>
          <i />
          <span>{text.processStepLabels[step.status as keyof AppText["processStepLabels"]]}</span>
        </div>
      ))}
    </div>
  );
}

function StyleEditor({ style, onChange, text, compact = false }: { style: SubtitleStyle; onChange: (style: SubtitleStyle) => void; text: AppText; compact?: boolean }) {
  const alignOptions = [
    { value: "left", label: text.alignLeft },
    { value: "center", label: text.alignCenter },
    { value: "right", label: text.alignRight }
  ];

  return (
    <div className={compact ? "tool-panel compact-style-panel" : "tool-panel"}>
      {!compact && <h3><Type size={15} /> {text.subtitleStyle}</h3>}
      <label>
        {text.stylePreset}
        <div className="style-preset-grid">
          {(Object.keys(subtitleStylePresets) as SubtitlePresetKey[]).map((preset) => (
            <button
              key={preset}
              type="button"
              className={style.fontFamily === subtitleStylePresets[preset].fontFamily && style.color === subtitleStylePresets[preset].color ? "style-preset active" : "style-preset"}
              onClick={() => onChange(subtitleStylePresets[preset])}
            >
              {text.stylePresetLabels[preset]}
            </button>
          ))}
        </div>
      </label>
      <label>
        {text.styleFont}
        <select value={style.fontFamily} onChange={(event) => onChange({ ...style, fontFamily: event.target.value })}>
          {subtitleFontOptions.map((font) => (
            <option key={font} value={font}>{font}</option>
          ))}
        </select>
      </label>
      <label>
        <span className="control-label-row"><span>{text.styleSize}</span><strong>{style.fontSize}</strong></span>
        <input type="range" min="24" max="72" value={style.fontSize} onChange={(event) => onChange({ ...style, fontSize: Number(event.target.value) })} />
      </label>
      <label>
        <span className="control-label-row"><span>{text.styleBottom}</span><strong>{style.bottom}%</strong></span>
        <input type="range" min="6" max="28" value={style.bottom} onChange={(event) => onChange({ ...style, bottom: Number(event.target.value) })} />
      </label>
      <label>
        {text.styleColor}
        <input type="color" value={style.color} onChange={(event) => onChange({ ...style, color: event.target.value })} />
      </label>
      <label>
        <span className="control-label-row"><span>{text.styleOutline}</span><strong>{style.stroke}</strong></span>
        <input type="range" min="0" max="12" value={style.stroke} onChange={(event) => onChange({ ...style, stroke: Number(event.target.value) })} />
      </label>
      <label>
        <span className="control-label-row"><span>{text.styleShadow}</span><strong>{style.shadow}</strong></span>
        <input type="range" min="0" max="100" value={style.shadow} onChange={(event) => onChange({ ...style, shadow: Number(event.target.value) })} />
      </label>
      <label>
        {text.styleAlign}
        <div className="style-align-control">
          {alignOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={style.align === option.value ? "style-align active" : "style-align"}
              onClick={() => onChange({ ...style, align: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </label>
    </div>
  );
}

function AboutPanel({ onClose, text }: { onClose: () => void; text: AppText }) {
  return (
    <aside className="info-center about-panel">
      <div className="panel-heading">
        <h2>{text.about}</h2>
        <button className="icon-button neon-pink" title={text.close} onClick={onClose}><XCircle size={18} /></button>
      </div>
      <div className="about-brand">
        <div className="brand-mark"><Captions size={18} /></div>
        <div>
          <strong>Neon Subtitle Studio</strong>
          <span>{text.aboutBody}</span>
        </div>
      </div>
      <div className="info-section">
        <span>{text.appVersionLabel}</span>
        <strong>{text.appVersion}</strong>
        <span>{text.appDeveloperLabel}</span>
        <strong>{text.appDeveloper}</strong>
      </div>
    </aside>
  );
}

function replaceEvery(value: string, search: string, replacement: string) {
  if (!search) return value;
  return value.split(search).join(replacement);
}

function stripExtension(fileName: string) {
  return sanitizeBaseName(fileName.replace(/\.[^/.]+$/, ""));
}

function sanitizeBaseName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trimStart();
}

function joinPath(directory: string, fileName: string) {
  const separator = directory.includes("\\") ? "\\" : "/";
  return `${directory.replace(/[\\/]+$/, "")}${separator}${fileName}`;
}

export default App;
