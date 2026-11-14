use serde::Serialize;
use ssh2::{Channel, CheckResult, KeyboardInteractivePrompt, KnownHostFileKind, Prompt, Session};
use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

// One SSH session per open machine. Its I/O thread owns the session and serves both
// the interactive shell (terminal) and app commands (remote_exec), so login/2FA happens once.

enum Req {
    Write(Vec<u8>),
    Resize(u32, u32),
    Exec(ExecReq, Sender<Result<ExecOut, String>>),
    Close,
}

struct ExecReq {
    command: String,
    stdin: Option<String>, // e.g. a whole script for `bash -s`; keeps secrets out of `ps`
    stream: bool,          // emit exec-data-{sid} chunks while it runs
    timeout_ms: u32,       // read timeout while it runs, 0 = none (a dead link then hangs until TCP gives up)
}

#[derive(Serialize)]
struct ExecOut {
    out: String,
    code: i32,
}

static SESSIONS: LazyLock<Mutex<HashMap<u32, Sender<Req>>>> = LazyLock::new(Default::default);
/// Auth prompts waiting for the user's answer from the popup.
static PENDING: LazyLock<Mutex<HashMap<u64, Sender<Option<Vec<String>>>>>> = LazyLock::new(Default::default);
static REQ_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Clone)]
struct AuthPrompt {
    req: u64,
    sid: u32,
    instructions: String,
    prompts: Vec<(String, bool)>, // (text, echo)
}

/// Shows the auth popup in the UI and blocks until it's answered (None = cancelled).
fn ask(app: &AppHandle, sid: u32, instructions: &str, prompts: Vec<(String, bool)>) -> Option<Vec<String>> {
    let req = REQ_ID.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = channel();
    PENDING.lock().unwrap().insert(req, tx);
    let msg = AuthPrompt { req, sid, instructions: instructions.trim().into(), prompts };
    let answer = app
        .emit("auth-prompt", msg)
        .ok()
        .and_then(|_| rx.recv_timeout(Duration::from_secs(120)).ok().flatten()); // ~sshd LoginGraceTime
    PENDING.lock().unwrap().remove(&req);
    answer
}

#[tauri::command]
fn auth_answer(req: u64, answers: Option<Vec<String>>) {
    if let Some(tx) = PENDING.lock().unwrap().remove(&req) {
        let _ = tx.send(answers);
    }
}

/// Keyboard-interactive: a lone password prompt gets the saved password (once); everything else
/// (2FA code, or the password again after a wrong saved one) goes to the popup.
struct Asker<'a> {
    app: &'a AppHandle,
    sid: u32,
    saved: Option<String>,
    retry: bool,
    cancelled: bool,
}

impl KeyboardInteractivePrompt for Asker<'_> {
    fn prompt<'b>(&mut self, _user: &str, instructions: &str, prompts: &[Prompt<'b>]) -> Vec<String> {
        if let [p] = prompts {
            if !p.echo && p.text.to_lowercase().contains("password") {
                if let Some(pw) = self.saved.take() {
                    return vec![pw];
                }
            }
        }
        let list = prompts.iter().map(|p| (p.text.trim().to_string(), p.echo)).collect();
        let note = if std::mem::take(&mut self.retry) { "Wrong password, try again." } else { instructions };
        ask(self.app, self.sid, note, list).unwrap_or_else(|| {
            self.cancelled = true;
            vec![String::new(); prompts.len()]
        })
    }
}

