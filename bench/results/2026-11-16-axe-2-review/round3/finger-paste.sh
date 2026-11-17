#!/bin/bash
# Does a finger left down stop a paste? EdgeLab's Text tab: a paste fill; a finger put down on an empty spot and left
# there (the engine's drag with up: false); the same fill; the finger lifted; the fill again.   finger-paste.sh UDID
U=$1; D=~/drive/al; cd ~/drive/src/simtap; DL="node bin/simulator-use.js"; BE=vendor/axe/simulator-use-engine
fill() { $DL act --device "$U" "fill #unicode $1" 'wait "Typed: Café"' 2>&1 | head -1 | cut -c1-90; }
xcrun simctl terminate $U dev.simtap.edgelab 2>/dev/null; xcrun simctl launch $U dev.simtap.edgelab >/dev/null; sleep 3
$DL act --device "$U" 'tap Text' >/dev/null 2>&1
echo "1. fill, no finger down: $(fill 'Café 日本 1')"
cat > /tmp/finger.mjs <<'JS'
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const [engine, udid, req] = process.argv.slice(2);
const child = spawn(engine, ["--udid", udid, "--no-bootstrap"], { stdio: ["pipe", "pipe", "ignore"] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
await lines.next();
child.stdin.write(JSON.stringify({ id: 1, ...JSON.parse(req) }) + "\n");
const a = JSON.parse((await lines.next()).value);
console.log(`  engine ${JSON.parse(req).up === false ? "finger down, left" : "finger lifted"}: ok=${a.ok} ${a.error ?? ""}`);
child.stdin.end();
JS
node /tmp/finger.mjs $BE $U '{"op":"drag","x1":30,"y1":120,"x2":40,"y2":120,"duration":0.2,"steps":2,"up":false}'
echo "2. fill, a finger down: $(fill 'Café 日本 2')"
node /tmp/finger.mjs $BE $U '{"op":"drag","x1":40,"y1":120,"x2":40,"y2":120,"duration":0.1,"steps":1,"down":false}'
echo "3. fill, the finger lifted: $(fill 'Café 日本 3')"
pkill -f simulator-use-engine; true
