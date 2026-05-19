#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use axum::{
    body::Body,
    extract::{Path as AxumPath, State as AxumState},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use futures_util::TryStreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tokio::net::TcpListener;
use uuid::Uuid;

const RENDER_BACKEND_ORIGIN: &str = "https://maru-website.onrender.com";
const SECURE_STORE_FILE_NAME: &str = "secure-store.json";
const FILES_MIRROR_FOLDER_NAME: &str = "files-structure-mirror";
const DRAG_SESSION_TTL_MS: u64 = 10 * 60 * 1000;

#[derive(Clone)]
struct DesktopRuntimeState {
    client: Client,
    drag_sessions: Arc<Mutex<HashMap<String, DragDownloadSession>>>,
    drag_server_origin: Arc<Mutex<Option<String>>>,
}

impl DesktopRuntimeState {
    fn new() -> Self {
        Self {
            client: Client::new(),
            drag_sessions: Arc::new(Mutex::new(HashMap::new())),
            drag_server_origin: Arc::new(Mutex::new(None)),
        }
    }

    fn drag_server_origin(&self) -> Option<String> {
        self.drag_server_origin
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }

    fn set_drag_server_origin(&self, origin: String) {
        if let Ok(mut guard) = self.drag_server_origin.lock() {
            *guard = Some(origin);
        }
    }
}