fn login(
    app: &AppHandle,
    sid: u32,
    host: &str,
    port: u16,
    user: &str,
    key_path: &str,
    saved: Option<String>,
) -> Result<Session, Box<dyn std::error::Error>> {
    let addr = (host, port).to_socket_addrs()?.next().ok_or("cannot resolve host")?;
    // Retry only the TCP connect: auth/host-key failures must not repeat (lockouts, re-prompts).
    let mut retries = 0;
    let tcp = loop {
        match TcpStream::connect_timeout(&addr, Duration::from_secs(10)) {
            Ok(t) => break t,
            Err(_) if retries < 3 => {
                retries += 1;
                std::thread::sleep(Duration::from_secs(2));
            }
            Err(e) => return Err(e.into()),
        }
    };
    let mut sess = Session::new()?;
    sess.set_timeout(30_000);
    sess.set_tcp_stream(tcp);
    sess.handshake()?;
    verify_host_key(&sess, host, port)?;

    let mut saved = saved;
    if !key_path.is_empty() {
        if !Path::new(key_path).is_file() {
            return Err(format!("private key file not found: {key_path}").into());
        }
        // With a key, the saved secret is its passphrase, not a login password.
        sess.userauth_pubkey_file(user, None, Path::new(key_path), saved.take().as_deref())?;
    }
    if !sess.authenticated() {
        let methods = sess.auth_methods(user)?.to_string();
        // A wrong password ends the round with a failure (no re-prompt), so retry via the popup
        // like OpenSSH's NumberOfPasswordPrompts=3. Cancelling the popup stops at once.
        let kbd = methods.contains("keyboard-interactive");
        let mut asker = Asker { app, sid, saved, retry: false, cancelled: false };
        for attempt in 0..3 {
            asker.retry = attempt > 0;
            let r = if kbd {
                sess.userauth_keyboard_interactive(user, &mut asker)
            } else {
                let pw = match asker.saved.take() {
                    Some(pw) => pw,
                    None => {
                        let note = if asker.retry { "Wrong password, try again." } else { "" };
                        ask(app, sid, note, vec![("Password:".into(), false)])
                            .and_then(|a| a.into_iter().next())
                            .ok_or("cancelled")?
                    }
                };
                sess.userauth_password(user, &pw)
            };
            if asker.cancelled {
                return Err("cancelled".into());
            }
            match r {
                Ok(()) => break,
                Err(e) if attempt == 2 => return Err(e.into()),
                Err(_) => {}
            }
        }
    }
    Ok(sess)
}

#[tauri::command]
async fn ssh_connect(
    app: AppHandle,
    sid: u32,
    id: i64,
    host: String,
    port: u16,
    user: String,
    key_path: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let saved = secret(id)?.get_password().ok();
        let sess = login(&app, sid, &host, port, &user, &key_path, saved).map_err(|e| e.to_string())?;
        let mut shell = sess.channel_session().map_err(|e| e.to_string())?;
        shell
            .request_pty("xterm-256color", None, Some((cols, rows, 0, 0)))
            .map_err(|e| e.to_string())?;
        shell.shell().map_err(|e| e.to_string())?;
        let (tx, rx) = channel();
        SESSIONS.lock().unwrap().insert(sid, tx);
        std::thread::spawn(move || io_loop(app, sid, sess, shell, rx));
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ponytail: 10ms poll loop + execs run inline (shell output waits while one runs);
// fine for short setup commands, move to async (russh) if long-running jobs are needed.
fn io_loop(app: AppHandle, sid: u32, sess: Session, mut shell: Channel, rx: Receiver<Req>) {
    let mut buf = [0u8; 16384];
    'outer: loop {
        let mut idle = true;
        sess.set_blocking(false);
        loop {
            match shell.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = app.emit(&format!("term-data-{sid}"), &buf[..n]);
                    idle = false;
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                Err(_) => break 'outer,
            }
        }
        if shell.eof() {
            break;
        }
        sess.set_blocking(true);
        loop {
            match rx.try_recv() {
                Ok(Req::Write(d)) => {
                    if shell.write_all(&d).is_err() {
                        break 'outer;
                    }
                    idle = false;
                }
                Ok(Req::Resize(c, r)) => {
                    let _ = shell.request_pty_size(c, r, None, None);
                }
                Ok(Req::Exec(req, reply)) => {
                    let _ = reply.send(exec(&app, sid, &sess, &req).map_err(|e| e.to_string()));
                    idle = false;
                }
                Ok(Req::Close) | Err(TryRecvError::Disconnected) => break 'outer,
                Err(TryRecvError::Empty) => break,
            }
        }
        if idle {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    SESSIONS.lock().unwrap().remove(&sid);
    let _ = app.emit(&format!("term-exit-{sid}"), ());
}

fn exec(app: &AppHandle, sid: u32, sess: &Session, req: &ExecReq) -> Result<ExecOut, Box<dyn std::error::Error>> {
    // Builds can be quiet for minutes: no read timeout unless the caller asks (deploy follow sends heartbeats).
    // ponytail: a hung command blocks this machine's session; add a cancel button if that bites.
    sess.set_timeout(req.timeout_ms);
    let r = exec_inner(app, sid, sess, req);
    sess.set_timeout(30_000);
    r
}

fn exec_inner(app: &AppHandle, sid: u32, sess: &Session, req: &ExecReq) -> Result<ExecOut, Box<dyn std::error::Error>> {
    let mut ch = sess.channel_session()?;
    ch.handle_extended_data(ssh2::ExtendedData::Merge)?; // stderr into stdout, in order
    ch.exec(&req.command)?;
    if let Some(input) = &req.stdin {
        ch.write_all(input.as_bytes())?;
    }
    ch.send_eof()?;
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = ch.read(&mut buf)?;
        if n == 0 {
            break;
        }
        if req.stream {
            let _ = app.emit(&format!("exec-data-{sid}"), &buf[..n]);
        }
        out.extend_from_slice(&buf[..n]);
    }
    ch.wait_close()?;
    Ok(ExecOut { out: String::from_utf8_lossy(&out).into_owned(), code: ch.exit_status()? })
}

