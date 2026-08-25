//! OS folder context menu: 「执行生成」→ 悬停展开全部方案。
use crate::models::SchemeSummary;
use tauri::AppHandle;

#[cfg(target_os = "windows")]
const MENU_DIR: &str = r"Software\Classes\Directory\shell\AutoExcelExec";
#[cfg(target_os = "windows")]
const MENU_BG: &str = r"Software\Classes\Directory\Background\shell\AutoExcelExec";
#[cfg(target_os = "windows")]
const LEGACY_DIR: &str = r"Software\Classes\Directory\shell\AutoExcelRun";
#[cfg(target_os = "windows")]
const LEGACY_BG: &str = r"Software\Classes\Directory\Background\shell\AutoExcelRun";

#[cfg(target_os = "windows")]
fn sanitize_key(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Rebuild Explorer cascading menu from current schemes. Called on app start / scheme changes.
pub fn sync_schemes(schemes: &[SchemeSummary]) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        sync_windows(schemes)
    }
    #[cfg(target_os = "macos")]
    {
        let _ = schemes;
        sync_macos()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = schemes;
        Ok(())
    }
}

pub fn unregister() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        unregister_windows()?;
        Ok("已取消系统右键「执行生成」菜单".into())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok("当前系统无需取消注册".into())
    }
}

#[cfg(target_os = "windows")]
fn sync_windows(schemes: &[SchemeSummary]) -> Result<(), String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let exe = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .display()
        .to_string()
        .replace('/', "\\");

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    // Drop legacy single-item menu + rebuild
    let _ = hkcu.delete_subkey_all(LEGACY_DIR);
    let _ = hkcu.delete_subkey_all(LEGACY_BG);
    let _ = hkcu.delete_subkey_all(MENU_DIR);
    let _ = hkcu.delete_subkey_all(MENU_BG);

    for (base, folder_token) in [(MENU_DIR, "%1"), (MENU_BG, "%V")] {
        let (root, _) = hkcu
            .create_subkey(base)
            .map_err(|e| format!("创建右键菜单失败: {e}"))?;
        root.set_value("MUIVerb", &"执行生成")
            .map_err(|e| e.to_string())?;
        root.set_value("Icon", &exe).map_err(|e| e.to_string())?;
        // Empty SubCommands → use nested shell\ entries as cascade
        root.set_value("SubCommands", &"")
            .map_err(|e| e.to_string())?;

        let (shell, _) = root
            .create_subkey("shell")
            .map_err(|e| e.to_string())?;

        if schemes.is_empty() {
            let (item, _) = shell.create_subkey("empty").map_err(|e| e.to_string())?;
            item.set_value("", &"(暂无方案)")
                .map_err(|e| e.to_string())?;
            continue;
        }

        for (i, s) in schemes.iter().enumerate() {
            let key_name = format!("{:03}_{}", i, sanitize_key(&s.id));
            let (item, _) = shell
                .create_subkey(&key_name)
                .map_err(|e| e.to_string())?;
            let label = if s.name.trim().is_empty() {
                "未命名方案"
            } else {
                s.name.as_str()
            };
            item.set_value("", &label).map_err(|e| e.to_string())?;
            item.set_value("Icon", &exe).map_err(|e| e.to_string())?;
            let (cmd, _) = item.create_subkey("command").map_err(|e| e.to_string())?;
            let cmdline = format!(
                "\"{exe}\" --folder \"{folder_token}\" --scheme \"{}\"",
                s.id
            );
            cmd.set_value("", &cmdline).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn unregister_windows() -> Result<(), String> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let _ = hkcu.delete_subkey_all(MENU_DIR);
    let _ = hkcu.delete_subkey_all(MENU_BG);
    let _ = hkcu.delete_subkey_all(LEGACY_DIR);
    let _ = hkcu.delete_subkey_all(LEGACY_BG);
    Ok(())
}

#[cfg(target_os = "macos")]
fn sync_macos() -> Result<(), String> {
    // Finder has no reliable dynamic cascade submenu; keep helper script for CLI use.
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let Some(home) = home else {
        return Ok(());
    };
    let support = home.join("Library/Application Support/com.autoexcel.app");
    let _ = std::fs::create_dir_all(&support);
    let helper = support.join("run-folder.sh");
    let script = format!(
        "#!/bin/bash\nexec \"{}\" --folder \"$1\" ${{2:+--scheme \"$2\"}}\n",
        exe.display()
    );
    let _ = std::fs::write(&helper, script);
    let _ = std::process::Command::new("chmod")
        .args(["+x", &helper.display().to_string()])
        .status();
    Ok(())
}

/// Sync using schemes loaded from app data.
pub fn sync_from_app(app: &AppHandle) -> Result<(), String> {
    let list = crate::schemes::list_schemes(app)?;
    sync_schemes(&list)
}
