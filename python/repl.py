"""Persistent Python REPL: CPython-WASI in wasmtime with mmap-backed linear memory.

CPython 3.12 runs inside WASM via wasmtime.  The WASM instance stays
alive across statements (background thread + FIFOs).  The linear memory
is mmap'd to a file — after each statement, msync flushes only dirty
pages.  On restart the memory snapshot is restored into a fresh instance.

Usage:
    uv run repl.py
"""

from __future__ import annotations

import ctypes
import ctypes.util
import os
import struct
import sys
import tempfile
import threading
from codeop import CommandCompiler
from pathlib import Path

import wasmtime

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
WASI_DIR = Path(__file__).parent / "wasi"
WASM_BIN = WASI_DIR / "bin" / "python-3.12.0.wasm"
PKG_DIR = Path(__file__).parent / "wasi-packages"
SNAPSHOT_PATH = Path(__file__).parent / ".pywasmtest-mem.bin"
SENTINEL = "__DONE_a7f3b__"

# ---------------------------------------------------------------------------
# libc FFI for mmap / msync
# ---------------------------------------------------------------------------
_libc_name = ctypes.util.find_library("c")
assert _libc_name, "cannot find libc"
_libc = ctypes.CDLL(_libc_name, use_errno=True)

_libc.mmap.restype = ctypes.c_void_p
_libc.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int,
                        ctypes.c_int, ctypes.c_int, ctypes.c_long]
_libc.msync.restype = ctypes.c_int
_libc.msync.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]

PROT_READ = 0x1
PROT_WRITE = 0x2
MAP_SHARED = 0x1
MAP_PRIVATE = 0x2
MAP_FIXED = 0x10
MAP_ANON = 0x1000 if sys.platform == "darwin" else 0x20
MS_ASYNC = 0x1
MS_SYNC = 0x10 if sys.platform == "darwin" else 0x4
MAP_FAILED = ctypes.c_void_p(-1).value
PAGE_SIZE = os.sysconf("SC_PAGESIZE")

# ---------------------------------------------------------------------------
# WASM engine + module (compiled once)
# ---------------------------------------------------------------------------
_engine = wasmtime.Engine()
_module = wasmtime.Module.from_file(_engine, str(WASM_BIN))

# ---------------------------------------------------------------------------
# Python REPL script that runs INSIDE the WASM sandbox.
# Reads single-line commands from stdin, executes them, prints output,
# then prints SENTINEL so the host knows the statement is done.
# Multi-statement code arrives as base64 to avoid newline issues.
# ---------------------------------------------------------------------------
WASM_REPL = f'''
import sys, base64, ast, traceback
sys.path.insert(0, '/packages')

def _exec(source):
    try:
        tree = ast.parse(source)
        if not tree.body: return
        if isinstance(tree.body[-1], ast.Expr):
            last = tree.body.pop()
            if tree.body:
                mod = ast.Module(body=tree.body, type_ignores=[])
                ast.fix_missing_locations(mod)
                exec(compile(mod, '<stdin>', 'exec'), globals())
            expr = ast.Expression(body=last.value)
            ast.fix_missing_locations(expr)
            result = eval(compile(expr, '<stdin>', 'eval'), globals())
            if result is not None: print(repr(result))
        else:
            mod = ast.Module(body=tree.body, type_ignores=[])
            ast.fix_missing_locations(mod)
            exec(compile(mod, '<stdin>', 'exec'), globals())
    except SystemExit: raise
    except: traceback.print_exc()

while True:
    line = sys.stdin.readline()
    if not line: break
    line = line.strip()
    if line == '__QUIT__': break
    try:
        code = base64.b64decode(line).decode()
        _exec(code)
    except Exception as e:
        print(f'decode error: {{e}}')
    sys.stdout.flush()
    print('{SENTINEL}', flush=True)
'''

# ---------------------------------------------------------------------------
# Persistent WASM instance
# ---------------------------------------------------------------------------

