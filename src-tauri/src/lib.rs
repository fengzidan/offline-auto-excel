mod commands;
mod engine;
mod excel_io;
mod models;
mod ops;
mod schemes;
mod writer;

use commands::{
    copy_scheme, delete_scheme, execute_pipeline, export_formula_template, export_pipeline_file,
    export_scheme, import_scheme, list_schemes, load_scheme, peek_raw_sheet, preview_source_table,
    preview_step, rename_scheme, save_scheme, scan_source_dir,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
