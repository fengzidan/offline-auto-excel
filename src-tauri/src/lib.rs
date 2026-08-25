mod commands;
mod engine;
mod excel_io;
mod folder_run;
mod models;
mod ops;
mod schemes;
mod shell_menu;
mod writer;

use commands::{
    copy_scheme, delete_scheme, execute_pipeline, execute_scheme_in_folder, export_formula_template,
    export_pipeline_file, export_scheme, import_scheme, list_schemes, load_scheme, peek_raw_sheet,
    prepare_folder_run, preview_source_table, preview_step, rename_scheme, save_scheme,
    scan_source_dir, sync_folder_context_menu, unregister_folder_context_menu,
};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderRunRequest {
    pub folder: String,
    pub scheme_id: Option<String>,
}

pub struct PendingFolderRun(pub Mutex<Option<FolderRunRequest>>);

fn parse_flag_value(args: &[String], names: &[&str]) -> Option<String> {
    let mut i = 0usize;
    while i < args.len() {
        let a = &args[i];
        for name in names {
            if a == name {
                return args.get(i + 1).cloned();
            }
            let prefix = format!("{name}=");
            if let Some(rest) = a.strip_prefix(&prefix) {
                if !rest.is_empty() {
                    return Some(rest.to_string());
                }
            }
        }
        i += 1;
    }
    None
}

fn parse_folder_run(args: &[String]) -> Option<FolderRunRequest> {
    let folder = parse_flag_value(args, &["--folder"])?;
    let scheme_id = parse_flag_value(args, &["--scheme"]);
    Some(FolderRunRequest { folder, scheme_id })
}

fn emit_folder_run(app: &tauri::AppHandle, req: FolderRunRequest) {
    let _ = app.emit("folder-run", req);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(req) = parse_folder_run(&argv) {
                emit_folder_run(app, req);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
                let _ = w.unminimize();
            }
        }))
        .manage(PendingFolderRun(Mutex::new(None)))
        .setup(|app| {
            // Auto-register cascading「执行生成」menu with all schemes
            let _ = crate::shell_menu::sync_from_app(app.handle());

            let args: Vec<String> = std::env::args().collect();
            if let Some(req) = parse_folder_run(&args) {
                if let Ok(mut g) = app.state::<PendingFolderRun>().0.lock() {
                    *g = Some(req.clone());
                }
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    emit_folder_run(&handle, req);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_source_dir,
            preview_source_table,
            peek_raw_sheet,
            preview_step,
            execute_pipeline,
            export_formula_template,
            list_schemes,
            load_scheme,
            save_scheme,
            delete_scheme,
            rename_scheme,
            copy_scheme,
            export_scheme,
            export_pipeline_file,
            import_scheme,
            prepare_folder_run,
            execute_scheme_in_folder,
            sync_folder_context_menu,
            unregister_folder_context_menu,
            take_pending_folder_run,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn take_pending_folder_run(
    state: tauri::State<'_, PendingFolderRun>,
) -> Option<FolderRunRequest> {
    state.0.lock().ok().and_then(|mut g| g.take())
}
