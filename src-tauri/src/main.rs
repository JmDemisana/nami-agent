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
    gemini_key_index: Arc<Mutex<usize>>,
}

impl DesktopRuntimeState {
    fn new() -> Self {
        Self {
            client: Client::new(),
            drag_sessions: Arc::new(Mutex::new(HashMap::new())),
            drag_server_origin: Arc::new(Mutex::new(None)),
            gemini_key_index: Arc::new(Mutex::new(0)),
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
    nami_agent_gemini_key: Option<String>,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NamiAgentMessage {
    role: String,
    parts: Vec<NamiAgentPart>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NamiAgentPart {
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    inline_data: Option<NamiAgentInlineData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    function_call: Option<NamiAgentFunctionCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    function_response: Option<NamiAgentFunctionResponse>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NamiAgentInlineData {
    mime_type: String,
    data: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NamiAgentFunctionCall {
    name: String,
    args: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NamiAgentFunctionResponse {
    name: String,
    response: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NamiAgentChatRequest {
    messages: Vec<NamiAgentMessage>,
    system_prompt: String,
    model: Option<String>,
    max_output_tokens: Option<u32>,
    thinking_budget: Option<i32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NamiAgentChatResponse {
    text: Option<String>,
    function_call: Option<NamiAgentFunctionCall>,
    done: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NamiAgentFileOpResult {
    ok: bool,
    content: Option<String>,
    entries: Option<Vec<String>>,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NamiAgentCommandResult {
    ok: bool,
    stdout: String,
    stderr: String,
    exit_code: i32,
    error: Option<String>,
}

#[tauri::command]
fn nami_agent_get_cwd() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string())
}

#[tauri::command]
async fn nami_agent_run_command(command: String, cwd: Option<String>) -> NamiAgentCommandResult {
    let timeout_secs = 30u64;

    let cmd_clone = command.clone();
    let cwd_clone = cwd.clone();
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        tokio::task::spawn_blocking(move || {
            let mut cmd = std::process::Command::new("powershell");
            cmd.args(["-NoProfile", "-Command", &cmd_clone]);
            if let Some(ref dir) = cwd_clone {
                if !dir.trim().is_empty() {
                    cmd.current_dir(dir);
                }
            }
            cmd.output()
        }),
    )
    .await;

    match output {
        Ok(block_result) => {
            let spawn_result = match block_result {
                Ok(r) => r,
                Err(e) => {
                    return NamiAgentCommandResult {
                        ok: false,
                        stdout: String::new(),
                        stderr: String::new(),
                        exit_code: -1,
                        error: Some(format!("Spawn task failed: {e}")),
                    };
                }
            };
            match spawn_result {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                    let exit_code = out.status.code().unwrap_or(-1);
                    NamiAgentCommandResult {
                        ok: out.status.success(),
                        stdout,
                        stderr,
                        exit_code,
                        error: if out.status.success() { None } else { Some("Command exited with non-zero status".to_string()) },
                    }
                }
                Err(e) => NamiAgentCommandResult {
                    ok: false,
                    stdout: String::new(),
                    stderr: String::new(),
                    exit_code: -1,
                    error: Some(format!("Failed to execute command: {e}")),
                },
            }
        }
        Err(_) => NamiAgentCommandResult {
            ok: false,
            stdout: String::new(),
            stderr: String::new(),
            exit_code: -1,
            error: Some(format!("Command timed out after {}s", timeout_secs)),
        },
    }
}

#[tauri::command]
fn get_nami_agent_key(app: AppHandle) -> Result<Option<String>, String> {
    let store = read_secure_store(&app)?;
    Ok(store.nami_agent_gemini_key)
}

#[tauri::command]
fn save_nami_agent_key(app: AppHandle, key: String) -> Result<(), String> {
    update_secure_store(&app, |store| {
        store.nami_agent_gemini_key = if key.trim().is_empty() {
            None
        } else {
            Some(key.trim().to_string())
        };
    })?;
    Ok(())
}

#[tauri::command]
fn parse_api_keys(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .collect()
}

const DEFAULT_GEMINI_MODEL: &str = "gemini-2.5-flash-lite";
const ALLOWED_GEMINI_MODELS: &[&str] = &["gemini-2.5-flash-lite", "gemini-2.5-flash"];

fn select_gemini_model(requested_model: Option<&str>) -> &'static str {
    requested_model
        .and_then(|model| {
            let trimmed = model.trim();
            ALLOWED_GEMINI_MODELS
                .iter()
                .copied()
                .find(|allowed| *allowed == trimmed)
        })
        .unwrap_or(DEFAULT_GEMINI_MODEL)
}

fn clamp_max_output_tokens(value: Option<u32>) -> u32 {
    value.unwrap_or(1536).clamp(256, 4096)
}

/// Parse "Please retry in 33.19s" from a Gemini 429 error body.
fn parse_retry_after_secs(body: &serde_json::Value) -> Option<u64> {
    let msg = body
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())?;
    let marker = "Please retry in ";
    let start = msg.find(marker)? + marker.len();
    let rest = &msg[start..];
    let end = rest.find('s')?;
    rest[..end].trim().parse::<f64>().ok().map(|s| s.ceil() as u64)
}

async fn try_gemini_with_key(
    client: &Client,
    api_key: &str,
    model: &str,
    body: &serde_json::Value,
) -> Result<(reqwest::StatusCode, serde_json::Value), String> {
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        model, api_key
    );

    let response = client
        .post(&url)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Gemini API request failed: {e}"))?;

    let status = response.status();
    let response_body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Gemini response: {e}"))?;

    Ok((status, response_body))
}

#[tauri::command]
async fn gemini_chat(
    _app: AppHandle,
    state: State<'_, DesktopRuntimeState>,
    api_keys: String,
    request: NamiAgentChatRequest,
) -> Result<NamiAgentChatResponse, String> {
    let keys = parse_api_keys(&api_keys);
    if keys.is_empty() {
        return Err("No valid Gemini API keys provided.".to_string());
    }

    let mut contents: Vec<serde_json::Value> = Vec::new();
    for msg in &request.messages {
        let mut parts = Vec::new();
        for part in &msg.parts {
            let mut part_obj = serde_json::Map::new();
            if let Some(text) = &part.text {
                part_obj.insert("text".into(), serde_json::Value::String(text.clone()));
            }
            if let Some(id) = &part.inline_data {
                let mut id_obj = serde_json::Map::new();
                id_obj.insert("mimeType".into(), serde_json::Value::String(id.mime_type.clone()));
                id_obj.insert("data".into(), serde_json::Value::String(id.data.clone()));
                part_obj.insert("inlineData".into(), serde_json::Value::Object(id_obj));
            }
            if let Some(fc) = &part.function_call {
                let mut fc_obj = serde_json::Map::new();
                fc_obj.insert("name".into(), serde_json::Value::String(fc.name.clone()));
                fc_obj.insert("args".into(), fc.args.clone());
                part_obj.insert("functionCall".into(), serde_json::Value::Object(fc_obj));
            }
            if let Some(fr) = &part.function_response {
                let mut fr_obj = serde_json::Map::new();
                fr_obj.insert("name".into(), serde_json::Value::String(fr.name.clone()));
                fr_obj.insert("response".into(), fr.response.clone());
                part_obj.insert("functionResponse".into(), serde_json::Value::Object(fr_obj));
            }
            parts.push(serde_json::Value::Object(part_obj));
        }
        let mut content = serde_json::Map::new();
        let role = if msg.role == "function" {
            "user".to_string()
        } else {
            msg.role.clone()
        };
        content.insert("role".into(), serde_json::Value::String(role));
        content.insert("parts".into(), serde_json::Value::Array(parts));
        contents.push(serde_json::Value::Object(content));
    }

    let system_instruction: serde_json::Value = serde_json::json!({
        "parts": [{ "text": request.system_prompt }]
    });

    let tools = serde_json::json!([{
        "functionDeclarations": [
            {
                "name": "read_file",
                "description": "Read the contents of a file at the given path.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute path to the file" }
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "write_file",
                "description": "Write content to a file at the given path. Creates or overwrites.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute path to the file" },
                        "content": { "type": "string", "description": "File content to write" }
                    },
                    "required": ["path", "content"]
                }
            },
            {
                "name": "list_directory",
                "description": "List files and directories in the given folder path.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute path to the directory" }
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "web_search",
                "description": "Search the web for current information, documentation, or anything you don't know. Use this whenever you need up-to-date info.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "The search query" }
                    },
                    "required": ["query"]
                }
            },
            {
                "name": "run_command",
                "description": "Execute a PowerShell command on the user's Windows machine. Use this before asking for local facts, standard folder paths, OS info, file counts, dev servers, packages, tests, builds, git, or CLI tasks. Discover Desktop with [Environment]::GetFolderPath('Desktop'), home with $HOME, Documents with [Environment]::GetFolderPath('MyDocuments'), and Downloads with Join-Path $HOME 'Downloads'.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "The shell command to execute (PowerShell syntax)" }
                    },
                    "required": ["command"]
                }
            }
        ]
    }]);

    let model = select_gemini_model(request.model.as_deref());
    let max_output_tokens = clamp_max_output_tokens(request.max_output_tokens);
    let thinking_budget = request.thinking_budget.unwrap_or(0).clamp(0, 24576);

    let body = serde_json::json!({
        "system_instruction": system_instruction,
        "contents": contents,
        "tools": tools,
        "tool_config": {
            "function_calling_config": {
                "mode": "AUTO"
            }
        },
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": max_output_tokens,
            "thinkingConfig": {
                "thinkingBudget": thinking_budget
            }
        }
    });

    // Strategy: avoid model fallback. It costs requests and can hit the same free-tier bucket.
    // Rotate keys for ordinary errors, but on 429 wait/retry instead of burning more calls.

    let start_idx = {
        let mut guard = state.gemini_key_index.lock().map_err(|e| format!("Lock error: {e}"))?;
        let idx = *guard % keys.len();
        *guard = (*guard + 1) % keys.len();
        idx
    };

    let mut log_lines: Vec<String> = Vec::new();
    log_lines.push(format!(
        "Key #{} on {} ({} total keys, maxOutputTokens {}, thinkingBudget {})",
        start_idx + 1,
        model,
        keys.len(),
        max_output_tokens,
        thinking_budget
    ));

    let mut rate_limit_wait: Option<u64> = None;

    for offset in 0..keys.len().min(2) {
        let key_idx = (start_idx + offset) % keys.len();

        log_lines.push(format!("  \u{2192} trying key #{}...", key_idx + 1));

        let (status, response_body) = match try_gemini_with_key(&state.client, &keys[key_idx], model, &body).await {
            Ok(pair) => pair,
            Err(e) => {
                log_lines.push(format!("  \u{2717} key #{}: network error \u{2014} {}", key_idx + 1, e));
                continue;
            }
        };

        if status.is_success() {
            return parse_gemini_response(response_body);
        }

        let http_code = status.as_u16();
        let err_msg = response_body
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("Unknown error")
            .to_string();

        if http_code == 429 {
            let wait_secs = parse_retry_after_secs(&response_body).unwrap_or(30);
            rate_limit_wait = Some(rate_limit_wait.map(|w| w.min(wait_secs)).unwrap_or(wait_secs));

            // Quick blip (≤5s): wait and retry same key once
            if wait_secs <= 5 {
                log_lines.push(format!("  \u{23f3} key #{}: short 429 ({}s), retrying...", key_idx + 1, wait_secs));
                tokio::time::sleep(std::time::Duration::from_secs(wait_secs + 1)).await;

                match try_gemini_with_key(&state.client, &keys[key_idx], model, &body).await {
                    Ok((s, b)) if s.is_success() => {
                        return parse_gemini_response(b);
                    }
                    Ok((s, b)) => {
                        let e = b.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()).unwrap_or("still failing");
                        log_lines.push(format!("  \u{2717} key #{}: HTTP {} after wait \u{2014} {}", key_idx + 1, s.as_u16(), e));
                        if s.as_u16() == 429 {
                            if let Some(new_wait) = parse_retry_after_secs(&b) {
                                rate_limit_wait = Some(rate_limit_wait.map(|w| w.min(new_wait)).unwrap_or(new_wait));
                            }
                        }
                    }
                    Err(e) => {
                        log_lines.push(format!("  \u{2717} key #{}: network error after wait \u{2014} {}", key_idx + 1, e));
                    }
                }
            } else {
                log_lines.push(format!("  \u{2717} key #{}: 429 ({}s) \u{2014} frontend will handle", key_idx + 1, wait_secs));
            }
            break;
        }

        // Non-429 errors: try one more key
        log_lines.push(format!("  \u{2717} key #{}: HTTP {} \u{2014} {}", key_idx + 1, http_code, err_msg));
    }

    let full_log = log_lines.join("\n");
    eprintln!("[nami-agent]\n{}", full_log);

    let retry_str = rate_limit_wait.map(|s| s.to_string()).unwrap_or_default();
    let friendly = if rate_limit_wait.is_some() {
        format!("⏳ Rate limited. Waiting {}s. Retrying automatically...", retry_str)
    } else if full_log.contains("503") {
        "🔌 Gemini servers are overloaded. Retrying...".to_string()
    } else {
        "❌ Gemini API error. Retrying...".to_string()
    };

    // Return the error with a retryAfter hint so the frontend knows to auto-retry
    Err(format!("RETRY_AFTER:{}\n{}\n---VERBOSE---\n{}", retry_str, friendly, full_log))
}

