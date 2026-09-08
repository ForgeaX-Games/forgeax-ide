// ForgeaX Studio desktop shell (Tauri 2).
//
// Two runtime forms share this one shell:
//   - dev  : scripts/desktop.ts starts the shared desktop-dev profile, then
//            passes its resolved UI origin to `cargo tauri dev`.
//   - prod : Tauri starts one bundled `local-runtime` launcher. That launcher
//            owns preparation, server/engine supervision and HTTP readiness,
//            then publishes one runtime state contract for this shell to read.
//
// The web UI is platform-agnostic: it detects Tauri via `__TAURI_INTERNALS__`
// (src/lib/platform/runtime.ts) and only then uses native window APIs; in a
// plain browser (web-server form) every native call is a no-op.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;

// ───────────────────────── SidecarSupervisor ─────────────────────────
//
// Tauri owns exactly one process: the shared local-runtime launcher. The
// launcher owns its server/engine children; this outer supervisor only drains
// launcher output, applies a bounded restart policy, and reaps it on app exit.
#[cfg(not(debug_assertions))]
mod supervisor {
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tauri::{AppHandle, Emitter};
    use tauri_plugin_shell::process::{CommandChild, CommandEvent};

    /// Max restart attempts before a sidecar is declared `failed`.
    const MAX_RESTARTS: u32 = 5;
    /// Grace period between SIGTERM and SIGKILL during shutdown.
    const KILL_GRACE: Duration = Duration::from_secs(3);

    /// How to (re)spawn a given sidecar. Returns the live child + its event rx.
    /// Boxed so the monitor task can respawn without re-borrowing the AppHandle's
    /// shell builder ownership at the call site.
    pub type SpawnFn = dyn Fn() -> Result<(tauri::async_runtime::Receiver<CommandEvent>, CommandChild), String>
        + Send
        + Sync;

    /// A single supervised sidecar. The PID is mirrored into an atomic so the
    /// exit-reaper can signal it without locking the (possibly busy) child mutex.
    pub struct SidecarHandle {
        pub name: &'static str,
        pid: AtomicU32,
        /// Set once shutdown begins so the monitor loop stops restarting.
        shutting_down: Arc<AtomicBool>,
        /// Retained so shutdown can request a graceful, cross-platform stop on
        /// stdin before falling back to CommandChild::kill.
        child: Mutex<Option<CommandChild>>,
        spawn: Arc<SpawnFn>,
    }

    impl SidecarHandle {
        pub fn pid(&self) -> Option<u32> {
            match self.pid.load(Ordering::SeqCst) {
                0 => None,
                p => Some(p),
            }
        }
    }

    /// Owns the single bundled runtime launcher; lives in Tauri managed state.
    pub struct Supervisor {
        pub runtime: Arc<SidecarHandle>,
    }

