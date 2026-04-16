FROM denoland/deno:2.7.12

RUN apt-get update && apt-get install -y gcc make && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY print_constants.c Makefile ./
RUN make

COPY deno.json polyfill.ts main.ts ./
RUN deno install

CMD ["sh", "-c", "printf 'x = 42\\nx * 2\\nexit()\\n' | deno task repl && printf 'x\\nexit()\\n' | deno task repl"]