fn parse_gemini_response(response_body: serde_json::Value) -> Result<NamiAgentChatResponse, String> {
    let candidate = response_body
        .get("candidates")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .ok_or_else(|| "No candidates returned from Gemini".to_string())?;

    let finish_reason = candidate
        .get("finishReason")
        .and_then(|r| r.as_str())
        .unwrap_or("");

    let content = candidate
        .get("content")
        .ok_or_else(|| "No content in Gemini response".to_string())?;

    let parts = content
        .get("parts")
        .and_then(|p| p.as_array())
        .ok_or_else(|| "No parts in Gemini response".to_string())?;

    let mut text_parts = Vec::new();
    let mut function_call = None;

    for part in parts {
        if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
            if !t.is_empty() {
                text_parts.push(t.to_string());
            }
        }
        if let Some(fc) = part.get("functionCall") {
            let name = fc
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let args = fc.get("args").cloned().unwrap_or(serde_json::Value::Null);
            function_call = Some(NamiAgentFunctionCall { name, args });
        }
    }

    let text = if text_parts.is_empty() {
        None
    } else {
        Some(text_parts.join("\n"))
    };

    let has_no_fc = function_call.is_none();
    Ok(NamiAgentChatResponse {
        text,
        function_call,
        done: finish_reason == "STOP" && has_no_fc,
    })
}

