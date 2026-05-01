import {
  Captions,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronsUp,
  Clipboard,
  Clock3,
  FileSearch,
  Download,
  FolderOpen,
  HelpCircle,
  HardDrive,
  Minimize2,
  Play,
  Replace,
  Scissors,
  Settings,
  SlidersHorizontal,
  Type,
  Upload,
  Wand2,
  XCircle
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@tauri-apps/api/core";
import { ChangeEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./lib/api";
import { buildDebugText, jobError, normalizeError } from "./lib/errors";
import type { AssetStatus, Job, LanguageCode, SubtitleSegment } from "./lib/types";

const languages: { code: LanguageCode; label: string }[] = [
  { code: "auto", label: "Auto" },
  { code: "tr", label: "Türkçe" },
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
  { code: "ar", label: "العربية" }
];

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
  outputs: ["srt", "vtt", "ass", "mp4"],
  status: "ready_for_edit",
  progress: 72,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
};

const processingSteps: { status: Job["status"]; label: string }[] = [
  { status: "queued", label: "Alındı" },
  { status: "extracting_audio", label: "Ses" },
  { status: "transcribing", label: "Metin" },
  { status: "translating", label: "Çeviri" },
  { status: "ready_for_edit", label: "Kontrol" },
  { status: "completed", label: "Hazır" }
];

const workflowItems = [
  { key: "setup", label: "Setup", icon: Upload },
  { key: "processing", label: "Processing", icon: Wand2 },
  { key: "editor", label: "Editor", icon: Scissors },
  { key: "export", label: "Export", icon: Download },
  { key: "done", label: "Done", icon: CheckCircle2 },
  { key: "settings", label: "Settings", icon: Settings }
] as const;

const outputFormats = ["SRT", "VTT", "ASS", "MP4", "MOV", "WEBM"] as const;
type OutputFormat = (typeof outputFormats)[number];

const outputFormatDetails: Record<OutputFormat, { title: string; description: string; extension: string; kind: "subtitle" | "video" }> = {
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
  WEBM: {
    title: "WEBM altyazılı video",
    description: "Web kullanımına uygun altyazısı gömülü video çıktısı.",
    extension: "webm",
    kind: "video"
  }
};

const defaultStyle = {
  fontFamily: "Inter",
  fontSize: 42,
  color: "#ffffff",
  stroke: 4,
  shadow: 60,
  bottom: 12,
  align: "center"
};

const TIMELINE_WINDOW_MS = 35000;
const TIMELINE_FOLLOW_RATIO = 0.38;

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

function statusLabel(status: Job["status"]) {
  const map: Record<Job["status"], string> = {
    queued: "Sırada",
    extracting_audio: "Ses ayrılıyor",
    transcribing: "Yazıya dökülüyor",
    translating: "Çeviri",
    ready_for_edit: "Düzenlemeye hazır",
    exporting: "Export",
    completed: "Tamamlandı",
    failed: "Hata",
    cancelled: "İptal",
    paused: "Duraklatıldı"
  };
  return map[status];
}

function processingDetail(job?: Job) {
  if (!job) return "Yerel motor bağlantısı bekleniyor.";
  const translationText = job.translation_enabled ? " Ardından çeviri hazırlanacak." : "";
  const map: Record<Job["status"], string> = {
    queued: "Video sıraya alındı. Yerel işlem motoru işi başlatıyor.",
    extracting_audio: "Video sesi ayrılıyor ve konuşma için temizleniyor.",
    transcribing: `Temizlenen ses tam zaman çizgisiyle yazıya dökülüyor.${translationText}`,
    translating: "Altyazı metni seçilen dile çevriliyor.",
    ready_for_edit: "Altyazılar hazır. Editör açılıyor.",
    exporting: "Seçilen çıktı formatı hazırlanıyor ve dosya doğrulanıyor.",
    completed: "İşlem tamamlandı.",
    failed: "İşlem hata verdi. Debug bilgisi kopyalanabilir.",
    cancelled: "İşlem iptal edildi.",
    paused: "İşlem duraklatıldı."
  };
  return map[job.status];
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

function viewTitle(view: string) {
  const map: Record<string, string> = {
    setup: "Setup",
    processing: "Processing",
    editor: "Subtitle Editor",
    export: "Export",
    done: "Done",
    settings: "Settings"
  };
  return map[view] ?? "Setup";
}

function App() {
  const isDesktopApp = isTauri();
  const [activeView, setActiveView] = useState("setup");
  const [assetStatus, setAssetStatus] = useState<AssetStatus | null>(null);
  const [jobs, setJobs] = useState<Job[]>(() => isDesktopApp ? initialJobs : [previewJob]);
  const [selectedJobId, setSelectedJobId] = useState(() => isDesktopApp ? "" : "preview-job");
  const [segments, setSegments] = useState<SubtitleSegment[]>(() => isDesktopApp ? [] : sampleSegments);
  const [engineOnline, setEngineOnline] = useState(false);
  const [videoPath, setVideoPath] = useState("");
  const [videoFileName, setVideoFileName] = useState("");
  const [sourceLanguage, setSourceLanguage] = useState<LanguageCode>("tr");
  const [targetLanguage, setTargetLanguage] = useState<LanguageCode>("tr");
  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [message, setMessage] = useState("Yerel sistem kontrol ediliyor");
  const [lastError, setLastError] = useState<ReturnType<typeof normalizeError> | null>(null);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [subtitleStyle, setSubtitleStyle] = useState(defaultStyle);
  const [workflowUnlocked, setWorkflowUnlocked] = useState(() => !isDesktopApp);
  const [infoOpen, setInfoOpen] = useState(false);
  const [selectedOutputFormat, setSelectedOutputFormat] = useState<OutputFormat>("SRT");
  const [lastExportFiles, setLastExportFiles] = useState<string[]>([]);
  const [exportDirectory, setExportDirectory] = useState("");
  const [exportBaseName, setExportBaseName] = useState("");
  const [currentVideoMs, setCurrentVideoMs] = useState(0);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [exportingNow, setExportingNow] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [pendingExportPath, setPendingExportPath] = useState("");
  const [exportJobId, setExportJobId] = useState("");
  const [exportComplete, setExportComplete] = useState(false);
  const [processingTick, setProcessingTick] = useState(0);
  const [displayProgress, setDisplayProgress] = useState(0);
  const [tabBarCollapsed, setTabBarCollapsed] = useState(false);
  const [selectedSegmentId, setSelectedSegmentId] = useState("");
  const [videoDurationMs, setVideoDurationMs] = useState(0);
  const [timelineWindowStartMs, setTimelineWindowStartMs] = useState(0);
  const [timelineManualScroll, setTimelineManualScroll] = useState(false);
  const [segmentsOpen, setSegmentsOpen] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const selectedJob = useMemo(() => jobs.find((job) => job.id === selectedJobId) ?? (!isDesktopApp ? previewJob : undefined), [isDesktopApp, jobs, selectedJobId]);
  const processingProgress = Math.max(0, Math.min(100, selectedJob?.progress ?? 0));
  const visibleProcessingProgress = Math.max(processingProgress, Math.round(displayProgress));
  const processingDots = ".".repeat((processingTick % 3) + 1);
  const hasActivePipeline = isProcessingStatus(selectedJob?.status);
  const exportFlowActive = !exportComplete && (exportingNow || selectedJob?.status === "exporting" || Boolean(pendingExportPath));
  const hasLockedJob = Boolean(selectedJob && selectedJob.id !== "preview-job" && (isRunningStatus(selectedJob.status) || exportingNow));
  const hasStartedJob = Boolean(selectedJob && selectedJob.id !== "preview-job" && workflowUnlocked);
  const currentOutput = outputFormatDetails[selectedOutputFormat];
  const outputPreviewName = `${exportBaseName || "ornek-video-altyazi"}.${currentOutput.extension}`;
  const canCancelJob = Boolean(selectedJob && selectedJob.id !== "preview-job" && ["queued", "extracting_audio", "transcribing", "translating", "exporting"].includes(selectedJob.status));
  const translationActive = selectedJob?.translation_enabled ?? translationEnabled;
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
  const previewText = activeSubtitle ? (translationActive ? activeSubtitle.translated_text : activeSubtitle.source_text) : "";
  const visibleNavItems = useMemo(() =>
    workflowItems.map((item) => ({
      ...item,
      enabled:
        (item.key === "setup" && !hasStartedJob && !hasLockedJob && !exportingNow) ||
        item.key === "settings" ||
        (!isDesktopApp && item.key !== "done") ||
        (item.key === "processing" && workflowUnlocked && hasActivePipeline && !exportFlowActive) ||
        (item.key === "editor" && canOpenEditor) ||
        (item.key === "export" && canOpenExport) ||
        (item.key === "done" && canOpenDone)
    })),
  [canOpenDone, canOpenEditor, canOpenExport, exportFlowActive, exportingNow, hasActivePipeline, hasLockedJob, hasStartedJob, isDesktopApp, workflowUnlocked]);
  const readyAssets = assetStatus?.ready ?? false;
  const activeError = lastError ?? jobError(selectedJob);

  function changeSourceLanguage(language: LanguageCode) {
    setSourceLanguage(language);
    if (!translationEnabled && language !== "auto") {
      setTargetLanguage(language);
    }
  }

  async function refresh(preferredJobId?: string) {
    try {
      const [health, assets, jobList] = await Promise.all([api.health(), api.assets(), api.jobs()]);
      setEngineOnline(health.ok);
      setAssetStatus(assets);
      if (isDesktopApp && jobList.jobs.length) {
        setJobs((currentJobs) => mergeFreshJobs(jobList.jobs, currentJobs));
        setSelectedJobId((current) => {
          const preferred = preferredJobId ? jobList.jobs.find((job) => job.id === preferredJobId) : undefined;
          if (preferred) return preferred.id;
          if (!current) return "";

          const currentJob = jobList.jobs.find((job) => job.id === current);
          const latestUsableJob = jobList.jobs.find((job) => !["cancelled", "failed"].includes(job.status));
          if (!currentJob) return latestUsableJob?.id ?? jobList.jobs[0]?.id ?? "";
          if (["cancelled", "failed"].includes(currentJob.status) && latestUsableJob) return latestUsableJob.id;
          return current;
        });
      }
      const messageJobId = preferredJobId ?? selectedJobId;
      if (!jobList.jobs.some((job) => job.id === messageJobId && isRunningStatus(job.status))) {
        setMessage(assets.ready ? "" : "Kurulum kaynakları tamamlanıyor");
      }
    } catch {
      setEngineOnline(false);
      setMessage("Yerel çalışma sistemi bekleniyor");
    }
  }

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, hasActivePipeline ? 1000 : 4000);
    return () => window.clearInterval(timer);
  }, [hasActivePipeline, selectedJobId]);

  useEffect(() => {
    if (!hasActivePipeline) return;
    const timer = window.setInterval(() => setProcessingTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [hasActivePipeline]);

  useEffect(() => {
    if (!isDesktopApp || !selectedJob || !["cancelled", "failed"].includes(selectedJob.status)) return;
    const latestUsableJob = jobs.find((job) => job.id !== selectedJob.id && !["cancelled", "failed"].includes(job.status));
    if (!latestUsableJob) return;
    setSelectedJobId(latestUsableJob.id);
    setLastError(null);
    if (["ready_for_edit", "completed"].includes(latestUsableJob.status)) {
      setWorkflowUnlocked(true);
      setActiveView("editor");
    }
  }, [isDesktopApp, jobs, selectedJob?.id, selectedJob?.status]);

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
    if (!exportingNow) return;
    const timer = window.setInterval(() => {
      setExportProgress((current) => Math.min(96, current + 4));
    }, 650);
    return () => window.clearInterval(timer);
  }, [exportingNow]);

  useEffect(() => {
    if (!exportJobId || !selectedJob || selectedJob.id !== exportJobId || selectedJob.status !== "completed") return;
    setExportProgress(100);
    setLastExportFiles((current) => current.length ? current : pendingExportPath ? [pendingExportPath] : []);
    setPendingExportPath("");
    setExportJobId("");
    setExportComplete(true);
    setActiveView("done");
    setMessage("Export tamamlandı ve seçilen klasöre kaydedildi");
    setExportingNow(false);
  }, [exportJobId, pendingExportPath, selectedJob?.id, selectedJob?.status]);

  useEffect(() => {
    if (!selectedJob || selectedJob.id === "preview-job" || !engineOnline) return;
    const shouldLoadSegments = ["ready_for_edit", "completed"].includes(selectedJob.status);
    if (!shouldLoadSegments) return;
    api.segments(selectedJob.id)
      .then((result) => {
        setSegments(result.segments);
        if (selectedJob.status === "ready_for_edit" && result.segments.length > 0 && !["editor", "export", "done", "settings"].includes(activeView)) {
          setActiveView("editor");
          setMessage("Altyazılar hazır, editör açıldı");
        }
      })
      .catch(() => undefined);
  }, [activeView, selectedJob?.id, selectedJob?.status, engineOnline]);

  useEffect(() => {
    if (!visibleNavItems.some((item) => item.key === activeView && item.enabled)) {
      setActiveView(exportFlowActive ? "export" : hasActivePipeline ? "processing" : canOpenEditor ? "editor" : "setup");
    }
  }, [activeView, canOpenEditor, exportFlowActive, hasActivePipeline, visibleNavItems]);

  useEffect(() => {
    if (!segmentsOpen || !selectedSegmentId) return;
    window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(`[data-segment-id="${selectedSegmentId}"]`);
      target?.scrollIntoView({ block: "nearest" });
      target?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    });
  }, [segmentsOpen, selectedSegmentId]);

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
        setMessage("Oynatma kontrolü hazır");
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

  async function openDesktopVideoFile() {
    try {
      setLastError(null);
      setMessage("Dosya seçici açılıyor");
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "Video",
            extensions: ["mp4", "mov", "mkv", "avi", "m4v", "webm"]
          }
        ]
      });
      if (typeof selected === "string") {
        setVideoPath(selected);
        const fileName = selected.split("/").pop() ?? selected;
        setVideoFileName(fileName);
        setExportBaseName(stripExtension(fileName));
        setMessage("Video seçildi");
      } else {
        setMessage("Video seçimi iptal edildi");
      }
    } catch (error) {
      console.info("[NEON_FILE_PICKER_ERROR]", error);
      setLastError(normalizeError(error, "import_video"));
      setMessage("Dosya seçici açılamadı. Debug bilgisini kopyalayabilirsiniz.");
      fileInputRef.current?.click();
    }
  }

  async function chooseVideoFile() {
    if (hasLockedJob) {
      setMessage("Aktif iş varken yeni video seçilemez. Yeni video için mevcut akışı tamamlayıp Yeni video seçin.");
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
      setMessage("Aktif iş varken yeni video seçilemez. Önce mevcut export akışını tamamlayın veya Yeni video ile sıfırlayın.");
      return;
    }
    const file = event.target.files?.[0];
    if (!file) return;
    setVideoFileName(file.name);
    setExportBaseName(stripExtension(file.name));
    setVideoPath("");
    setMessage("Video seçildi. İşleme masaüstü uygulamada başlayacak.");
  }

  async function chooseExportDirectory() {
    if (!isDesktopApp) {
      setMessage("Klasör seçimi masaüstü uygulamada aktif");
      return;
    }
    const selected = await open({
      multiple: false,
      directory: true
    });
    if (typeof selected === "string") {
      setExportDirectory(selected);
      setMessage("Export konumu seçildi");
    }
  }

  async function createAndStartJob() {
    if (hasLockedJob) {
      setMessage("Aktif iş zaten devam ediyor. Yeni video için önce mevcut akışı tamamlayın.");
      setActiveView("editor");
      return;
    }
    if (!videoPath) {
      setMessage(videoFileName ? "Tarayıcı önizlemesi dosya yolunu vermez; gerçek işlem masaüstü app içinde başlayacak." : "Önce yerel bir video seçin");
      setActiveView("setup");
      return;
    }
    if (!window.confirm("Bu video için offline altyazı işlemi başlatılsın mı?")) return;

    const payload = {
      video_path: videoPath,
      source_language: sourceLanguage,
      target_language: translationEnabled ? targetLanguage : sourceLanguage === "auto" ? "tr" : sourceLanguage,
      translation_enabled: translationEnabled,
      outputs: [selectedOutputFormat.toLowerCase()]
    };

    if (!engineOnline) {
      setSegments([]);
      setWorkflowUnlocked(true);
      setActiveView("processing");
      setMessage("Yerel sistem hazır olunca işlem başlayacak");
      return;
    }

    try {
      setLastError(null);
      setSegments([]);
      const { job } = await api.createJob(payload);
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setSelectedJobId(job.id);
      setWorkflowUnlocked(true);
      setActiveView("processing");
      await api.startJob(job.id);
      await refresh(job.id);
    } catch (error) {
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
    setSegmentsOpen(true);
    setStyleOpen(false);
    setTimelineManualScroll(true);
    const startX = event.clientX;
    const initialStart = segment.start_ms;
    const initialEnd = segment.end_ms;
    const initialDuration = Math.max(220, initialEnd - initialStart);

    const onMove = (moveEvent: PointerEvent) => {
      const deltaMs = Math.round(((moveEvent.clientX - startX) / rect.width) * timelineWindow.duration);
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
    if (!window.confirm("Devam eden işlem iptal edilsin mi? Çıkan ara dosyalar korunabilir ama bu iş durdurulur.")) return;
    try {
      setLastError(null);
      const result = await api.cancelJob(selectedJob.id);
      setJobs((current) => current.map((job) => (job.id === result.job.id ? result.job : job)));
      setWorkflowUnlocked(false);
      setMessage("İşlem iptal edildi");
      setActiveView("setup");
    } catch (error) {
      setLastError(normalizeError(error, "cancel"));
    }
  }

  async function exportCurrentJob() {
    if (!exportDirectory.trim()) {
      setActiveView("export");
      setMessage("Önce kayıt klasörü seçin");
      return;
    }
    if (!exportBaseName.trim()) {
      setActiveView("export");
      setMessage("Önce çıktı dosya adını yazın");
      return;
    }
    if (!window.confirm(`${selectedOutputFormat} çıktısı "${outputPreviewName}" adıyla seçilen klasöre kaydedilsin mi? Aynı isimli dosya varsa üzerine yazılabilir.`)) return;
    if (!selectedJob || !engineOnline) {
      setMessage("Export için gerçek motor ve video dosyası gerekli");
      return;
    }
    const expectedExportPath = joinPath(exportDirectory, outputPreviewName);
    try {
      setLastError(null);
      if (selectedJob && engineOnline) {
        await api.saveSegments(selectedJob.id, segments);
      }
      setMessage("Export kaydediliyor. İşlem bitene kadar uygulamayı kapatmayın.");
      setExportingNow(true);
      setExportComplete(false);
      setExportProgress(8);
      setPendingExportPath(expectedExportPath);
      setExportJobId(selectedJob.id);
      setJobs((current) => current.map((job) => (job.id === selectedJob.id ? { ...job, status: "exporting", progress: 90 } : job)));
      const result = await api.exportJob(selectedJob.id, {
        outputs: [selectedOutputFormat.toLowerCase()],
        output_dir: exportDirectory,
        base_name: exportBaseName
      });
      setExportProgress(100);
      setPendingExportPath("");
      setExportJobId("");
      setExportComplete(true);
      setJobs((current) => current.map((job) => (job.id === result.job.id ? result.job : job)));
      setLastExportFiles(result.files);
      setActiveView("done");
      setMessage(`${selectedOutputFormat} çıktı tamamlandı ve seçilen klasöre kaydedildi`);
    } catch (error) {
      const maybeTransportError = error instanceof Error && /load failed|failed to fetch|network/i.test(error.message);
      if (maybeTransportError) {
        try {
          await refresh(selectedJob.id);
          setExportProgress(100);
          setPendingExportPath("");
          setExportJobId("");
          setExportComplete(true);
          setLastExportFiles([expectedExportPath]);
          setActiveView("done");
          setMessage("Export tamamlandı. Yanıt gecikti ama dosya seçilen klasöre kaydedildi.");
          return;
        } catch {
          // Fall through to the normal debug path.
        }
      }
      setLastError(normalizeError(error, "exporting"));
      setMessage("Export tamamlanamadı. Debug bilgisini kopyalayabilirsiniz.");
      setExportJobId("");
      setExportComplete(false);
    } finally {
      setExportingNow(false);
    }
  }

  function applyReplaceAll() {
    if (!findText) return;
    if (!window.confirm(`Tüm "${findText}" eşleşmeleri "${replaceText}" ile değiştirilsin mi?`)) return;
    setSegments((current) =>
      current.map((segment) => ({
        ...segment,
        source_text: replaceEvery(segment.source_text, findText, replaceText),
        translated_text: replaceEvery(segment.translated_text, findText, replaceText)
      }))
    );
    setMessage("Toplu düzeltme uygulandı");
  }

  async function copyDebugInfo() {
    if (!activeError) return;
    const debugText = buildDebugText(activeError, selectedJob, assetStatus);
    try {
      await navigator.clipboard.writeText(debugText);
      setMessage("Debug bilgisi kopyalandı");
    } catch {
      console.info("[NEON_DEBUG_COPY]", debugText);
      setMessage("Debug bilgisi console'a yazıldı");
    }
  }

  function resetForNewVideo(openPicker = false) {
    setVideoPath("");
    setVideoFileName("");
    setSegments(isDesktopApp ? [] : sampleSegments);
    setSelectedJobId(isDesktopApp ? "" : "preview-job");
    setWorkflowUnlocked(!isDesktopApp);
    setSourceLanguage("auto");
    setTargetLanguage("en");
    setTranslationEnabled(false);
    setLastExportFiles([]);
    setExportProgress(0);
    setPendingExportPath("");
    setExportJobId("");
    setExportComplete(false);
    setLastError(null);
    setExportDirectory("");
    setExportBaseName("");
    setMessage("Yeni video için hazır");
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

  return (
    <div className="app-shell">
      <header className={tabBarCollapsed ? "app-header compact collapsed" : "app-header compact"}>
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
              title={!enabled ? "Bu adım işlem ilerledikçe açılır" : label}
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
            title="Settings"
          >
            <Settings size={16} />
          </button>
          <button className="nav-item top-tab icon-only" title={tabBarCollapsed ? "Sekmeleri aç" : "Sekmeleri kapat"} onClick={() => setTabBarCollapsed((value) => !value)}>
            <ChevronsUp size={16} />
          </button>
          <button className="icon-button neon-blue" title="Bilgi merkezi" onClick={() => setInfoOpen((value) => !value)}><HelpCircle size={16} /></button>
        </div>
      </header>

      <main className="workspace">
        <input ref={fileInputRef} className="hidden-file-input" type="file" accept="video/*,.mkv,.mov,.mp4,.avi,.m4v,.webm" onChange={chooseBrowserFile} />

        {message && !activeError && (
          <section className="status-banner">
            <span>{message}</span>
          </section>
        )}

        {activeError && (
          <section className="error-banner">
            <div>
              <p className="eyebrow">{activeError.code} · {activeError.stage}</p>
              <h2>{activeError.title}</h2>
              <span>{activeError.message}</span>
            </div>
            <button className="action-button neon-pink" onClick={copyDebugInfo}>
              <Clipboard size={17} /> Debug kopyala
            </button>
          </section>
        )}

        {activeView === "setup" && (
          <section className="import-layout">
            <div className="panel import-panel">
              <h2>1. Video ve dil ayarları</h2>
              <div className="file-picker">
                <div>
                  <span>Yerel video dosyası</span>
                  <strong>{videoFileName || (videoPath ? videoPath.split("/").pop() : "Henüz video seçilmedi")}</strong>
                </div>
                <button className="file-select-button" onClick={chooseVideoFile}>
                  <FileSearch size={20} />
                  <span>Yerelden seç</span>
                </button>
              </div>
              <div className="form-grid">
                <label>
                  Konuşma dili
                  <select value={sourceLanguage} onChange={(event) => changeSourceLanguage(event.target.value as LanguageCode)}>
                    {languages.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}
                  </select>
                </label>
                <label className="toggle-field">
                  Çeviri
                  <button className={translationEnabled ? "toggle-button active" : "toggle-button"} onClick={() => setTranslationEnabled((value) => !value)}>
                    {translationEnabled ? "Açık" : "Kapalı"}
                  </button>
                </label>
              </div>
              {translationEnabled && (
                <div className="form-grid single">
                  <label>
                    Çeviri dili
                    <select value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value as LanguageCode)}>
                      {languages.filter((language) => language.code !== "auto").map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}
                    </select>
                  </label>
                </div>
              )}
              <div className="mode-note">
                {translationEnabled ? "Altyazı orijinal konuşmadan çıkarılır ve seçilen dile çevrilir." : "Altyazı sadece videodaki konuşma diliyle hazırlanır."}
              </div>
              <p className="field-caption">Desteklenen giriş formatları</p>
              <div className="format-strip">
                {["MP4", "MOV", "MKV", "AVI", "WEBM", "M4V"].map((format) => <span key={format}>{format}</span>)}
              </div>
              {hasLockedJob && <div className="mode-note">Aktif iş varken yeni video seçimi kilitlidir. Mevcut işi düzenleyip export alabilir veya Yeni video akışını başlatabilirsin.</div>}
              <button className="action-button neon-green" onClick={createAndStartJob} disabled={hasLockedJob || !videoPath}><Wand2 size={18} /> İşlemi başlat</button>
            </div>
          </section>
        )}

        {activeView === "processing" && (
          <section className="panel processing-screen">
            <ProcessingRail job={selectedJob} />
            <div className="processing-center">
              <Wand2 size={38} className="neon-text-green" />
              <h2>Video işleniyor</h2>
              <div className="processing-percent">{visibleProcessingProgress}%</div>
              <p>{processingDetail(selectedJob)}</p>
              <div className="timeline wide"><div style={{ width: `${visibleProcessingProgress}%` }} /></div>
              <div className="processing-live">
                <span>{selectedJob ? statusLabel(selectedJob.status) : "Önizleme modu"}{hasActivePipeline ? processingDots : ""}</span>
              </div>
              <div className="processing-meta-grid">
                <div>
                  <span>Aktif adım</span>
                  <strong>{selectedJob ? statusLabel(selectedJob.status) : "Önizleme"}</strong>
                </div>
                <div>
                  <span>İlerleme</span>
                  <strong>{visibleProcessingProgress}%</strong>
                </div>
                <div>
                  <span>Çeviri</span>
                  <strong>{translationActive ? "Açık" : "Kapalı"}</strong>
                </div>
              </div>
              {canCancelJob && (
                <div className="tool-actions">
                  <button className="action-button neon-pink" onClick={cancelCurrentJob}><XCircle size={17} /> İptal et</button>
                </div>
              )}
            </div>
          </section>
        )}

        {activeView === "editor" && (
          canOpenEditor ? (
          <section className={segmentsOpen || styleOpen ? "studio-layout side-panel-open" : "studio-layout side-panel-closed"}>
            <div className="video-panel panel">
              <div className="video-stage">
                {videoSource ? (
                  <video
                    key={videoSource}
                    ref={videoRef}
                    className="studio-video"
                    src={videoSource}
                    controls
                    preload="metadata"
                    onLoadedMetadata={(event) => {
                      setVideoDurationMs(Math.floor(event.currentTarget.duration * 1000));
                      setCurrentVideoMs(Math.round(event.currentTarget.currentTime * 1000));
                    }}
                    onPlay={() => setVideoPlaying(true)}
                    onPause={() => setVideoPlaying(false)}
                    onEnded={() => setVideoPlaying(false)}
                    onTimeUpdate={(event) => setCurrentVideoMs(Math.round(event.currentTarget.currentTime * 1000))}
                    onSeeked={(event) => setCurrentVideoMs(Math.round(event.currentTarget.currentTime * 1000))}
                  />
                ) : (
                  <div className="video-placeholder">
                    <div className="play-orbit"><Play size={42} /></div>
                    <span>{isDesktopApp ? "Video kaynağı bekleniyor" : "Video oynatma masaüstü uygulamada aktif"}</span>
                  </div>
                )}
                {previewText && (
                  <div
                    className="subtitle-preview"
                    style={{
                      color: subtitleStyle.color,
                      fontFamily: subtitleStyle.fontFamily,
                      fontSize: `${Math.max(18, Math.min(48, subtitleStyle.fontSize * 0.58))}px`,
                      bottom: `${subtitleStyle.bottom}%`,
                      textShadow: `0 0 ${subtitleStyle.shadow / 10}px rgba(0,0,0,.9), 0 0 ${subtitleStyle.stroke}px rgba(0,0,0,.95)`,
                      textAlign: subtitleStyle.align as "left" | "center" | "right"
                    }}
                  >
                    {previewText}
                  </div>
                )}
              </div>
              <div className="editor-timeline-panel">
                <div className="timeline-window-label">
                  <span>{formatTime(timelineWindow.start)}</span>
                  <strong>Görünen aralık</strong>
                  <span>{formatTime(timelineWindow.end)}</span>
                </div>
                <div className="subtitle-timeline" ref={timelineRef} onPointerDown={handleTimelineSeek}>
                  <div className="timeline-progress" style={{ width: `${clamp(((currentVideoMs - timelineWindow.start) / timelineWindow.duration) * 100, 0, 100)}%` }} />
                  <button
                    className="playhead"
                    style={{ left: `${clamp(((currentVideoMs - timelineWindow.start) / timelineWindow.duration) * 100, 0, 100)}%` }}
                    title="Oynatma noktasını sürükle"
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
                    return (
                      <button
                        key={segment.id}
                        className={active ? "timeline-segment active" : "timeline-segment"}
                        style={{ left: `${start}%`, width: `${width}%` }}
                        onClick={() => selectTimelineSegment(segment)}
                        onDoubleClick={() => openTimelineSegment(segment)}
                        onPointerDown={(event) => beginSegmentDrag(event, segment.id, "move")}
                        title={`${formatTime(segment.start_ms)} - ${formatTime(segment.end_ms)}`}
                      >
                        <span onPointerDown={(event) => beginSegmentDrag(event, segment.id, "start")} />
                        <b>{segment.source_text || segment.translated_text}</b>
                        <span onPointerDown={(event) => beginSegmentDrag(event, segment.id, "end")} />
                      </button>
                    );
                  })}
                </div>
                {selectedTimelineSegment && (
                  <div className="timeline-editor">
                    <div className="transport">
                      <button className="icon-button neon-blue" title="Previous segment" onClick={() => jumpSegment(-1)}><ChevronLeft size={18} /></button>
                      <button className="icon-button neon-green" title="Play" onClick={() => videoRef.current?.paused ? videoRef.current?.play() : videoRef.current?.pause()}><Play size={18} /></button>
                      <button className="icon-button neon-blue" title="Next segment" onClick={() => jumpSegment(1)}><ChevronRight size={18} /></button>
                      <span>{formatTime(currentVideoMs)}</span>
                    </div>
                    <label>
                      Başlangıç
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
                      Bitiş
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
                      <Download size={16} /> Export
                    </button>
                  </div>
                )}
              </div>
            </div>

            <aside className="editor-side-rail">
              {styleOpen ? (
                <div className="drawer-panel">
                  <div className="panel-heading">
                    <h2>Altyazı stili</h2>
                    <button className="icon-button neon-blue" title="Altyazı stilini küçült" onClick={() => setStyleOpen(false)}><Minimize2 size={16} /></button>
                  </div>
                  <StyleEditor style={subtitleStyle} onChange={setSubtitleStyle} compact />
                </div>
              ) : (
                <button className="collapsed-panel-button icon-drawer-button" title="Altyazı stili" onClick={() => { setStyleOpen(true); setSegmentsOpen(false); }}>
                  <Type size={18} />
                </button>
              )}
              {segmentsOpen ? (
                <div className="segments-panel panel">
                  <div className="panel-heading">
                    <h2>Segmentler</h2>
                    <button className="icon-button neon-blue" title="Segmentleri küçült" onClick={() => setSegmentsOpen(false)}><Minimize2 size={16} /></button>
                  </div>
                  <div className="replace-bar">
                    <FileSearch size={16} />
                    <input id="find-text" value={findText} onChange={(event) => setFindText(event.target.value)} placeholder="Bul" />
                    <input value={replaceText} onChange={(event) => setReplaceText(event.target.value)} placeholder="Değiştir" />
                    <button className="icon-button neon-blue" title="Toplu düzelt" onClick={applyReplaceAll}><Replace size={16} /></button>
                  </div>
                  <div className="segment-list">
                    {segments.length === 0 && (
                      <div className="empty-state">
                        <Captions size={28} />
                        <strong>Henüz segment yok</strong>
                        <span>Video işlenirken altyazı satırları burada canlı olarak görünecek.</span>
                      </div>
                    )}
                    {segments.map((segment) => (
                      <article data-segment-id={segment.id} className={selectedTimelineSegment?.id === segment.id ? "segment-row active" : "segment-row"} key={segment.id} onClick={() => setSelectedSegmentId(segment.id)}>
                        <div className="segment-time">
                          <Clock3 size={15} />
                          <span>{formatTime(segment.start_ms)} - {formatTime(segment.end_ms)}</span>
                        </div>
                        <textarea autoFocus={segmentsOpen && selectedTimelineSegment?.id === segment.id} value={segment.source_text} onChange={(event) => updateSegment(segment.id, { source_text: event.target.value })} />
                        {translationActive && (
                          <textarea value={segment.translated_text} onChange={(event) => updateSegment(segment.id, { translated_text: event.target.value })} dir={segment.target_language === "ar" ? "rtl" : "ltr"} />
                        )}
                      </article>
                    ))}
                  </div>
                </div>
              ) : (
                <button className="collapsed-panel-button icon-drawer-button" title="Segmentler" onClick={() => { setSegmentsOpen(true); setStyleOpen(false); }}>
                  <Captions size={18} />
                </button>
              )}
            </aside>
          </section>
          ) : (
            <section className="panel empty-workflow">
              <Upload size={34} />
              <h2>Önce yerel bir video seç</h2>
              <p>Studio ekranı, video seçilip işlem başlatıldıktan sonra açılır.</p>
              <button className="action-button neon-blue" onClick={() => { setActiveView("setup"); if (!hasLockedJob) chooseVideoFile(); }}>
                <FileSearch size={18} /> Video seç
              </button>
            </section>
          )
        )}

        {activeView === "export" && (
          <section className="export-workflow">
            <div className="panel export-panel">
              <h2>4. Çıktı hazırla</h2>
              <div className="format-grid">
                {outputFormats.map((format) => (
                  <button
                    key={format}
                    className={selectedOutputFormat === format ? "format-option active" : "format-option"}
                    disabled={exportingNow}
                    onClick={() => setSelectedOutputFormat(format)}
                  >
                    {format}
                  </button>
                ))}
              </div>
              <div className="export-detail">
                <div>
                  <span>Seçili çıktı</span>
                  <strong>{currentOutput.title}</strong>
                  <p>{currentOutput.description}</p>
                </div>
                <div>
                  <span>Üretilecek dosya</span>
                  <code>{outputPreviewName}</code>
                </div>
              </div>
              <div className="export-location">
                <label>
                  Dosya adı
                  <input value={exportBaseName} disabled={exportingNow} onChange={(event) => setExportBaseName(sanitizeBaseName(event.target.value))} placeholder="ornek-video-altyazi" />
                </label>
                <label>
                  Kayıt konumu
                  <div className="path-picker">
                    <span>{exportDirectory || "Henüz klasör seçilmedi"}</span>
                    <button className="icon-button neon-blue" title="Klasör seç" disabled={exportingNow} onClick={chooseExportDirectory}><FolderOpen size={17} /></button>
                  </div>
                </label>
              </div>
              <div className="export-actions">
                <button className="action-button neon-blue" onClick={() => setActiveView("editor")} disabled={exportingNow}>Editöre dön</button>
                {canCancelJob && <button className="action-button neon-yellow" onClick={cancelCurrentJob}><XCircle size={17} /> İptal et</button>}
                <button className="action-button neon-pink" onClick={exportCurrentJob} disabled={exportingNow}>
                  <Download size={17} /> {exportingNow ? "Kaydediliyor" : "Kaydet / Export al"}
                </button>
              </div>
              {exportingNow && (
                <div className="export-progress-panel">
                  <div>
                    <strong>Kaydediliyor</strong>
                    <span>Seçilen format hazırlanıyor. Dosya doğrulaması tamamlanınca bilgi ekranına geçilecek.</span>
                  </div>
                  <b>{exportProgress}%</b>
                  <div className="timeline wide"><div style={{ width: `${exportProgress}%` }} /></div>
                </div>
              )}
              <div className="export-note-grid">
                <div>
                  <span>Çalışma mantığı</span>
                  <strong>Tek export, tek format</strong>
                  <p>Bu ekranda seçili olan format üretilir. Sonra burada kalıp başka format seçerek yeni çıktı alabilirsin.</p>
                </div>
                <div>
                  <span>Dosya davranışı</span>
                  <strong>Seçilen klasöre kaydet</strong>
                  <p>Aynı dosya adı ve format tekrar seçilirse mevcut dosyanın üzerine yazılabilir.</p>
                </div>
              </div>
              {lastExportFiles.length > 0 && (
                <div className="export-result-panel">
                  <strong>Son alınan çıktılar</strong>
                  {lastExportFiles.map((file) => <code key={file}>{file}</code>)}
                  <div className="tool-actions">
                    <button className="action-button neon-green" onClick={() => resetForNewVideo(true)}>Yeni video</button>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {activeView === "done" && (
          <section className="panel done-panel">
            <CheckCircle2 size={42} className="ok" />
            <h2>Çıktılar hazır</h2>
            <p>Export tamamlandı. Dosyalar seçtiğin klasöre belirlediğin adla kaydedildi.</p>
            {lastExportFiles.length > 0 && (
              <div className="export-file-list">
                {lastExportFiles.map((file) => <code key={file}>{file}</code>)}
              </div>
            )}
            <div className="top-actions">
              <button className="action-button neon-blue" onClick={() => setActiveView("editor")}>Editöre dön</button>
              <button className="action-button neon-green" onClick={() => resetForNewVideo(true)}>Yeni video</button>
            </div>
          </section>
        )}

        {activeView === "settings" && (
          <section className="settings-grid">
            <div className="panel">
              <h2>Ayarlar</h2>
              <div className="inspector-row"><span>UI dili</span><strong>TR + EN hazır</strong></div>
              <div className="inspector-row"><span>Gizlilik</span><strong>Tüm işlem cihazda</strong></div>
            </div>
            <div className="panel">
              <h2>Tanılama</h2>
              <div className="asset-row"><HardDrive className="neon-text-blue" /><div><strong>Offline kaynaklar</strong><span>{readyAssets ? "Hazır" : "Tamamlanıyor"}</span></div></div>
              <div className="asset-row"><SlidersHorizontal className="neon-text-yellow" /><div><strong>İşlem sistemi</strong><span>{engineOnline ? "Çalışıyor" : "Bekleniyor"}</span></div></div>
            </div>
          </section>
        )}
        {infoOpen && <InfoCenter onClose={() => setInfoOpen(false)} />}
      </main>
    </div>
  );
}

function ProcessingRail({ job }: { job?: Job }) {
  const steps = job?.translation_enabled ? processingSteps : processingSteps.filter((step) => step.status !== "translating");
  const currentIndex = steps.findIndex((step) => step.status === job?.status);
  const safeIndex = currentIndex === -1 ? 0 : currentIndex;
  return (
    <div className="processing-rail" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
      {steps.map((step, index) => (
        <div key={step.status} className={index <= safeIndex ? "process-step active" : "process-step"}>
          <i />
          <span>{step.label}</span>
        </div>
      ))}
    </div>
  );
}

function StyleEditor({ style, onChange, compact = false }: { style: typeof defaultStyle; onChange: (style: typeof defaultStyle) => void; compact?: boolean }) {
  return (
    <div className={compact ? "tool-panel compact-style-panel" : "tool-panel"}>
      {!compact && <h3><Type size={15} /> Altyazı stili</h3>}
      <label>
        Boyut
        <input type="range" min="24" max="72" value={style.fontSize} onChange={(event) => onChange({ ...style, fontSize: Number(event.target.value) })} />
      </label>
      <label>
        Alt konum
        <input type="range" min="6" max="28" value={style.bottom} onChange={(event) => onChange({ ...style, bottom: Number(event.target.value) })} />
      </label>
      <label>
        Renk
        <input type="color" value={style.color} onChange={(event) => onChange({ ...style, color: event.target.value })} />
      </label>
      <label>
        Gölge
        <input type="range" min="0" max="100" value={style.shadow} onChange={(event) => onChange({ ...style, shadow: Number(event.target.value) })} />
      </label>
    </div>
  );
}

function InfoCenter({ onClose }: { onClose: () => void }) {
  return (
    <aside className="info-center">
      <div className="panel-heading">
        <h2>Bilgi Merkezi</h2>
        <button className="icon-button neon-pink" title="Kapat" onClick={onClose}><XCircle size={18} /></button>
      </div>
      <div className="info-section">
        <h3>Kısayollar</h3>
        <span>Space oynat/durdur</span>
        <span>Cmd/Ctrl+F bul</span>
        <span>Cmd/Ctrl+E export</span>
      </div>
      <div className="info-section">
        <h3>Akış</h3>
        <span>Video seçildikten sonra işlem Studio ekranına taşınır.</span>
        <span>Çeviri kapalıysa altyazı konuşma diliyle hazırlanır.</span>
        <span>Çeviri açıksa hedef dil seçimi devreye girer.</span>
      </div>
      <div className="info-section">
        <h3>Hata paylaşımı</h3>
        <span>Bir hata görünürse Debug kopyala çıktısını geliştiriciye ilet.</span>
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