fn send(sid: u32, req: Req) -> Result<(), String> {
    SESSIONS
        .lock()
        .unwrap()
        .get(&sid)
        .ok_or("not connected")?
        .send(req)
        .map_err(|_| "not connected".to_string())
}

#[tauri::command]
fn term_write(sid: u32, data: String) -> Result<(), String> {
    send(sid, Req::Write(data.into_bytes()))
}

#[tauri::command]
fn term_resize(sid: u32, cols: u32, rows: u32) {
    let _ = send(sid, Req::Resize(cols, rows));
}

/// Runs a command on the machine over the already-authenticated session.
#[tauri::command]
async fn remote_exec(
    sid: u32,
    command: String,
    stdin: Option<String>,
    stream: Option<bool>,
    timeout_ms: Option<u32>,
) -> Result<ExecOut, String> {
    let (tx, rx) = channel();
    let req = ExecReq { command, stdin, stream: stream.unwrap_or(false), timeout_ms: timeout_ms.unwrap_or(0) };
    send(sid, Req::Exec(req, tx))?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|_| "disconnected".to_string())?)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn ssh_disconnect(sid: u32) {
    if let Some(tx) = SESSIONS.lock().unwrap().remove(&sid) {
        let _ = tx.send(Req::Close);
    }
}

/// Same policy as `ssh -o StrictHostKeyChecking=accept-new`: trust on first use, reject changed keys.
fn verify_host_key(sess: &Session, host: &str, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let file = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|h| PathBuf::from(h).join(".ssh").join("known_hosts"))
        .ok_or("no home dir")?;
    let mut kh = sess.known_hosts()?;
    if file.exists() {
        kh.read_file(&file, KnownHostFileKind::OpenSSH)?;
    }
    let (key, kind) = sess.host_key().ok_or("no host key")?;
    match kh.check_port(host, port, key) {
        CheckResult::Match => Ok(()),
        CheckResult::NotFound => {
            let name = if port == 22 { host.to_string() } else { format!("[{host}]:{port}") };
            kh.add(&name, key, "", kind.into())?;
            std::fs::create_dir_all(file.parent().unwrap())?;
            kh.write_file(&file, KnownHostFileKind::OpenSSH)?;
            Ok(())
        }
        CheckResult::Mismatch => Err("HOST KEY CHANGED - possible MITM, check ~/.ssh/known_hosts".into()),
        CheckResult::Failure => Err("host key check failed".into()),
    }
}

