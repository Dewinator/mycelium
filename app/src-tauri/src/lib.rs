// mycelium native shell — Tauri 2.
//
// Sub-task 3 of #176 per docs/native-tauri-shell-spike.md:
//   - one sidecar (the bundled Node mcp-server binary)
//   - main window points at http://127.0.0.1:8787 (existing dashboard)
//   - tray icon with Show/Hide, Quit
//   - Wave-3 forward-compat: pass MYCELIUM_DATA_DIR (root for pgdata/models/
//     wire-cert) AND distinct MYCELIUM_DASHBOARD_PORT / MYCELIUM_WIRE_PORT
//     env vars when spawning the sidecar.
//
// Quit semantics (decision 4 of the spike): closing the main window minimises
// to tray. The app exits only via tray "Quit", Cmd-Q, or explicit
// app_handle.exit().

use std::path::PathBuf;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const SIDECAR_NAME: &str = "mycelium-mcp";
const DASHBOARD_PORT: &str = "8787";
const WIRE_PORT: &str = "8443";

/// Resolve the per-OS data directory the sidecar should use.
/// Mirrors the Node-side `getDataDirLayout()` defaults so a Tauri install
/// and a `npm run dev` install land on the same files.
fn data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .expect("Tauri must resolve AppLocalData")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Materialise the data dir + wire-cert subpath so the Node side
            // never has to mkdir the root. (Node still mkdirs its own
            // subdirs via ensureDataDirs() — this is belt + suspenders.)
            let dir = data_dir(app.handle());
            std::fs::create_dir_all(&dir)?;
            std::fs::create_dir_all(dir.join("wire-cert"))?;

            // Spawn the bundled Node sidecar. Tauri resolves SIDECAR_NAME
            // to e.g. binaries/mycelium-mcp-aarch64-apple-darwin per
            // tauri.conf.json `bundle.externalBin`.
            spawn_sidecar(app.handle(), &dir)?;

            // Tray icon — Show/Hide + Quit.
            let show_hide = MenuItem::with_id(
                app, "show-hide", "Show / Hide window", true, None::<&str>,
            )?;
            let quit = MenuItem::with_id(
                app, "quit", "Quit mycelium", true, None::<&str>,
            )?;
            let menu = Menu::with_items(app, &[&show_hide, &quit])?;

            TrayIconBuilder::with_id("mycelium-tray")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show-hide" => toggle_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window minimises to tray (decision 4 of the spike).
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Best-effort: stop the sidecar on app exit. Node's existing
            // shutdown hooks flush PGlite WAL + drop llama.cpp context.
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(child) = app.try_state::<SidecarChild>() {
                    let _ = child.0.lock().unwrap().take().map(|c| c.kill());
                }
            }
        });
}

struct SidecarChild(std::sync::Mutex<Option<CommandChild>>);

fn spawn_sidecar(
    app: &AppHandle,
    data_dir: &PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    let sidecar = app.shell().sidecar(SIDECAR_NAME)?;
    let (mut rx, child) = sidecar
        .env("MYCELIUM_DATA_DIR", data_dir.display().to_string())
        .env("MYCELIUM_DASHBOARD_PORT", DASHBOARD_PORT)
        .env("MYCELIUM_WIRE_PORT", WIRE_PORT)
        .spawn()?;

    // Drain stdout/stderr to the Tauri log so a sidecar crash is debuggable.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    eprintln!("[mycelium-mcp] {}", String::from_utf8_lossy(&line))
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[mycelium-mcp ERR] {}", String::from_utf8_lossy(&line))
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[mycelium-mcp] exited: {:?}", payload);
                    break;
                }
                _ => {}
            }
        }
    });

    app.manage(SidecarChild(std::sync::Mutex::new(Some(child))));
    Ok(())
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            _ => {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }
}