    /// Append a chunk of sidecar output to a rolling per-sidecar log file under
    /// <projects>/.logs. Best-effort: logging must never crash the monitor.
    fn log_to_disk(log_dir: &std::path::Path, name: &str, bytes: &[u8]) {
        let _ = std::fs::create_dir_all(log_dir);
        let path = log_dir.join(format!("{name}.log"));
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = f.write_all(bytes);
            let _ = f.write_all(b"\n");
        }
    }

    /// Roll the log if it grew past ~4 MiB so it can't grow unbounded.
    fn roll_log_if_big(log_dir: &std::path::Path, name: &str) {
        let path = log_dir.join(format!("{name}.log"));
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > 4 * 1024 * 1024 {
                let _ = std::fs::rename(&path, log_dir.join(format!("{name}.log.1")));
            }
        }
    }

    /// Spawn a supervised sidecar: consume its event stream on a background
    /// task, drain output to disk, and restart on Terminated with bounded
    /// exponential backoff. `spawn` is invoked once now and again on each
    /// restart. Returns the managed handle.
    pub fn spawn_supervised(
        app: &AppHandle,
        name: &'static str,
        log_dir: std::path::PathBuf,
        spawn: Arc<SpawnFn>,
    ) -> Result<Arc<SidecarHandle>, String> {
        let (rx, child) = spawn()?;
        let handle = Arc::new(SidecarHandle {
            name,
            pid: AtomicU32::new(child.pid()),
            shutting_down: Arc::new(AtomicBool::new(false)),
            child: Mutex::new(Some(child)),
            spawn: spawn.clone(),
        });
        let _ = app.emit(
            "backend-status",
            serde_json::json!({ "who": name, "state": "connecting" }),
        );
        spawn_monitor(app.clone(), handle.clone(), log_dir, rx);
        Ok(handle)
    }

    fn spawn_monitor(
        app: AppHandle,
        handle: Arc<SidecarHandle>,
        log_dir: std::path::PathBuf,
        mut rx: tauri::async_runtime::Receiver<CommandEvent>,
    ) {
        tauri::async_runtime::spawn(async move {
            let name = handle.name;
            let mut restarts: u32 = 0;
            loop {
                while let Some(ev) = rx.recv().await {
                    match ev {
                        CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                            roll_log_if_big(&log_dir, name);
                            log_to_disk(&log_dir, name, &b);
                        }
                        CommandEvent::Error(e) => {
                            log_to_disk(
                                &log_dir,
                                name,
                                format!("[supervisor] error: {e}").as_bytes(),
                            );
                        }
                        CommandEvent::Terminated(payload) => {
                            log_to_disk(
                                &log_dir,
                                name,
                                format!(
                                    "[supervisor] sidecar '{name}' terminated code={:?} signal={:?} (restart #{restarts})",
                                    payload.code, payload.signal
                                )
                                .as_bytes(),
                            );
                            break;
                        }
                        _ => {}
                    }
                }

                // rx closed == process gone. Decide whether to restart.
                handle.pid.store(0, Ordering::SeqCst);
                if let Ok(mut child) = handle.child.lock() {
                    child.take();
                }
                if handle.shutting_down.load(Ordering::SeqCst) {
                    return; // intentional shutdown, don't resurrect.
                }
                if restarts >= MAX_RESTARTS {
                    let _ = app.emit(
                        "backend-status",
                        serde_json::json!({ "who": name, "state": "failed" }),
                    );
                    log_to_disk(
                        &log_dir,
                        name,
                        format!(
                            "[supervisor] '{name}' exceeded MAX_RESTARTS={MAX_RESTARTS}, giving up"
                        )
                        .as_bytes(),
                    );
                    return;
                }

                let _ = app.emit(
                    "backend-status",
                    serde_json::json!({ "who": name, "state": "restarting", "attempt": restarts + 1 }),
                );
                // 0.5 → 1 → 2 → 4 → 8 → 16s cap.
                let backoff = Duration::from_millis(500u64 << restarts.min(5));
                restarts += 1;
                tokio::time::sleep(backoff).await;
                if handle.shutting_down.load(Ordering::SeqCst) {
                    return;
                }

                match (handle.spawn)() {
                    Ok((new_rx, new_child)) => {
                        handle.pid.store(new_child.pid(), Ordering::SeqCst);
                        rx = new_rx;
                        if let Ok(mut child) = handle.child.lock() {
                            *child = Some(new_child);
                        }
                        log_to_disk(
                            &log_dir,
                            name,
                            format!(
                                "[supervisor] '{name}' restarted (pid {})",
                                handle.pid.load(Ordering::SeqCst)
                            )
                            .as_bytes(),
                        );
                        // loop back and consume the new rx.
                    }
                    Err(e) => {
                        log_to_disk(
                            &log_dir,
                            name,
                            format!("[supervisor] '{name}' respawn failed: {e}").as_bytes(),
                        );
                        // Treat a failed respawn like another crash for backoff
                        // purposes; loop continues with the same (now empty) rx
                        // by sleeping then retrying.
                        let backoff = Duration::from_millis(500u64 << restarts.min(5));
                        restarts += 1;
                        if restarts >= MAX_RESTARTS {
                            let _ = app.emit(
                                "backend-status",
                                serde_json::json!({ "who": name, "state": "failed" }),
                            );
                            return;
                        }
                        tokio::time::sleep(backoff).await;
                    }
                }
            }
        });
    }

    impl Supervisor {
        /// Ask the launcher to stop its process tree and persist `stopped`, then
        /// force-kill only if it outlives the grace period. The stdin protocol
        /// and CommandChild fallback are both cross-platform.
        pub fn shutdown_all(&self) {
            if self.runtime.shutting_down.swap(true, Ordering::SeqCst) {
                return;
            }
            if let Ok(mut child) = self.runtime.child.lock() {
                if let Some(child) = child.as_mut() {
                    let _ = child.write(b"shutdown\n");
                }
            }
            std::thread::sleep(KILL_GRACE);
            if self.runtime.pid().is_some() {
                if let Ok(mut child) = self.runtime.child.lock() {
                    if let Some(child) = child.take() {
                        let _ = child.kill();
                    }
                }
            }
        }
    }
}

