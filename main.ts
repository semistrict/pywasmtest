import "./polyfill.ts";
import { loadPyodide, type PyodideInterface } from "pyodide";

const {
  LIBC, PAGE_SIZE, PROT_READ, PROT_WRITE, MAP_FIXED, MAP_SHARED,
  MAP_PRIVATE, MAP_ANON, O_RDWR, MS_ASYNC, MS_SYNC,
} = await import(`./constants_${Deno.build.os}.ts`);

const SNAPSHOT_PATH = "./.pywasmtest-mem.bin";

// ---------------------------------------------------------------------------
// Pyodide snapshot file helpers
//
// Format: [header padded to PAGE_SIZE] [raw HEAPU8]
// ---------------------------------------------------------------------------
function padSnapshotToPage(snap: Uint8Array): Uint8Array {
  const u32 = new Uint32Array(snap.buffer, snap.byteOffset, 4);
  const origOffset = u32[1];
  const headerBytes = snap.subarray(0, origOffset);
  const heapBytes = snap.subarray(origOffset);

  const out = new Uint8Array(PAGE_SIZE + heapBytes.byteLength);
  out.set(headerBytes);
  const outU32 = new Uint32Array(out.buffer);
  outU32[1] = PAGE_SIZE;
  out.subarray(PAGE_SIZE).set(heapBytes);
  return out;
}

// ---------------------------------------------------------------------------
// stdout / stderr capture
// ---------------------------------------------------------------------------
const captured: string[] = [];

// ---------------------------------------------------------------------------
// Boot Pyodide
// ---------------------------------------------------------------------------
const snapshotData = await Deno.readFile(SNAPSHOT_PATH).catch(() => null);

const loadOptions: Record<string, unknown> = {
  stdout: (line: string) => captured.push(line),
  stderr: (line: string) => captured.push(line),
  _makeSnapshot: true,
};
if (snapshotData) {
  loadOptions._loadSnapshot = snapshotData;
}

const pyodide: PyodideInterface = await loadPyodide(
  loadOptions as Parameters<typeof loadPyodide>[0],
);
captured.length = 0;

// ---------------------------------------------------------------------------
// Python-side REPL helpers
// ---------------------------------------------------------------------------
pyodide.runPython(`
import sys
import traceback
from codeop import CommandCompiler as _CC

_repl_cc = _CC()

def _repl_check(source):
    try:
        code = _repl_cc(source, "<stdin>")
        return "incomplete" if code is None else "complete"
    except SyntaxError:
        return "complete"

def _repl_run(source):
    try:
        code = compile(source, "<stdin>", "single")
        exec(code, globals())
    except SystemExit:
        raise
    except:
        etype, value, tb = sys.exc_info()
        traceback.print_exception(etype, value, tb.tb_next if tb else tb)
`);
captured.length = 0;

// ---------------------------------------------------------------------------
// Memory-mapped persistence via libc directly (no custom C library)
//
// After the first full save we mmap the snapshot file over the WASM
// linear memory (MAP_FIXED | MAP_SHARED).  Every WASM write goes
// straight to the page cache.  Saving = msync().
// ---------------------------------------------------------------------------
const libc = Deno.dlopen(LIBC, {
  mmap: {
    parameters: ["pointer", "usize", "i32", "i32", "i32", "usize"],
    result: "pointer",
  },
  msync: { parameters: ["pointer", "usize", "i32"], result: "i32" },
  open: { parameters: ["buffer", "i32"], result: "i32" },
  close: { parameters: ["i32"], result: "i32" },
});

const MAP_FAILED = Deno.UnsafePointer.create(BigInt("0xFFFFFFFFFFFFFFFF"));

type EmsModule = { HEAPU8: Uint8Array };
const emsModule = (pyodide as unknown as { _module: EmsModule })._module;

let mmapPtr: Deno.PointerValue = null;
let mmapLen = 0;
let mmapFd = -1;

