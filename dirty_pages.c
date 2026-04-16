/*
 * dirty_pages.c — mprotect-based dirty page tracker
 *
 * After dp_arm(), all pages in the tracked region are marked read-only.
 * Writes fault into the signal handler which flips the page back to R/W
 * and sets a bit in a bitmap.  The caller can then query which pages
 * changed and write only those to disk.
 *
 * macOS delivers mprotect write-faults as SIGBUS; Linux uses SIGSEGV.
 */

#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static void        *dp_base;
static size_t       dp_len;
static size_t       dp_page_sz;
static size_t       dp_n_pages;
static uint8_t     *dp_bitmap;      /* 1 bit per page */
static int          dp_armed;
static struct sigaction dp_prev;

/* ------------------------------------------------------------------ */
/* Signal handler                                                      */
/* ------------------------------------------------------------------ */

static void dp_fault(int sig, siginfo_t *si, void *ctx) {
    uintptr_t addr = (uintptr_t)si->si_addr;
    uintptr_t lo   = (uintptr_t)dp_base;
    uintptr_t hi   = lo + dp_len;

    if (dp_armed && addr >= lo && addr < hi) {
        size_t idx = (addr - lo) / dp_page_sz;
        dp_bitmap[idx >> 3] |= (uint8_t)(1u << (idx & 7));

        void *page = (char *)dp_base + idx * dp_page_sz;
        mprotect(page, dp_page_sz, PROT_READ | PROT_WRITE);
        return;
    }

    /* Not ours — chain to the previous handler (V8, etc.) */
    if (dp_prev.sa_flags & SA_SIGINFO) {
        dp_prev.sa_sigaction(sig, si, ctx);
    } else if (dp_prev.sa_handler == SIG_DFL) {
        struct sigaction dfl = { .sa_handler = SIG_DFL };
        sigemptyset(&dfl.sa_mask);
        sigaction(sig, &dfl, NULL);
        raise(sig);
    } else if (dp_prev.sa_handler != SIG_IGN) {
        dp_prev.sa_handler(sig);
    }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

int dp_init(void *base, size_t len) {
    dp_page_sz = (size_t)getpagesize();

    /* Base must be page-aligned (V8 mmap guarantees this). */
    if ((uintptr_t)base & (dp_page_sz - 1))
        return -1;

    dp_base    = base;
    dp_len     = len;
    dp_n_pages = (len + dp_page_sz - 1) / dp_page_sz;
    dp_armed   = 0;

    dp_bitmap = calloc((dp_n_pages + 7) / 8, 1);
    if (!dp_bitmap) return -1;

    struct sigaction sa = {
        .sa_sigaction = dp_fault,
        .sa_flags     = SA_SIGINFO,
    };
    sigemptyset(&sa.sa_mask);

#ifdef __APPLE__
    return sigaction(SIGBUS, &sa, &dp_prev);
#else
    return sigaction(SIGSEGV, &sa, &dp_prev);
#endif
}

int dp_arm(void) {
    if (!dp_bitmap) return -1;
    memset(dp_bitmap, 0, (dp_n_pages + 7) / 8);
    if (mprotect(dp_base, dp_len, PROT_READ) != 0) return -1;
    dp_armed = 1;
    return 0;
}

int dp_disarm(void) {
    dp_armed = 0;
    if (!dp_base) return -1;
    return mprotect(dp_base, dp_len, PROT_READ | PROT_WRITE);
}

size_t dp_page_size(void) { return dp_page_sz; }
size_t dp_num_pages(void) { return dp_n_pages; }

int dp_dirty_count(void) {
    int n = 0;
    for (size_t i = 0; i < dp_n_pages; i++)
        if (dp_bitmap[i >> 3] & (1u << (i & 7))) n++;
    return n;
}

/*
 * Fill `out` with indices of dirty pages.  Returns the number written.
 */
int dp_dirty_indices(uint32_t *out, size_t max) {
    int n = 0;
    for (size_t i = 0; i < dp_n_pages && (size_t)n < max; i++)
        if (dp_bitmap[i >> 3] & (1u << (i & 7)))
            out[n++] = (uint32_t)i;
    return n;
}

void dp_cleanup(void) {
    if (dp_armed) dp_disarm();
#ifdef __APPLE__
    sigaction(SIGBUS, &dp_prev, NULL);
#else
    sigaction(SIGSEGV, &dp_prev, NULL);
#endif
    free(dp_bitmap);
    dp_bitmap  = NULL;
    dp_base    = NULL;
    dp_len     = 0;
    dp_n_pages = 0;
    dp_armed   = 0;
}
