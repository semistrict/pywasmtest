/*
 * mmap_heap.c — replace the WASM linear memory's anonymous mapping with
 *               a file-backed MAP_SHARED mapping so writes go to disk
 *               automatically.  msync() is the only explicit I/O needed.
 */

#include <fcntl.h>
#include <sys/mman.h>
#include <unistd.h>
#include <stddef.h>

static int   mh_fd   = -1;
static void *mh_addr = NULL;
static size_t mh_len = 0;

/*
 * Replace the anonymous mapping at `addr` with a file-backed one.
 * The file at `path` must already be >= offset+len bytes.
 * `offset` must be page-aligned.
 */
int mh_init(void *addr, size_t len, const char *path, size_t offset) {
    int fd = open(path, O_RDWR);
    if (fd < 0) return -1;

    void *p = mmap(addr, len, PROT_READ | PROT_WRITE,
                   MAP_FIXED | MAP_SHARED, fd, (off_t)offset);
    if (p == MAP_FAILED) {
        close(fd);
        return -1;
    }

    mh_fd   = fd;
    mh_addr = addr;
    mh_len  = len;
    return 0;
}

/* Async flush — tells the kernel to start writing dirty pages. */
int mh_sync(void) {
    if (!mh_addr) return -1;
    return msync(mh_addr, mh_len, MS_ASYNC);
}

/* Blocking flush — waits until all dirty pages are on disk. */
int mh_sync_wait(void) {
    if (!mh_addr) return -1;
    return msync(mh_addr, mh_len, MS_SYNC);
}

void mh_cleanup(void) {
    /* Swap back to anonymous so V8 doesn't write to the file after us. */
    if (mh_addr)
        mmap(mh_addr, mh_len, PROT_READ | PROT_WRITE,
             MAP_FIXED | MAP_PRIVATE | MAP_ANON, -1, 0);
    if (mh_fd >= 0) close(mh_fd);
    mh_fd   = -1;
    mh_addr = NULL;
    mh_len  = 0;
}
