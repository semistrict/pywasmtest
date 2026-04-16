FROM denoland/deno:2.7.12

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    make \
    xfsprogs \
    util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .
RUN deno cache mmap_heap_ffi_test.mjs

RUN printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  '' \
  'IMG=/tmp/pywasmtest-xfs.img' \
  'MNT=/mnt/xfs' \
  'WORK=$MNT/work' \
  '' \
  'truncate -s 2G "$IMG"' \
  'mkfs.xfs -f "$IMG" >/dev/null' \
  'mkdir -p "$MNT" "$WORK"' \
  'mount -o loop "$IMG" "$MNT"' \
  'cleanup() {' \
  '  umount "$MNT" || true' \
  '  rm -f "$IMG"' \
  '}' \
  'trap cleanup EXIT' \
  '' \
  'cp -a /src/. "$WORK/"' \
  'cd "$WORK"' \
  'make test-mmap-ffi' \
  > /usr/local/bin/run-xfs-demo.sh \
  && chmod +x /usr/local/bin/run-xfs-demo.sh

CMD ["/usr/local/bin/run-xfs-demo.sh"]