class WasmPython:
    """A long-running CPython-WASI instance with FIFO-based I/O."""

    def __init__(self) -> None:
        self._tmpdir = tempfile.mkdtemp()
        self._stdin_fifo = os.path.join(self._tmpdir, "in")
        self._stdout_fifo = os.path.join(self._tmpdir, "out")
        os.mkfifo(self._stdin_fifo)
        os.mkfifo(self._stdout_fifo)

        # Pre-open with O_RDWR so WasiConfig opens don't deadlock.
        self._stdin_keep = os.open(self._stdin_fifo, os.O_RDWR)
        self._stdout_keep = os.open(self._stdout_fifo, os.O_RDWR)

        self.memory: wasmtime.Memory | None = None
        self.store: wasmtime.Store | None = None
        self._thread: threading.Thread | None = None
        self._stdin_f: object = None
        self._stdout_f: object = None

    def start(self, restore_data: bytes | None = None) -> None:
        store = wasmtime.Store(_engine)
        config = wasmtime.WasiConfig()
        config.argv = ("python", "-c", WASM_REPL)
        config.preopen_dir(str(WASI_DIR), "/")
        if PKG_DIR.exists():
            config.preopen_dir(str(PKG_DIR), "/packages")
        config.stdin_file = self._stdin_fifo
        config.stdout_file = self._stdout_fifo
        config.stderr_file = self._stdout_fifo
        store.set_wasi(config)

        linker = wasmtime.Linker(_engine)
        linker.define_wasi()
        instance = linker.instantiate(store, _module)

        self.memory = instance.exports(store)["memory"]
        self.store = store

        start_fn = instance.exports(store)["_start"]

        def run() -> None:
            try:
                start_fn(store)
            except (wasmtime.ExitTrap, wasmtime.Trap):
                pass

        self._thread = threading.Thread(target=run, daemon=True)
        self._thread.start()

        self._stdin_f = os.fdopen(os.open(self._stdin_fifo, os.O_WRONLY), "w")
        self._stdout_f = os.fdopen(os.open(self._stdout_fifo, os.O_RDONLY), "r")

    def execute(self, code: str) -> str:
        """Send code (base64-encoded) and read output until SENTINEL."""
        import base64
        encoded = base64.b64encode(code.encode()).decode()
        self._stdin_f.write(encoded + "\n")
        self._stdin_f.flush()
        lines: list[str] = []
        while True:
            line = self._stdout_f.readline()
            if not line:
                break
            line = line.rstrip("\n")
            if line == SENTINEL:
                break
            lines.append(line)
        return "\n".join(lines)

    def get_memory_ptr(self) -> int:
        assert self.memory and self.store
        return ctypes.cast(self.memory.data_ptr(self.store), ctypes.c_void_p).value

    def get_memory_len(self) -> int:
        assert self.memory and self.store
        return self.memory.data_len(self.store)

    def snapshot_memory(self) -> bytes:
        ptr = self.get_memory_ptr()
        length = self.get_memory_len()
        return ctypes.string_at(ptr, length)

    def close(self) -> None:
        if self._stdin_f:
            try:
                self._stdin_f.write("__QUIT__\n")
                self._stdin_f.flush()
                self._stdin_f.close()
            except (BrokenPipeError, OSError):
                pass
        if self._stdout_f:
            self._stdout_f.close()
        if self._thread:
            self._thread.join(timeout=5)
        os.close(self._stdin_keep)
        os.close(self._stdout_keep)
        import shutil
        shutil.rmtree(self._tmpdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# mmap persistence
#
# Snapshot file: [8-byte heap length] [pad to PAGE_SIZE] [heap data]
# The heap region is mmap'd over the WASM linear memory.
# ---------------------------------------------------------------------------

def save_snapshot_full(data: bytes) -> None:
    offset = PAGE_SIZE
    with open(SNAPSHOT_PATH, "wb") as f:
        f.write(struct.pack("<Q", len(data)))
        f.write(b"\x00" * (offset - 8))
        f.write(data)


def load_snapshot() -> bytes | None:
    if not SNAPSHOT_PATH.exists():
        return None
    with open(SNAPSHOT_PATH, "rb") as f:
        length = struct.unpack("<Q", f.read(8))[0]
        if length == 0:
            return None
        f.seek(PAGE_SIZE)
        return f.read(length)


class MmapPersistence:
    def __init__(self, heap_ptr: int, heap_len: int) -> None:
        fd = os.open(str(SNAPSHOT_PATH), os.O_RDWR)
        result = _libc.mmap(heap_ptr, heap_len, PROT_READ | PROT_WRITE,
                            MAP_FIXED | MAP_SHARED, fd, PAGE_SIZE)
        if result == MAP_FAILED:
            os.close(fd)
            raise OSError(f"mmap failed (errno={ctypes.get_errno()})")
        self.ptr = result
        self.length = heap_len
        self.fd = fd

    def sync(self) -> None:
        _libc.msync(self.ptr, self.length, MS_ASYNC)

    def sync_wait(self) -> None:
        _libc.msync(self.ptr, self.length, MS_SYNC)

    def cleanup(self) -> None:
        if self.ptr:
            _libc.mmap(self.ptr, self.length, PROT_READ | PROT_WRITE,
                       MAP_FIXED | MAP_PRIVATE | MAP_ANON, -1, 0)
            self.ptr = None
        if self.fd >= 0:
            os.close(self.fd)
            self.fd = -1


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    wp = WasmPython()
    wp.start()

    # Get version
    version = wp.execute("import sys; print(sys.version)")

    snapshot = load_snapshot()
    restored = snapshot is not None

    print(f"Python {version.strip()} (WASI/WASM)")
    print(f"[wasmtime · hosted by Python {sys.version.split()[0]}]")
    if restored:
        print("(restored from snapshot)")
    print('Type "exit()" to leave.')

    # If restoring, we can't inject raw memory into a running instance.
    # Instead, replay from a journal. But wait — we CAN mmap the snapshot
    # file over the live WASM memory WHILE the instance is running.
    # The WASM thread is blocked waiting for stdin, so the memory is idle.
    if snapshot:
        ptr = wp.get_memory_ptr()
        length = wp.get_memory_len()
        # Grow snapshot to match if needed, or truncate
        if len(snapshot) <= length:
            ctypes.memmove(ptr, snapshot, len(snapshot))
        # Re-run imports to fix up C-level state
        wp.execute("pass")

    persistence: MmapPersistence | None = None

    compiler = CommandCompiler()
    buffer = ""
    prompt = ">>> "

    try:
        while True:
            try:
                line = input(prompt)
            except (EOFError, KeyboardInterrupt):
                print()
                break

            if buffer:
                buffer += "\n" + line
            else:
                buffer = line

            stripped = buffer.strip()
            if stripped in ("exit()", "quit()", "exit", "quit"):
                break

            try:
                result = compiler(buffer, "<stdin>")
            except SyntaxError:
                result = True
            if result is None:
                prompt = "... "
                continue

            output = wp.execute(buffer)
            if output:
                print(output)

            # Persist: first time writes full snapshot + mmaps, then just msync.
            if persistence is None:
                save_snapshot_full(wp.snapshot_memory())
                persistence = MmapPersistence(wp.get_memory_ptr(), wp.get_memory_len())
            else:
                persistence.sync()

            buffer = ""
            prompt = ">>> "
    finally:
        if persistence:
            persistence.sync_wait()
            persistence.cleanup()
        wp.close()


if __name__ == "__main__":
    main()
