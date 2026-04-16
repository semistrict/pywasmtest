#!/usr/bin/env -S deno run --allow-read=node_modules,. --allow-write=. --allow-net --allow-ffi --allow-run
/**
 * Pyodide heap: file-backed mmap (libc FFI) + per-step snapshots via reflink clone.
 * Each `run()` returns a new session loaded from that snapshot (chain: s = await s.run(...)).
 * `branch()` snapshots the heap and opens a **second** interpreter from that snapshot; the first keeps running.
 *
 * macOS: clonefile(2) (no subprocess). Linux: cp --reflink=auto (needs --allow-run).
 *
 * Entry: top-level `await runForkTimeTravelDemo()` — snapshot + fork demo (no `import.meta.main`).
 *
 * Disk I/O uses `node:fs/promises` (async, Node-compatible under Deno).
 *
 * Tear down with **`await using`** (`Symbol.asyncDispose`): pass
 * `removeWorkDirOnDispose: true` on the **root** `openMmapPySession()` only.
 */
import process from "node:process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

Object.defineProperty(process, "env", { get: () => ({}) });

import { dirname, join } from "jsr:@std/path";
import { loadPyodide } from "pyodide";
import { assert } from "jsr:@std/assert";

/** Snapshot layout: fixed header, then raw HEAPU8 (matches mprotect_vs_mmap_test.ts). */
export const SNAPSHOT_HEADER_BYTES = 16 * 1024;

function platform() {
  switch (Deno.build.os) {
    case "darwin":
      return {
        libc: "/usr/lib/libSystem.B.dylib",
        protRead: 0x1,
        protWrite: 0x2,
        mapShared: 0x1,
        mapPrivate: 0x2,
        mapFixed: 0x10,
        mapAnon: 0x1000,
        oRdwr: 0x2,
        msSync: 0x10,
      };
    case "linux":
      return {
        libc: "libc.so.6",
        protRead: 0x1,
        protWrite: 0x2,
        mapShared: 0x1,
        mapPrivate: 0x2,
        mapFixed: 0x10,
        mapAnon: 0x20,
        oRdwr: 0x2,
        msSync: 0x4,
      };
    default:
      throw new Error(`unsupported OS: ${Deno.build.os}`);
  }
}

function libcSymbols() {
  const base = {
    mmap: {
      parameters: ["pointer", "usize", "i32", "i32", "i32", "usize"],
      result: "pointer",
    },
    msync: { parameters: ["pointer", "usize", "i32"], result: "i32" },
    open: { parameters: ["buffer", "i32"], result: "i32" },
    close: { parameters: ["i32"], result: "i32" },
  };
  if (Deno.build.os === "darwin") {
    return {
      ...base,
      clonefile: { parameters: ["buffer", "buffer", "i32"], result: "i32" },
    };
  }
  return base;
}

/** Minimal snapshot layout (e.g. benchmarks); Pyodide `run`/`fork` uses `snapshotBytesFromPy` instead. */
export function buildSnapshotFile(heap, buildId) {
  const json = '{"hiwireKeys":[],"immortalKeys":[]}';
  const jsonBytes = new TextEncoder().encode(json);
  const heapOffset = SNAPSHOT_HEADER_BYTES;
  const out = new Uint8Array(heapOffset + heap.byteLength);
  const u32 = new Uint32Array(out.buffer);
  u32[0] = 0x706e7300;
  u32[1] = heapOffset;
  u32[2] = jsonBytes.byteLength;
  u32[3] = 0;
  for (let i = 0; i < 32 && i * 8 < buildId.length; i++) {
    u32[4 + i] = parseInt(buildId.slice(i * 8, (i + 1) * 8), 16);
  }
  out.set(jsonBytes, 48);
  out.subarray(heapOffset).set(heap);
  return out;
}

/** Align Pyodide `makeMemorySnapshot()` so the heap starts at `SNAPSHOT_HEADER_BYTES` (mmap offset). */
function padSnapshotToPage(snap) {
  const u32 = new Uint32Array(snap.buffer, snap.byteOffset, 4);
  const origOffset = u32[1];
  const headerBytes = snap.subarray(0, origOffset);
  const heapBytes = snap.subarray(origOffset);
  const out = new Uint8Array(SNAPSHOT_HEADER_BYTES + heapBytes.byteLength);
  out.set(headerBytes);
  const outU32 = new Uint32Array(out.buffer);
  outU32[1] = SNAPSHOT_HEADER_BYTES;
  out.subarray(SNAPSHOT_HEADER_BYTES).set(heapBytes);
  return out;
}

