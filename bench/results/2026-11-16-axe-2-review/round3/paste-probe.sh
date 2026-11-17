#!/bin/bash
# Why a paste (Cmd-V) leaves EdgeLab's #unicode field empty: the same Cmd-V sent by this build's engine, by 0.16.0's
# engine and by AXe's CLI, a typed key for comparison, and the field read after each.   paste-probe.sh UDID
U=$1; D=~/drive/al; cd ~/drive/src/simtap
DL="node bin/simulator-use.js"
AE=~/drive/ab/A/lib/node_modules/simulator-use/vendor/axe/simulator-use-engine
BE=vendor/axe/simulator-use-engine
cat > /tmp/steps.mjs <<'JS'
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const [engine, udid, steps] = process.argv.slice(2);
const child = spawn(engine, ["--udid", udid, "--no-bootstrap"], { stdio: ["pipe", "pipe", "ignore"] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const ready = JSON.parse((await lines.next()).value);
child.stdin.write(JSON.stringify({ id: 1, op: "steps", steps: JSON.parse(steps) }) + "\n");
const a = JSON.parse((await lines.next()).value);
console.log(`  steps by ${engine.includes("ab/A") ? "0.16.0" : "this build"} (input ${ready.hid ?? "?"}): ok=${a.ok} ${a.error ?? ""} via=${a.via ?? "?"}`);
child.stdin.end();
JS
field() { $DL look --device "$U" 2>/dev/null | grep -E '#unicode|keyboard' | tr '\n' ' '; echo; }
pos=$($DL look --device "$U" 2>/dev/null | grep '#unicode' | grep -oE '@[0-9]+,[0-9]+' | tr -d @)
X=${pos%,*}; Y=${pos#*,}; echo "field at $X,$Y"
xcrun simctl pbcopy "$U" <<< "Pasted1"
echo "1. this build: tap, Cmd-V"; node /tmp/steps.mjs $BE $U "[{\"tap\":[$X,$Y]},{\"sleep\":0.5},{\"combo\":{\"mods\":[227],\"key\":25}}]"; sleep 1; field
echo "2. 0.16.0: Cmd-V"; node /tmp/steps.mjs $AE $U "[{\"combo\":{\"mods\":[227],\"key\":25}}]"; sleep 1; field
echo "3. AXe CLI: Cmd-V"; vendor/axe/axe key-combo --modifiers 227 --key 25 --udid $U 2>&1 | tail -1; sleep 1; field
echo "4. this build: type x"; node /tmp/steps.mjs $BE $U '[{"type":"x"}]'; sleep 1; field
echo "5. this build: Cmd-A, then Cmd-C, delete, Cmd-V (the field's own text)"; node /tmp/steps.mjs $BE $U '[{"combo":{"mods":[227],"key":4}},{"combo":{"mods":[227],"key":6}},{"key":42},{"sleep":0.3},{"combo":{"mods":[227],"key":25}}]'; sleep 1; field
xcrun simctl io "$U" screenshot $D/probe-promax/paste.png >/dev/null 2>&1; sips -Z 700 $D/probe-promax/paste.png --out $D/probe-promax/paste-s.png >/dev/null
pkill -f simulator-use-engine; true
