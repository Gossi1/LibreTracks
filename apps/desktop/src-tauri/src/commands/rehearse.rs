use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
pub struct RehearseState {
    pub token: Mutex<Option<String>>,
    pub last_track_id: Mutex<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RehearseStatus {
    pub has_token: bool,
    pub last_track_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SongResponse {
    pub payload: SongPayload,
}

#[derive(Debug, Deserialize)]
pub struct SongPayload {
    pub song: SongData,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongData {
    pub title: String,
    pub time_signature: Option<String>,
    pub bpm: Option<f64>,
    #[serde(default)]
    pub section_markers: Vec<SectionMarker>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionMarker {
    pub section_type: String,
    pub start_beat: u32,
    pub end_beat: u32,
    pub start_beat_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RehearseSearchItem {
    pub rehearse_song_id: String,
    pub title: String,
    pub artist_name: Option<String>,
    pub bpm: Option<f64>,
    pub time_signature: Option<String>,
    pub ccli_song_number: Option<String>,
    pub album_artwork: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RehearseSearchResponse {
    pub payload: Vec<RehearseSearchPayloadItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RehearseSearchPayloadItem {
    pub rehearse_song_id: String,
    pub title: String,
    pub artist_name: Option<String>,
    pub bpm: Option<f64>,
    pub time_signature: Option<String>,
    pub album_artwork: Option<String>,
    pub other_ids: Option<RehearseOtherIds>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RehearseOtherIds {
    pub ccli_song_number: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RehearseParsedMarker {
    pub name: String,
    pub kind: String,
    pub variant: Option<u32>,
    pub start_seconds: f64,
    pub start_beat: u32,
    pub end_beat: u32,
    pub start_measure: i64,
    pub duration_measures: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RehearseSongResult {
    pub track_id: String,
    pub title: String,
    pub time_signature: String,
    pub bpm: Option<f64>,
    pub beats_per_bar: u32,
    pub markers: Vec<RehearseParsedMarker>,
    pub csv: String,
}

pub fn clean_song_search_title(input: &str) -> String {
    let trimmed = input.trim();
    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    if parts.len() > 1 {
        let first = parts[0];
        if first.chars().all(|c| c.is_alphanumeric() || c == '.' || c == '#' || c == '-')
            && first.chars().any(|c| c.is_ascii_digit())
        {
            return parts[1..].join(" ");
        }
    }
    trimmed.to_string()
}

fn clean_track_id(input: &str) -> String {
    let trimmed = input.trim();
    if let Some(pos) = trimmed.rfind('/') {
        let after = &trimmed[pos + 1..];
        let id_part = after.split(&['?', '#'][..]).next().unwrap_or(after);
        if !id_part.is_empty() {
            return id_part.to_string();
        }
    }
    trimmed.split(&['?', '#'][..]).next().unwrap_or(trimmed).to_string()
}

fn capitalize_word(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

fn capitalize_phrase(phrase: &str) -> String {
    phrase
        .split_whitespace()
        .map(capitalize_word)
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_section_type(raw: &str) -> (String, Option<u32>, String) {
    let lower = raw.to_lowercase().replace('-', "_");
    let parts: Vec<&str> = lower.split('_').collect();
    let last = parts.last().copied().unwrap_or("");
    let variant = last.parse::<u32>().ok();

    let base_kind = if variant.is_some() && parts.len() > 1 {
        parts[..parts.len() - 1].join("_")
    } else {
        lower.clone()
    };

    let kind = match base_kind.as_str() {
        "intro" => "intro",
        "verse" => "verse",
        "pre_chorus" | "prechorus" => "pre_chorus",
        "chorus" => "chorus",
        "post_chorus" | "postchorus" => "post_chorus",
        "bridge" => "bridge",
        "outro" => "outro",
        "instrumental" => "instrumental",
        "interlude" => "interlude",
        "refrain" => "refrain",
        "tag" => "tag",
        "vamp" => "vamp",
        "ending" => "ending",
        "breakdown" => "breakdown",
        "drop" => "drop",
        "solo" => "solo",
        "ad_lib" | "adlib" => "ad_lib",
        "all_in" => "all_in",
        "build" => "build",
        _ => "custom",
    }
    .to_string();

    let display_name = if let Some(v) = variant {
        format!("{} {}", capitalize_phrase(&base_kind.replace('_', " ")), v)
    } else {
        capitalize_phrase(&raw.replace('_', " "))
    };

    (kind, variant, display_name)
}

#[tauri::command(async)]
pub fn save_rehearse_token(
    token: String,
    state: State<'_, RehearseState>,
    app: AppHandle,
) {
    let clean = token.trim().to_string();
    if clean.is_empty() {
        return;
    }
    let mut current_token = state.token.lock().unwrap();
    *current_token = Some(clean.clone());
    println!("[Rehearse] Captured token (length: {})", clean.len());
    let _ = app.emit("rehearse-token-captured", clean);
}

#[tauri::command(async)]
pub fn set_last_rehearse_track_id(
    track_id: String,
    state: State<'_, RehearseState>,
    app: AppHandle,
) {
    let clean = clean_track_id(&track_id);
    if clean.is_empty() {
        return;
    }
    let mut current = state.last_track_id.lock().unwrap();
    *current = Some(clean.clone());
    println!("[Rehearse] Captured track_id: {}", clean);
    let _ = app.emit("rehearse-track-captured", clean);
}

#[tauri::command(async)]
pub fn get_rehearse_status(state: State<'_, RehearseState>) -> RehearseStatus {
    let token = state.token.lock().unwrap();
    let track_id = state.last_track_id.lock().unwrap();
    RehearseStatus {
        has_token: token.is_some(),
        last_track_id: track_id.clone(),
    }
}

#[tauri::command]
pub async fn open_rehearse_window(
    app: AppHandle,
    url: Option<String>,
) -> Result<(), String> {
    let default_url = "https://planning.worshiptools.com";
    let start_url = url
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(default_url);

    let parsed_url: url::Url = start_url
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;

    if let Some(existing) = app.get_webview_window("rehearse") {
        let _ = existing.navigate(parsed_url);
        let _ = existing.set_focus();
        return Ok(());
    }

    let init_script = r#"
    (() => {
        const sendPayload = (key, value) => {
            if (!value) return;
            try {
                if (window.__TAURI_INTERNALS__) {
                    if (key === 'token') {
                        window.__TAURI_INTERNALS__.invoke('save_rehearse_token', { token: value });
                    } else if (key === 'track_id') {
                        window.__TAURI_INTERNALS__.invoke('set_last_rehearse_track_id', { trackId: value });
                    }
                }
            } catch (_) {}
            try {
                const iframe = document.createElement('iframe');
                iframe.style.display = 'none';
                iframe.src = 'https://libretracks-capture.local/?' + encodeURIComponent(key) + '=' + encodeURIComponent(value);
                (document.body || document.documentElement).appendChild(iframe);
                setTimeout(() => {
                    try { iframe.remove(); } catch (_) {}
                }, 1000);
            } catch (_) {}
        };

        const updateToolbar = (text, isSuccess) => {
            try {
                const dot = document.getElementById('__lt_dot__');
                const msg = document.getElementById('__lt_msg__');
                if (dot && isSuccess) {
                    dot.style.background = '#34d399';
                    dot.style.boxShadow = '0 0 6px #34d399';
                }
                if (msg && text) msg.textContent = text;
            } catch (_) {}
        };

        const notifyToken = (token) => {
            if (!token) return;
            sendPayload('token', token);
            updateToolbar('Live Token Captured! You can now close this window.', true);
        };

        const notifyTrackId = (trackId) => {
            if (!trackId) return;
            sendPayload('track_id', trackId);
            updateToolbar('Captured Song ID: ' + trackId, true);
        };

        const extractBearer = (val) => {
            if (!val || typeof val !== 'string') return null;
            const m = val.match(/Bearer\s+([A-Za-z0-9_\-\.]+)/i);
            return m ? m[1].trim() : null;
        };

        const scanHeaders = (headersObj) => {
            if (!headersObj) return;
            try {
                if (typeof headersObj.get === 'function') {
                    const h = headersObj.get('authorization') || headersObj.get('Authorization');
                    const t = extractBearer(h);
                    if (t) notifyToken(t);
                } else if (Array.isArray(headersObj)) {
                    for (const [k, v] of headersObj) {
                        if (k && k.toLowerCase() === 'authorization') {
                            const t = extractBearer(v);
                            if (t) notifyToken(t);
                        }
                    }
                } else if (typeof headersObj === 'object') {
                    for (const k of Object.keys(headersObj)) {
                        if (k.toLowerCase() === 'authorization') {
                            const t = extractBearer(headersObj[k]);
                            if (t) notifyToken(t);
                        }
                    }
                }
            } catch (_) {}
        };

        const isCcliRehearseUrl = (rawUrl) => {
            if (!rawUrl || typeof rawUrl !== 'string') return false;
            return rawUrl.includes('rehearse-api.ccli.com') ||
                   rawUrl.includes('rehearse.ccli.com') ||
                   rawUrl.includes('songselect.ccli.com') ||
                   (rawUrl.includes('ccli.com') && (rawUrl.includes('/api/') || rawUrl.includes('/songs')));
        };

        // Hook window.fetch
        const origFetch = window.fetch;
        window.fetch = async function(...args) {
            try {
                const resource = args[0];
                const config = args[1];
                const url = typeof resource === 'string' ? resource : (resource && resource.url ? resource.url : '');
                
                if (isCcliRehearseUrl(url)) {
                    if (config && config.headers) scanHeaders(config.headers);
                    if (resource instanceof Request && resource.headers) scanHeaders(resource.headers);

                    const m = url.match(/\/api\/songs\/([^/?#]+)/i) || url.match(/\/songs\/([^/?#]+)/i);
                    if (m && m[1]) notifyTrackId(m[1]);

                    try {
                        const parsed = new URL(url, window.location.href);
                        const tok = parsed.searchParams.get('token') || parsed.searchParams.get('access_token');
                        if (tok) notifyToken(tok);
                    } catch (_) {}
                }
            } catch (e) {
                console.error('[Rehearse Interceptor Error]', e);
            }
            return origFetch.apply(this, args);
        };

        // Hook XMLHttpRequest
        const origOpen = XMLHttpRequest.prototype.open;
        const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.open = function(method, url) {
            this._reqUrl = url;
            try {
                if (isCcliRehearseUrl(url)) {
                    const m = String(url).match(/\/api\/songs\/([^/?#]+)/i) || String(url).match(/\/songs\/([^/?#]+)/i);
                    if (m && m[1]) notifyTrackId(m[1]);
                }
            } catch (_) {}
            return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
            try {
                if (isCcliRehearseUrl(this._reqUrl) && header && header.toLowerCase() === 'authorization') {
                    const t = extractBearer(value);
                    if (t) notifyToken(t);
                }
            } catch (_) {}
            return origSetHeader.apply(this, arguments);
        };

        // Scan localStorage / sessionStorage for CCLI / Rehearse keys only
        const scanStorage = () => {
            try {
                for (const storage of [window.localStorage, window.sessionStorage]) {
                    if (!storage) continue;
                    for (let i = 0; i < storage.length; i++) {
                        const k = storage.key(i);
                        if (!k) continue;
                        const v = storage.getItem(k);
                        if (!v) continue;
                        if (k.toLowerCase().includes('rehearse') || (k.toLowerCase().includes('ccli') && !k.includes('cookie'))) {
                            const t = extractBearer(v);
                            if (t) notifyToken(t);
                            try {
                                const obj = JSON.parse(v);
                                if (obj.token) notifyToken(obj.token);
                                if (obj.accessToken) notifyToken(obj.accessToken);
                                if (obj.access_token) notifyToken(obj.access_token);
                            } catch (_) {}
                        }
                    }
                }
            } catch (_) {}
        };
        setInterval(scanStorage, 3000);
        setTimeout(scanStorage, 1200);

        // Inject navigation / status bar
        const injectBar = () => {
            if (document.getElementById('__lt_rehearse_toolbar__')) return;
            const bar = document.createElement('div');
            bar.id = '__lt_rehearse_toolbar__';
            bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:38px;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:space-between;padding:0 14px;font-family:system-ui,-apple-system,sans-serif;font-size:12px;z-index:2147483647;border-bottom:1px solid #334155;box-shadow:0 2px 10px rgba(0,0,0,0.5);';
            bar.innerHTML = `
                <div style="display:flex;align-items:center;gap:10px;">
                    <strong style="color:#57f1db;font-weight:700;letter-spacing:0.02em;">LibreTracks Capture</strong>
                    <span id="__lt_status_indicator__" style="display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;background:#1e293b;border:1px solid #334155;font-size:11px;">
                        <span id="__lt_dot__" style="width:7px;height:7px;border-radius:50%;background:#94a3b8;transition:background 0.3s;"></span>
                        <span id="__lt_msg__">Ready. Open a song to capture Rehearse token.</span>
                    </span>
                </div>
                <div style="display:flex;align-items:center;gap:6px;">
                    <button id="__lt_btn_songselect__" style="background:#0891b2;color:#fff;border:none;border-radius:4px;padding:4px 8px;font-size:11px;font-weight:600;cursor:pointer;">SongSelect (CCLI)</button>
                    <button id="__lt_btn_planning__" style="background:#2563eb;color:#fff;border:none;border-radius:4px;padding:4px 8px;font-size:11px;font-weight:600;cursor:pointer;">Planning</button>
                    <button id="__lt_btn_rehearse__" style="background:#334155;color:#cbd5e1;border:none;border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;">CCLI Rehearse</button>
                </div>
            `;
            if (document.body) {
                document.body.prepend(bar);
                document.body.style.paddingTop = '38px';
            }
            const bSong = document.getElementById('__lt_btn_songselect__');
            if (bSong) bSong.onclick = () => { window.location.href = 'https://songselect.ccli.com'; };
            const bPlan = document.getElementById('__lt_btn_planning__');
            if (bPlan) bPlan.onclick = () => { window.location.href = 'https://planning.worshiptools.com'; };
            const bReh = document.getElementById('__lt_btn_rehearse__');
            if (bReh) bReh.onclick = () => { window.location.href = 'https://rehearse.ccli.com'; };
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', injectBar);
        } else {
            injectBar();
        }
    })();
    "#;

    let app_handle_for_nav = app.clone();
    let _window = WebviewWindowBuilder::new(&app, "rehearse", WebviewUrl::External(parsed_url))
        .title("CCLI Rehearse & Planning — LibreTracks")
        .inner_size(1150.0, 780.0)
        .initialization_script(init_script)
        .on_navigation(move |nav_url| {
            if nav_url.host_str() == Some("libretracks-capture.local") {
                let state = app_handle_for_nav.state::<RehearseState>();
                for (key, val) in nav_url.query_pairs() {
                    if key == "token" && !val.trim().is_empty() {
                        let token_str = val.trim().to_string();
                        let mut current = state.token.lock().unwrap();
                        *current = Some(token_str.clone());
                        println!("[Rehearse] Captured token via navigation (len {})", token_str.len());
                        let _ = app_handle_for_nav.emit("rehearse-token-captured", token_str);
                    } else if key == "track_id" && !val.trim().is_empty() {
                        let track_clean = clean_track_id(&val);
                        let mut current = state.last_track_id.lock().unwrap();
                        *current = Some(track_clean.clone());
                        println!("[Rehearse] Captured track_id via navigation: {}", track_clean);
                        let _ = app_handle_for_nav.emit("rehearse-track-captured", track_clean);
                    }
                }
                return false;
            }
            true
        })
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

pub async fn search_rehearse_songs_internal(
    query: &str,
) -> Result<Vec<RehearseSearchItem>, String> {
    let clean_query = clean_song_search_title(query);
    if clean_query.is_empty() {
        return Ok(Vec::new());
    }

    let mut search_url = url::Url::parse("https://rehearse-api.ccli.com/api/songs")
        .map_err(|e| e.to_string())?;
    search_url
        .query_pairs_mut()
        .append_pair("search", &clean_query)
        .append_pair("limit", "10");

    let client = reqwest::Client::new();
    let res = client
        .get(search_url)
        .header("Accept", "*/*")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
        )
        .send()
        .await
        .map_err(|e| format!("Search request failed: {e}"))?;

    if !res.status().is_success() {
        return Ok(Vec::new());
    }

    let search_res: RehearseSearchResponse = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse search JSON: {e}"))?;

    let items = search_res
        .payload
        .into_iter()
        .map(|item| RehearseSearchItem {
            rehearse_song_id: item.rehearse_song_id,
            title: item.title,
            artist_name: item.artist_name,
            bpm: item.bpm,
            time_signature: item.time_signature,
            ccli_song_number: item.other_ids.and_then(|o| o.ccli_song_number),
            album_artwork: item.album_artwork,
        })
        .collect();

    Ok(items)
}

#[tauri::command]
pub async fn search_rehearse_songs(
    query: String,
) -> Result<Vec<RehearseSearchItem>, String> {
    search_rehearse_songs_internal(&query).await
}

#[tauri::command]
pub async fn fetch_rehearse_song(
    track_id: String,
    custom_token: Option<String>,
    state: State<'_, RehearseState>,
) -> Result<RehearseSongResult, String> {
    let mut clean_id = clean_track_id(&track_id);
    if clean_id.is_empty() {
        return Err("Please provide a valid Rehearse track ID or song URL.".to_string());
    }

    // If the input contains spaces or does not look like a numeric/UUID ID, auto-resolve it via search!
    if clean_id.contains(' ') || clean_id.chars().all(|c| !c.is_ascii_digit()) {
        let results = search_rehearse_songs_internal(&clean_id).await?;
        if let Some(first) = results.into_iter().next() {
            println!(
                "[Rehearse] Auto-resolved song title '{}' to Rehearse ID '{}' ({})",
                clean_id, first.rehearse_song_id, first.title
            );
            clean_id = first.rehearse_song_id;
        } else {
            return Err(format!(
                "No song matching '{}' was found on CCLI Rehearse. Please check the song title or enter a CCLI number / Track ID.",
                clean_id
            ));
        }
    }

    let token = custom_token
        .filter(|t| !t.trim().is_empty())
        .or_else(|| state.token.lock().unwrap().clone())
        .ok_or_else(|| {
            "No active Rehearse token found. Please open Rehearse in LibreTracks or enter your token in settings.".to_string()
        })?;

    let client = reqwest::Client::new();
    let res = client
        .get(format!("https://rehearse-api.ccli.com/api/songs/{clean_id}"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "*/*")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
        )
        .send()
        .await
        .map_err(|e| format!("Network request failed: {e}"))?;

    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("Rehearse authentication failed (HTTP 401/403). The token may have expired. Please open Rehearse to refresh the token.".to_string());
    }
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("Rehearse track '{clean_id}' was not found (HTTP 404). Check the Track ID or URL."));
    }
    if !status.is_success() {
        return Err(format!("Rehearse API returned HTTP {status}"));
    }

    let body: SongResponse = res.json().await.map_err(|e| format!("Failed to parse Rehearse response JSON: {e}"))?;
    let song = body.payload.song;

    let time_signature = song.time_signature.unwrap_or_else(|| "4/4".to_string());
    let beats_per_bar = time_signature
        .split('/')
        .next()
        .and_then(|b| b.parse::<u32>().ok())
        .unwrap_or(4);

    let mut csv = String::from("#,Name,Start (s),Measure,Length (Measures)\n");
    let mut markers: Vec<RehearseParsedMarker> = Vec::new();
    let mut last_beat: i64 = -1;

    for (idx, m) in song.section_markers.iter().enumerate() {
        let sb = m.start_beat as i64;
        if sb < last_beat {
            break;
        }
        last_beat = sb;

        let eb = m.end_beat as i64;
        let start_measure = ((sb - 1) / beats_per_bar as i64) + 1;
        let duration_measures = std::cmp::max(1, (eb - sb) / beats_per_bar as i64);

        let (kind, variant, display_name) = parse_section_type(&m.section_type);

        csv.push_str(&format!(
            "M{},{},{:.2},{},{}\n",
            idx + 1,
            display_name.to_uppercase(),
            m.start_beat_seconds,
            start_measure,
            duration_measures
        ));

        markers.push(RehearseParsedMarker {
            name: display_name,
            kind,
            variant,
            start_seconds: m.start_beat_seconds,
            start_beat: m.start_beat,
            end_beat: m.end_beat,
            start_measure,
            duration_measures,
        });
    }

    Ok(RehearseSongResult {
        track_id: clean_id,
        title: song.title,
        time_signature,
        bpm: song.bpm,
        beats_per_bar,
        markers,
        csv,
    })
}

#[tauri::command]
pub async fn export_song_markers(
    track_id: String,
    state: State<'_, RehearseState>,
) -> Result<String, String> {
    let result = fetch_rehearse_song(track_id, None, state).await?;
    Ok(result.csv)
}