#[tauri::command]
fn nami_agent_read_file(path: String) -> NamiAgentFileOpResult {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return NamiAgentFileOpResult {
            ok: false,
            content: None,
            entries: None,
            error: Some("File not found".to_string()),
        };
    }
    if p.is_dir() {
        return NamiAgentFileOpResult {
            ok: false,
            content: None,
            entries: None,
            error: Some("Path is a directory, not a file".to_string()),
        };
    }
    match std::fs::read_to_string(p) {
        Ok(content) => NamiAgentFileOpResult {
            ok: true,
            content: Some(content),
            entries: None,
            error: None,
        },
        Err(e) => NamiAgentFileOpResult {
            ok: false,
            content: None,
            entries: None,
            error: Some(format!("Could not read file: {e}")),
        },
    }
}

#[tauri::command]
fn nami_agent_write_file(path: String, content: String) -> NamiAgentFileOpResult {
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return NamiAgentFileOpResult {
                    ok: false,
                    content: None,
                    entries: None,
                    error: Some(format!("Could not create parent directory: {e}")),
                };
            }
        }
    }
    match std::fs::write(p, &content) {
        Ok(()) => NamiAgentFileOpResult {
            ok: true,
            content: None,
            entries: None,
            error: None,
        },
        Err(e) => NamiAgentFileOpResult {
            ok: false,
            content: None,
            entries: None,
            error: Some(format!("Could not write file: {e}")),
        },
    }
}

