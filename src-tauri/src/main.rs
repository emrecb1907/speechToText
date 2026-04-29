use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

#[tauri::command]
async fn start_engine(app: AppHandle) -> Result<(), String> {
    let shell = app.shell();
    let sidecar = shell.sidecar("neon-engine").map_err(|error| error.to_string())?;
    let (_rx, _child) = sidecar.spawn().map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = start_engine(handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![start_engine])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    run();
}
