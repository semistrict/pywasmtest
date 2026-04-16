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

.PHONY: all clean test-mmap
