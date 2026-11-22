#!/usr/bin/env python3
# Experiment: what the Simulator's Web Inspector socket (webinspectord) says. Lists the apps and pages it knows, and
# with --eval evaluates one expression in each page.   UDID=... python3 bench/debug/wir-probe.py [--eval 'document.title']
import json, os, plistlib, socket, struct, subprocess, sys, time, uuid

udid = os.environ["UDID"]
path = subprocess.run(["xcrun", "simctl", "getenv", udid, "RWI_LISTEN_SOCKET"], capture_output=True, text=True).stdout.strip()
print("socket:", path)
s = socket.socket(socket.AF_UNIX); s.connect(path); s.settimeout(3)
conn = str(uuid.uuid4()).upper()

def send(selector, args):
    body = plistlib.dumps({"__selector": selector, "__argument": args}, fmt=plistlib.FMT_BINARY)
    s.sendall(struct.pack(">I", len(body)) + body)

buf = b""
def recv(timeout=1.5):
    global buf
    out = []; end = time.time() + timeout
    while time.time() < end:
        try:
            chunk = s.recv(65536)
            if not chunk: break
            buf += chunk
        except socket.timeout:
            break
        while len(buf) >= 4:
            n = struct.unpack(">I", buf[:4])[0]
            if len(buf) < 4 + n: break
            out.append(plistlib.loads(buf[4:4 + n])); buf = buf[4 + n:]
        if out: end = min(end, time.time() + 0.4)
    return out

def show(msgs):
    for m in msgs:
        a = dict(m.get("__argument", {}))
        if "WIRMessageDataKey" in a: a["WIRMessageDataKey"] = a["WIRMessageDataKey"].decode("utf8", "replace")[:3000]
        a.pop("WIRApplicationIconKey", None)
        for v in (a.get("WIRApplicationDictionaryKey") or {}).values(): v.pop("WIRApplicationIconKey", None)
        if os.environ.get("QUIET") and m.get("__selector") not in ("_rpc_applicationSentData:",): continue
        print(" <", m.get("__selector"), json.dumps(a, default=str)[:3400])

send("_rpc_reportIdentifier:", {"WIRConnectionIdentifierKey": conn})
first = recv(); show(first)
send("_rpc_getConnectedApplications:", {"WIRConnectionIdentifierKey": conn})
apps = recv(); show(apps)
ids = {}
for m in first + apps:
    a = m.get("__argument", {})
    for k, v in (a.get("WIRApplicationDictionaryKey") or {}).items(): ids[k] = v
    if "WIRApplicationIdentifierKey" in a: ids[a["WIRApplicationIdentifierKey"]] = a
print("apps:", {k: (v.get("WIRApplicationBundleIdentifierKey"), v.get("WIRIsApplicationActiveKey"), v.get("WIRHostApplicationIdentifierKey")) for k, v in ids.items()})
expr = sys.argv[sys.argv.index("--eval") + 1] if "--eval" in sys.argv else None
for app in ids:
    send("_rpc_forwardGetListing:", {"WIRConnectionIdentifierKey": conn, "WIRApplicationIdentifierKey": app})
    listing = recv(); show(listing)
    for m in listing:
        for page, info in (m.get("__argument", {}).get("WIRListingKey") or {}).items():
            print("  page", app, page, info.get("WIRTypeKey"), info.get("WIRTitleKey"), info.get("WIRURLKey"))
            if not expr: continue
            sender = str(uuid.uuid4()).upper()
            send("_rpc_forwardSocketSetup:", {"WIRConnectionIdentifierKey": conn, "WIRApplicationIdentifierKey": app, "WIRPageIdentifierKey": info["WIRPageIdentifierKey"], "WIRSenderKey": sender, "WIRAutomaticallyPause": False})
            setup = recv(); show(setup)
            target = None
            for x in setup:
                d = x.get("__argument", {}).get("WIRMessageDataKey")
                if d:
                    j = json.loads(d)
                    if j.get("method") == "Target.targetCreated": target = j["params"]["targetInfo"]["targetId"]
            inner = json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {"expression": expr, "returnByValue": True}})
            outer = {"id": 1, "method": "Target.sendMessageToTarget", "params": {"targetId": target, "message": inner}} if target else json.loads(inner)
            t0 = time.time()
            send("_rpc_forwardSocketData:", {"WIRConnectionIdentifierKey": conn, "WIRApplicationIdentifierKey": app, "WIRPageIdentifierKey": info["WIRPageIdentifierKey"], "WIRSenderKey": sender, "WIRSocketDataKey": json.dumps(outer).encode()})
            got = recv(3); print("  eval took", round((time.time() - t0) * 1000), "ms incl. wait"); show(got)
            send("_rpc_forwardDidClose:", {"WIRConnectionIdentifierKey": conn, "WIRApplicationIdentifierKey": app, "WIRPageIdentifierKey": info["WIRPageIdentifierKey"], "WIRSenderKey": sender})