/// Native mouse capture for FPS play. WKWebView denies the web Pointer Lock API
/// for embedded content, so we lock at the OS level instead: set_cursor_grab on
/// macOS calls CGAssociateMouseAndMouseCursorPosition(false), freezing the
/// cursor while mouse-move events keep flowing. The frontend toggles this on a
/// game click and off on ESC.
#[tauri::command]
fn set_pointer_capture(window: tauri::Window, capture: bool) {
    let _ = window.set_cursor_visible(!capture);
    let _ = window.set_cursor_grab(capture);
}

// ───────────────────────── Native menu bar (T5 bridge) ─────────────────────
//
// The webview is the SSOT for the menu bar (menu-registry.ts). The bridge
// (native-menu-bridge.ts) calls `serializeMenusForNative(t)` there, then this
// command turns the resulting JSON into a real native Menu and installs it via
// `set_as_app_menu()`. Menu event dispatch happens in the webview too: a
// global `on_menu_event` (registered in `run()` below) emits `menu:invoke` to
// the "main" window with the clicked id; the webview looks it up in the
// registry and calls `host.commands.execute(commandId, args)`. Rust owns no
// business logic beyond "id → emit" — matching the tray's split, but with the
// tray callback kept in `build_tray()` for the show/hide/quit items.

#[derive(Debug, serde::Deserialize)]
struct NativeMenuItemJson {
    id: String,
    label: String,
    #[serde(default)]
    accelerator: Option<String>,
    enabled: bool,
    #[serde(default)]
    danger: Option<bool>,
    #[serde(rename = "separatorBefore", default)]
    separator_before: bool,
    #[serde(default)]
    children: Option<Vec<NativeMenuItemJson>>,
}

#[derive(Debug, serde::Deserialize)]
struct NativeMenuJson {
    /// The MenuId bucket ('brand' | 'file' | 'edit' | ...); used to
    /// select platform-specific placement (e.g. 'brand' → app menu on macOS)
    /// and to skip buckets the OS bar doesn't render (e.g. 'publish').
    menu: String,
    /// Already-translated title for the top-level submenu (e.g. "File",
    /// "Edit"). The JS bridge fills it via `t('menubar.<menu>')`. Falls
    /// back to `menu` id if missing (defensive; the bridge always sends it).
    #[serde(default)]
    title: Option<String>,
    items: Vec<NativeMenuItemJson>,
}

/// Event payload emitted to the webview when a native menu item is clicked.
/// The webview's `native-menu-bridge.ts` looks the id up in the menu registry
/// (which owns `commandId` + `args`) and calls the host command bus.
#[derive(Clone, serde::Serialize)]
struct MenuInvokePayload {
    id: String,
}

/// Replace the app's native menu bar with the given payload. Called by the
/// webview once the menu registry is populated (and again whenever it changes,
/// so runtime toggles of `when`/`enabled` predicates flow to the OS bar).
///
/// `publish` is intentionally skipped — it's an in-app dropdown, not an OS
/// menu category (T5 spec).
///
/// MUST stay non-`async`: Tauri runs sync commands on the main thread but
/// spawns `async` ones onto the async runtime, and macOS requires NSMenu to be
/// built and installed on the main thread. Off-thread the bar still renders
/// with correct labels but its items never deliver menu events, so every click
/// is a silent no-op (the `on_main` trace below is what pinned this down).
#[tauri::command]
fn set_app_menu(app: tauri::AppHandle, payload: Vec<NativeMenuJson>) -> Result<(), String> {
    // `on_main` is the load-bearing signal: macOS silently produces a menu that
    // renders but never delivers events when NSMenu is built off the main thread.
    let thread = std::thread::current();
    let on_main = thread.name() == Some("main");
    fx_trace_line(&format!(
        "set_app_menu: enter thread={:?} on_main={} menus={}",
        thread.name(),
        on_main,
        payload.len(),
    ));

    let menu = Menu::new(&app).map_err(|e| {
        fx_trace_line(&format!("set_app_menu: Menu::new FAILED {e}"));
        e.to_string()
    })?;
    let mut installed = 0usize;
    for m in payload.iter() {
        if m.menu == "publish" {
            continue;
        }
        let title = m.title.as_deref().unwrap_or(m.menu.as_str());
        let submenu = Submenu::new(&app, title, true).map_err(|e| e.to_string())?;
        append_items(&app, &submenu, &m.items)?;
        menu.append(&submenu).map_err(|e| e.to_string())?;
        installed += 1;
        fx_trace_line(&format!(
            "set_app_menu:   + submenu '{}' ({}) items={} ids=[{}]",
            title,
            m.menu,
            m.items.len(),
            m.items
                .iter()
                .map(|i| i.id.as_str())
                .collect::<Vec<_>>()
                .join(","),
        ));
    }
    menu.set_as_app_menu().map_err(|e| {
        fx_trace_line(&format!("set_app_menu: set_as_app_menu FAILED {e}"));
        e.to_string()
    })?;
    fx_trace_line(&format!("set_app_menu: installed ok submenus={installed}"));
    Ok(())
}

