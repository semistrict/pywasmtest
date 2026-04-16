"""Torture test for the persistent CPython-WASI REPL.

Exercises variables, functions, classes, imports, comprehensions, error
handling, lambdas, large allocations — then restarts and verifies
everything survived via the mmap'd WASM linear memory snapshot.

Run:
    uv run pytest test_repl.py -v
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

# Import the REPL internals
from repl import WasmPython, save_snapshot_full, load_snapshot, MmapPersistence

SNAPSHOT = Path(__file__).parent / ".pywasmtest-mem.bin"


@pytest.fixture(autouse=True)
def clean_snapshot():
    """Remove snapshot before each test."""
    SNAPSHOT.unlink(missing_ok=True)
    yield
    SNAPSHOT.unlink(missing_ok=True)


@pytest.fixture
def wp():
    """A fresh WasmPython instance."""
    w = WasmPython()
    w.start()
    yield w
    w.close()


def run(wp: WasmPython, code: str) -> str:
    return wp.execute(code).strip()


# -----------------------------------------------------------------
# Session 1: build up state
# -----------------------------------------------------------------

class TestSession:
    def test_variables(self, wp):
        run(wp, "x = 42")
        run(wp, "y = 3.14")
        run(wp, 'name = "wasm"')
        run(wp, 'data = [1, 2, 3, {"nested": True}]')
        assert run(wp, "x") == "42"
        assert run(wp, "y") == "3.14"
        assert run(wp, "name") == "'wasm'"
        assert "nested" in run(wp, "data")

    def test_function(self, wp):
        run(wp, "def fib(n):\n    if n < 2: return n\n    return fib(n-1) + fib(n-2)")
        assert run(wp, "fib(10)") == "55"

    def test_class(self, wp):
        run(wp, 'class Dog:\n    def __init__(self, name): self.name = name\n    def speak(self): return f"{self.name} says woof!"')
        run(wp, 'rex = Dog("Rex")')
        assert run(wp, "rex.speak()") == "'Rex says woof!'"

    def test_imports(self, wp):
        run(wp, "import json")
        run(wp, "import math")
        assert "3.14" in run(wp, "json.dumps({'pi': math.pi})")
        assert run(wp, "math.sqrt(144)") == "12.0"

    def test_comprehensions(self, wp):
        run(wp, "squares = [i**2 for i in range(10)]")
        assert run(wp, "squares") == "[0, 1, 4, 9, 16, 25, 36, 49, 64, 81]"
        run(wp, "evens = {i for i in range(20) if i % 2 == 0}")
        assert run(wp, "len(evens)") == "10"

    def test_error_handling(self, wp):
        run(wp, "try:\n    1/0\nexcept ZeroDivisionError as e:\n    caught = str(e)")
        assert "division by zero" in run(wp, "caught")

    def test_lambda_and_map(self, wp):
        run(wp, "double = lambda x: x * 2")
        assert run(wp, "list(map(double, range(5)))") == "[0, 2, 4, 6, 8]"

    def test_large_allocation(self, wp):
        run(wp, "big = {f'key_{i}': list(range(50)) for i in range(100)}")
        assert run(wp, "len(big)") == "100"
        assert run(wp, "sum(len(v) for v in big.values())") == "5000"

    def test_syntax_error(self, wp):
        out = run(wp, "def +++")
        assert "SyntaxError" in out

    def test_runtime_error(self, wp):
        out = run(wp, "undefined_variable")
        assert "NameError" in out

    def test_multiline_string(self, wp):
        run(wp, 's = """hello\nworld\nfoo"""')
        assert run(wp, "len(s.splitlines())") == "3"

    def test_nested_functions(self, wp):
        run(wp, "def make_adder(n):\n    def adder(x): return x + n\n    return adder")
        run(wp, "add5 = make_adder(5)")
        assert run(wp, "add5(10)") == "15"

    def test_decorator(self, wp):
        run(wp, "def twice(f):\n    def wrapper(*a): return f(f(*a))\n    return wrapper")
        run(wp, "@twice\ndef inc(x): return x + 1")
        assert run(wp, "inc(0)") == "2"


# -----------------------------------------------------------------
# Snapshot + restore
# -----------------------------------------------------------------

# -----------------------------------------------------------------
# Packages: pure-Python packages installed on the host and mapped
# into the WASI sandbox via preopen_dir.
# -----------------------------------------------------------------

class TestPackages:
    def test_six(self, wp):
        run(wp, "import six")
        assert run(wp, "six.PY3") == "True"
        assert run(wp, "six.text_type.__name__") == "'str'"

    def test_attrs(self, wp):
        run(wp, "import attr")
        run(wp, "@attr.s\nclass C:\n    x = attr.ib(default=0)\n    y = attr.ib(default=0)")
        assert run(wp, "C(1, 2)") == "C(x=1, y=2)"
        assert run(wp, "C(1, 2) == C(1, 2)") == "True"
        assert run(wp, "C(1, 2) == C(1, 3)") == "False"

    def test_more_itertools(self, wp):
        run(wp, "from more_itertools import chunked, flatten")
        assert run(wp, "list(chunked(range(7), 3))") == "[[0, 1, 2], [3, 4, 5], [6]]"
        assert run(wp, "list(flatten([[1,2],[3],[4,5]]))") == "[1, 2, 3, 4, 5]"

    def test_decorator(self, wp):
        run(wp, "from decorator import decorator")
        run(wp, "@decorator\ndef trace(f, *args, **kw):\n    print(f'calling {f.__name__}')\n    return f(*args, **kw)")
        run(wp, "@trace\ndef add(a, b): return a + b")
        out = run(wp, "add(1, 2)")
        assert "calling add" in out
        assert "3" in out

    def test_pyparsing(self, wp):
        run(wp, "from pyparsing import Word, alphas, nums")
        run(wp, "greeting = Word(alphas) + Word(alphas)")
        out = run(wp, "greeting.parse_string('Hello World').as_list()")
        assert "Hello" in out
        assert "World" in out

    def test_packages_persist_across_calls(self, wp):
        """Verify that imported packages and objects built with them persist."""
        run(wp, "import attr")
        run(wp, "@attr.s\nclass Point:\n    x = attr.ib()\n    y = attr.ib()")
        run(wp, "origin = Point(0, 0)")
        # Later call — state should persist within the session.
        assert run(wp, "origin") == "Point(x=0, y=0)"
        run(wp, "from more_itertools import first")
        assert run(wp, "first([10, 20, 30])") == "10"

    def test_multiple_packages_together(self, wp):
        """Use several packages in a single computation."""
        run(wp, "import six")
        run(wp, "from more_itertools import chunked")
        run(wp, "import json")
        run(wp, "result = json.dumps({six.text_type(i): chunk for i, chunk in enumerate(chunked(range(9), 3))})")
        out = run(wp, "result")
        assert '"0": [0, 1, 2]' in out


# -----------------------------------------------------------------
# Snapshot + restore
# -----------------------------------------------------------------

class TestPersistence:
    def test_snapshot_roundtrip(self, wp):
        """Save a snapshot and verify the file is non-empty."""
        run(wp, "x = 42")
        data = wp.snapshot_memory()
        assert len(data) > 1_000_000  # should be several MB
        save_snapshot_full(data)
        assert SNAPSHOT.exists()
        loaded = load_snapshot()
        assert loaded is not None
        assert len(loaded) == len(data)
        # The bytes should match what we saved.
        assert loaded == data

    def test_mmap_within_session(self, wp):
        """mmap the live WASM memory — writes persist to disk via msync."""
        run(wp, "a = 111")
        assert run(wp, "a") == "111"

        # Full save creates the file, then mmap replaces the backing.
        save_snapshot_full(wp.snapshot_memory())
        mm = MmapPersistence(wp.get_memory_ptr(), wp.get_memory_len())

        # Further execution writes go through the mmap'd pages.
        run(wp, "b = 222")
        run(wp, "c = a + b")
        assert run(wp, "c") == "333"

        # msync flushes dirty pages to disk.
        mm.sync_wait()

        # Read the file back and verify it contains the updated memory.
        updated = load_snapshot()
        assert updated is not None

        # The snapshot on disk should match the live WASM memory.
        live = wp.snapshot_memory()
        assert updated == live

        mm.cleanup()
