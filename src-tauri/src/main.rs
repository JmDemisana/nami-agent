#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let main_url = WebviewUrl::App("tauri-launcher.html".into());

            WebviewWindowBuilder::new(app, "main", main_url)
                .title("Maru Desktop")
                .inner_size(1480.0, 940.0)
                .min_inner_size(1080.0, 720.0)
                .resizable(true)
                .decorations(false)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Maru Desktop");
}