/// Trace sink for the menu bridge. The release `.app` builds tauri without the
/// `devtools` feature, so webview `console.*` is unreachable there — routing the
/// webview's bridge trace here puts the whole native↔webview chain in one stderr
/// stream (visible when the .app is launched from a terminal).
fn fx_trace_line(line: &str) {
    eprintln!("[fx-trace] {line}");
}

/// Webview-callable end of `fx_trace_line` (see above).
#[tauri::command]
fn fx_trace(line: String) {
    fx_trace_line(&line);
}

/// Recursive builder for a Submenu's children. Honors `separator_before`
/// (skipped for the first item to keep the "boundary between groups" semantic
/// clean), and turns `children` into nested Submenus.
fn append_items(
    app: &tauri::AppHandle,
    parent: &Submenu<tauri::Wry>,
    items: &[NativeMenuItemJson],
) -> Result<(), String> {
    for (idx, item) in items.iter().enumerate() {
        if item.separator_before && idx != 0 {
            let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
            parent.append(&sep).map_err(|e| e.to_string())?;
        }
        if let Some(children) = &item.children {
            let child = Submenu::with_id(app, &item.id, &item.label, item.enabled)
                .map_err(|e| e.to_string())?;
            append_items(app, &child, children)?;
            parent.append(&child).map_err(|e| e.to_string())?;
        } else {
            let mi = MenuItem::with_id(
                app,
                &item.id,
                &item.label,
                item.enabled,
                item.accelerator.as_deref(),
            )
            .map_err(|e| e.to_string())?;
            parent.append(&mi).map_err(|e| e.to_string())?;
        }
        // `danger` is UI-only in menu-registry.ts (Web highlight); the OS bar
        // has no equivalent, so it's intentionally ignored here.
        let _ = item.danger;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            set_pointer_capture,
            set_app_menu,
            fx_trace
        ])
        // Global menu event handler — fires for BOTH the tray menu and the
        // app menu bar. The tray keeps its own callback (build_tray) for
        // 'show'/'hide'/'quit'; here we forward everything else to the webview
        // as `menu:invoke`, and the webview looks the id up in the registry to
        // dispatch the associated command. Rust owns no business logic.
        .on_menu_event(|app_handle, event| {
            let id = event.id().as_ref().to_string();
            fx_trace_line(&format!("on_menu_event: id={id}"));
            // Skip tray-owned ids — the tray's `on_menu_event` handles them.
            if matches!(id.as_str(), "show" | "hide" | "quit") {
                fx_trace_line("on_menu_event: tray-owned id, skipped");
                return;
            }
            let echo = id.clone();
            match app_handle.emit("menu:invoke", MenuInvokePayload { id }) {
                Ok(()) => fx_trace_line(&format!("on_menu_event: emitted menu:invoke id={echo}")),
                Err(e) => fx_trace_line(&format!("on_menu_event: emit FAILED id={echo} err={e}")),
            }
        })
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                // scripts/desktop.ts has already started and verified the
                // desktop-dev profile and injected its resolved devUrl.
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    // DevTools is noisy (engine multi-light warnings etc.) and not
                    // wanted by default. Only auto-open when explicitly asked via
                    // FORGEAX_DEVTOOLS=1 (set by `bash app.sh debug`). You can always
                    // open it manually with the standard inspector shortcut.
                    if std::env::var("FORGEAX_DEVTOOLS").as_deref() == Ok("1") {
                        win.open_devtools();
                    }
                }
            }

            #[cfg(not(debug_assertions))]
            start_bundled_backend(app)?;

            build_tray(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building ForgeaX Studio desktop shell")
        .run(|_app_handle, _event| {
            // Reap the bundled local-runtime launcher on app exit. Its own
            // signal handler then shuts down the server/engine process tree.
            #[cfg(not(debug_assertions))]
            {
                use tauri::{Manager, RunEvent};
                if matches!(_event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                    if let Some(sup) = _app_handle.try_state::<supervisor::Supervisor>() {
                        sup.shutdown_all();
                    }
                }
            }
        });
}

