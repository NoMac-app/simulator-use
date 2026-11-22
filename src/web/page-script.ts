/**
 * What a web page shows, said by the page: the script below runs in the page (WebKit's inspector, inspector.ts) and
 * answers the elements in view, each with its kind, its words, its state and its box in the page's own points.
 *
 * It lists what a person can act on or read: links, buttons, fields, checkboxes, radio buttons, selects, anything
 * with a role or a click handler of its own, headings, images with a name, and the runs of text between them. It
 * goes into open shadow roots and into frames of the page's own origin. An element counts only if it is drawn
 * (not hidden, not transparent, not clipped away), has part of it in view, and is what a touch at its middle
 * reaches (so a link under a cookie banner is not listed, and the banner is).
 *
 * Written as plain ES2017 text, since it runs in whatever page is there; it changes nothing in the page and reads
 * no value of a password field.
 */
export const PAGE_SCRIPT = String.raw`(() => {
  const MAX = 400, TEXT = 160;
  const vw = window.innerWidth, vh = window.innerHeight;
  const out = [];
  const seen = new Set();
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const cut = (s) => (s.length > TEXT ? s.slice(0, TEXT - 1) + "…" : s);
  const styleOf = (el) => (el.ownerDocument.defaultView || window).getComputedStyle(el);
  // Whether an element itself is drawn; what holds it was looked at on the way down to it.
  const drawn = (el) => {
    const s = styleOf(el);
    if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse" || Number(s.opacity) === 0) return false;
    return !(el.getAttribute("aria-hidden") === "true" || el.hasAttribute("inert"));
  };
  // A frame's own offset in the top page, for boxes of what is inside it.
  const boxOf = (el, dx, dy) => {
    // A link that wraps over lines is tapped on its first line's box, not in the gap its whole box may hold.
    const rects = el.getClientRects ? el.getClientRects() : [];
    let r = el.getBoundingClientRect();
    if (rects.length > 1 && styleOf(el).display.indexOf("inline") === 0) {
      for (const one of rects) if (one.width > 4 && one.height > 4) { r = one; break; }
    }
    const x = Math.max(0, r.left + dx), y = Math.max(0, r.top + dy);
    const right = Math.min(vw, r.right + dx), bottom = Math.min(vh, r.bottom + dy);
    if (right - x < 2 || bottom - y < 2) return null;
    return { x, y, w: right - x, h: bottom - y, cut: r.top + dy < 0 || r.bottom + dy > vh };
  };
  const reached = (el, box, dx, dy) => {
    const doc = el.ownerDocument;
    let at = doc.elementFromPoint(box.x + box.w / 2 - dx, box.y + box.h / 2 - dy);
    while (at && at.shadowRoot) {
      const inner = at.shadowRoot.elementFromPoint(box.x + box.w / 2 - dx, box.y + box.h / 2 - dy);
      if (!inner || inner === at) break;
      at = inner;
    }
    for (let e = at; e; e = e.parentNode || e.host) if (e === el) return true;
    // A label reaches its field, and a field its label.
    if (at && el.contains && el.contains(at)) return true;
    if (at && at.tagName === "LABEL" && (at.control === el || at.contains(el))) return true;
    return false;
  };
  const labelled = (el) => {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const words = by.split(/\s+/).map((id) => { const t = el.ownerDocument.getElementById(id); return t ? clean(t.innerText || t.textContent) : ""; }).filter(Boolean).join(" ");
      if (words) return words;
    }
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    if (el.labels && el.labels.length) { const t = clean(el.labels[0].innerText || el.labels[0].textContent); if (t) return t; }
    return "";
  };
  const nameOf = (el, kind) => {
    const said = labelled(el);
    if (said) return said;
    if (kind === "image") return clean(el.getAttribute("alt")) || clean(el.getAttribute("title"));
    if (kind === "textfield" || kind === "securefield" || kind === "searchfield" || kind === "textview") return clean(el.getAttribute("placeholder")) || clean(el.getAttribute("title")) || clean(el.getAttribute("name"));
    if (kind === "popup") return clean(el.getAttribute("title")) || clean(el.getAttribute("name"));
    if (el.tagName === "INPUT") return clean(el.value) || clean(el.getAttribute("title"));
    const own = clean(el.innerText || el.textContent);
    if (own) return own;
    const img = el.querySelector && el.querySelector("img[alt], svg[aria-label], [title]");
    if (img) return clean(img.getAttribute("alt") || img.getAttribute("aria-label") || img.getAttribute("title"));
    return clean(el.getAttribute("title")) || clean(el.getAttribute("value"));
  };
  const ROLES = { button: "button", link: "link", checkbox: "checkbox", switch: "switch", radio: "radio", tab: "tab", menuitem: "button", menuitemcheckbox: "checkbox", menuitemradio: "radio", option: "button",
    textbox: "textfield", searchbox: "searchfield", combobox: "popup", listbox: "popup", slider: "slider", spinbutton: "textfield", heading: "heading", img: "image", progressbar: "progress" };
  const kindOf = (el) => {
    const role = (el.getAttribute("role") || "").toLowerCase();
    const tag = el.tagName;
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "hidden") return null;
      if (type === "checkbox") return role === "switch" ? "switch" : "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "password") return "securefield";
      if (type === "search") return "searchfield";
      if (type === "submit" || type === "button" || type === "reset" || type === "image" || type === "file" || type === "color") return "button";
      return "textfield";
    }
    if (ROLES[role]) return ROLES[role];
    if (tag === "A" && el.hasAttribute("href")) return "link";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return "popup";
    if (tag === "TEXTAREA") return "textview";
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "IMG" || (tag === "svg" && el.getAttribute("aria-label"))) return "image";
    if (tag === "PROGRESS" || tag === "METER") return "progress";
    if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) return "textview";
    if (el.hasAttribute("onclick") || (el.tabIndex >= 0 && el.hasAttribute("tabindex") && role !== "presentation" && role !== "none")) return "button";
    return null;
  };
  const CONTROL = { button: 1, link: 1, checkbox: 1, switch: 1, radio: 1, tab: 1, textfield: 1, securefield: 1, searchfield: 1, textview: 1, popup: 1, slider: 1 };
  const push = (item) => { if (out.length < MAX) out.push(item); };
  const add = (el, kind, dx, dy) => {
    const box = boxOf(el, dx, dy);
    if (!box || !reached(el, box, dx, dy)) return false;
    const item = { k: kind, x: Math.round(box.x * 10) / 10, y: Math.round(box.y * 10) / 10, w: Math.round(box.w * 10) / 10, h: Math.round(box.h * 10) / 10 };
    const name = cut(nameOf(el, kind));
    if (name) item.n = name;
    // A link with no words (an icon) is named by where it goes.
    else if (kind === "link" && el.href) item.href = String(el.href).slice(0, 300);
    if (el.id && /^[A-Za-z][\w:.-]{0,47}$/.test(el.id)) item.id = el.id;
    if (kind === "textfield" || kind === "searchfield" || kind === "textview") { const v = clean(el.isContentEditable ? el.innerText : el.value); if (v) item.v = cut(v); }
    // A password's letters stay in the page: only how many there are.
    if (kind === "securefield" && el.value) item.v = "•".repeat(Math.min(el.value.length, 40));
    if (kind === "popup" && el.tagName === "SELECT") { const o = el.selectedOptions && el.selectedOptions[0]; if (o) item.v = cut(clean(o.textContent)); }
    if (kind === "slider" || kind === "progress") { const v = el.value !== undefined ? el.value : el.getAttribute("aria-valuenow"); if (v !== null && v !== undefined && v !== "") item.v = String(v); }
    if (kind === "checkbox" || kind === "switch" || kind === "radio") { const c = el.checked !== undefined ? el.checked : el.getAttribute("aria-checked") === "true"; item.on = Boolean(c); }
    if (kind === "tab" && el.getAttribute("aria-selected") === "true") item.sel = true;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") item.off = true;
    if (el.getAttribute("aria-expanded")) item.exp = el.getAttribute("aria-expanded") === "true";
    if (kind === "heading") item.lvl = Number((/^H([1-6])$/.exec(el.tagName) || [])[1] || el.getAttribute("aria-level") || 0);
    if (box.cut) item.cut = true;
    if (!item.n && !item.id && !item.v && !CONTROL[kind]) return false;
    push(item);
    return true;
  };
  const BLOCK = /^(block|flex|grid|list-item|table|table-cell|table-row|table-caption|flow-root|inline-block)$/;
  // The text a block holds itself (not in a block inside it), as one run with its own box. The words of the links
  // and buttons in it are left out when it is mostly them (a row of links with separators: they are listed
  // themselves), and kept when it is a sentence with a link or two in it (which reads as nothing without them).
  const textOf = (el, dx, dy) => {
    const range = el.ownerDocument.createRange();
    const parts = [];
    let own = 0, held = 0, left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    const walk = (node, inControl) => {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          const t = clean(child.nodeValue);
          if (!t) continue;
          if (!inControl) {
            range.selectNodeContents(child);
            for (const r of range.getClientRects()) {
              if (r.width < 1 || r.height < 1 || r.bottom + dy < 0 || r.top + dy > vh || r.right + dx < 0 || r.left + dx > vw) continue;
              left = Math.min(left, r.left + dx); top = Math.min(top, r.top + dy); right = Math.max(right, r.right + dx); bottom = Math.max(bottom, r.bottom + dy);
            }
            own += t.length;
          } else held += t.length;
          parts.push({ t, c: inControl });
        } else if (child.nodeType === 1) {
          if (SKIP[child.tagName] || !drawn(child) || BLOCK.test(styleOf(child).display)) continue;
          const kind = kindOf(child);
          if (kind && kind !== "link" && kind !== "button") continue;
          walk(child, inControl || Boolean(kind));
        }
      }
    };
    walk(el, false);
    if (!own || right - left < 2 || bottom - top < 2) return;
    const whole = held > 0 && own >= held;
    const said = parts.filter((p) => whole || !p.c).map((p) => p.t).join(" ").replace(/\s+([,.;:!?)\]])/g, "$1").replace(/([(\[])\s+/g, "$1");
    const x = Math.max(0, left), y = Math.max(0, top), w = Math.min(vw, right) - x, h = Math.min(vh, bottom) - y;
    if (!said || w < 2 || h < 2) return;
    push({ k: "text", n: cut(said), x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10 });
  };
  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, LINK: 1, META: 1 };
  // Down the page from an element that is drawn: itself as a control or a run of text, then what it holds.
  const visit = (el, dx, dy, depth) => {
    if (out.length >= MAX || depth > 400 || SKIP[el.tagName] || !drawn(el)) return;
    const tag = el.tagName;
    if (tag === "IFRAME" || tag === "FRAME") {
      try {
        const inner = el.contentDocument;
        if (inner && inner.body) { const r = el.getBoundingClientRect(); visit(inner.body, dx + r.left + el.clientLeft, dy + r.top + el.clientTop, depth + 1); }
      } catch (e) { /* Another origin's frame: its own page, not this one's to read. */ }
      return;
    }
    const r = el.getBoundingClientRect();
    // Nothing of it is in view, nor of what it holds (what a box lets overflow may still be).
    if (r.width > 0 && r.height > 0 && (r.bottom + dy < 0 || r.top + dy > vh || r.right + dx < 0 || r.left + dx > vw) && styleOf(el).overflow !== "visible") return;
    const kind = kindOf(el);
    if (kind) {
      const listed = add(el, kind, dx, dy);
      // A link's or a button's words are its name, and a field holds nothing: only a heading is gone into (for the
      // links it may hold), and a control that is not listed (covered, out of view) for what of it may be.
      if (listed && kind !== "heading") return;
      if (listed) seen.add(el);
    } else if (BLOCK.test(styleOf(el).display)) {
      textOf(el, dx, dy);
    }
    if (el.shadowRoot) for (let child = el.shadowRoot.firstElementChild; child; child = child.nextElementSibling) visit(child, dx, dy, depth + 1);
    for (let child = el.firstElementChild; child; child = child.nextElementSibling) visit(child, dx, dy, depth + 1);
  };
  if (document.body) visit(document.body, 0, 0, 0);
  const vv = window.visualViewport;
  const se = document.scrollingElement || document.documentElement;
  return JSON.stringify({
    v: 1, url: location.href, title: document.title, visible: document.visibilityState === "visible", ready: document.readyState,
    w: vw, h: vh, scale: vv ? vv.scale : 1, vx: vv ? vv.offsetLeft : 0, vy: vv ? vv.offsetTop : 0, vw: vv ? vv.width : vw, vh: vv ? vv.height : vh,
    sx: se.scrollLeft, sy: se.scrollTop, sw: se.scrollWidth, sh: se.scrollHeight, more: out.length >= MAX,
    items: out,
  });
})()`;
