all: constants_$(shell uname -s | tr A-Z a-z).ts

constants_darwin.ts: print_constants.c
	$(CC) -o print_constants print_constants.c
	./print_constants > $@
	rm -f print_constants

constants_linux.ts: print_constants.c
	$(CC) -o print_constants print_constants.c
	./print_constants > $@
	rm -f print_constants

clean:
	rm -f print_constants constants_darwin.ts constants_linux.ts

test-mmap:
	deno task build
	deno test --allow-read=node_modules,. --allow-write=. --allow-net --allow-ffi mprotect_vs_mmap_test.ts

test-mmap-ffi:
	deno run --allow-read=node_modules,. --allow-write=. --allow-net --allow-ffi --allow-run mmap_heap_ffi_test.mjs

demo-time-travel:
	deno run --allow-read=node_modules,. --allow-write=. --allow-net --allow-ffi --allow-run mmap_heap_ffi_test.mjs

docker-test-mmap-ffi-xfs:
	DOCKER_HOST=$${DOCKER_HOST:-unix://$${HOME}/.docker/run/docker.sock} docker build -t pywasmtest-xfs .
	DOCKER_HOST=$${DOCKER_HOST:-unix://$${HOME}/.docker/run/docker.sock} docker run --rm --privileged pywasmtest-xfs

test-repl:
	cd python && uv run pytest test_repl.py -v

.PHONY: all clean test-mmap test-mmap-ffi demo-time-travel docker-test-mmap-ffi-xfs test-repl
