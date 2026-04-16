/**
 * Benchmark: mprotect+signal handler vs mmap+msync
 *
 * Runs the same operations under both approaches and compares wall-clock
 * time for the save step.
 *
 * Run:
 *   deno test --allow-read=node_modules,. --allow-write=. --allow-net --allow-ffi mprotect_vs_mmap_test.ts
 */

import "./polyfill.ts";
import { loadPyodide } from "pyodide";
import { assert } from "jsr:@std/assert";

const PAGE_SIZE = 16384;
const SNAP_MPROTECT = "./.bench-snap-mprotect.bin";
const SNAP_MMAP = "./.bench-snap-mmap.bin";

// ---------------------------------------------------------------------------
// Snapshot file helpers (page-aligned heap for mmap compatibility)
// ---------------------------------------------------------------------------

function buildSnapshotFile(heap: Uint8Array, buildId: string): Uint8Array {
  const json = '{"hiwireKeys":[],"immortalKeys":[]}';
  const jsonBytes = new TextEncoder().encode(json);
  const heapOffset = PAGE_SIZE;
  const out = new Uint8Array(heapOffset + heap.byteLength);
  const u32 = new Uint32Array(out.buffer);
  u32[0] = 0x706e7300;
  u32[1] = heapOffset;
  u32[2] = jsonBytes.byteLength;
  u32[3] = 0;
  for (let i = 0; i < 32 && i * 8 < buildId.length; i++)
    u32[4 + i] = parseInt(buildId.slice(i * 8, (i + 1) * 8), 16);
  out.set(jsonBytes, 48);
  out.subarray(heapOffset).set(heap);
  return out;
}

// ---------------------------------------------------------------------------
// FFI libraries
// ---------------------------------------------------------------------------

function openDp() {
  return Deno.dlopen("./libdirtypages.dylib", {
    dp_init: { parameters: ["pointer", "usize"], result: "i32" },
    dp_arm: { parameters: [], result: "i32" },
    dp_disarm: { parameters: [], result: "i32" },
    dp_page_size: { parameters: [], result: "usize" },
    dp_dirty_count: { parameters: [], result: "i32" },
    dp_dirty_indices: { parameters: ["buffer", "usize"], result: "i32" },
    dp_cleanup: { parameters: [], result: "void" },
  });
}

function openMh() {
  return Deno.dlopen("./libmmapheap.dylib", {
    mh_init: { parameters: ["pointer", "usize", "buffer", "usize"], result: "i32" },
    mh_sync: { parameters: [], result: "i32" },
    mh_sync_wait: { parameters: [], result: "i32" },
    mh_cleanup: { parameters: [], result: "void" },
  });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmt(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function pad(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - s.length));
}

