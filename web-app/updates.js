const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
let feedbackBusiness;
let feedbackHost;
const recentFeedback = new Map();
const sourceFeedback = new Map();

export function feedbackScope(business) {
  if (business === feedbackBusiness) return;
  feedbackBusiness = business;
  recentFeedback.clear();
  sourceFeedback.clear();
  feedbackHost?.remove();
  feedbackHost = null;
}

export function toast(message, key = message) {
  const now = Date.now();
  for (const [entry, at] of recentFeedback) if (now - at > 60000) recentFeedback.delete(entry);
  if (recentFeedback.has(key)) return;
  recentFeedback.set(key, now);
  if (!feedbackHost?.isConnected) {
    feedbackHost = document.createElement("div");
    feedbackHost.className = "toast-stack";
    feedbackHost.setAttribute("aria-label", "Recent feedback");
    document.body.append(feedbackHost);
  }
  if (feedbackHost.children.length >= 3) feedbackHost.firstElementChild.remove();
  const item = document.createElement("div");
  item.className = "feedback-toast";
  item.innerHTML = `<span role="status">${esc(message)}</span><button type="button" aria-label="Dismiss notification" title="Dismiss">${icon("x")}</button>`;
  let timer;
  const pause = () => clearTimeout(timer);
  const resume = () => { pause(); timer = setTimeout(() => item.remove(), 6500); };
  item.addEventListener("mouseenter", pause);
  item.addEventListener("mouseleave", resume);
  item.addEventListener("focusin", pause);
  item.addEventListener("focusout", resume);
  item.querySelector("button").onclick = () => { pause(); item.remove(); };
  feedbackHost.append(item);
  window.lucide?.createIcons();
  resume();
}

export function operationFeedback(path, payload) {
  if (path === "ingestion/upload") {
    toast("Files checked.", `upload:${(payload.uploads || [payload.upload]).map(u => u?.id).join(":")}`);
    for (const source of payload.uploads || [payload.upload]) if (source?.id) sourceFeedback.set(source.id, Date.now());
  } else if (path === "ingestion/manual/draft") toast("Draft saved.", "draft-saved");
  else if (path === "ingestion/manual/submit") {
    toast("Records submitted.", "records-submitted");
    if (payload.upload?.id) sourceFeedback.set(payload.upload.id, Date.now());
  }
}

export function updatesPageHtml() {
  return `<section id="updates-page" class="updates-page" aria-labelledby="updates-heading">
    <div class="section-heading"><h1 id="updates-heading">Updates</h1><button class="secondary" data-updates-refresh type="button">${icon("refresh-cw")} Refresh</button></div>
    <p id="updates-message" role="status" aria-live="polite">Loading updates...</p>
    <div id="updates-content"></div>
  </section>`;
}

