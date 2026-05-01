use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const ENGINE_PORT: u16 = 43187;
const ENGINE_PROCESS_NAME: &str = "neon-engine";
const ENGINE_SHUTDOWN_GRACE_MS: u64 = 2500;

#[derive(Default)]
struct EngineState {
    child: Mutex<Option<CommandChild>>,
}

fn command_pids(program: &str, args: &[&str]) -> Vec<u32> {
    let Ok(output) = Command::new(program).args(args).output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect()
}

#[cfg(target_family = "unix")]
fn engine_pids_to_cleanup(skip_pid: Option<u32>) -> Vec<u32> {
    let mut pids = BTreeSet::new();
    let port_selector = format!("-iTCP:{ENGINE_PORT}");
    for pid in command_pids(
        "lsof",
        &[
            &port_selector,
            "-sTCP:LISTEN",
        ],
    ) {
        pids.insert(pid);
    }
    for pid in command_pids("pgrep", &["-x", ENGINE_PROCESS_NAME]) {
        pids.insert(pid);
    }

    let current_pid = std::process::id();
    pids.into_iter()
        .filter(|pid| *pid != current_pid && Some(*pid) != skip_pid)
        .collect()
}

#[cfg(target_family = "unix")]
fn signal_pid(pid: u32, signal: &str) {
    let _ = Command::new("kill")
        .args([format!("-{signal}"), pid.to_string()])
        .status();
}

#[cfg(target_family = "unix")]
fn cleanup_stale_engines(skip_pid: Option<u32>, reason: &str) {
    let pids = engine_pids_to_cleanup(skip_pid);
    if pids.is_empty() {
        return;
    }

    eprintln!("[NEON_ENGINE] cleanup reason={reason} pids={pids:?}");
    for pid in &pids {
        signal_pid(*pid, "TERM");
    }
    thread::sleep(Duration::from_millis(ENGINE_SHUTDOWN_GRACE_MS));
    for pid in engine_pids_to_cleanup(skip_pid) {
        signal_pid(pid, "KILL");
    }
}

#[cfg(target_os = "windows")]
fn cleanup_stale_engines(skip_pid: Option<u32>, reason: &str) {
    let _ = skip_pid;
    eprintln!("[NEON_ENGINE] cleanup reason={reason} method=taskkill");
    let _ = Command::new("taskkill")
        .args(["/F", "/IM", "neon-engine.exe", "/T"])
        .status();
}

fn cleanup_engine_chunks(data_dir: &Path, reason: &str) {
    let chunks_dir = data_dir.join("chunks");
    let Ok(entries) = std::fs::read_dir(&chunks_dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let result = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        if let Err(error) = result {
            eprintln!("[NEON_ERROR] chunk cleanup failed reason={reason} path={} error={error}", path.display());
        }
    }
}

fn stop_managed_engine(app: &AppHandle, state: tauri::State<'_, EngineState>, reason: &str) {
    let data_dir = app.path().app_data_dir().ok();
    let child = match state.child.lock() {
        Ok(mut slot) => slot.take(),
        Err(error) => {
            eprintln!("[NEON_ERROR] engine state lock failed during {reason}: {error}");
            None
        }
    };

    if let Some(child) = child {
        let pid = child.pid();
        eprintln!("[NEON_ENGINE] stopping managed sidecar reason={reason} pid={pid}");
        cleanup_stale_engines(None, reason);
        if let Err(error) = child.kill() {
            eprintln!("[NEON_ERROR] managed sidecar kill failed pid={pid}: {error}");
        }
    } else {
        cleanup_stale_engines(None, reason);
    }

    if let Some(data_dir) = data_dir {
        cleanup_engine_chunks(&data_dir, reason);
    }
}

fn engine_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let resource_dir = app.path().resource_dir().map_err(|error| error.to_string())?;
    let data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    Ok((resource_dir, data_dir))
}

#[tauri::command]
async fn start_engine(app: AppHandle, state: tauri::State<'_, EngineState>) -> Result<(), String> {
    {
        let child = state.child.lock().map_err(|error| error.to_string())?;
        if child.is_some() {
            return Ok(());
        }
    }

    let (resource_dir, data_dir) = engine_paths(&app)?;
    cleanup_stale_engines(None, "before_start");
    cleanup_engine_chunks(&data_dir, "before_start");
    let shell = app.shell();
    let sidecar = shell
        .sidecar("neon-engine")
        .map_err(|error| error.to_string())?
        .current_dir(&resource_dir)
        .env("NEON_STUDIO_ROOT", &resource_dir)
        .env("NEON_STUDIO_DATA", &data_dir)
        .env("NEON_STUDIO_PORT", ENGINE_PORT.to_string());
    let (mut rx, child) = sidecar.spawn().map_err(|error| error.to_string())?;
    let pid = child.pid();

    {
        let mut slot = state.child.lock().map_err(|error| error.to_string())?;
        *slot = Some(child);
    }

    let app_for_events = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(bytes) => {
                    if let Ok(text) = String::from_utf8(bytes) {
                        eprint!("{text}");
                    }
                }
                CommandEvent::Stdout(bytes) => {
                    if let Ok(text) = String::from_utf8(bytes) {
                        print!("{text}");
                    }
                }
                CommandEvent::Error(error) => {
                    eprintln!("[NEON_ERROR] engine sidecar stream error: {error}");
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!(
                        "[NEON_ERROR] engine sidecar terminated pid={pid} code={:?} signal={:?}",
                        payload.code, payload.signal
                    );
                    let state = app_for_events.state::<EngineState>();
                    if let Ok(mut slot) = state.child.lock() {
                        if slot.as_ref().map(|child| child.pid()) == Some(pid) {
                            *slot = None;
                        }
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(EngineState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<EngineState>();
                if let Err(error) = start_engine(handle.clone(), state).await {
                    eprintln!("[NEON_ERROR] engine sidecar failed to start: {error}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![start_engine])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                let state = app_handle.state::<EngineState>();
                stop_managed_engine(app_handle, state, "app_exit");
            }
            _ => {}
        });
}

fn main() {
    run();
}