function rpad(s: string, n: number): string {
  return " ".repeat(Math.max(0, n - s.length)) + s;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

Deno.test({
  name: "mprotect+signal vs mmap+msync",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const captured: string[] = [];

    // Boot Pyodide and load heavy packages.
    console.log("\n--- Setup ---");
    const py = await loadPyodide({
      stdout: (msg: string) => captured.push(msg),
      stderr: (msg: string) => captured.push(msg),
    });

    const builtins = ["numpy", "scipy", "sympy", "pandas"];
    for (const pkg of builtins) {
      try { await py.loadPackage(pkg, { messageCallback: () => {} }); } catch {}
    }
    py.runPython(`
for mod in ["numpy", "scipy", "sympy", "pandas"]:
    try: __import__(mod)
    except ImportError: pass
`);
    captured.length = 0;

    type EmsModule = { HEAPU8: Uint8Array };
    const emsModule = (py as unknown as { _module: EmsModule })._module;
    const heapSize = emsModule.HEAPU8.byteLength;
    const totalPages = Math.ceil(heapSize / PAGE_SIZE);
    const buildId: string = (py as unknown as { _api: { config: { BUILD_ID: string } } })
      ._api.config.BUILD_ID;

    console.log(`  Heap: ${fmt(heapSize)} (${totalPages} pages)\n`);

    // Operations to benchmark.
    const ops = [
      { label: "x = 42", code: "x = 42" },
      { label: "1 + 1", code: "1 + 1" },
      { label: "np.zeros(10k)", code: "import numpy as np; a = np.zeros(10_000)" },
      { label: "np.random.randn(100k)", code: "import numpy as np; b = np.random.randn(100_000)" },
      { label: "np.linalg.svd(100x100)", code: "import numpy as np; u,s,v = np.linalg.svd(np.random.randn(100,100))" },
      { label: "pd.DataFrame(10k)", code: "import pandas as pd; import numpy as np; df = pd.DataFrame({'a': np.arange(10000), 'b': np.random.randn(10000)})" },
      { label: "dict 50k entries", code: "big = {str(i): list(range(100)) for i in range(50_000)}" },
      { label: "pass (no-op)", code: "pass" },
    ];

    const WARMUP = 1;
    const ITERS = 5;

    function runPy(code: string) {
      captured.length = 0;
      py.globals.set("__b", code);
      py.runPython("exec(compile(__b, '<b>', 'exec'), globals())");
    }

    // =================================================================
    // Measure full save (baseline)
    // =================================================================
    const fullTimes: number[] = [];
    for (let i = 0; i < WARMUP + ITERS; i++) {
      runPy("_dummy = 1");
      const snap = buildSnapshotFile(emsModule.HEAPU8, buildId);
      const t = performance.now();
      Deno.writeFileSync(SNAP_MPROTECT, snap);
      const elapsed = performance.now() - t;
      if (i >= WARMUP) fullTimes.push(elapsed);
    }
    const fullMedian = fullTimes.sort((a, b) => a - b)[Math.floor(ITERS / 2)];

    // =================================================================
    // Measure mprotect + pwrite
    // =================================================================
    const dp = openDp();
    const heapPtr = Deno.UnsafePointer.of(emsModule.HEAPU8 as unknown as Uint8Array<ArrayBuffer>)!;

    // Write initial file for pwrite target.
    const initSnap = buildSnapshotFile(emsModule.HEAPU8, buildId);
    Deno.writeFileSync(SNAP_MPROTECT, initSnap);
    const heapFileOffset = PAGE_SIZE;

    dp.symbols.dp_init(heapPtr, BigInt(heapSize));

    interface Result {
      label: string;
      mprotectMs: number;
      mmapMs: number;
      dirtyPages: number;
    }
    const results: Result[] = [];

    for (const op of ops) {
      const times: number[] = [];

      for (let i = 0; i < WARMUP + ITERS; i++) {
        dp.symbols.dp_arm();
        runPy(op.code);

        const dirtyCount = dp.symbols.dp_dirty_count();
        const indices = new Uint32Array(dirtyCount);
        dp.symbols.dp_dirty_indices(indices, BigInt(dirtyCount));

        const t = performance.now();
        if (dirtyCount > 0) {
          const file = Deno.openSync(SNAP_MPROTECT, { write: true });
          for (let j = 0; j < dirtyCount; j++) {
            const idx = indices[j];
            const off = idx * PAGE_SIZE;
            const end = Math.min(off + PAGE_SIZE, heapSize);
            file.seekSync(heapFileOffset + off, Deno.SeekMode.Start);
            file.writeSync(emsModule.HEAPU8.subarray(off, end));
          }
          file.close();
        }
        const elapsed = performance.now() - t;
        if (i >= WARMUP) times.push(elapsed);
      }

      const lastDirty = dp.symbols.dp_dirty_count();
      // Re-arm was done at loop start; grab dirty count from last iter.
      // Actually we consumed it above. Let's just record from the last run.
      dp.symbols.dp_arm();
      runPy(op.code);
      const finalDirty = dp.symbols.dp_dirty_count();

      results.push({
        label: op.label,
        mprotectMs: times.sort((a, b) => a - b)[Math.floor(ITERS / 2)],
        mmapMs: 0, // filled in next section
        dirtyPages: finalDirty,
      });
    }

    dp.symbols.dp_disarm();
    dp.symbols.dp_cleanup();
    dp.close();

    // =================================================================
    // Measure mmap + msync
    // =================================================================
    const mh = openMh();
    const mmapSnap = buildSnapshotFile(emsModule.HEAPU8, buildId);
    Deno.writeFileSync(SNAP_MMAP, mmapSnap);

    const pathBuf = new TextEncoder().encode(SNAP_MMAP + "\0");
    const mrc = mh.symbols.mh_init(heapPtr, BigInt(heapSize), pathBuf, BigInt(PAGE_SIZE));
    assert(mrc === 0, `mh_init failed: ${mrc}`);

    for (let ri = 0; ri < results.length; ri++) {
      const op = ops[ri];
      const times: number[] = [];

      for (let i = 0; i < WARMUP + ITERS; i++) {
        runPy(op.code);

        const t = performance.now();
        mh.symbols.mh_sync_wait(); // MS_SYNC for fair timing (waits for I/O)
        const elapsed = performance.now() - t;
        if (i >= WARMUP) times.push(elapsed);
      }

      results[ri].mmapMs = times.sort((a, b) => a - b)[Math.floor(ITERS / 2)];
    }

    mh.symbols.mh_sync_wait();
    mh.symbols.mh_cleanup();
    mh.close();

    // =================================================================
    // Print results
    // =================================================================
    console.log("--- Results (median of 5 iterations) ---\n");
    console.log(
      `  ${pad("Operation", 26)} ${rpad("Dirty", 12)} ${rpad("Written", 10)} ${rpad("mprotect", 10)} ${rpad("mmap", 10)} ${rpad("speedup", 8)}`,
    );
    console.log("  " + "-".repeat(80));

    for (const r of results) {
      const written = r.dirtyPages * PAGE_SIZE;
      const speedup = r.mprotectMs > 0
        ? `${(r.mprotectMs / Math.max(r.mmapMs, 0.01)).toFixed(1)}x`
        : "-";
      console.log(
        `  ${pad(r.label, 26)} ${rpad(`${r.dirtyPages}/${totalPages}`, 12)} ${rpad(fmt(written), 10)} ${rpad(r.mprotectMs.toFixed(1) + "ms", 10)} ${rpad(r.mmapMs.toFixed(1) + "ms", 10)} ${rpad(speedup, 8)}`,
      );
    }

    console.log("  " + "-".repeat(80));
    console.log(
      `  ${pad("Full writeFile (baseline)", 26)} ${rpad(`${totalPages}/${totalPages}`, 12)} ${rpad(fmt(heapSize + PAGE_SIZE), 10)} ${rpad(fullMedian.toFixed(1) + "ms", 10)} ${rpad("-", 10)} ${rpad("-", 8)}`,
    );

    // Cleanup
    try { Deno.removeSync(SNAP_MPROTECT); } catch {}
    try { Deno.removeSync(SNAP_MMAP); } catch {}

    console.log("");
  },
});
