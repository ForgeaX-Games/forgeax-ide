fn main() {
    // The guardian is a standalone POSIX binary and does not need Tauri's
    // resource validation. Release staging builds it before the final Tauri
    // resources exist, so keep this path independent of desktop bundle files.
    if std::env::var_os("FORGEAX_BUILD_RUNTIME_GUARDIAN").is_some() {
        println!("cargo:rerun-if-env-changed=FORGEAX_BUILD_RUNTIME_GUARDIAN");
        return;
    }
    tauri_build::build()
}
