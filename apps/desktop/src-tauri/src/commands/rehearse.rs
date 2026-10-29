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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorshipToolsCapturedCredentials {
    pub account_id: Option<String>,
    pub refresh_token: Option<String>,
    pub api_key: Option<String>,
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

#[tauri::command(async)]
pub fn save_worshiptools_credentials(
    credentials: WorshipToolsCapturedCredentials,
    app: AppHandle,
) {
    println!(
        "[WorshipTools] Captured credentials manually/via IPC: account_id={:?}, api_key={:?}, refresh_token_len={:?}",
        credentials.account_id,
        credentials.api_key,
        credentials.refresh_token.as_ref().map(|s| s.len())
    );
    let _ = app.emit("worshiptools-credentials-captured", credentials);
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
                    } else if (key === 'wt_account_id') {
                        window.__TAURI_INTERNALS__.invoke('save_worshiptools_credentials', { credentials: { accountId: value } });
                    } else if (key === 'wt_refresh_token') {
                        window.__TAURI_INTERNALS__.invoke('save_worshiptools_credentials', { credentials: { refreshToken: value } });
                    } else if (key === 'wt_api_key') {
                        window.__TAURI_INTERNALS__.invoke('save_worshiptools_credentials', { credentials: { apiKey: value } });
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

        const capturedState = {
            rehearseToken: false,
            rehearseTrackId: null,
            wtAccountId: null,
            wtRefreshToken: null,
            wtApiKey: null
        };

        const updateToolbar = (text, isSuccess) => {
            try {
                const dot = document.getElementById('__lt_dot__');
                const msg = document.getElementById('__lt_msg__');
                if (dot) {
                    dot.style.background = isSuccess ? '#34d399' : '#f59e0b';
                    dot.style.boxShadow = isSuccess ? '0 0 6px #34d399' : '0 0 6px #f59e0b';
                }
                if (msg && text) msg.textContent = text;
            } catch (_) {}
        };

        const updateWtStatusDisplay = () => {
            const parts = [];
            if (capturedState.wtAccountId) parts.push('Account ✓');
            else parts.push('Account: waiting…');
            if (capturedState.wtRefreshToken) parts.push('Refresh Token ✓');
            else parts.push('Refresh Token: waiting…');
            if (capturedState.wtApiKey) parts.push('API Key ✓');
            const isFullyReady = Boolean(capturedState.wtAccountId && capturedState.wtRefreshToken);
            const prefix = isFullyReady ? 'All credentials captured! ' : 'WorshipTools: ';
            updateToolbar(prefix + parts.join(' | '), isFullyReady);
        };

        const notifyToken = (token) => {
            if (!token) return;
            capturedState.rehearseToken = true;
            sendPayload('token', token);
            updateToolbar('CCLI Token Captured! You can close this window.', true);
        };

        const notifyTrackId = (trackId) => {
            if (!trackId) return;
            capturedState.rehearseTrackId = trackId;
            sendPayload('track_id', trackId);
            updateToolbar('Captured Song ID: ' + trackId, true);
        };

        const reservedAccounts = new Set([
            'login', 'logout', 'auth', 'users', 'default', 'documents', 'projects',
            'v1', 'api', 'databases', 'static', 'assets', 'home', 'planning',
            'dashboard', 'undefined', 'null', 'settings', 'account'
        ]);

        const notifyWt = (creds) => {
            if (!creds) return;
            let changed = false;
            if (creds.accountId && creds.accountId !== capturedState.wtAccountId) {
                const aid = String(creds.accountId).trim();
                if (aid.length >= 8 && !reservedAccounts.has(aid.toLowerCase())) {
                    capturedState.wtAccountId = aid;
                    sendPayload('wt_account_id', aid);
                    changed = true;
                }
            }
            if (creds.refreshToken && creds.refreshToken !== capturedState.wtRefreshToken) {
                const rt = String(creds.refreshToken).trim();
                if (rt.length >= 20) {
                    capturedState.wtRefreshToken = rt;
                    sendPayload('wt_refresh_token', rt);
                    changed = true;
                }
            }
            if (creds.apiKey && creds.apiKey !== capturedState.wtApiKey) {
                const key = String(creds.apiKey).trim();
                if (key.startsWith('AIza') && key.length >= 30) {
                    capturedState.wtApiKey = key;
                    sendPayload('wt_api_key', key);
                    changed = true;
                }
            }
            if (changed || capturedState.wtAccountId || capturedState.wtRefreshToken) {
                updateWtStatusDisplay();
            }
        };

        const scanObjForTokens = (obj, depth = 0) => {
            if (!obj || depth > 8) return;
            try {
                if (typeof obj === 'string') {
                    const s = obj.trim();
                    if (!s) return;
                    if (s.startsWith('{') || s.startsWith('[')) {
                        try {
                            const parsed = JSON.parse(s);
                            scanObjForTokens(parsed, depth + 1);
                        } catch (_) {}
                    }
                    const mRefresh = s.match(/(AMf-v[A-Za-z0-9_\-]{30,})/);
                    if (mRefresh && mRefresh[1]) {
                        notifyWt({ refreshToken: mRefresh[1] });
                    }
                    const mApi = s.match(/(AIza[0-9A-Za-z_\-]{35})/);
                    if (mApi && mApi[1]) {
                        notifyWt({ apiKey: mApi[1] });
                    }
                    const mAcc = s.match(/"accountId"\s*:\s*"([a-zA-Z0-9_\-]{8,50})"/i) ||
                                 s.match(/"currentAccountId"\s*:\s*"([a-zA-Z0-9_\-]{8,50})"/i);
                    if (mAcc && mAcc[1] && !reservedAccounts.has(mAcc[1].toLowerCase())) {
                        notifyWt({ accountId: mAcc[1] });
                    }
                    if (s.startsWith('AMf-v') && s.length > 50) {
                        notifyWt({ refreshToken: s });
                    }
                    return;
                }

                if (typeof obj !== 'object') return;

                if (obj.apiKey && typeof obj.apiKey === 'string') notifyWt({ apiKey: obj.apiKey });
                if (obj.refreshToken && typeof obj.refreshToken === 'string') notifyWt({ refreshToken: obj.refreshToken });
                if (obj.refresh_token && typeof obj.refresh_token === 'string') notifyWt({ refreshToken: obj.refresh_token });
                if (obj.accountId && typeof obj.accountId === 'string') notifyWt({ accountId: obj.accountId });
                if (obj.currentAccountId && typeof obj.currentAccountId === 'string') notifyWt({ accountId: obj.currentAccountId });
                if (obj.selectedAccountId && typeof obj.selectedAccountId === 'string') notifyWt({ accountId: obj.selectedAccountId });

                if (obj.stsTokenManager && typeof obj.stsTokenManager === 'object') {
                    if (obj.stsTokenManager.refreshToken) notifyWt({ refreshToken: obj.stsTokenManager.refreshToken });
                    if (obj.stsTokenManager.apiKey) notifyWt({ apiKey: obj.stsTokenManager.apiKey });
                }

                if (obj.value) {
                    scanObjForTokens(obj.value, depth + 1);
                }

                const keys = Object.keys(obj);
                for (let i = 0; i < keys.length; i++) {
                    const k = keys[i];
                    const val = obj[k];
                    if (val && (typeof val === 'object' || typeof val === 'string')) {
                        scanObjForTokens(val, depth + 1);
                    }
                }
            } catch (_) {}
        };

        const scanIndexedDB = () => {
            try {
                if (!window.indexedDB) return;

                const openAndScan = (dbName) => {
                    try {
                        const req = indexedDB.open(dbName);
                        req.onerror = () => {};
                        req.onsuccess = (e) => {
                            const db = e.target.result;
                            if (!db) return;
                            const storeNames = Array.from(db.objectStoreNames || []);
                            for (const storeName of storeNames) {
                                try {
                                    const tx = db.transaction(storeName, 'readonly');
                                    const store = tx.objectStore(storeName);
                                    if (typeof store.getAll === 'function') {
                                        const allReq = store.getAll();
                                        allReq.onsuccess = () => {
                                            if (Array.isArray(allReq.result)) {
                                                for (const item of allReq.result) {
                                                    scanObjForTokens(item);
                                                }
                                            }
                                        };
                                    }
                                    const curReq = store.openCursor();
                                    curReq.onsuccess = (ev) => {
                                        const cursor = ev.target.result;
                                        if (cursor) {
                                            if (cursor.key) scanObjForTokens(cursor.key);
                                            if (cursor.value) scanObjForTokens(cursor.value);
                                            cursor.continue();
                                        }
                                    };
                                } catch (_) {}
                            }
                        };
                    } catch (_) {}
                };

                openAndScan('firebaseLocalStorageDb');
                openAndScan('worshiptools');
                openAndScan('planning');
                openAndScan('worshiptools_planning');

                if (typeof indexedDB.databases === 'function') {
                    indexedDB.databases().then(dbs => {
                        if (Array.isArray(dbs)) {
                            for (const d of dbs) {
                                if (d && d.name && d.name !== 'firebaseLocalStorageDb') {
                                    openAndScan(d.name);
                                }
                            }
                        }
                    }).catch(() => {});
                }
            } catch (_) {}
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

        const inspectUrlForWt = (url) => {
            if (!url || typeof url !== 'string') return;
            try {
                const mKey = url.match(/[?&](?:key|apiKey)=(AIza[0-9A-Za-z_\-]+)/i);
                if (mKey && mKey[1]) {
                    notifyWt({ apiKey: mKey[1] });
                }

                const mAcc = url.match(/\/accounts\/([a-zA-Z0-9_\-]{8,50})/i) ||
                             url.match(/\/account\/([a-zA-Z0-9_\-]{8,50})/i) ||
                             url.match(/[?&]account(?:_?id)?=([a-zA-Z0-9_\-]{8,50})/i);
                if (mAcc && mAcc[1] && !reservedAccounts.has(mAcc[1].toLowerCase())) {
                    notifyWt({ accountId: mAcc[1] });
                }
            } catch (_) {}
        };

        // Hook window.fetch
        const origFetch = window.fetch;
        window.fetch = async function(...args) {
            try {
                const resource = args[0];
                const config = args[1];
                const url = typeof resource === 'string' ? resource : (resource && resource.url ? resource.url : '');

                inspectUrlForWt(url);

                if (config && config.body) {
                    scanObjForTokens(config.body);
                }

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
                console.error('[Capture Interceptor Error]', e);
            }

            const res = await origFetch.apply(this, args);

            try {
                const resource = args[0];
                const url = typeof resource === 'string' ? resource : (resource && resource.url ? resource.url : '');
                if (url && (url.includes('securetoken.googleapis.com') || url.includes('identitytoolkit.googleapis.com') || url.includes('worshiptools.com') || url.includes('token'))) {
                    res.clone().text().then(text => {
                        scanObjForTokens(text);
                    }).catch(() => {});
                }
            } catch (_) {}

            return res;
        };

        // Hook XMLHttpRequest
        const origOpen = XMLHttpRequest.prototype.open;
        const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        const origSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function(method, url) {
            this._reqUrl = url;
            try {
                inspectUrlForWt(String(url));
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

        XMLHttpRequest.prototype.send = function(body) {
            try {
                if (body) {
                    scanObjForTokens(body);
                }
                const url = String(this._reqUrl || '');
                if (url.includes('securetoken.googleapis.com') || url.includes('identitytoolkit.googleapis.com') || url.includes('worshiptools.com') || url.includes('token')) {
                    this.addEventListener('load', function() {
                        try {
                            if (this.responseText) {
                                scanObjForTokens(this.responseText);
                            }
                        } catch (_) {}
                    });
                }
            } catch (_) {}
            return origSend.apply(this, arguments);
        };

        // Scan localStorage, sessionStorage, cookies & global objects
        const scanStorage = () => {
            try {
                inspectUrlForWt(window.location.href);

                for (const storage of [window.localStorage, window.sessionStorage]) {
                    if (!storage) continue;
                    for (let i = 0; i < storage.length; i++) {
                        const k = storage.key(i);
                        if (!k) continue;
                        const v = storage.getItem(k);
                        if (!v) continue;

                        // 1. CCLI Rehearse
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

                        // 2. WorshipTools & Firebase
                        scanObjForTokens(v);
                        if (k.startsWith('firebase:authUser:')) {
                            const mKey = k.match(/firebase:authUser:(AIza[0-9A-Za-z_\-]+):/);
                            if (mKey && mKey[1]) notifyWt({ apiKey: mKey[1] });
                        }

                        // 3. WorshipTools Account ID
                        if (/^(?:account[-_]?id|current[-_]?account|selected[-_]?account|wt[-_]?account)/i.test(k)) {
                            if (typeof v === 'string' && v.length >= 8 && !reservedAccounts.has(v.toLowerCase())) {
                                notifyWt({ accountId: v.trim() });
                            }
                        }
                    }
                }

                if (document.cookie) {
                    const mCook = document.cookie.match(/(?:account[-_]?id|wt[-_]?account)=([a-zA-Z0-9_\-]{8,50})/i);
                    if (mCook && mCook[1] && !reservedAccounts.has(mCook[1].toLowerCase())) {
                        notifyWt({ accountId: mCook[1] });
                    }
                }

                // Global variables inspection
                if (window.firebase) scanObjForTokens(window.firebase);
                if (window.__WT_USER__) scanObjForTokens(window.__WT_USER__);
            } catch (_) {}
        };

        const runFullScan = () => {
            scanStorage();
            scanIndexedDB();
        };

        setInterval(runFullScan, 2000);
        setTimeout(runFullScan, 300);
        setTimeout(runFullScan, 1000);
        setTimeout(runFullScan, 2500);
        setTimeout(runFullScan, 5000);

        // Inject navigation / status bar
        const injectBar = () => {
            if (document.getElementById('__lt_rehearse_toolbar__')) return;
            const bar = document.createElement('div');
            bar.id = '__lt_rehearse_toolbar__';
            bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:40px;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:space-between;padding:0 14px;font-family:system-ui,-apple-system,sans-serif;font-size:12px;z-index:2147483647;border-bottom:1px solid #334155;box-shadow:0 2px 10px rgba(0,0,0,0.5);';
            bar.innerHTML = `
                <div style="display:flex;align-items:center;gap:10px;">
                    <strong style="color:#57f1db;font-weight:700;letter-spacing:0.02em;">LibreTracks Capture</strong>
                    <span id="__lt_status_indicator__" style="display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;background:#1e293b;border:1px solid #334155;font-size:11px;">
                        <span id="__lt_dot__" style="width:7px;height:7px;border-radius:50%;background:#f59e0b;transition:background 0.3s;"></span>
                        <span id="__lt_msg__">Scanning credentials… Sign in or browse planning.worshiptools.com.</span>
                    </span>
                    <button id="__lt_btn_capture_now__" style="background:#10b981;color:#fff;border:none;border-radius:4px;padding:3px 8px;font-size:11px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:3px;" title="Scan storage & IndexedDB immediately">⚡ Capture Now</button>
                </div>
                <div style="display:flex;align-items:center;gap:6px;">
                    <button id="__lt_btn_planning__" style="background:#2563eb;color:#fff;border:none;border-radius:4px;padding:4px 8px;font-size:11px;font-weight:600;cursor:pointer;">WT Planning</button>
                    <button id="__lt_btn_wt_accounts__" style="background:#4f46e5;color:#fff;border:none;border-radius:4px;padding:4px 8px;font-size:11px;font-weight:600;cursor:pointer;">WT Accounts</button>
                    <button id="__lt_btn_songselect__" style="background:#0891b2;color:#fff;border:none;border-radius:4px;padding:4px 8px;font-size:11px;font-weight:600;cursor:pointer;">SongSelect</button>
                    <button id="__lt_btn_rehearse__" style="background:#334155;color:#cbd5e1;border:none;border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;">CCLI Rehearse</button>
                </div>
            `;
            if (document.body) {
                document.body.prepend(bar);
                document.body.style.paddingTop = '40px';
            }
            const bCap = document.getElementById('__lt_btn_capture_now__');
            if (bCap) {
                bCap.onclick = () => {
                    runFullScan();
                    updateToolbar('Manual scan triggered…', Boolean(capturedState.wtAccountId && capturedState.wtRefreshToken));
                    setTimeout(updateWtStatusDisplay, 500);
                };
            }
            const bPlan = document.getElementById('__lt_btn_planning__');
            if (bPlan) bPlan.onclick = () => { window.location.href = 'https://planning.worshiptools.com'; };
            const bWtAcc = document.getElementById('__lt_btn_wt_accounts__');
            if (bWtAcc) bWtAcc.onclick = () => { window.location.href = 'https://accounts.worshiptools.com'; };
            const bSong = document.getElementById('__lt_btn_songselect__');
            if (bSong) bSong.onclick = () => { window.location.href = 'https://songselect.ccli.com'; };
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
        .title("WorshipTools & CCLI Rehearse — LibreTracks Capture")
        .inner_size(1150.0, 780.0)
        .initialization_script(init_script)
        .on_navigation(move |nav_url| {
            if nav_url.host_str() == Some("libretracks-capture.local") {
                let state = app_handle_for_nav.state::<RehearseState>();
                let mut wt_creds = WorshipToolsCapturedCredentials::default();
                let mut has_wt_cred = false;

                for (key, val) in nav_url.query_pairs() {
                    let val_trim = val.trim().to_string();
                    if val_trim.is_empty() {
                        continue;
                    }
                    if key == "token" {
                        let mut current = state.token.lock().unwrap();
                        *current = Some(val_trim.clone());
                        println!("[Rehearse] Captured token via navigation (len {})", val_trim.len());
                        let _ = app_handle_for_nav.emit("rehearse-token-captured", val_trim);
                    } else if key == "track_id" {
                        let track_clean = clean_track_id(&val_trim);
                        let mut current = state.last_track_id.lock().unwrap();
                        *current = Some(track_clean.clone());
                        println!("[Rehearse] Captured track_id via navigation: {}", track_clean);
                        let _ = app_handle_for_nav.emit("rehearse-track-captured", track_clean);
                    } else if key == "wt_account_id" {
                        println!("[WorshipTools] Captured account_id via navigation: {}", val_trim);
                        wt_creds.account_id = Some(val_trim);
                        has_wt_cred = true;
                    } else if key == "wt_refresh_token" {
                        println!("[WorshipTools] Captured refresh_token via navigation (len {})", val_trim.len());
                        wt_creds.refresh_token = Some(val_trim);
                        has_wt_cred = true;
                    } else if key == "wt_api_key" {
                        println!("[WorshipTools] Captured api_key via navigation: {}", val_trim);
                        wt_creds.api_key = Some(val_trim);
                        has_wt_cred = true;
                    }
                }

                if has_wt_cred {
                    let _ = app_handle_for_nav.emit("worshiptools-credentials-captured", wt_creds);
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