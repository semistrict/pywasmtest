/**
 * Pyodide worker — accepts JSON commands over stdin, runs Python code
 * in a persistent Pyodide instance, and mmaps the WASM memory to disk.
 *
 * Protocol (newline-delimited JSON):
 *   → {"type":"exec","code":"..."}   — execute code, return output
 *   → {"type":"check","code":"..."}  — check if code is complete/incomplete
 *   → {"type":"snapshot"}            — msync the mmap'd memory
 *   ← {"type":"result","output":"..."}
 *   ← {"type":"status","status":"complete"|"incomplete"}
 *   ← {"type":"ok"}
 *   ← {"type":"error","message":"..."}
 */

import "../polyfill.ts";
import { loadPyodide, type PyodideInterface } from "pyodide";

const SNAPSHOT_PATH = ".pywasmtest-mem.bin";

const {
  LIBC, PAGE_SIZE, PROT_READ, PROT_WRITE, MAP_FIXED, MAP_SHARED,
  MAP_PRIVATE, MAP_ANON, O_RDWR, MS_ASYNC, MS_SYNC,
} = await import(`../constants_${Deno.build.os}.ts`);

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

function padSnapshotToPage(snap: Uint8Array): Uint8Array {
  const u32 = new Uint32Array(snap.buffer, snap.byteOffset, 4);
  const origOffset = u32[1];
  const headerBytes = snap.subarray(0, origOffset);
  const heapBytes = snap.subarray(origOffset);
  const out = new Uint8Array(PAGE_SIZE + heapBytes.byteLength);
  out.set(headerBytes);
  new Uint32Array(out.buffer)[1] = PAGE_SIZE;
  out.subarray(PAGE_SIZE).set(heapBytes);
  return out;
}

// ---------------------------------------------------------------------------
// libc FFI
// ---------------------------------------------------------------------------

const libc = Deno.dlopen(LIBC, {
  mmap: { parameters: ["pointer", "usize", "i32", "i32", "i32", "usize"], result: "pointer" },
  msync: { parameters: ["pointer", "usize", "i32"], result: "i32" },
  open: { parameters: ["buffer", "i32"], result: "i32" },
  close: { parameters: ["i32"], result: "i32" },
});

const MAP_FAILED = Deno.UnsafePointer.create(BigInt("0xFFFFFFFFFFFFFFFF"));

// ---------------------------------------------------------------------------
// Boot Pyodide
// ---------------------------------------------------------------------------

const captured: string[] = [];
const snapshotData = await Deno.readFile(SNAPSHOT_PATH).catch(() => null);

const loadOptions: Record<string, unknown> = {
  stdout: (line: string) => captured.push(line),
  stderr: (line: string) => captured.push(line),
  _makeSnapshot: true,
};
if (snapshotData) loadOptions._loadSnapshot = snapshotData;

const pyodide: PyodideInterface = await loadPyodide(
  loadOptions as Parameters<typeof loadPyodide>[0],
);
captured.length = 0;

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
// mmap persistence
// ---------------------------------------------------------------------------

type EmsModule = { HEAPU8: Uint8Array };
const emsModule = (pyodide as unknown as { _module: EmsModule })._module;

let mmapPtr: Deno.PointerValue = null;
let mmapLen = 0;
let mmapFd = -1;

function initMmap(): void {
  const heap = emsModule.HEAPU8;
  const addr = Deno.UnsafePointer.of(heap as unknown as Uint8Array<ArrayBuffer>)!;
  const pathBuf = new TextEncoder().encode(SNAPSHOT_PATH + "\0");
  const fd = libc.symbols.open(pathBuf, O_RDWR);
  if (fd < 0) throw new Error(`open failed (fd=${fd})`);
  const ptr = libc.symbols.mmap(addr, BigInt(heap.byteLength), PROT_READ | PROT_WRITE,
    MAP_FIXED | MAP_SHARED, fd, BigInt(PAGE_SIZE));
  if (ptr === MAP_FAILED) { libc.symbols.close(fd); throw new Error("mmap failed"); }
  mmapPtr = ptr;
  mmapLen = heap.byteLength;
  mmapFd = fd;
}

function doSnapshot(): void {
  if (mmapPtr) {
    libc.symbols.msync(mmapPtr, BigInt(mmapLen), MS_ASYNC);
    return;
  }
  const raw = (pyodide as unknown as { makeMemorySnapshot(): Uint8Array }).makeMemorySnapshot();
  Deno.writeFileSync(SNAPSHOT_PATH, padSnapshotToPage(raw));
  initMmap();
}

if (snapshotData) initMmap();

// ---------------------------------------------------------------------------
// Send ready + version info
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
function send(obj: Record<string, unknown>): void {
  Deno.stdout.writeSync(enc.encode(JSON.stringify(obj) + "\n"));
}

send({
  type: "ready",
  version: pyodide.runPython("sys.version"),
  pyodideVersion: pyodide.version,
  restored: !!snapshotData,
});

// ---------------------------------------------------------------------------
// Command loop
// ---------------------------------------------------------------------------

const buf = new Uint8Array(65536);
const decoder = new TextDecoder();
let remainder = "";

while (true) {
  const n = await Deno.stdin.read(buf);
  if (n === null) break;

  const chunk = remainder + decoder.decode(buf.subarray(0, n));
  const lines = chunk.split("\n");
  remainder = lines.pop()!;

  for (const line of lines) {
    if (!line.trim()) continue;
    let cmd: { type: string; code?: string };
    try {
      cmd = JSON.parse(line);
    } catch {
      send({ type: "error", message: "invalid JSON" });
      continue;
    }

    if (cmd.type === "check" && cmd.code !== undefined) {
      pyodide.globals.set("__src__", cmd.code);
      const status: string = pyodide.runPython("_repl_check(__src__)");
      send({ type: "status", status });
    } else if (cmd.type === "exec" && cmd.code !== undefined) {
      captured.length = 0;
      pyodide.globals.set("__src__", cmd.code);
      try {
        pyodide.runPython("_repl_run(__src__)");
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes("SystemExit")) {
          send({ type: "exit" });
          break;
        }
      }
      send({ type: "result", output: captured.join("\n") });
    } else if (cmd.type === "snapshot") {
      doSnapshot();
      send({ type: "ok" });
    } else if (cmd.type === "quit") {
      break;
    } else {
      send({ type: "error", message: `unknown command: ${cmd.type}` });
    }
  }
}

// Cleanup
if (mmapPtr) {
  libc.symbols.msync(mmapPtr, BigInt(mmapLen), MS_SYNC);
  libc.symbols.mmap(mmapPtr, BigInt(mmapLen), PROT_READ | PROT_WRITE,
    MAP_FIXED | MAP_PRIVATE | MAP_ANON, -1, BigInt(0));
  libc.symbols.close(mmapFd);
}
libc.close();