#[tauri::command]
fn nami_agent_list_directory(path: String) -> NamiAgentFileOpResult {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return NamiAgentFileOpResult {
            ok: false,
            content: None,
            entries: None,
            error: Some("Directory not found".to_string()),
        };
    }
    if !p.is_dir() {
        return NamiAgentFileOpResult {
            ok: false,
            content: None,
            entries: None,
            error: Some("Path is not a directory".to_string()),
        };
    }
    match std::fs::read_dir(p) {
        Ok(entries) => {
            let mut names: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        format!("{name}/")
                    } else {
                        name
                    }
                })
                .collect();
            names.sort();
            NamiAgentFileOpResult {
                ok: true,
                content: None,
                entries: Some(names),
                error: None,
            }
        }
        Err(e) => NamiAgentFileOpResult {
            ok: false,
            content: None,
            entries: None,
            error: Some(format!("Could not read directory: {e}")),
        },
    }
}

#[tauri::command]
async fn nami_agent_web_search(
    state: State<'_, DesktopRuntimeState>,
    api_keys: String,
    query: String,
) -> Result<String, String> {
    // Try Tavily first (most reliable)
    if let Ok(tavily_key) = std::env::var("TAVILY_API_KEY") {
        if !tavily_key.is_empty() {
            let tavily_body = serde_json::json!({
                "api_key": tavily_key,
                "query": query,
                "max_results": 5
            });
            let resp = state
                .client
                .post("https://api.tavily.com/search")
                .json(&tavily_body)
                .send()
                .await
                .map_err(|e| format!("Tavily request failed: {e}"))?;
            if resp.status().is_success() {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    if let Some(results) = data["results"].as_array() {
                        if !results.is_empty() {
                            let mut lines = Vec::new();
                            for (i, r) in results.iter().enumerate() {
                                let title = r["title"].as_str().unwrap_or("");
                                let url = r["url"].as_str().unwrap_or("");
                                let snippet = r["content"].as_str().unwrap_or("");
                                lines.push(format!(
                                    "{}. {} — {}\n   {}",
                                    i + 1,
                                    title,
                                    url,
                                    snippet
                                ));
                            }
                            return Ok(lines.join("\n\n"));
                        }
                    }
                }
            }
        }
    }

    // Fallback: use Gemini to answer the query directly (knowledge fallback)
    let keys = parse_api_keys(&api_keys);
    if keys.is_empty() {
        return Err("No API keys available for search fallback.".to_string());
    }

    let search_body = serde_json::json!({
        "contents": [{
            "role": "user",
            "parts": [{"text": format!("Provide a concise answer for: {}. Include any relevant details or URLs if known.", query)}]
        }],
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 500
        }
    });

    // Try keys one at a time on the efficient default model, rotating start per request.
    let model = DEFAULT_GEMINI_MODEL;

    let start_idx = {
        let mut guard = state.gemini_key_index.lock().map_err(|e| format!("Lock error: {e}"))?;
        let idx = *guard % keys.len();
        *guard = (*guard + 1) % keys.len();
        idx
    };

    for offset in 0..keys.len() {
        let key_idx = (start_idx + offset) % keys.len();

        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, keys[key_idx]
        );
        if let Ok(resp) = state.client.post(&url).json(&search_body).send().await {
            if resp.status().is_success() {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    if let Some(text) = data["candidates"]
                        .as_array()
                        .and_then(|c| c.first())
                        .and_then(|c| c["content"]["parts"].as_array())
                        .and_then(|p| p.first())
                        .and_then(|p| p["text"].as_str())
                    {
                        if !text.is_empty() {
                            return Ok(format!("[Web search results for: {}]\n\n{}", query, text));
                        }
                    }
                }
            }
        }
    }

    Err("Web search: all keys exhausted.".to_string())
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
            open_files_structure_mirror,
            get_nami_agent_key,
            save_nami_agent_key,
            gemini_chat,
            nami_agent_read_file,
            nami_agent_write_file,
            nami_agent_list_directory,
            nami_agent_web_search,
            nami_agent_run_command,
            nami_agent_get_cwd
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
