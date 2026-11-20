# qa_tabs.py: one reusable tab per QA persona, for browser-harness journey scripts.
#
# Load it inside every browser-harness call, after the project's own helpers (so it can
# use their reset_identity()), and do not define your own persona():
#     exec(open("<repo>/.claude/skills/claw-forge-verify/qa_tabs.py").read())
#     persona("mei")      # switch to Mei's tab; created only if she has none yet
#     ...
#     prune_tabs()        # once, at the end of the sweep
#
# Why: verifiers gave every persona a new browser context in every sweep and never closed
# it. On 2026-11-20 one scholium QA Chrome held 337 renderer processes and 8.6 GB after
# five sweeps. Here a persona owns exactly one tab per QA browser, reused across sweeps
# and sessions, and prune_tabs() closes the rest.
#
# Environment:
#   BU_CDP_URL / BU_CDP_WS  the dedicated QA browser; the registry is kept per CDP port.
#   QA_SWEEP     sweep label, e.g. "s21". A persona's first persona() call in a new sweep
#                resets its identity (the project's reset_identity(), else cookies and
#                storage), so every sweep still starts each persona clean.
#   QA_TABS_DIR  registry location (default ~/.cache/claw-forge-qa-tabs/<port>).
import os as _qt_os, re as _qt_re
from urllib.parse import urlparse as _qt_urlparse

def _qt_cdp_url():
    return _qt_os.environ.get("BU_CDP_URL") or _qt_os.environ.get("BU_CDP_WS") or ""

def _qt_dir():
    d = _qt_os.environ.get("QA_TABS_DIR")
    if not d:
        port = _qt_urlparse(_qt_cdp_url()).port if _qt_cdp_url() else None
        d = _qt_os.path.expanduser(f"~/.cache/claw-forge-qa-tabs/{port or 'default'}")
    _qt_os.makedirs(d, exist_ok=True)
    return d

def _qt_file(name):
    return _qt_os.path.join(_qt_dir(), _qt_re.sub(r"[^A-Za-z0-9_.-]", "_", name))

def _qt_read(path):  # -> (targetId, browserContextId, sweep) or None
    try:
        parts = open(path).read().split("\t")
    except FileNotFoundError:
        return None
    return tuple((parts + ["", "", ""])[:3]) if parts[0] else None

def _qt_write(name, tid, ctx, sweep):
    path = _qt_file(name)
    open(path + ".tmp", "w").write(f"{tid}\t{ctx}\t{sweep}")
    _qt_os.replace(path + ".tmp", path)

def _qt_pages():
    return [t for t in cdp("Target.getTargets")["targetInfos"] if t["type"] == "page"]

def _qt_reset():
    """Make the attached persona tab a stranger to the app again."""
    cdp("Page.navigate", url="about:blank")
    if callable(globals().get("reset_identity")):
        reset_identity()
    else:
        cdp("Network.clearBrowserCookies")

def persona(name, viewport=(1440, 900), timezone=None):
    """Switch to `name`'s own tab and return its targetId. The tab (in its own browser
    context) is created only if this persona has no live tab in this QA browser yet;
    otherwise the same tab is reused, in this sweep and in later ones."""
    sweep = _qt_os.environ.get("QA_SWEEP", "")
    rec = _qt_read(_qt_file(name))
    live = {t["targetId"] for t in _qt_pages()}
    if rec and rec[0] in live:
        tid, ctx, last = rec
        fresh = bool(sweep) and last != sweep
    else:
        if _qt_cdp_url():
            prune_tabs(stale=False)  # reclaim leaked contexts before adding one
        ctx = cdp("Target.createBrowserContext")["browserContextId"]
        tid = cdp("Target.createTarget", url="about:blank", browserContextId=ctx)["targetId"]
        fresh = False
    pin = globals().get("MYSID")  # pin.py keeps each script on its own CDP session
    if pin is not None:
        pin[0] = None
    switch_tab(tid)
    if pin is not None:
        pin[0] = globals()["_raw_cdp"]("Target.attachToTarget", targetId=tid, flatten=True)["sessionId"]
    for domain in ("Page", "Runtime", "Network", "DOM"):
        cdp(domain + ".enable")
    if viewport:
        cdp("Emulation.setDeviceMetricsOverride", width=viewport[0], height=viewport[1],
            deviceScaleFactor=1, mobile=False)
    if timezone:
        try: cdp("Emulation.setTimezoneOverride", timezoneId=timezone)
        except Exception: pass
    if fresh:
        _qt_reset()
    _qt_write(name, tid, ctx, sweep)
    if len(live) > 60:
        print(f"!! QA browser has {len(live)} tabs open; run prune_tabs()")
    return tid

def prune_tabs(stale=True, app_prefixes=(), dry_run=False):
    """Close QA-browser tabs nobody should still have open; return what was closed.
    - browser contexts no persona owns (leaks from scripts that bypassed persona())
    - with stale=True and QA_SWEEP set: personas not used in this sweep (run at sweep end)
    - default-context pages under one of app_prefixes (leftovers from new_tab())
    Never touches the tab the daemon is attached to. Refuses to run unless BU_CDP_URL or
    BU_CDP_WS names a dedicated QA browser, so it can never close your own Chrome's tabs."""
    if not _qt_cdp_url():
        raise RuntimeError("prune_tabs: BU_CDP_URL is not set; refusing to prune your own Chrome")
    sweep = _qt_os.environ.get("QA_SWEEP", "")
    pages = _qt_pages()
    live = {t["targetId"] for t in pages}
    contexts = set(cdp("Target.getBrowserContexts")["browserContextIds"])
    keep, forget = set(), []
    for fname in _qt_os.listdir(_qt_dir()):
        if fname.endswith(".tmp"):
            continue
        rec = _qt_read(_qt_os.path.join(_qt_dir(), fname))
        if not rec or rec[0] not in live or (stale and sweep and rec[2] != sweep):
            forget.append(fname)
        else:
            keep.add(rec[1])
    try:
        cur = current_tab()["targetId"]
    except Exception:
        cur = None
    cur_ctx = next((t.get("browserContextId") for t in pages if t["targetId"] == cur), None)
    dispose = [c for c in contexts if c not in keep and c != cur_ctx]
    default_pages = [t for t in pages if t.get("browserContextId") not in contexts]
    close = [t["targetId"] for t in default_pages if t["targetId"] != cur
             and any(t["url"].startswith(p) for p in app_prefixes)]
    if close and len(close) == len(default_pages):
        close = close[1:]  # keep one default tab so the browser always has a page
    if not dry_run:
        for c in dispose:
            cdp("Target.disposeBrowserContext", browserContextId=c)
        for t in close:
            cdp("Target.closeTarget", targetId=t)
        for fname in forget:
            try: _qt_os.remove(_qt_os.path.join(_qt_dir(), fname))
            except FileNotFoundError: pass
    return {"disposed_contexts": len(dispose), "closed_pages": len(close), "kept_personas": len(keep)}

def tab_report():
    """Pages, contexts and live personas in this QA browser; log it in _run-log.md."""
    live = {t["targetId"] for t in _qt_pages()}
    personas = []
    for fname in _qt_os.listdir(_qt_dir()):
        rec = None if fname.endswith(".tmp") else _qt_read(_qt_os.path.join(_qt_dir(), fname))
        if rec and rec[0] in live:
            personas.append(fname)
    return {"pages": len(live), "contexts": len(cdp("Target.getBrowserContexts")["browserContextIds"]),
            "personas": sorted(personas)}
