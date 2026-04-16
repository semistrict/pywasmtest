FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen

COPY repl.py ./

CMD ["sh", "-c", "printf 'x = 42\\nx * 2\\nexit()\\n' | uv run repl.py && printf 'x\\nexit()\\n' | uv run repl.py"]
