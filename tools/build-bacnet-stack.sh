#!/bin/sh
# Builds the two bacnet-stack programs HEAPY Edge uses, from a pinned release:
#   bin/router-mstp   MS/TP <-> BACnet/IP router (the box side of the MS/TP driver)
#   bin/bacserv-mstp  MS/TP test device (simulator only)
# bacnet-stack: GPL-2.0-or-later WITH GCC-exception-2.0 / MIT, used as separate programs.
set -e
TAG=${BACNET_STACK_TAG:-bacnet-stack-1.6.1}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC=${BACNET_STACK_SRC:-/tmp/bacnet-stack-$TAG}
mkdir -p "$ROOT/bin"
[ -d "$SRC" ] || git clone -q --depth 1 --branch "$TAG" https://github.com/bacnet-stack/bacnet-stack.git "$SRC"
cd "$SRC"
make -s clean >/dev/null 2>&1 || true
make -s BACDL=mstp server >/dev/null
cp bin/bacserv "$ROOT/bin/bacserv-mstp"
make -s router-mstp >/dev/null
cp bin/router-mstp "$ROOT/bin/router-mstp"
echo "built $TAG: $ROOT/bin/router-mstp $ROOT/bin/bacserv-mstp"