/// Password / key passphrase lives in the OS credential store, never in sqlite.
fn secret(id: i64) -> Result<keyring::Entry, String> {
    keyring::Entry::new("sun-curved", &format!("conn-{id}")).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_secret(id: i64, secret_value: String) -> Result<(), String> {
    if secret_value.is_empty() {
        return del_secret(id);
    }
    secret(id)?.set_password(&secret_value).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_secret(id: i64) -> Result<String, String> {
    match secret(id)?.get_password() {
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        r => r.map_err(|e| e.to_string()),
    }
}

#[tauri::command]
fn del_secret(id: i64) -> Result<(), String> {
    match secret(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---------- SSH tunnel (local port forward) for the database app ----------
// 127.0.0.1:<random> -> SSH server -> remote_host:remote_port, over one logged-in session.
// Reused per (ssh conn, remote host, port) until the session dies.

static TUNNELS: LazyLock<Mutex<HashMap<String, u16>>> = LazyLock::new(Default::default);
/// Bumped by ssh_tunnels_close; each tunnel loop stops when it no longer matches its start value.
static TUNNEL_GEN: AtomicU64 = AtomicU64::new(0);

/// Closes every SSH tunnel (frees the sessions and local ports), e.g. when the database app is swiped away.
#[tauri::command]
fn ssh_tunnels_close() {
    TUNNEL_GEN.fetch_add(1, Ordering::Relaxed);
    TUNNELS.lock().unwrap().clear();
}

#[tauri::command]
async fn ssh_tunnel(
    app: AppHandle,
    id: i64,
    host: String,
    port: u16,
    user: String,
    key_path: String,
    remote_host: String,
    remote_port: u16,
) -> Result<u16, String> {
    let key = format!("{id}|{remote_host}|{remote_port}");
    if let Some(p) = TUNNELS.lock().unwrap().get(&key) {
        return Ok(*p);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let saved = secret(id)?.get_password().ok();
        // sid 0: auth prompts show as a plain "Sign in" popup (no terminal tab owns this session).
        let sess = login(&app, 0, &host, port, &user, &key_path, saved).map_err(|e| e.to_string())?;
        sess.set_keepalive(true, 30);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let local = listener.local_addr().map_err(|e| e.to_string())?.port();
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        TUNNELS.lock().unwrap().insert(key.clone(), local);
        let started = TUNNEL_GEN.load(Ordering::Relaxed);
        std::thread::spawn(move || {
            tunnel_loop(&sess, &listener, &remote_host, remote_port, started);
            let mut t = TUNNELS.lock().unwrap();
            if t.get(&key) == Some(&local) {
                t.remove(&key); // a newer tunnel for the same key may already be registered
            }
        });
        Ok(local)
    })
    .await
    .map_err(|e| e.to_string())?
}

struct Pipe {
    tcp: TcpStream,
    ch: Channel,
    to_ch: Vec<u8>,
    to_tcp: Vec<u8>,
    done: bool,
}

// ponytail: single-thread 2ms poll loop over all forwarded sockets; fine for a DB pool, not for bulk transfer.
fn tunnel_loop(sess: &Session, listener: &std::net::TcpListener, rhost: &str, rport: u16, started: u64) {
    let mut pipes: Vec<Pipe> = Vec::new();
    let mut buf = [0u8; 32768];
    let mut last_ka = std::time::Instant::now();
    loop {
        if TUNNEL_GEN.load(Ordering::Relaxed) != started {
            let _ = sess.disconnect(None, "closed", None);
            return;
        }
        let mut idle = true;
        match listener.accept() {
            Ok((tcp, _)) => {
                idle = false;
                sess.set_blocking(true);
                let ch = sess.channel_direct_tcpip(rhost, rport, None);
                sess.set_blocking(false);
                match ch {
                    Ok(ch) if tcp.set_nonblocking(true).is_ok() => pipes.push(Pipe { tcp, ch, to_ch: Vec::new(), to_tcp: Vec::new(), done: false }),
                    Ok(_) => {}
                    Err(_) => return, // session gone (or target refused): drop the tunnel, the next connect builds a new one
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => {}
            Err(_) => return,
        }
        sess.set_blocking(false);
        // Ok(0) = would block; Err = closed or failed.
        let nb = |r: std::io::Result<usize>| match r {
            Ok(0) => Err(()),
            Ok(n) => Ok(n),
            Err(e) if e.kind() == ErrorKind::WouldBlock => Ok(0),
            Err(_) => Err(()),
        };
        for p in pipes.iter_mut() {
            let mut moved = 0;
            if p.to_ch.is_empty() {
                match nb(p.tcp.read(&mut buf)) {
                    Ok(n) => (p.to_ch.extend_from_slice(&buf[..n]), moved += n).1,
                    Err(()) => p.done = true,
                }
            }
            if !p.to_ch.is_empty() {
                match nb(p.ch.write(&p.to_ch)) {
                    Ok(n) => (p.to_ch.drain(..n), moved += n).1,
                    Err(()) => p.done = true,
                }
            }
            if p.to_tcp.is_empty() {
                match nb(p.ch.read(&mut buf)) {
                    Ok(n) => (p.to_tcp.extend_from_slice(&buf[..n]), moved += n).1,
                    Err(()) => p.done = true,
                }
            }
            if !p.to_tcp.is_empty() {
                match nb(p.tcp.write(&p.to_tcp)) {
                    Ok(n) => (p.to_tcp.drain(..n), moved += n).1,
                    Err(()) => p.done = true,
                }
            }
            if moved > 0 {
                idle = false;
            }
        }
        for p in pipes.iter_mut().filter(|p| p.done) {
            let _ = p.tcp.shutdown(std::net::Shutdown::Both);
            let _ = p.ch.close();
        }
        pipes.retain(|p| !p.done);
        if last_ka.elapsed() > Duration::from_secs(15) {
            last_ka = std::time::Instant::now();
            sess.set_blocking(true);
            let alive = sess.keepalive_send().is_ok();
            sess.set_blocking(false);
            if !alive {
                return;
            }
        }
        if idle {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

// ----- Notepad: each note is <name>.md in %APPDATA%\Sun Curved\notepad[\<folder>] (one folder level) -----
// A note's id is its file creation time (ms): stable across rename/move, so pins/recent survive restarts.

fn np_root() -> Result<PathBuf, String> {
    let base = std::env::var_os("APPDATA").map(PathBuf::from).ok_or("APPDATA not set")?;
    let d = base.join("Sun Curved").join("notepad");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

// names come from the UI: refuse anything that could escape the notepad folder or that Windows rejects
fn np_part(s: &str) -> Result<&str, String> {
    let bad = s.trim().is_empty() || s == "." || s == ".." || s.ends_with(['.', ' '])
        || s.chars().any(|c| "<>:\"/\\|?*".contains(c) || c < ' ');
    if bad { Err(format!("invalid name: {s}")) } else { Ok(s) }
}

fn np_path(folder: &str, name: Option<&str>) -> Result<PathBuf, String> {
    let mut p = np_root()?;
    if !folder.is_empty() { p.push(np_part(folder)?) }
    if let Some(n) = name { p.push(format!("{}.md", np_part(n)?)) }
    Ok(p)
}

fn np_ms(t: std::io::Result<std::time::SystemTime>) -> u64 {
    t.ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

#[derive(Serialize)]
struct NpNote { id: u64, name: String, text: String, t: u64, folder: Option<String> }

#[derive(Serialize)]
struct NpTree { dirs: Vec<String>, notes: Vec<NpNote> }

fn np_scan(dir: &Path, folder: Option<&str>, out: &mut NpTree) -> std::io::Result<()> {
    for e in std::fs::read_dir(dir)? {
        let p = e?.path();
        let m = std::fs::metadata(&p)?;
        if m.is_dir() {
            let Some(name) = p.file_name().and_then(|s| s.to_str()) else { continue };
            if folder.is_none() && !name.starts_with('.') { // one level only; ".assets" etc. are not note folders
                out.dirs.push(name.to_string());
                np_scan(&p, Some(name), out)?;
            }
        } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("md")) {
            let Some(name) = p.file_stem().and_then(|s| s.to_str()) else { continue };
            out.notes.push(NpNote {
                id: np_ms(m.created()),
                name: name.to_string(),
                text: String::from_utf8_lossy(&std::fs::read(&p)?).into_owned(),
                t: np_ms(m.modified()),
                folder: folder.map(str::to_string),
            });
        }
    }
    Ok(())
}

#[tauri::command]
fn np_list() -> Result<NpTree, String> {
    let mut out = NpTree { dirs: vec![], notes: vec![] };
    np_scan(&np_root()?, None, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// write a note; returns its id (file creation time)
#[tauri::command]
fn np_write(folder: String, name: String, text: String) -> Result<u64, String> {
    let p = np_path(&folder, Some(&name))?;
    std::fs::write(&p, text).map_err(|e| e.to_string())?;
    Ok(np_ms(std::fs::metadata(&p).and_then(|m| m.created())))
}

#[tauri::command]
fn np_mkdir(folder: String) -> Result<(), String> {
    std::fs::create_dir(np_path(&folder, None)?).map_err(|e| e.to_string())
}

/// rename/move a note (name = Some) or rename a folder (name = None); never overwrites
#[tauri::command]
fn np_move(folder: String, name: Option<String>, to_folder: String, to_name: Option<String>) -> Result<(), String> {
    let (from, to) = (np_path(&folder, name.as_deref())?, np_path(&to_folder, to_name.as_deref())?);
    if to.exists() { return Err(format!("already exists: {}", to.display())) }
    std::fs::rename(from, to).map_err(|e| e.to_string())
}

/// delete a note, or an (empty) folder
#[tauri::command]
fn np_remove(folder: String, name: Option<String>) -> Result<(), String> {
    let p = np_path(&folder, name.as_deref())?;
    if name.is_some() { std::fs::remove_file(p) } else { std::fs::remove_dir(p) }.map_err(|e| e.to_string())
}

// Images in notes live in notepad\.assets\<ms>.<ext>; notes link them as ![](.assets/<name>).
// ponytail: images are never deleted (a note may still link one); add a "clean unused images" action if the folder grows
fn np_assets() -> Result<PathBuf, String> {
    let d = np_root()?.join(".assets");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

/// save raw image bytes (invoke body) with extension from the "x-ext" header; returns the file name
#[tauri::command]
fn np_save_image(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw image bytes".into()) };
    let ext = request.headers().get("x-ext").and_then(|v| v.to_str().ok()).unwrap_or("png").to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "gif", "webp", "bmp"].contains(&ext.as_str()) { return Err(format!("unsupported image type: {ext}")) }
    let dir = np_assets()?;
    let ms = np_ms(Ok(std::time::SystemTime::now()));
    let name = (0..).map(|i| if i == 0 { format!("{ms}.{ext}") } else { format!("{ms}-{i}.{ext}") })
        .find(|n| !dir.join(n).exists()).unwrap();
    std::fs::write(dir.join(&name), bytes).map_err(|e| e.to_string())?;
    Ok(name)
}

/// bytes of a saved image (arrives in JS as an ArrayBuffer)
#[tauri::command]
fn np_image(name: String) -> Result<tauri::ipc::Response, String> {
    let p = np_assets()?.join(np_part(&name)?); // a bare file name only, never a path
    std::fs::read(p).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// Export PDF: WebView2 renders the page's print layout (the A4 sheets the Notepad just laid out) straight
/// into Downloads\<name>.pdf — A4, no margins, backgrounds on, no header/footer, no print dialog. Returns the path.
#[cfg(windows)]
#[tauri::command]
async fn np_pdf(webview: tauri::Webview, path: String, landscape: bool) -> Result<(), String> {
    use webview2_com::{Microsoft::Web::WebView2::Win32::*, PrintToPdfCompletedHandler};
    use windows::core::{Interface, HSTRING};
    let path = PathBuf::from(path);
    if !path.is_absolute() || !path.extension().is_some_and(|x| x.eq_ignore_ascii_case("pdf")) { return Err("choose a .pdf file".into()) }
    let (tx, rx) = std::sync::mpsc::channel::<Result<bool, String>>();
    let target = HSTRING::from(path.as_os_str());
    webview.with_webview(move |w| {
        let fail = tx.clone();
        let start = || -> windows::core::Result<()> {
            unsafe {
                let wv = w.controller().CoreWebView2()?;
                let env = wv.cast::<ICoreWebView2_2>()?.Environment()?.cast::<ICoreWebView2Environment6>()?;
                let s = env.CreatePrintSettings()?;
                s.SetOrientation(if landscape { COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE } else { COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT })?;
                s.SetPageWidth(8.27)?; // A4 in inches
                s.SetPageHeight(11.69)?;
                s.SetMarginTop(0.0)?;
                s.SetMarginBottom(0.0)?;
                s.SetMarginLeft(0.0)?;
                s.SetMarginRight(0.0)?;
                s.SetShouldPrintBackgrounds(true.into())?;
                s.SetShouldPrintHeaderAndFooter(false.into())?;
                let done = PrintToPdfCompletedHandler::create(Box::new(move |hr, ok| {
                    let _ = tx.send(hr.map(|_| ok.into()).map_err(|e| e.to_string()));
                    Ok(())
                }));
                wv.cast::<ICoreWebView2_7>()?.PrintToPdf(&target, &s, &done)
            }
        };
        if let Err(e) = start() { let _ = fail.send(Err(e.to_string())); }
    }).map_err(|e| e.to_string())?;
    // the handler fires on the UI thread; wait for it off that thread
    let ok = tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string()))
        .await.map_err(|e| e.to_string())???;
    if ok { Ok(()) } else { Err("PDF export failed".into()) }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            ssh_disconnect,
            term_write,
            term_resize,
            remote_exec,
            auth_answer,
            set_secret,
            get_secret,
            del_secret,
            ssh_tunnel,
            ssh_tunnels_close,
            np_list,
            np_write,
            np_mkdir,
            np_move,
            np_remove,
            np_save_image,
            np_image,
            #[cfg(windows)]
            np_pdf
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
