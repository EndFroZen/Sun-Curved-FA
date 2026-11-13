fn main() {
    // icon.ico is baked into the exe by this script; without this cargo keeps the stale icon
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
