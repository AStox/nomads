#!/bin/bash
# usage: mkmark.sh <site> <outdir>   a copy of a built play site (the published one, or mksite.sh's) whose planet pass paints a magenta disc on the ground at a unit point, where the picture draws that
# place: the shader's own hit point, not the page's pick. play.live.debug.check({ op: "mark", v: [x, y, z, radiusRad] }) sets it (radius 0 clears it). Everything but isopixel/ is linked, not copied.
set -e
src="$1"; out="$2"
rm -rf "$out"; mkdir -p "$out"
for e in "$src"/*; do n=$(basename "$e"); [ "$n" = isopixel ] || [ "$n" = reports ] || ln -s "$(cd "$src" && pwd -P)/$n" "$out/$n"; done
cp -R "$src/isopixel" "$out/isopixel"
python3 - "$out/isopixel" <<'PY'
import sys
d = sys.argv[1]
def sub(f, a, b):
    s = open(f"{d}/{f}").read()
    assert s.count(a) == 1, (f, a, s.count(a))
    open(f"{d}/{f}", "w").write(s.replace(a, b))
sub("wgsl/globe.js", "  o_.color = vec4f(shown, 1.0);\n  return o_;\n}\n`;", "  o_.color = vec4f(shown, 1.0);\n  let mkr = bitcast<f32>(u.bw2.w);\n  if (mkr > 0.0 && distance(p, vec3f(bitcast<f32>(u.bw2.x), bitcast<f32>(u.bw2.y), bitcast<f32>(u.bw2.z))) < mkr) { o_.color = vec4f(1.0, 0.0, 1.0, 1.0); }\n  return o_;\n}\n`;")
sub("planet.js", "u[80] = opts.spr ?? 0.6;", "{ const m = globalThis.__mark ?? [0, 0, 0, 0]; u[72] = m[0]; u[73] = m[1]; u[74] = m[2]; u[75] = m[3]; }\n    u[80] = opts.spr ?? 0.6;")
sub("worker.js", '  if (m.op === "arr")', '  if (m.op === "mark") { globalThis.__mark = m.v; return true; }\n  if (m.op === "arr")')
PY
echo marked "$out"
