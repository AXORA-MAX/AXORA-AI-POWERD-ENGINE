#!/bin/sh
# TEST-ONLY wrapper: makes the Node-based mockCoreProcess.js runnable as
# a plain executable, so AXORA_CORE_BIN can point directly at it exactly
# the way it would point at a real compiled axora-core binary. Not part
# of the gateway or shipped to users — exists purely to prove the
# gateway's AXORA_CORE_BIN wiring against a real (mock) process end to
# end. See docs/VERIFICATION.md Milestone 10.
exec node "$(dirname "$0")/mockCoreProcess.js" "$@"
