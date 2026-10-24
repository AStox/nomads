#!/bin/bash
# usage: mksite.sh <worktree> <outdir>   builds the styles demo and injects the perf prelude into the render worker
export PATH="$HOME/.bun/bin:$PATH"
cd "$1" && BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun scripts/demo.ts styles --out "$2" >/dev/null 2>&1 || exit 1
cp /tmp/globe-audit/perf/site/isopixel/perfprelude.js "$2/isopixel/perfprelude.js"
{ echo 'import "./perfprelude.js";'; cat "$2/isopixel/worker.js"; } > "$2/isopixel/worker.js.new" && mv "$2/isopixel/worker.js.new" "$2/isopixel/worker.js"
echo built "$2"