function snapshotBytesFromPy(py) {
  return padSnapshotToPage(py.makeMemorySnapshot());
}

async function readHeapFromSnapshotPath(path) {
  const file = await readFile(path);
  const u8 = file instanceof Uint8Array ? file : new Uint8Array(file);
  assert(u8.byteLength >= SNAPSHOT_HEADER_BYTES);
  return u8.subarray(SNAPSHOT_HEADER_BYTES);
}

const MAP_FAILED = Deno.UnsafePointer.create(BigInt("0xFFFFFFFFFFFFFFFF"));

function makePyStdout() {
  return (s) => {
    if (s.length === 0) return;
    process.stdout.write(s);
    if (!s.endsWith("\n")) process.stdout.write("\n");
  };
}

async function reflinkClone(libc, src, dst) {
  await mkdir(dirname(dst), { recursive: true });
  try {
    await rm(dst, { force: true });
  } catch {
    /* destination may not exist */
  }

  if (Deno.build.os === "darwin") {
    const sbuf = new TextEncoder().encode(src + "\0");
    const dbuf = new TextEncoder().encode(dst + "\0");
    const r = libc.symbols.clonefile(sbuf, dbuf, 0);
    assert(r === 0, `clonefile(${src} -> ${dst}) failed: ${r}`);
    return;
  }

  const tryReflink = new Deno.Command("cp", {
    args: ["--reflink=auto", "--", src, dst],
  });
  const o1 = await tryReflink.output();
  if (o1.success) return;

  const plain = new Deno.Command("cp", { args: ["--", src, dst] });
  const o2 = await plain.output();
  assert(
    o2.success,
    `cp failed (reflink and plain): ${new TextDecoder().decode(o2.stderr)}`,
  );
}