function initMmap(): void {
  const heap = emsModule.HEAPU8;
  const addr = Deno.UnsafePointer.of(
    heap as unknown as Uint8Array<ArrayBuffer>,
  )!;
  const pathBuf = new TextEncoder().encode(SNAPSHOT_PATH + "\0");

  const fd = libc.symbols.open(pathBuf, O_RDWR);
  if (fd < 0) throw new Error(`open failed (fd=${fd})`);

  const ptr = libc.symbols.mmap(
    addr,
    BigInt(heap.byteLength),
    PROT_READ | PROT_WRITE,
    MAP_FIXED | MAP_SHARED,
    fd,
    BigInt(PAGE_SIZE), // heap starts one page into the file
  );
  if (ptr === MAP_FAILED) {
    libc.symbols.close(fd);
    throw new Error("mmap MAP_FIXED failed");
  }

  mmapPtr = ptr;
  mmapLen = heap.byteLength;
  mmapFd = fd;
}

function mmapSync(flags: number): void {
  if (mmapPtr) {
    libc.symbols.msync(mmapPtr, BigInt(mmapLen), flags);
  }
}

function mmapCleanup(): void {
  if (mmapPtr) {
    // Swap back to anonymous so V8 doesn't write to the file after us.
    libc.symbols.mmap(
      mmapPtr,
      BigInt(mmapLen),
      PROT_READ | PROT_WRITE,
      MAP_FIXED | MAP_PRIVATE | MAP_ANON,
      -1,
      BigInt(0),
    );
  }
  if (mmapFd >= 0) libc.symbols.close(mmapFd);
  mmapPtr = null;
  mmapLen = 0;
  mmapFd = -1;
}

function saveSnapshot(): void {
  if (mmapPtr) {
    mmapSync(MS_ASYNC);
    return;
  }

  // First save — proper Pyodide snapshot, re-padded so the heap starts
  // at a page boundary.
  const raw = (
    pyodide as unknown as { makeMemorySnapshot(): Uint8Array }
  ).makeMemorySnapshot();
  const padded = padSnapshotToPage(raw);
  Deno.writeFileSync(SNAPSHOT_PATH, padded);
  initMmap();
}

// If we restored from a snapshot, the file exists and heap matches — mmap now.
if (snapshotData) {
  initMmap();
}

// ---------------------------------------------------------------------------
// Terminal I/O
// ---------------------------------------------------------------------------
const encoder = new TextEncoder();

function write(text: string): void {
  Deno.stdout.writeSync(encoder.encode(text));
}

async function* readLines(): AsyncGenerator<string> {
  const buf = new Uint8Array(4096);
  const decoder = new TextDecoder();
  let remainder = "";

  while (true) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;
    const chunk = remainder + decoder.decode(buf.subarray(0, n));
    const parts = chunk.split("\n");
    remainder = parts.pop()!;
    for (const line of parts) yield line;
  }
  if (remainder.length > 0) yield remainder;
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------
const version = pyodide.runPython("sys.version");
write(`Python ${version}\n`);
write(`[Pyodide ${pyodide.version} · Deno ${Deno.version.deno}]\n`);
if (snapshotData) write("(restored from snapshot)\n");
write(`Type "exit()" to leave.\n`);

// ---------------------------------------------------------------------------
// REPL loop
// ---------------------------------------------------------------------------
let buffer = "";
write(">>> ");

for await (const line of readLines()) {
  if (buffer === "" && /^\s*(exit|quit)\s*\(\s*\)\s*$/.test(line)) {
    break;
  }

  buffer = buffer === "" ? line : buffer + "\n" + line;

  pyodide.globals.set("__src__", buffer);
  const status: string = pyodide.runPython("_repl_check(__src__)");

  if (status === "incomplete") {
    write("... ");
    continue;
  }

  captured.length = 0;
  let shouldExit = false;

  try {
    pyodide.runPython("_repl_run(__src__)");
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("SystemExit")) {
      shouldExit = true;
    }
  }

  if (captured.length > 0) {
    write(captured.join("\n") + "\n");
  }

  if (shouldExit) break;

  saveSnapshot();

  buffer = "";
  write(">>> ");
}

// Final sync + cleanup.
mmapSync(MS_SYNC);
mmapCleanup();
libc.close();
write("\n");
