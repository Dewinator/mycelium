import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  defaultRootDir,
  getDataDirLayout,
  ensureDataDirs,
} from "../../native/data-dir.js";

function withEnv(
  patches: Record<string, string | undefined>,
  fn: () => Promise<void> | void
): () => Promise<void> {
  return async () => {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(patches)) prev[k] = process.env[k];
    try {
      for (const [k, v] of Object.entries(patches)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

test(
  "defaultRootDir returns OS-conventional absolute path ending in mycelium",
  () => {
    const root = defaultRootDir();
    assert.ok(path.isAbsolute(root), `expected absolute path, got ${root}`);
    assert.equal(path.basename(root), "mycelium");
  }
);

test(
  "MYCELIUM_DATA_DIR override propagates to all subpaths",
  withEnv(
    {
      MYCELIUM_DATA_DIR: "/tmp/mycelium-test-root",
      MYCELIUM_PGLITE_DATA_DIR: undefined,
      MYCELIUM_LLAMA_MODELS_DIR: undefined,
    },
    () => {
      const layout = getDataDirLayout();
      assert.equal(layout.root, "/tmp/mycelium-test-root");
      assert.equal(layout.pgData, "/tmp/mycelium-test-root/pgdata");
      assert.equal(layout.models, "/tmp/mycelium-test-root/models");
      assert.equal(layout.wireCert, "/tmp/mycelium-test-root/wire-cert");
    }
  )
);

test(
  "MYCELIUM_PGLITE_DATA_DIR overrides pgData independent of root",
  withEnv(
    {
      MYCELIUM_DATA_DIR: "/tmp/mycelium-test-root",
      MYCELIUM_PGLITE_DATA_DIR: "/var/custom/pglite",
      MYCELIUM_LLAMA_MODELS_DIR: undefined,
    },
    () => {
      const layout = getDataDirLayout();
      assert.equal(layout.pgData, "/var/custom/pglite");
      assert.equal(layout.root, "/tmp/mycelium-test-root");
      assert.equal(layout.models, "/tmp/mycelium-test-root/models");
    }
  )
);

test(
  "MYCELIUM_LLAMA_MODELS_DIR overrides models independent of root",
  withEnv(
    {
      MYCELIUM_DATA_DIR: "/tmp/mycelium-test-root",
      MYCELIUM_PGLITE_DATA_DIR: undefined,
      MYCELIUM_LLAMA_MODELS_DIR: "/var/custom/models",
    },
    () => {
      const layout = getDataDirLayout();
      assert.equal(layout.models, "/var/custom/models");
      assert.equal(layout.pgData, "/tmp/mycelium-test-root/pgdata");
    }
  )
);

test("ensureDataDirs creates root + three subdirs", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mycelium-data-dir-"));
  try {
    const layout = await ensureDataDirs({
      root: tmp,
      pgData: path.join(tmp, "pgdata"),
      models: path.join(tmp, "models"),
      wireCert: path.join(tmp, "wire-cert"),
    });
    for (const dir of [layout.root, layout.pgData, layout.models, layout.wireCert]) {
      const st = await stat(dir);
      assert.ok(st.isDirectory(), `${dir} should be a directory`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("ensureDataDirs is idempotent (second call does not throw)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mycelium-data-dir-"));
  try {
    const layout = {
      root: tmp,
      pgData: path.join(tmp, "pgdata"),
      models: path.join(tmp, "models"),
      wireCert: path.join(tmp, "wire-cert"),
    };
    await ensureDataDirs(layout);
    await ensureDataDirs(layout);
    const st = await stat(layout.wireCert);
    assert.ok(st.isDirectory());
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
