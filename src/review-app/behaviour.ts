// What the review page does beyond its links, anchors and <details>.
//
// The left and right arrow keys move to the previous and next view, or to
// those of steps with errors while "Focus on errors" is checked; in the
// Overview they do nothing unless a lightbox is open. The track keeps the
// selected thumbnail in view, and the Trajectory tab returns to the view last
// shown. Space opens the selected view's lightbox (a step's own fragment
// selects its before view; in the Overview, the focused image's), and closes
// any open lightbox wherever the focus is. While a lightbox is open, the arrow
// keys and its arrows move through its sequence, and the page follows to the
// item's step. The run's time is shown in the reader's own time zone, and a
// file's window reads the file when it first opens.

/** The most of a file a window shows. */
const shownBytes = 1_000_000;

export function bind(doc: Document = document) {
  const views = () => [...doc.querySelectorAll<HTMLElement>(".center .view")];
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const body = (box: HTMLElement) => box.querySelector<HTMLElement>(".lb-body>*");
  const target = (el: Element | null) => el ? doc.getElementById(el.getAttribute("popovertarget") ?? "") : null;
  const sourceOf = (box: HTMLElement) => {
    for (const o of doc.querySelectorAll(".zoom,.enlarge,.gthumb")) {
      if (o.getAttribute("popovertarget") !== box.id) continue;
      const s = o.classList.contains("enlarge") ? o.closest<HTMLElement>(".term") : o.querySelector("img");
      if (s && s.getBoundingClientRect().width) return s;
    }
    return null;
  };
  // A contained image shows its picture inside its box, not across it.
  const shown = (s: HTMLElement) => {
    const r = s.getBoundingClientRect();
    if (!(s instanceof HTMLImageElement) || getComputedStyle(s).objectFit !== "contain" || !s.naturalWidth || !s.naturalHeight) return r;
    const k = Math.min(r.width / s.naturalWidth, r.height / s.naturalHeight), w = s.naturalWidth * k, h = s.naturalHeight * k;
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
  };
  // The transform that lays an element over the source's rectangle, measured
  // from the element's own untransformed place; the element keeps its current
  // (possibly mid-flight) look until the caller animates it.
  const from = (el: HTMLElement, src: HTMLElement) => {
    const now = getComputedStyle(el).transform;
    el.style.transition = "none"; el.style.transform = "none";
    const b = el.getBoundingClientRect(), a = shown(src);
    el.style.transform = now === "none" ? "" : now; el.getBoundingClientRect(); el.style.transition = "";
    if (!b.width) return "";
    const k = a.width / b.width;
    return `translate(${a.left + a.width / 2 - b.left - b.width * k / 2}px,${a.top + a.height / 2 - b.top - b.height * k / 2}px) scale(${k})`;
  };
  let hidden: HTMLElement | null = null, token = 0;
  const unhide = () => { if (hidden) hidden.style.visibility = ""; hidden = null; };
  const open = (box: HTMLElement) => {
    token++; unhide();
    const src = still() ? null : sourceOf(box);
    box.toggleAttribute("data-flip", !!src); box.showPopover();
    const el = body(box);
    if (src && el) {
      const f = from(el, src);
      el.style.transition = "none"; el.style.transform = f; el.getBoundingClientRect(); el.style.transition = ""; el.style.transform = "";
      src.style.visibility = "hidden"; hidden = src;
    }
  };
  const leave = (box: HTMLElement) => {
    if (box.hasAttribute("data-instant")) return;
    const el = body(box), src = hidden, n = ++token;
    if (src && el && !still() && src.getBoundingClientRect().width) {
      box.setAttribute("data-flip", ""); el.style.transform = from(el, src);
      el.addEventListener("transitionend", () => { if (n === token) unhide(); }, { once: true });
      setTimeout(() => { if (n === token) unhide(); }, 450);
    } else { box.removeAttribute("data-flip"); unhide(); }
    setTimeout(() => { if (n === token && !box.matches(":popover-open") && el) el.style.transform = ""; }, 520);
  };
  doc.querySelectorAll<HTMLElement>(".lightbox").forEach(b => b.addEventListener("beforetoggle", e => { if ((e as ToggleEvent).newState === "closed") leave(b); }));
  const go = (b: Element) => {
    const box = b.closest<HTMLElement>(".lightbox"), next = target(b);
    if (!next) return;
    const instant = [box, next].filter((x): x is HTMLElement => !!x);
    instant.forEach(x => x.setAttribute("data-instant", "")); token++; unhide();
    if (box) box.hidePopover();
    const s = next.dataset.step;
    if (s && decodeURIComponent(location.hash.slice(1)) !== s) location.hash = encodeURIComponent(s);
    const el = body(next); if (el) el.style.transform = "";
    next.showPopover();
    const src = sourceOf(next); if (src) { src.style.visibility = "hidden"; hidden = src; }
    setTimeout(() => instant.forEach(x => x.removeAttribute("data-instant")), 60);
  };
  doc.querySelectorAll<HTMLElement>(".fwin").forEach(w => w.addEventListener("beforetoggle", e => { if ((e as ToggleEvent).newState === "open") void fill(w); }));
  doc.addEventListener("click", e => {
    const t = e.target instanceof Element ? e.target : null;
    const b = t?.closest(".lb-nav");
    if (b) { e.preventDefault(); go(b); return; }
    const lb = target(t?.closest(".zoom,.enlarge,.gthumb") ?? null);
    if (lb) { e.preventDefault(); open(lb); return; }
    if (t instanceof HTMLElement && (t.classList.contains("lightbox") || t.classList.contains("fwin"))) t.hidePopover();
  });
  try {
    doc.querySelectorAll<HTMLTimeElement>("time[data-local]").forEach(t => {
      const d = new Date(t.dateTime);
      if (isNaN(d.getTime()) || !d.getTimezoneOffset()) return;
      t.textContent = new Intl.DateTimeFormat(undefined, { ...(d.getFullYear() !== d.getUTCFullYear() ? { year: "numeric" } : {}), month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
      const li = t.closest<HTMLElement>("[hidden]"); if (li) li.hidden = false;
    });
  } catch { /* the UTC time stays */ }
  const current = () => {
    let el: HTMLElement | null = null;
    try { el = doc.getElementById(decodeURIComponent(location.hash.slice(1))); } catch { /* a malformed fragment selects nothing */ }
    if (!el) return 0;
    const v = el.classList.contains("step") ? el.querySelector(".view.first") : el.closest(".view");
    return v ? views().indexOf(v as HTMLElement) : -1;
  };
  const focused = () => !!(doc.getElementById("focus-errors") as HTMLInputElement | null)?.checked;
  let last = "";
  const reveal = () => {
    const i = current(); if (i < 0) return;
    last = location.hash;
    doc.querySelector(`.track a[data-t="${i}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  doc.addEventListener("keydown", e => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const box = doc.querySelector<HTMLElement>(".lightbox:popover-open");
    if (e.key === " ") {
      if (box) { e.preventDefault(); if (!e.repeat) box.hidePopover(); return; }
      const opener = t instanceof Element ? t.closest(".zoom,.enlarge,.gthumb") : null;
      if (t instanceof Element && !opener && (t.closest("summary") || t.closest("button"))) return;
      e.preventDefault(); if (e.repeat) return;
      if (opener?.classList.contains("gthumb")) { const g = target(opener); if (g) open(g); return; }
      const i = current(), v = i < 0 ? null : views()[i];
      const lb = v && doc.getElementById(v.id.replace(/^step-/, "lightbox-"));
      if (lb) open(lb);
      return;
    }
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    if (box) { e.preventDefault(); const b = box.querySelector(d < 0 ? ".lb-nav.prev" : ".lb-nav.next"); if (b) go(b); return; }
    const all = views(); let j = current();
    if (j < 0) return;
    do j += d; while (j >= 0 && j < all.length && focused() && !all[j]!.closest(".step")!.classList.contains("err"));
    if (j < 0 || j >= all.length) return;
    e.preventDefault(); location.hash = encodeURIComponent(all[j]!.id);
  });
  doc.querySelector(".tabs .t-traj")?.addEventListener("click", e => { if (last) { e.preventDefault(); location.hash = last; } });
  addEventListener("hashchange", () => {
    let id = "";
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { /* keep the popovers of no step */ }
    doc.querySelectorAll<HTMLElement>(":popover-open").forEach(p => { if (p.dataset.step !== id) p.hidePopover(); });
    reveal();
  });
  reveal();
}

// A file window reads its file once, shows at most its first megabyte, and
// lays out JSON that is not already laid out for reading.
async function fill(w: HTMLElement) {
  if (w.dataset.filled) return;
  w.dataset.filled = "reading";
  const pre = w.querySelector<HTMLElement>(".fw-body")!, note = w.querySelector<HTMLElement>(".fw-note")!;
  try {
    const response = await fetch(w.dataset.src!);
    if (!response.ok) throw new Error(`${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer()), cut = bytes.length > shownBytes;
    let text = new TextDecoder().decode(cut ? bytes.subarray(0, shownBytes) : bytes);
    if (!cut && /\.json$/i.test(w.dataset.src!)) {
      try { const pretty = JSON.stringify(JSON.parse(text), null, 2); if (pretty !== text.trimEnd()) { text = pretty; note.hidden = false; } } catch { /* shown as written */ }
    }
    pre.textContent = text;
    if (!text) pre.innerHTML = `<span class="quiet">Empty file.</span>`;
    if (cut) pre.insertAdjacentHTML("beforeend", `\n<span class="quiet">Showing the first megabyte; download the file for the rest.</span>`);
    w.dataset.filled = "done";
  } catch {
    pre.innerHTML = `<span class="quiet">The file could not be read.</span>`;
    delete w.dataset.filled;
  }
}