/** Build a session: mmap `ctx.backingPath` over the already-initialized interpreter heap. */
function createMmapSession(ctx) {
  const {
    workDir,
    backingPath,
    branchId,
    P,
    libc,
    py,
    ems,
    clonesDir,
    pyStdout,
    removeWorkDirOnDispose = false,
  } = ctx;

  let mmapPtr = null;
  let mmapFd = -1;
  let mappedLen = 0;
  let mappedBuf = null;
  let step = 0;
  let forkSeq = 0;
  let disposed = false;

  function heapPtr() {
    return Deno.UnsafePointer.of(ems.HEAPU8);
  }

  function mmapCleanup() {
    if (mmapPtr) {
      libc.symbols.mmap(
        mmapPtr,
        BigInt(mappedLen),
        P.protRead | P.protWrite,
        P.mapFixed | P.mapPrivate | P.mapAnon,
        -1,
        BigInt(0),
      );
    }
    if (mmapFd >= 0) libc.symbols.close(mmapFd);
    mmapPtr = null;
    mmapFd = -1;
    mappedLen = 0;
    mappedBuf = null;
  }

  function mmapInitFromFile() {
    const heap = ems.HEAPU8;
    const addr = heapPtr();
    const pathBuf = new TextEncoder().encode(backingPath + "\0");
    const fd = libc.symbols.open(pathBuf, P.oRdwr);
    assert(fd >= 0, `open(${backingPath}) failed, fd=${fd}`);

    const mapped = libc.symbols.mmap(
      addr,
      BigInt(heap.byteLength),
      P.protRead | P.protWrite,
      P.mapFixed | P.mapShared,
      fd,
      BigInt(SNAPSHOT_HEADER_BYTES),
    );
    assert(mapped !== MAP_FAILED, "mmap(MAP_FIXED|MAP_SHARED) failed");

    mmapPtr = addr;
    mmapFd = fd;
    mappedLen = heap.byteLength;
    mappedBuf = heap.buffer;
  }

  async function syncHeapToBacking() {
    const heap = ems.HEAPU8;
    const grown =
      !mmapPtr || heap.byteLength !== mappedLen || heap.buffer !== mappedBuf;

    if (grown) {
      mmapCleanup();
      await writeFile(backingPath, snapshotBytesFromPy(py));
      mmapInitFromFile();
    } else {
      const rc = libc.symbols.msync(heapPtr(), BigInt(mappedLen), P.msSync);
      assert(rc === 0, `msync failed: ${rc}`);
    }
  }

  function syncMappedPagesNow() {
    const rc = libc.symbols.msync(heapPtr(), BigInt(mappedLen), P.msSync);
    assert(rc === 0, `msync failed: ${rc}`);
  }

  mmapInitFromFile();

  function disposeMmapAndLibc() {
    if (disposed) return;
    mmapCleanup();
    libc.close();
    disposed = true;
  }

  const api = {
    workDir,
    backingPath,
    branchId,

    async eval(expr) {
      assert(!disposed, "session disposed");
      py.globals.set("__mmap_eval_e", expr);
      py.runPython(
        "_mmap_eval_r = repr(eval(compile(__mmap_eval_e, '<mmap>', 'eval')))",
      );
      return String(py.globals.get("_mmap_eval_r"));
    },

    /**
     * Reflink snapshot of **right now** into another interpreter+mmap session.
     * This session keeps running on `backingPath`; the returned session is an alternate timeline.
     */
    async branch() {
      assert(!disposed, "session disposed");
      await syncHeapToBacking();
      // Explicit checkpoint barrier: clone only after all mapped writes hit the file.
      syncMappedPagesNow();
      forkSeq += 1;
      const forkName = `fork-${String(forkSeq).padStart(4, "0")}.bin`;
      const snapshotPath = join(clonesDir, forkName);
      await reflinkClone(libc, backingPath, snapshotPath);

      const live = ems.HEAPU8;
      const fromClone = await readHeapFromSnapshotPath(snapshotPath);
      assert(fromClone.length === live.length);
      assert(
        fromClone.every((b, i) => b === live[i]),
        "reflink branch heap mismatch",
      );

      const childBranchId = `${branchId}~fork${forkSeq}`;
      const childClonesDir = join(workDir, "clones", childBranchId);
      await mkdir(childClonesDir, { recursive: true });

      return forkSessionFromSnapshot({
        workDir,
        snapshotPath,
        branchId: childBranchId,
        clonesDir: childClonesDir,
        pyStdout,
      });
    },

    async run(code) {
      assert(!disposed, "session already used after run(); use the returned session or branch() first");

      const oneLine = code.trim().replaceAll("\n", "\\n");
      console.log(`[run:${branchId}] ${oneLine}`);
      py.globals.set("__mmap_run_chunk", code);
      py.runPython(
        "exec(compile(__mmap_run_chunk, '<run>', 'exec'), globals())",
      );

      await syncHeapToBacking();
      // Explicit checkpoint barrier before cloning snapshot for next session.
      syncMappedPagesNow();

      step += 1;
      const snapshotPath = join(
        clonesDir,
        `${String(step).padStart(4, "0")}.bin`,
      );
      await reflinkClone(libc, backingPath, snapshotPath);

      const live = ems.HEAPU8;
      const fromClone = await readHeapFromSnapshotPath(snapshotPath);
      assert(fromClone.length === live.length);
      assert(
        fromClone.every((b, i) => b === live[i]),
        "reflink snapshot heap mismatch",
      );

      const childBranchId = `${branchId}-${String(step).padStart(4, "0")}`;
      const childClonesDir = join(workDir, "clones", childBranchId);
      await mkdir(childClonesDir, { recursive: true });

      disposeMmapAndLibc();

      return forkSessionFromSnapshot({
        workDir,
        snapshotPath,
        branchId: childBranchId,
        clonesDir: childClonesDir,
        pyStdout,
      });
    },

    async close(opts) {
      if (!disposed) {
        mmapCleanup();
        libc.close();
        disposed = true;
      }
      if (opts?.removeWorkDir) {
        try {
          await rm(workDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    },
  };

  api[Symbol.asyncDispose] = async () => {
    await api.close({ removeWorkDir: removeWorkDirOnDispose });
  };

  return api;
}

async function forkSessionFromSnapshot({
  workDir,
  snapshotPath,
  branchId,
  clonesDir,
  pyStdout,
}) {
  const P = platform();
  const libc = Deno.dlopen(P.libc, libcSymbols());

  const snapshotRaw = await readFile(snapshotPath);
  const snapshotBytes = snapshotRaw instanceof Uint8Array
    ? snapshotRaw
    : new Uint8Array(snapshotRaw);
  const py = await loadPyodide({
    stdout: pyStdout,
    stderr: (s) => process.stderr.write(s),
    _makeSnapshot: true,
    _loadSnapshot: snapshotBytes,
  });

  const ems = py._module;

  return createMmapSession({
    workDir,
    backingPath: snapshotPath,
    branchId,
    P,
    libc,
    py,
    ems,
    clonesDir,
    pyStdout,
    removeWorkDirOnDispose: false,
  });
}

/**
 * New interpreter + mmap on `workDir/backing.bin`. Use `s = await s.run(code)` to fork.
 */
export async function openMmapPySession(options) {
  const P = platform();
  const libc = Deno.dlopen(P.libc, libcSymbols());

  const workDir = options?.workDir ?? join(Deno.cwd(), ".mmap-py-work");
  const removeWorkDirOnDispose = options?.removeWorkDirOnDispose ?? false;
  const backingPath = join(workDir, "backing.bin");
  const branchId = "root";
  const clonesDir = join(workDir, "clones", branchId);
  await mkdir(clonesDir, { recursive: true });

  const pyStdout = makePyStdout();

  const py = await loadPyodide({
    stdout: pyStdout,
    stderr: (s) => process.stderr.write(s),
    _makeSnapshot: true,
  });

  const ems = py._module;
  await writeFile(backingPath, snapshotBytesFromPy(py));

  return createMmapSession({
    workDir,
    backingPath,
    branchId,
    P,
    libc,
    py,
    ems,
    clonesDir,
    pyStdout,
    removeWorkDirOnDispose,
  });
}

/** `rel()` = ms since timer created; `startStep()` / `endStep()` = Δ ms for one operation. */
function makeTimeLog() {
  const t0 = performance.now();
  let stepStart = t0;
  return {
    rel() {
      return (performance.now() - t0).toFixed(1);
    },
    startStep() {
      stepStart = performance.now();
    },
    endStep() {
      return (performance.now() - stepStart).toFixed(1);
    },
  };
}

function demoBanner(title, tm) {
  console.log(`\n━━ ${title} — +${tm.rel()} ms ━━\n`);
}

/**
 * Demo goal:
 * 1) parent and child inherit values from before the fork,
 * 2) after fork they mutate the same variable independently,
 * 3) reads from each session differ afterward.
 */
async function runForkTimeTravelDemo() {
  const tm = makeTimeLog();
  console.log("Demo: inherit-before-fork, diverge-after-fork.\n");

  const workDir = join(Deno.cwd(), ".demo-time-travel-work");
  tm.startStep();
  await using root = await openMmapPySession({
    workDir,
    removeWorkDirOnDispose: true,
  });
  console.log(
    `  [+${tm.rel()} ms, Δ${tm.endStep()} ms] open session (mmap-backed heap)`,
  );

  let parent = root;
  demoBanner("1. Create state before fork", tm);
  tm.startStep();
  parent = await parent.run(`
value = "before-fork"
`);
  console.log(
    `  [+${tm.rel()} ms, Δ${tm.endStep()} ms] run (set value)`,
  );
  console.log(
    `  [+${tm.rel()} ms] parent value before fork:`,
    await parent.eval("value"),
  );

  demoBanner("2. Fork from snapshot", tm);
  tm.startStep();
  const child = await parent.branch();
  console.log(
    `  [+${tm.rel()} ms, Δ${tm.endStep()} ms] branch()`,
  );
  console.log(
    `  [+${tm.rel()} ms] child inherited value:`,
    await child.eval("value"),
  );

  demoBanner("3. Mutate parent and child independently", tm);
  tm.startStep();
  parent = await parent.run(`
value = "parent-after-fork"
`);
  console.log(
    `  [+${tm.rel()} ms, Δ${tm.endStep()} ms] run (parent write)`,
  );
  tm.startStep();
  let childAfter = await child.run(`
value = "child-after-fork"
`);
  console.log(
    `  [+${tm.rel()} ms, Δ${tm.endStep()} ms] run (child write)`,
  );

  demoBanner("4. Read both values", tm);
  const parentValue = await parent.eval("value");
  const childValue = await childAfter.eval("value");
  console.log(
    `  [+${tm.rel()} ms] parent value:`,
    parentValue,
  );
  console.log(
    `  [+${tm.rel()} ms] child value:`,
    childValue,
  );
  console.log(
    `  [+${tm.rel()} ms] diverged after fork:`,
    parentValue !== childValue,
  );

  console.log(
    `\nDone. Inherited before fork, changed independently after fork. Total +${tm.rel()} ms\n`,
  );
}

await runForkTimeTravelDemo();