#[derive(Clone, Debug)]
struct DragDownloadSession {
    request_path: String,
    file_name: String,
    authorization: Option<String>,
    files_account_auth: Option<String>,
    school_device_platform: Option<String>,
    expires_at: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecureStoreData {
    elevation_token: Option<String>,
    shared_auth_user: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopEnvironment {
    is_desktop_app: bool,
    is_windows: bool,
    platform: String,
    version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BasicResult {
    ok: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DragDownloadResult {
    ok: bool,
    drag_url: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PathCommandResult {
    ok: bool,
    message: Option<String>,
    target_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ElevationTokenPayload {
    token: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedAuthPayload {
    raw_auth_user: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareDragDownloadPayload {
    request_path: String,
    file_name: String,
    authorization: Option<String>,
    files_account_auth: Option<String>,
    school_device_platform: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenPathPayload {
    target_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenStructureMirrorPayload {
    directories: Vec<MirrorDirectoryInput>,
    writable: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MirrorDirectoryEntry {
    directory: String,
    #[serde(default)]
    files: Vec<MirrorFileEntry>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MirrorFileEntry {
    name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum MirrorDirectoryInput {
    Path(String),
    Entry(MirrorDirectoryEntry),
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn trim_to_option(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn prune_drag_sessions(sessions: &mut HashMap<String, DragDownloadSession>) {
    let now = now_millis();
    sessions.retain(|_, session| session.expires_at > now);
}

fn secure_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data path. {error}"))?;

    Ok(app_data_dir.join(SECURE_STORE_FILE_NAME))
}

fn files_mirror_root(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data path. {error}"))?;

    Ok(app_data_dir.join(FILES_MIRROR_FOLDER_NAME))
}

fn read_secure_store(app: &AppHandle) -> Result<SecureStoreData, String> {
    let store_path = secure_store_path(app)?;

    match fs::read_to_string(store_path) {
        Ok(raw) => serde_json::from_str::<SecureStoreData>(&raw)
            .map_err(|error| format!("Could not read desktop auth storage. {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(SecureStoreData::default())
        }
        Err(error) => Err(format!("Could not read desktop auth storage. {error}")),
    }
}

fn write_secure_store(app: &AppHandle, store: &SecureStoreData) -> Result<(), String> {
    let store_path = secure_store_path(app)?;

    if let Some(parent) = store_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create desktop auth folder. {error}"))?;
    }

    let serialized = serde_json::to_string(store)
        .map_err(|error| format!("Could not serialize desktop auth storage. {error}"))?;

    fs::write(store_path, serialized)
        .map_err(|error| format!("Could not save desktop auth storage. {error}"))
}

fn update_secure_store(
    app: &AppHandle,
    update: impl FnOnce(&mut SecureStoreData),
) -> Result<SecureStoreData, String> {
    let mut store = read_secure_store(app)?;
    update(&mut store);
    write_secure_store(app, &store)?;
    Ok(store)
}

fn sanitize_mirror_segment(value: &str) -> String {
    let sanitized = value
        .trim()
        .trim_matches([' ', '.'])
        .chars()
        .map(|character| {
            if matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            ) || character.is_control()
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim()
        .trim_matches([' ', '.'])
        .to_string();

    if sanitized.is_empty() {
        "untitled".to_string()
    } else {
        sanitized
    }
}

fn normalize_directory_parts(directory: &str) -> Vec<String> {
    directory
        .split(['/', '\\', '\u{2215}', '\u{2044}'])
        .map(sanitize_mirror_segment)
        .filter(|segment| !segment.is_empty())
        .collect()
}

fn set_path_readonly(path: &Path) {
    if let Ok(metadata) = fs::metadata(path) {
        let mut permissions = metadata.permissions();
        permissions.set_readonly(true);
        let _ = fs::set_permissions(path, permissions);
    }
}

fn clear_path_readonly_recursively(path: &Path) {
    if let Ok(metadata) = fs::metadata(path) {
        if metadata.is_dir() {
            if let Ok(entries) = fs::read_dir(path) {
                for entry in entries.flatten() {
                    clear_path_readonly_recursively(&entry.path());
                }
            }
        }

        let mut permissions = metadata.permissions();
        if permissions.readonly() {
            permissions.set_readonly(false);
            let _ = fs::set_permissions(path, permissions);
        }
    }
}

fn build_files_mirror(
    app: &AppHandle,
    payload: &OpenStructureMirrorPayload,
) -> Result<PathBuf, String> {
    let mirror_root = files_mirror_root(app)?;
    let writable = payload.writable.unwrap_or(false);
    let storage_root = mirror_root.join("Network Storage 1");

    if mirror_root.exists() {
        clear_path_readonly_recursively(&mirror_root);
        fs::remove_dir_all(&mirror_root)
            .map_err(|error| format!("Could not clear the old Files mirror. {error}"))?;
    }

    fs::create_dir_all(&storage_root)
        .map_err(|error| format!("Could not create the Files mirror folders. {error}"))?;

    let readme = [
        "Maru Desktop Files Mirror",
        "",
        if writable {
            "Elevation was active when this mirror was generated."
        } else {
            "This mirror opens as a read-only File Explorer view by default."
        },
        "It mirrors the folder tree and placeholder file names only.",
        "Changes made here do not automatically sync back to the remote Files storage.",
    ]
    .join("\r\n");

    let readme_path = mirror_root.join("README.txt");
    fs::write(&readme_path, readme)
        .map_err(|error| format!("Could not write the Files mirror readme. {error}"))?;

    if !writable {
        set_path_readonly(&readme_path);
    }

    let mut created_files = HashSet::<PathBuf>::new();

    for item in &payload.directories {
        let entry = match item {
            MirrorDirectoryInput::Path(directory) => MirrorDirectoryEntry {
                directory: directory.clone(),
                files: Vec::new(),
            },
            MirrorDirectoryInput::Entry(entry) => entry.clone(),
        };

        let folder_path = normalize_directory_parts(&entry.directory)
            .into_iter()
            .fold(storage_root.clone(), |path, segment| path.join(segment));

        fs::create_dir_all(&folder_path)
            .map_err(|error| format!("Could not build the Files mirror folders. {error}"))?;

        for file in entry.files {
            let placeholder_path = folder_path.join(sanitize_mirror_segment(&file.name));

            if !created_files.insert(placeholder_path.clone()) {
                continue;
            }

            File::create(&placeholder_path)
                .map_err(|error| format!("Could not create a Files mirror placeholder. {error}"))?;

            if !writable {
                set_path_readonly(&placeholder_path);
            }
        }
    }

    Ok(mirror_root)
}

fn open_path_in_file_manager(target_path: &Path) -> Result<(), String> {
    if !target_path.exists() {
        return Err("That local path does not exist anymore.".to_string());
    }

    let mut command = if cfg!(target_os = "windows") {
        let mut command = Command::new("explorer");
        command.arg(target_path);
        command
    } else if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(target_path);
        command
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(target_path);
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open that path in the file manager. {error}"))
}

fn copy_response_header(source: &reqwest::Response, target: &mut HeaderMap, name: &str) {
    let Ok(header_name) = HeaderName::from_bytes(name.as_bytes()) else {
        return;
    };

    let Some(value) = source.headers().get(name) else {
        return;
    };

    if let Ok(header_value) = HeaderValue::from_bytes(value.as_bytes()) {
        target.insert(header_name, header_value);
    }
}

fn json_error_response(status: StatusCode, message: &str) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(json!({ "error": message })),
    )
        .into_response()
}

fn stream_upstream_response(upstream: reqwest::Response, fallback_file_name: &str) -> Response {
    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut headers = HeaderMap::new();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    copy_response_header(&upstream, &mut headers, header::CONTENT_TYPE.as_str());
    copy_response_header(
        &upstream,
        &mut headers,
        header::CONTENT_DISPOSITION.as_str(),
    );
    copy_response_header(&upstream, &mut headers, header::CONTENT_LENGTH.as_str());
    copy_response_header(&upstream, &mut headers, "x-school-ratelimit-warning");

    if !headers.contains_key(header::CONTENT_DISPOSITION) {
        let fallback_name = fallback_file_name.replace('"', "");
        if let Ok(value) =
            HeaderValue::from_str(&format!("attachment; filename=\"{fallback_name}\""))
        {
            headers.insert(header::CONTENT_DISPOSITION, value);
        }
    }

    let stream = upstream
        .bytes_stream()
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error.to_string()));

    (status, headers, Body::from_stream(stream)).into_response()
}

async fn handle_drag_download(
    AxumPath(token): AxumPath<String>,
    AxumState(state): AxumState<DesktopRuntimeState>,
) -> Response {
    let session = {
        let Ok(mut sessions) = state.drag_sessions.lock() else {
            return json_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "The desktop drag session store is unavailable right now.",
            );
        };

        prune_drag_sessions(&mut sessions);
        sessions.get(&token).cloned()
    };

    let Some(session) = session else {
        return json_error_response(StatusCode::NOT_FOUND, "Drag-out session expired.");
    };

    if now_millis() > session.expires_at {
        if let Ok(mut sessions) = state.drag_sessions.lock() {
            sessions.remove(&token);
        }

        return json_error_response(StatusCode::GONE, "Drag-out session expired.");
    }

    let mut request = state
        .client
        .get(format!("{RENDER_BACKEND_ORIGIN}{}", session.request_path))
        .header(header::ACCEPT.as_str(), "*/*");

    if let Some(authorization) = session.authorization {
        request = request.header(header::AUTHORIZATION.as_str(), authorization);
    }

    if let Some(files_account_auth) = session.files_account_auth {
        request = request.header("X-Files-Account-Auth", files_account_auth);
    }

    if let Some(school_device_platform) = session.school_device_platform {
        request = request.header("X-School-Device-Platform", school_device_platform);
    }

    match request.send().await {
        Ok(upstream) => stream_upstream_response(upstream, &session.file_name),
        Err(error) => json_error_response(
            StatusCode::BAD_GATEWAY,
            &format!("Could not reach the Maru backend. {error}"),
        ),
    }
}

async fn start_drag_download_server(state: DesktopRuntimeState) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("Could not start the local drag-download server. {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("Could not inspect the local drag-download server. {error}"))?;

    let router = Router::new()
        .route(
            "/__desktop/drag-download/{token}",
            get(handle_drag_download),
        )
        .with_state(state);

    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("[maru-desktop-tauri] drag-download server failed: {error}");
        }
    });

    Ok(format!("http://127.0.0.1:{}", address.port()))
}

#[tauri::command]
fn get_environment(app: AppHandle) -> DesktopEnvironment {
    DesktopEnvironment {
        is_desktop_app: true,
        is_windows: cfg!(target_os = "windows"),
        platform: std::env::consts::OS.to_string(),
        version: app.package_info().version.to_string(),
    }
}

#[tauri::command]
fn get_secure_auth(app: AppHandle) -> Result<SecureStoreData, String> {
    read_secure_store(&app)
}

#[tauri::command]
fn set_elevation_token(
    app: AppHandle,
    payload: ElevationTokenPayload,
) -> Result<BasicResult, String> {
    update_secure_store(&app, |store| {
        store.elevation_token = trim_to_option(payload.token);
    })?;

    Ok(BasicResult { ok: true })
}

#[tauri::command]
fn clear_elevation_token(app: AppHandle) -> Result<BasicResult, String> {
    update_secure_store(&app, |store| {
        store.elevation_token = None;
    })?;

    Ok(BasicResult { ok: true })
}

#[tauri::command]
fn set_shared_auth_user(app: AppHandle, payload: SharedAuthPayload) -> Result<BasicResult, String> {
    update_secure_store(&app, |store| {
        store.shared_auth_user = trim_to_option(payload.raw_auth_user);
    })?;

    Ok(BasicResult { ok: true })
}

#[tauri::command]
fn clear_shared_auth_user(app: AppHandle) -> Result<BasicResult, String> {
    update_secure_store(&app, |store| {
        store.shared_auth_user = None;
    })?;

    Ok(BasicResult { ok: true })
}

#[tauri::command]
fn prepare_drag_download(
    state: State<'_, DesktopRuntimeState>,
    payload: PrepareDragDownloadPayload,
) -> DragDownloadResult {
    let request_path = payload.request_path.trim();
    let file_name = payload.file_name.trim();

    if request_path.is_empty() || file_name.is_empty() {
        return DragDownloadResult {
            ok: false,
            drag_url: None,
            error: Some("Missing drag download payload.".to_string()),
        };
    }

    if !request_path.starts_with("/api/") {
        return DragDownloadResult {
            ok: false,
            drag_url: None,
            error: Some("That drag request path is not allowed.".to_string()),
        };
    }

    let Some(server_origin) = state.drag_server_origin() else {
        return DragDownloadResult {
            ok: false,
            drag_url: None,
            error: Some("The local drag-download bridge is not ready yet.".to_string()),
        };
    };

    let token = format!("drag-{}-{}", now_millis(), Uuid::new_v4().simple());
    let session = DragDownloadSession {
        request_path: request_path.to_string(),
        file_name: file_name.to_string(),
        authorization: trim_to_option(payload.authorization),
        files_account_auth: trim_to_option(payload.files_account_auth)
            .filter(|value| value == "signed-in"),
        school_device_platform: trim_to_option(payload.school_device_platform),
        expires_at: now_millis() + DRAG_SESSION_TTL_MS,
    };

    let Ok(mut sessions) = state.drag_sessions.lock() else {
        return DragDownloadResult {
            ok: false,
            drag_url: None,
            error: Some("The desktop drag session store is unavailable right now.".to_string()),
        };
    };

    prune_drag_sessions(&mut sessions);
    sessions.insert(token.clone(), session);

    DragDownloadResult {
        ok: true,
        drag_url: Some(format!("{server_origin}/__desktop/drag-download/{token}")),
        error: None,
    }
}

#[tauri::command]
fn open_files_in_explorer(payload: OpenPathPayload) -> PathCommandResult {
    let trimmed_path = payload.target_path.trim();

    if trimmed_path.is_empty() {
        return PathCommandResult {
            ok: false,
            message: Some("That local path is missing.".to_string()),
            target_path: None,
        };
    }

    let target_path = PathBuf::from(trimmed_path);

    match open_path_in_file_manager(&target_path) {
        Ok(()) => PathCommandResult {
            ok: true,
            message: None,
            target_path: Some(target_path.to_string_lossy().to_string()),
        },
        Err(message) => PathCommandResult {
            ok: false,
            message: Some(message),
            target_path: None,
        },
    }
}

#[tauri::command]
fn open_files_structure_mirror(
    app: AppHandle,
    payload: OpenStructureMirrorPayload,
) -> PathCommandResult {
    match build_files_mirror(&app, &payload).and_then(|path| {
        open_path_in_file_manager(&path)?;
        Ok(path)
    }) {
        Ok(path) => PathCommandResult {
            ok: true,
            message: None,
            target_path: Some(path.to_string_lossy().to_string()),
        },
        Err(message) => PathCommandResult {
            ok: false,
            message: Some(message),
            target_path: None,
        },
    }
}

fn main() {
    let runtime_state = DesktopRuntimeState::new();
    let server_state = runtime_state.clone();

    tauri::Builder::default()
        .manage(runtime_state)
        .invoke_handler(tauri::generate_handler![
            get_environment,
            get_secure_auth,
            set_elevation_token,
            clear_elevation_token,
            set_shared_auth_user,
            clear_shared_auth_user,
            prepare_drag_download,
            open_files_in_explorer,
            open_files_structure_mirror
        ])
        .setup(move |app| {
            if let Err(error) = tauri::async_runtime::block_on(async {
                let origin = start_drag_download_server(server_state.clone()).await?;
                server_state.set_drag_server_origin(origin);
                Ok::<(), String>(())
            }) {
                eprintln!("[maru-desktop-tauri] drag-download bridge disabled: {error}");
            }

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