export function mountUpdates({ root, api }) {
  const control = root.querySelector("#updates-control");
  if (!control) return () => {};
  const bell = control.querySelector("button");
  const panel = control.querySelector("#updates-panel");
  const page = root.querySelector("#updates-page");
  const navigation = root.querySelector("[data-updates-nav]");
  const controller = new AbortController();
  let disposed = false, pending = false, refreshAgain = false, enabled = false, latest, initializedAt, snapshotAt;
  let filter = "all", category = "all", offset = 0;
  const seenEvents = new Set();
  const alive = () => !disposed && control.isConnected;
  const message = (text, error = false) => {
    const target = page?.querySelector("#updates-message");
    if (!target || !alive()) return;
    target.textContent = text;
    target.classList.toggle("error-text", error);
  };
  const itemHtml = item => {
    // Never render a provider/request-controlled URL as an actionable link.
    const href = /^#\/data\?upload=[0-9a-f-]{36}$/i.test(item.href) ? item.href : "#/data";
    const snoozed = item.snoozedUntil && new Date(item.snoozedUntil) > new Date();
    const date = new Date(item.createdAt);
    return `<article class="update-row ${item.readAt ? "" : "is-unread"}" data-update-id="${esc(item.id)}">
      <div class="update-marker">${icon(item.kind === "report_ready" ? "file-check-2" : "file-warning")}</div>
      <div class="update-body"><h2>${esc(item.title)}</h2><p>${esc(item.message)}</p>
        <div class="update-context"><span>${esc(item.period)}</span><time datetime="${esc(item.createdAt)}">${esc(Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "")}</time>
          ${item.evidenceStatus === "superseded" ? "<strong>Replaced by newer evidence</strong>" : ""}
          ${snoozed ? "<span>Snoozed</span>" : ""}</div>
        <div class="update-actions"><a class="quiet-link" href="${esc(href)}" data-update-open="${esc(item.id)}">${esc(item.actionLabel)} ${icon("arrow-up-right")}</a>
          ${page ? `<button class="text-button" type="button" data-update-state="${esc(item.id)}" data-action="${item.readAt ? "unread" : "read"}" title="${item.readAt ? "Mark unread" : "Mark read"}" aria-label="${item.readAt ? "Mark unread" : "Mark read"}: ${esc(item.title)}">${icon(item.readAt ? "mail" : "mail-open")}</button>
          <label class="update-snooze"><span class="sr-only">Remind me: ${esc(item.title)}</span><select data-update-snooze="${esc(item.id)}" aria-label="Remind me: ${esc(item.title)}"><option value="">Remind me</option><option value="24">Tomorrow</option><option value="168">In a week</option>${snoozed ? '<option value="0">End snooze</option>' : ""}</select></label>` : ""}</div>
      </div></article>`;
  };
  async function refresh({ feedback = false } = {}) {
    if (!alive()) return;
    if (pending) { refreshAgain = true; return; }
    pending = true;
    try {
      const header = await api("updates?limit=5");
      if (!alive()) return;
      enabled = header.enabled;
      control.hidden = !enabled;
      if (navigation) navigation.hidden = !enabled;
      if (!enabled) { message("Updates are not enabled for this business."); if (page) page.querySelector("#updates-content").replaceChildren(); return; }
      bell.title = "Updates";
      bell.setAttribute("aria-label", `Updates, ${header.unreadCount} unread`);
      control.querySelector(".updates-count").textContent = header.unreadCount > 99 ? "99+" : header.unreadCount || "";
      panel.querySelector(".recent-updates").innerHTML = header.items.length ? header.items.map(itemHtml).join("") : '<p class="updates-empty">You are all caught up.</p>';
      if (initializedAt) {
        for (const item of header.items) if (!seenEvents.has(item.id) && new Date(item.createdAt) > new Date(initializedAt) && !item.readAt && item.evidenceStatus === "current" &&
          (!item.snoozedUntil || new Date(item.snoozedUntil) <= new Date()) && Date.now() - (sourceFeedback.get(item.sourceId) || 0) > 60000) toast(item.title, `event:${item.id}`);
      } else initializedAt = header.snapshotAt;
      header.items.forEach(item => seenEvents.add(item.id));
      if (page) {
        const data = await api(`updates?filter=${filter}&category=${category}&offset=${offset}&limit=25`);
        if (!alive()) return;
        if (!data.enabled) { control.hidden = true; if (navigation) navigation.hidden = true; message("Updates are not enabled for this business."); page.querySelector("#updates-content").replaceChildren(); return; }
        latest = data;
        snapshotAt = data.snapshotAt;
        renderPage();
        message("");
      }
      if (feedback) toast("Updates refreshed.", `refresh:${Date.now()}`);
      window.lucide?.createIcons();
    } catch (error) {
      if (!alive()) return;
      bell.title = "Updates could not refresh. Open Updates to retry.";
      message(error.message || "Updates could not load. Please retry.", true);
      // Never replace a failed fetch with an empty or zero-unread success state.
      if (!enabled) { control.hidden = false; bell.setAttribute("aria-label", "Updates unavailable"); }
    } finally {
      pending = false;
      if (refreshAgain && alive()) { refreshAgain = false; void refresh(); }
    }
  }
  function renderPage() {
    page.querySelector("#updates-content").innerHTML = `<div class="updates-toolbar">
      <label>Status<select id="updates-filter"><option value="all">All updates</option><option value="unread">Unread</option><option value="snoozed">Snoozed</option></select></label>
      <label>Category<select id="updates-category"><option value="all">All categories</option><option value="reports">Reports</option><option value="data">Data & uploads</option></select></label>
      <button type="button" class="secondary" data-updates-read-all ${latest.unreadCount ? "" : "disabled"}>${icon("check-check")} Mark all read</button>
    </div><div class="updates-list" aria-label="Business updates">${latest.items.length ? latest.items.map(itemHtml).join("") : '<p class="updates-empty">No updates in this view.</p>'}</div>
    <div class="updates-pagination"><button class="secondary" type="button" data-updates-page="previous" ${offset ? "" : "disabled"}>${icon("arrow-left")} Previous</button><button class="secondary" type="button" data-updates-page="next" ${latest.hasMore ? "" : "disabled"}>Next ${icon("arrow-right")}</button></div>
    <details class="updates-preferences"><summary>Notification preferences</summary><div>
      <label><input type="checkbox" data-update-preference="reports" ${latest.preferences.reports ? "checked" : ""}> Reports ready</label>
      <label><input type="checkbox" data-update-preference="data" ${latest.preferences.data ? "checked" : ""}> Files needing review</label>
    </div></details>`;
    page.querySelector("#updates-filter").value = filter;
    page.querySelector("#updates-category").value = category;
  }
  async function save(path, body, button) {
    if (button) button.disabled = true;
    try { await api(path, body); if (alive()) { await refresh(); if (path === "updates/preferences") toast("Preferences saved.", `preference:${body.category}:${body.enabled}`); } }
    catch (error) {
      if (button?.type === "checkbox") button.checked = !body.enabled;
      message(error.message || "This change could not be saved. Try again.", true);
      toast("Update could not be saved. Please retry.", `failed:${body.id || path}`);
    }
    finally { if (button?.isConnected) button.disabled = false; }
  }
  bell.onclick = () => {
    if (!enabled) { void refresh(); return; }
    panel.hidden = !panel.hidden;
    bell.setAttribute("aria-expanded", String(!panel.hidden));
  };
  document.addEventListener("click", event => {
    if (!control.contains(event.target)) { panel.hidden = true; bell.setAttribute("aria-expanded", "false"); }
  }, { signal: controller.signal });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !panel.hidden) { panel.hidden = true; bell.setAttribute("aria-expanded", "false"); bell.focus(); }
  }, { signal: controller.signal });
  root.addEventListener("click", event => {
    const open = event.target.closest("[data-update-open]");
    if (open) { void save("updates/state", { id: open.dataset.updateOpen, action: "read" }); return; }
    const state = event.target.closest("[data-update-state]");
    if (state) void save("updates/state", { id: state.dataset.updateState, action: state.dataset.action }, state);
    if (event.target.closest("[data-updates-read-all]")) void save("updates/read-all", { through: snapshotAt }, event.target.closest("button"));
    if (event.target.closest("[data-updates-refresh]")) void refresh({ feedback: true });
    const pagination = event.target.closest("[data-updates-page]");
    if (pagination) { offset = Math.max(0, offset + (pagination.dataset.updatesPage === "next" ? 25 : -25)); void refresh(); }
  }, { signal: controller.signal });
  root.addEventListener("change", event => {
    if (event.target.id === "updates-filter" || event.target.id === "updates-category") {
      if (event.target.id === "updates-filter") filter = event.target.value; else category = event.target.value;
      offset = 0;
      void refresh();
    }
    if (event.target.matches("[data-update-snooze]")) void save("updates/state", { id: event.target.dataset.updateSnooze, action: "snooze", hours: Number(event.target.value) }, event.target);
    if (event.target.matches("[data-update-preference]")) {
      void save("updates/preferences", { category: event.target.dataset.updatePreference, enabled: event.target.checked }, event.target);
    }
  }, { signal: controller.signal });
  const timer = setInterval(() => { if (!document.hidden && navigator.onLine) void refresh(); }, 30000);
  void refresh();
  return () => { disposed = true; clearInterval(timer); controller.abort(); };
}