/// Start the one bundled local-runtime launcher and consume its state contract.
/// Tauri does not prepare services, choose ports, or probe HTTP independently.
#[cfg(not(debug_assertions))]
fn start_bundled_backend(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use std::fs;

    let handle = app.handle().clone();
    let res_root = app.path().resource_dir()?.join("resources");
    let launcher = res_root.join("runtime").join("local-runtime.mjs");
    if !launcher.exists() {
        return Err(format!(
            "bundled runtime launcher is missing: {}",
            launcher.display()
        )
        .into());
    }

    let projects_dir = std::env::var_os("FORGEAX_PROJECT_ROOT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            app.path()
                .home_dir()
                .map(|h| h.join("ForgeaxProjects"))
                .unwrap_or_else(|_| res_root.clone())
        });
    fs::create_dir_all(&projects_dir)?;
    let state_file = projects_dir
        .join(".forgeax")
        .join("runtime")
        .join("desktop-prod.json");
    if let Some(parent) = state_file.parent() {
        fs::create_dir_all(parent)?;
    }
    let _ = fs::remove_file(&state_file);
    let log_dir = projects_dir.join(".logs");

    let runtime_spawn: std::sync::Arc<supervisor::SpawnFn> = {
        let app = app.handle().clone();
        let launcher = launcher.clone();
        let res_root = res_root.clone();
        let projects_dir = projects_dir.clone();
        let state_file = state_file.clone();
        std::sync::Arc::new(move || {
            let _ = fs::remove_file(&state_file);
            app.shell()
                .sidecar("bun")
                .map_err(|e| e.to_string())?
                .args([
                    "run".to_string(),
                    launcher.to_string_lossy().into_owned(),
                    "--profile".to_string(),
                    "desktop-prod".to_string(),
                ])
                .env("FORGEAX_STARTUP_PROFILE", "desktop-prod")
                .env(
                    "FORGEAX_RESOURCE_ROOT",
                    res_root.to_string_lossy().to_string(),
                )
                .env(
                    "FORGEAX_PROJECT_ROOT",
                    projects_dir.to_string_lossy().to_string(),
                )
                .env(
                    "FORGEAX_RUNTIME_STATE_FILE",
                    state_file.to_string_lossy().to_string(),
                )
                .spawn()
                .map_err(|e| e.to_string())
        })
    };
    let runtime_handle =
        supervisor::spawn_supervised(&handle, "local-runtime", log_dir, runtime_spawn)
            .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
    app.manage(supervisor::Supervisor {
        runtime: runtime_handle,
    });

    // The launcher is the only readiness authority. Its state is atomically
    // replaced, so every read observes either the old complete document or the
    // new complete document.
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let mut last_state = String::new();
        let mut ever_ready = false;
        let mut timeout_reported = false;
        loop {
            if let Ok(raw) = fs::read_to_string(&state_file) {
                if let Ok(state) = serde_json::from_str::<serde_json::Value>(&raw) {
                    let status = state
                        .get("status")
                        .and_then(|value| value.as_str())
                        .unwrap_or("invalid");
                    let error = state.get("error").cloned();
                    let signature = format!("{status}:{error:?}");
                    let state_changed = signature != last_state;
                    if state_changed {
                        let _ = handle.emit(
                            "backend-status",
                            serde_json::json!({
                                "who": "local-runtime",
                                "state": status,
                                "error": error,
                            }),
                        );
                        last_state = signature;
                    }
                    if status == "ready" && state_changed {
                        if let Some(origin) =
                            state.get("publicOrigin").and_then(|value| value.as_str())
                        {
                            if let Some(win) = handle.get_webview_window("main") {
                                if let Ok(url) = origin.parse() {
                                    let _ = win.navigate(url);
                                }
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                            ever_ready = true;
                        }
                    }
                }
            }
            if !ever_ready
                && !timeout_reported
                && started.elapsed() >= std::time::Duration::from_secs(60)
            {
                let _ = handle.emit(
                    "backend-status",
                    serde_json::json!({
                        "who": "local-runtime",
                        "state": "failed",
                        "error": "runtime state did not become ready within 60 seconds",
                    }),
                );
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                timeout_reported = true;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    });

    Ok(())
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示 Show", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏 Hide", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip("ForgeaX Studio")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "hide" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
