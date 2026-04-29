import {
  Captions,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Clock3,
  FileSearch,
  Download,
  HelpCircle,
  HardDrive,
  Play,
  Replace,
  Save,
  Scissors,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  SpellCheck,
  Type,
  Upload,
  Wand2,
  XCircle
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
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

const exportPresets = ["YouTube", "TikTok/Reels", "Premiere", "DaVinci", "WebVTT", "MP4 Burn-in"];
const workflowItems = [
  { key: "setup", label: "Setup", icon: Upload },
  { key: "processing", label: "Processing", icon: Wand2 },
  { key: "editor", label: "Editor", icon: Scissors },
  { key: "export", label: "Export", icon: Download },
  { key: "done", label: "Done", icon: CheckCircle2 },
  { key: "settings", label: "Settings", icon: Settings }
] as const;

const outputFormats = ["SRT", "VTT", "ASS", "MP4", "MOV", "WEBM"] as const;

const defaultGlossary = [
  { term: "Neon Studio", replacement: "Neon Studio", note: "Marka adı korunur" },
  { term: "AI", replacement: "Yapay zeka", note: "TR çeviri tercihi" }
];

const defaultStyle = {
  fontFamily: "Inter",
  fontSize: 42,
  color: "#ffffff",
  stroke: 4,
  shadow: 60,
  bottom: 12,
  align: "center"
};

function formatTime(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = ms % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
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
  const isDesktopApp = Reflect.has(window, "__TAURI_INTERNALS__");
  const [activeView, setActiveView] = useState("setup");
  const [assetStatus, setAssetStatus] = useState<AssetStatus | null>(null);
  const [jobs, setJobs] = useState<Job[]>(() => isDesktopApp ? initialJobs : [previewJob]);
  const [selectedJobId, setSelectedJobId] = useState(() => isDesktopApp ? "" : "preview-job");
  const [segments, setSegments] = useState<SubtitleSegment[]>(() => isDesktopApp ? [] : sampleSegments);
  const [engineOnline, setEngineOnline] = useState(false);
  const [videoPath, setVideoPath] = useState("");
  const [videoFileName, setVideoFileName] = useState("");
  const [sourceLanguage, setSourceLanguage] = useState<LanguageCode>("auto");
  const [targetLanguage, setTargetLanguage] = useState<LanguageCode>("en");
  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [message, setMessage] = useState("Yerel sistem kontrol ediliyor");
  const [lastError, setLastError] = useState<ReturnType<typeof normalizeError> | null>(null);
  const [selectedPreset, setSelectedPreset] = useState("YouTube");
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [glossary, setGlossary] = useState(defaultGlossary);
  const [subtitleStyle, setSubtitleStyle] = useState(defaultStyle);
  const [workflowUnlocked, setWorkflowUnlocked] = useState(() => !isDesktopApp);
  const [infoOpen, setInfoOpen] = useState(false);
  const [selectedOutputFormats, setSelectedOutputFormats] = useState<string[]>(["SRT", "VTT"]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const selectedJob = useMemo(() => jobs.find((job) => job.id === selectedJobId) ?? (!isDesktopApp ? previewJob : undefined), [isDesktopApp, jobs, selectedJobId]);
  const hasJob = Boolean(selectedJob);
  const canOpenEditor = !isDesktopApp || (workflowUnlocked && (hasJob || segments.length > 0));
  const canOpenExport = !isDesktopApp || (workflowUnlocked && Boolean(selectedJob && ["ready_for_edit", "completed"].includes(selectedJob.status)));
  const canOpenDone = !isDesktopApp || Boolean(selectedJob?.status === "completed");
  const visibleNavItems = useMemo(() =>
    workflowItems.map((item) => ({
      ...item,
      enabled:
        item.key === "setup" ||
        item.key === "settings" ||
        (!isDesktopApp && item.key !== "done") ||
        (item.key === "processing" && workflowUnlocked) ||
        (item.key === "editor" && canOpenEditor) ||
        (item.key === "export" && canOpenExport) ||
        (item.key === "done" && canOpenDone)
    })),
  [canOpenDone, canOpenEditor, canOpenExport, isDesktopApp, workflowUnlocked]);
  const readyAssets = assetStatus?.ready ?? false;
  const activeError = lastError ?? jobError(selectedJob);
  const qualityWarnings = useMemo(() => getQualityWarnings(segments), [segments]);

  async function refresh() {
    try {
      const [health, assets, jobList] = await Promise.all([api.health(), api.assets(), api.jobs()]);
      setEngineOnline(health.ok);
      setAssetStatus(assets);
      if (isDesktopApp && jobList.jobs.length) {
        setJobs(jobList.jobs);
        setSelectedJobId((current) => jobList.jobs.some((job) => job.id === current) ? current : "");
      }
      setMessage(assets.ready ? "Tam offline çalışma hazır" : "Kurulum kaynakları tamamlanıyor");
    } catch {
      setEngineOnline(false);
      setMessage("Yerel çalışma sistemi bekleniyor");
    }
  }

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 4000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selectedJob || selectedJob.id === "demo-job" || !engineOnline) return;
    api.segments(selectedJob.id).then((result) => setSegments(result.segments)).catch(() => undefined);
  }, [selectedJob?.id, engineOnline]);

  useEffect(() => {
    if (!visibleNavItems.some((item) => item.key === activeView)) {
      setActiveView(canOpenEditor ? "editor" : "setup");
    }
  }, [activeView, canOpenEditor, visibleNavItems]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod && event.code === "Space") {
        event.preventDefault();
        setMessage("Oynatma kontrolü hazır");
      }
      if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveCurrentSegments();
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

  async function chooseVideoFile() {
    if (!Reflect.has(window, "__TAURI_INTERNALS__")) {
      fileInputRef.current?.click();
      return;
    }
    try {
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
        setVideoFileName(selected.split("/").pop() ?? selected);
        setMessage("Video seçildi");
      }
    } catch {
      fileInputRef.current?.click();
    }
  }

  function chooseBrowserFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setVideoFileName(file.name);
    setVideoPath("");
    setMessage("Video seçildi. İşleme masaüstü uygulamada başlayacak.");
  }

  async function createAndStartJob() {
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
      outputs: selectedOutputFormats.map((format) => format.toLowerCase())
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
      const { job } = await api.createJob(payload);
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setSelectedJobId(job.id);
      setWorkflowUnlocked(true);
      setActiveView("processing");
      await api.startJob(job.id);
      await refresh();
    } catch (error) {
      setLastError(normalizeError(error, "import_video"));
      setActiveView("setup");
    }
  }

  function updateSegment(id: string, patch: Partial<SubtitleSegment>) {
    setSegments((current) => current.map((segment) => (segment.id === id ? { ...segment, ...patch } : segment)));
  }

  async function saveCurrentSegments() {
    if (!window.confirm("Altyazı düzenlemeleri kaydedilsin mi?")) return;
    if (!selectedJob || !engineOnline) {
      setMessage("Demo segmentleri arayüzde güncellendi");
      return;
    }
    try {
      setLastError(null);
      await api.saveSegments(selectedJob.id, segments);
      setMessage("Autosave güncellendi");
    } catch (error) {
      setLastError(normalizeError(error, "autosave"));
    }
  }

  async function exportCurrentJob() {
    if (!window.confirm(`${selectedPreset} ayarıyla export alınsın mı?`)) return;
    if (!selectedJob || !engineOnline) {
      setMessage("Export için gerçek motor ve video dosyası gerekli");
      return;
    }
    try {
      setLastError(null);
      const result = await api.exportJob(selectedJob.id);
      setJobs((current) => current.map((job) => (job.id === result.job.id ? result.job : job)));
      setMessage(`Export tamamlandı: ${result.files.length} dosya`);
    } catch (error) {
      setLastError(normalizeError(error, "exporting"));
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

  function applyGlossary() {
    if (!window.confirm("Terim listesi tüm segmentlere uygulansın mı?")) return;
    setSegments((current) =>
      current.map((segment) => {
        let source = segment.source_text;
        let translated = segment.translated_text;
        for (const item of glossary) {
          source = replaceEvery(source, item.term, item.replacement);
          translated = replaceEvery(translated, item.term, item.replacement);
        }
        return { ...segment, source_text: source, translated_text: translated };
      })
    );
    setMessage("Terim listesi uygulandı");
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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Captions size={22} /></div>
          <div>
            <strong>Neon Studio</strong>
            <span>Offline Subtitle Lab</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="Main">
          {visibleNavItems.map(({ key, label, icon: Icon, enabled }) => (
            <button
              key={key}
              className={activeView === key ? "nav-item active" : "nav-item"}
              disabled={!enabled}
              onClick={() => enabled && setActiveView(key)}
              title={!enabled ? "Bu adım işlem ilerledikçe açılır" : label}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
        <input ref={fileInputRef} className="hidden-file-input" type="file" accept="video/*,.mkv,.mov,.mp4,.avi,.m4v,.webm" onChange={chooseBrowserFile} />

        <div className="system-card">
          <div className="system-row">
            {engineOnline ? <CheckCircle2 className="ok" size={18} /> : <XCircle className="danger" size={18} />}
            <span>Çalışma sistemi</span>
          </div>
          <div className="system-row">
            {readyAssets ? <CheckCircle2 className="ok" size={18} /> : <XCircle className="danger" size={18} />}
            <span>Tam offline kaynaklar</span>
          </div>
          <p>{message}</p>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">FULL OFFLINE BUILD</p>
            <h1>{viewTitle(activeView)}</h1>
          </div>
          <div className="top-actions">
            <button className="icon-button neon-blue" title="Bilgi merkezi" onClick={() => setInfoOpen((value) => !value)}><HelpCircle size={18} /></button>
            <button className="action-button neon-green" onClick={videoPath ? createAndStartJob : chooseVideoFile}>
              {videoPath ? <Play size={17} /> : <Upload size={17} />}
              {videoPath ? "Start" : "Video seç"}
            </button>
          </div>
        </header>

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
                  <select value={sourceLanguage} onChange={(event) => setSourceLanguage(event.target.value as LanguageCode)}>
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
              <button className="action-button neon-green" onClick={createAndStartJob}><Wand2 size={18} /> İşlemi başlat</button>
            </div>
          </section>
        )}

        {activeView === "processing" && (
          <section className="panel processing-screen">
            <ProcessingRail job={selectedJob} />
            <div className="processing-center">
              <Wand2 size={38} className="neon-text-green" />
              <h2>Video işleniyor</h2>
              <p>Ses hazırlanıyor, konuşma yazıya dökülüyor ve gerekiyorsa çeviri hazırlanıyor.</p>
              <div className="timeline wide"><div style={{ width: `${selectedJob?.progress ?? 45}%` }} /></div>
              <span>{selectedJob ? statusLabel(selectedJob.status) : "Önizleme modu"}</span>
              <button className="action-button neon-blue" onClick={() => setActiveView("editor")}>Editörü önizle</button>
            </div>
          </section>
        )}

        {activeView === "editor" && (
          canOpenEditor ? (
          <section className="studio-layout">
            <div className="video-panel panel">
              <ProcessingRail job={selectedJob} />
              <div className="video-stage">
                <div className="play-orbit"><Play size={42} /></div>
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
                  {segments[0]?.source_text}
                </div>
              </div>
              <div className="transport">
                <button className="icon-button neon-blue" title="Previous segment"><ChevronLeft size={18} /></button>
                <button className="icon-button neon-green" title="Play"><Play size={18} /></button>
                <button className="icon-button neon-blue" title="Next segment"><ChevronRight size={18} /></button>
                <div className="timeline">
                  <div style={{ width: `${selectedJob?.progress ?? 50}%` }} />
                </div>
                <span>{selectedJob ? `${selectedJob.progress}%` : "0%"}</span>
              </div>
              <div className="waveform" aria-label="Waveform preview">
                {Array.from({ length: 72 }).map((_, index) => <i key={index} style={{ height: `${20 + ((index * 17) % 64)}%` }} />)}
              </div>
            </div>

            <div className="segments-panel panel">
              <div className="panel-heading">
                <h2>Segmentler</h2>
                <button className="action-button neon-yellow" onClick={saveCurrentSegments}><Save size={16} /> Autosave</button>
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
                  <article className="segment-row" key={segment.id}>
                    <div className="segment-time">
                      <Clock3 size={15} />
                      <span>{formatTime(segment.start_ms)} - {formatTime(segment.end_ms)}</span>
                    </div>
                    <input value={segment.speaker_label} onChange={(event) => updateSegment(segment.id, { speaker_label: event.target.value })} />
                    <textarea value={segment.source_text} onChange={(event) => updateSegment(segment.id, { source_text: event.target.value })} />
                    <textarea value={segment.translated_text} onChange={(event) => updateSegment(segment.id, { translated_text: event.target.value })} dir={segment.target_language === "ar" ? "rtl" : "ltr"} />
                  </article>
                ))}
              </div>
            </div>

            <aside className="inspector panel">
              <h3>Editör kontrolü</h3>
              <div className="inspector-row"><span>Durum</span><strong>{selectedJob ? statusLabel(selectedJob.status) : "Hazır"}</strong></div>
              <div className="inspector-row"><span>Konuşma</span><strong>{selectedJob?.source_language.toUpperCase()}</strong></div>
              <div className="inspector-row"><span>Çeviri</span><strong>{translationEnabled ? selectedJob?.target_language.toUpperCase() : "Kapalı"}</strong></div>
              <QualityPanel warnings={qualityWarnings} />
              <GlossaryPanel glossary={glossary} onChange={setGlossary} onApply={applyGlossary} />
              <button className="action-button neon-pink full-width" onClick={() => setActiveView("export")}><Download size={17} /> Export hazırlığı</button>
            </aside>
          </section>
          ) : (
            <section className="panel empty-workflow">
              <Upload size={34} />
              <h2>Önce yerel bir video seç</h2>
              <p>Studio ekranı, video seçilip işlem başlatıldıktan sonra açılır.</p>
              <button className="action-button neon-blue" onClick={() => { setActiveView("setup"); chooseVideoFile(); }}>
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
                    className={selectedOutputFormats.includes(format) ? "format-option active" : "format-option"}
                    onClick={() => setSelectedOutputFormats((current) => current.includes(format) ? current.filter((item) => item !== format) : [...current, format])}
                  >
                    {format}
                  </button>
                ))}
              </div>
              <div className="preset-strip compact">
                {exportPresets.map((preset) => (
                  <button key={preset} className={selectedPreset === preset ? "preset active" : "preset"} onClick={() => setSelectedPreset(preset)}>
                    {preset}
                  </button>
                ))}
              </div>
              {(selectedOutputFormats.includes("MP4") || selectedOutputFormats.includes("MOV") || selectedOutputFormats.includes("WEBM")) && (
                <StyleEditor style={subtitleStyle} onChange={setSubtitleStyle} />
              )}
              <button className="action-button neon-pink" onClick={exportCurrentJob}><Download size={17} /> Export al</button>
            </div>
          </section>
        )}

        {activeView === "done" && (
          <section className="panel done-panel">
            <CheckCircle2 size={42} className="ok" />
            <h2>Çıktılar hazır</h2>
            <p>Export tamamlandığında dosya konumu, yeniden export ve yeni video aksiyonları burada görünecek.</p>
            <div className="top-actions">
              <button className="action-button neon-blue" onClick={() => setActiveView("editor")}>Editöre dön</button>
              <button className="action-button neon-green" onClick={() => setActiveView("setup")}>Yeni video</button>
            </div>
          </section>
        )}

        {activeView === "settings" && (
          <section className="settings-grid">
            <div className="panel">
              <h2>Ayarlar</h2>
              <div className="inspector-row"><span>UI dili</span><strong>TR + EN hazır</strong></div>
              <div className="inspector-row"><span>Autosave</span><strong>Chunk bazlı</strong></div>
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
  const currentIndex = processingSteps.findIndex((step) => step.status === job?.status);
  const safeIndex = currentIndex === -1 ? 0 : currentIndex;
  return (
    <div className="processing-rail">
      {processingSteps.map((step, index) => (
        <div key={step.status} className={index <= safeIndex ? "process-step active" : "process-step"}>
          <i />
          <span>{step.label}</span>
        </div>
      ))}
    </div>
  );
}

function QualityPanel({ warnings }: { warnings: string[] }) {
  return (
    <div className="tool-panel">
      <h3><ShieldAlert size={15} /> Kalite kontrol</h3>
      {warnings.length ? warnings.map((warning) => <span key={warning} className="warning-line">{warning}</span>) : <span className="quiet-line">Uyarı yok</span>}
    </div>
  );
}

function StyleEditor({ style, onChange }: { style: typeof defaultStyle; onChange: (style: typeof defaultStyle) => void }) {
  return (
    <div className="tool-panel">
      <h3><Type size={15} /> Altyazı stili</h3>
      <label>
        Boyut
        <input type="range" min="24" max="72" value={style.fontSize} onChange={(event) => onChange({ ...style, fontSize: Number(event.target.value) })} />
      </label>
      <label>
        Renk
        <input type="color" value={style.color} onChange={(event) => onChange({ ...style, color: event.target.value })} />
      </label>
      <label>
        Gölge
        <input type="range" min="0" max="100" value={style.shadow} onChange={(event) => onChange({ ...style, shadow: Number(event.target.value) })} />
      </label>
      <label>
        Alt konum
        <input type="range" min="6" max="28" value={style.bottom} onChange={(event) => onChange({ ...style, bottom: Number(event.target.value) })} />
      </label>
    </div>
  );
}

function GlossaryPanel({
  glossary,
  onChange,
  onApply
}: {
  glossary: typeof defaultGlossary;
  onChange: (items: typeof defaultGlossary) => void;
  onApply: () => void;
}) {
  return (
    <div className="tool-panel">
      <h3><SpellCheck size={15} /> Terim listesi</h3>
      {glossary.map((item, index) => (
        <div className="glossary-row" key={`${item.term}-${index}`}>
          <input value={item.term} onChange={(event) => onChange(glossary.map((entry, entryIndex) => entryIndex === index ? { ...entry, term: event.target.value } : entry))} />
          <input value={item.replacement} onChange={(event) => onChange(glossary.map((entry, entryIndex) => entryIndex === index ? { ...entry, replacement: event.target.value } : entry))} />
        </div>
      ))}
      <div className="tool-actions">
        <button className="action-button neon-blue" onClick={() => onChange([...glossary, { term: "", replacement: "", note: "" }])}>Ekle</button>
        <button className="action-button neon-yellow" onClick={onApply}>Uygula</button>
      </div>
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
        <span>Cmd/Ctrl+S kaydet</span>
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

function getQualityWarnings(segments: SubtitleSegment[]) {
  const warnings = new Set<string>();
  segments.forEach((segment, index) => {
    const text = segment.translated_text || segment.source_text;
    const duration = segment.end_ms - segment.start_ms;
    if (!text.trim()) warnings.add("Boş altyazı segmenti var");
    if (text.length > 90) warnings.add("Çok uzun satırlar var");
    if (duration < 900) warnings.add("Ekranda çok kısa kalan segment var");
    if (index > 0 && segment.start_ms < segments[index - 1].end_ms) warnings.add("Zaman kodları çakışıyor");
    if (segment.target_language === "ar" && !/[\u0600-\u06FF]/.test(text)) warnings.add("Arapça hedefte RTL metin kontrolü gerekiyor");
  });
  return Array.from(warnings);
}

function replaceEvery(value: string, search: string, replacement: string) {
  if (!search) return value;
  return value.split(search).join(replacement);
}

export default App;
