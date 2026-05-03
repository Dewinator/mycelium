// Single source of truth for the native-app data layout.
//
// One root directory per install holds three subtrees:
//
//   ${MYCELIUM_DATA_DIR}/
//     ├── pgdata/        PGlite WAL + heap (#185)
//     ├── models/        GGUF files for node-llama-cpp (#187)
//     └── wire-cert/     Self-signed mTLS cert for Wave-3 wire port
//                        (created here, populated by Wave-2/3 ticket)
//
// Default root per platform — matches what the Tauri shell will pass in
// via `MYCELIUM_DATA_DIR` (BaseDirectory::AppLocalData):
//
//   macOS:   ~/Library/Application Support/mycelium/
//   Linux:   $XDG_DATA_HOME/mycelium/  (fallback ~/.local/share/mycelium/)
//   Windows: %APPDATA%/mycelium/
//
// Backward compatibility: the pre-existing `MYCELIUM_PGLITE_DATA_DIR` and
// `MYCELIUM_LLAMA_MODELS_DIR` env vars still override their respective
// subpaths. Setting just `MYCELIUM_DATA_DIR` is the new one-knob path.

import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface DataDirLayout {
  root: string;
  pgData: string;
  models: string;
  wireCert: string;
}

export function defaultRootDir(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "mycelium");
  }
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "mycelium");
  }
  const xdg =
    process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
  return path.join(xdg, "mycelium");
}

export function getDataDirLayout(): DataDirLayout {
  const root = process.env.MYCELIUM_DATA_DIR ?? defaultRootDir();
  return {
    root,
    pgData: process.env.MYCELIUM_PGLITE_DATA_DIR ?? path.join(root, "pgdata"),
    models: process.env.MYCELIUM_LLAMA_MODELS_DIR ?? path.join(root, "models"),
    wireCert: path.join(root, "wire-cert"),
  };
}

export async function ensureDataDirs(
  layout: DataDirLayout = getDataDirLayout()
): Promise<DataDirLayout> {
  await mkdir(layout.root, { recursive: true });
  await mkdir(layout.pgData, { recursive: true });
  await mkdir(layout.models, { recursive: true });
  await mkdir(layout.wireCert, { recursive: true });
  return layout;
}
