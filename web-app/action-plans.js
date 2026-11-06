const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const labels = { planned: "Planned", in_progress: "In progress", blocked: "Blocked", completed: "Completed", cancelled: "Cancelled" };
const transitions = { planned: ["planned", "in_progress", "cancelled"], in_progress: ["in_progress", "blocked", "completed", "cancelled"],
  blocked: ["blocked", "in_progress", "cancelled"], completed: ["completed"], cancelled: ["cancelled"] };

export const actionTransitions = status => Object.hasOwn(transitions, status) ? [...transitions[status]] : [];

export function availableFindings(data) {
  const used = new Set((data.actions || []).map(action => action.sourceFindingId));
  const candidates = [data.signals, data.risks, data.opportunities, data.focusAreas].flatMap(items => items || []);
  return [...new Map(candidates.filter(item => item.id && item.status === "active" && !used.has(item.id)).map(item => [item.id, item])).values()];
}

export function renderActionRows(actions, { canWrite = false, userId } = {}) {
  return actions.map(action => {
    const options = actionTransitions(action.status);
    const finding = action.sourceFinding || {};
    return `<article class="action-plan-row" data-action-id="${escape(action.id)}">
      <div class="action-plan-main"><h2>${escape(action.title)}</h2>
        <p class="action-plan-description">${escape(action.description)}</p>
        <div class="action-plan-meta"><span>${action.ownerUserId === userId ? "Assigned to you" : "Assigned to a team member"}</span>
          <span>Due ${action.dueDate ? `<time datetime="${escape(action.dueDate)}">${escape(action.dueDate)}</time>` : "date not set"}</span>
          ${action.metric?.label ? `<span>${escape(action.metric.label)}</span>` : ""}</div>
        <details class="action-plan-evidence"><summary>Source finding</summary><h3>${escape(finding.title || "Finding reference")}</h3>
          <p>${escape(finding.summary || "No summary recorded.")}</p>
          ${action.reportingPeriod?.label ? `<p>${escape(action.reportingPeriod.label)}</p>` : ""}
          <p class="action-plan-reference">Reference: ${escape(action.sourceFindingId)}</p></details></div>
      <div class="action-plan-state">${canWrite && options.length > 1
        ? `<label><span class="sr-only">Status: ${escape(action.title)}</span><select data-action-status="${escape(action.id)}" aria-label="Status: ${escape(action.title)}">${options.map(status => `<option value="${status}" ${status === action.status ? "selected" : ""}>${labels[status]}</option>`).join("")}</select></label>`
        : `<span>${escape(Object.hasOwn(labels, action.status) ? labels[action.status] : "Unknown status")}</span>`}</div></article>`;
  }).join("");
}

export function actionPlansHtml() {
  return `<section id="action-plans" class="action-plans" aria-labelledby="action-plans-heading">
    <header class="action-plans-heading"><h1 id="action-plans-heading">Action plans</h1><div>
      <button class="secondary" data-plans-refresh type="button" title="Refresh action plans">${icon("refresh-cw")} Refresh</button>
      <button class="primary" data-plan-new type="button" hidden>${icon("plus")} New action</button></div></header>
    <p class="action-plans-message" role="status" aria-live="polite">Loading action plans...</p>
    <div class="action-plans-tools"><label>Status<select name="plan-status"><option value="all">All statuses</option>${Object.entries(labels).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
      <label class="action-plans-search">Search<input type="search" name="plan-search" placeholder="Search actions"></label><span class="action-plans-count"></span></div>
    <div class="action-plan-list" aria-live="polite"></div>
    <dialog class="action-plan-dialog" aria-labelledby="action-plan-dialog-title"><form id="action-plan-form">
      <header><h2 id="action-plan-dialog-title">New action</h2><button type="button" data-plan-close class="action-plan-icon" title="Close" aria-label="Close new action">${icon("x")}</button></header>
      <label>Verified finding<select name="findingId" required></select></label><p class="action-plan-source"></p>
      <label>Action title<input name="title" maxlength="200" required></label>
      <label>Steps and resources<textarea name="description" maxlength="4000" rows="4"></textarea></label>
      <div class="action-plan-form-row"><label>Owner<input name="owner" readonly></label><label>Due date<input name="dueDate" type="date"></label></div>
      <p class="action-plan-form-message" role="alert"></p><footer><button type="button" data-plan-close class="secondary">Cancel</button><button type="submit" class="primary">${icon("check")} Save action</button></footer>
    </form></dialog></section>`;
}

export function mountActionPlans({ root, api, initial }) {
  const controller = new AbortController();
  let data = initial, disposed = false, pending = false;
  const alive = () => !disposed && root.isConnected;
  const request = (path, body, method) => api(path, body, { signal: controller.signal, ...(method ? { method } : {}) });
  const message = root.querySelector(".action-plans-message");
  const list = root.querySelector(".action-plan-list");
  const refresh = root.querySelector("[data-plans-refresh]");
  const create = root.querySelector("[data-plan-new]");
  const filter = root.querySelector('[name="plan-status"]');
  const search = root.querySelector('[name="plan-search"]');
  const dialog = root.querySelector("dialog");
  const form = dialog.querySelector("form");
  const formMessage = form.querySelector(".action-plan-form-message");
  const fields = form.elements;
  let candidates = [];
  const access = () => {
    const organizationId = data.shell?.activeOrganization?.id;
    const role = data.shell?.organizations?.find(item => item.id === organizationId)?.role;
    return { canWrite: ["owner", "admin", "analyst"].includes(role), userId: data.shell?.user?.id };
  };
  function status(text, error = false) {
    message.textContent = text;
    message.classList.toggle("error-text", error);
  }
  function render() {
    if (!alive()) return;
    const { canWrite, userId } = access();
    const ready = Array.isArray(data.actions);
    const actions = ready ? data.actions : [];
    candidates = availableFindings(data);
    const query = search.value.trim().toLocaleLowerCase();
    const visible = actions.filter(action => (filter.value === "all" || action.status === filter.value) &&
      `${action.title} ${action.description || ""}`.toLocaleLowerCase().includes(query));
    list.innerHTML = !ready ? "" : visible.length ? renderActionRows(visible, { canWrite, userId })
      : `<p class="action-plans-empty">${actions.length ? "No actions match these filters." : "No action plans yet."}</p>`;
    root.querySelector(".action-plans-count").textContent = `${visible.length} of ${actions.length}`;
    create.hidden = !canWrite || !ready;
    create.disabled = pending || !candidates.length;
    create.title = candidates.length ? "Create an action from a verified finding" : "No active verified findings available";
    refresh.disabled = pending;
    list.querySelectorAll("[data-action-status]").forEach(select => {
      select.disabled = pending;
      select.onchange = () => saveStatus(select.dataset.actionStatus, select.value);
    });
    window.lucide?.createIcons();
  }
  async function reload() {
    const next = await request("dashboard");
    if (!alive()) return;
    if (next.shell?.activeOrganization?.id !== data.shell?.activeOrganization?.id) {
      throw new Error("The selected business changed. Reopen Action plans.");
    }
    if (!Array.isArray(next.actions)) throw new Error("Action plans are unavailable in this environment.");
    data = next;
    render();
  }
  refresh.onclick = async () => {
    if (pending) return;
    pending = true;
    status("Loading action plans...");
    render();
    try { await reload(); if (alive()) status("Action plans refreshed."); }
    catch (error) { if (alive()) status(error.message || "Unable to load action plans.", true); }
    finally { pending = false; render(); }
  };
  filter.onchange = render;
  search.oninput = render;
  create.onclick = () => {
    if (pending || !access().canWrite || !candidates.length) return;
    form.reset();
    fields.namedItem("findingId").innerHTML = candidates.map(item => `<option value="${escape(item.id)}">${escape(item.title)}</option>`).join("");
    fields.namedItem("owner").value = data.shell?.user?.displayName || "You";
    formMessage.textContent = "";
    let previousDefault = "";
    fields.namedItem("findingId").onchange = () => {
      const finding = candidates.find(item => item.id === fields.namedItem("findingId").value);
      const title = fields.namedItem("title");
      if (!title.value || title.value === previousDefault) title.value = finding?.title || "";
      previousDefault = finding?.title || "";
      form.querySelector(".action-plan-source").textContent = finding?.summary || "";
    };
    fields.namedItem("findingId").onchange();
    dialog.showModal();
    fields.namedItem("title").focus();
  };
  form.querySelectorAll("[data-plan-close]").forEach(button => { button.onclick = () => dialog.close(); });
  form.onsubmit = async event => {
    event.preventDefault();
    if (pending || !access().canWrite || !form.reportValidity()) return;
    const findingId = fields.namedItem("findingId").value;
    if (!candidates.some(item => item.id === findingId)) { formMessage.textContent = "Choose an active verified finding."; return; }
    pending = true;
    form.querySelector('[type="submit"]').disabled = true;
    formMessage.textContent = "Saving action...";
    render();
    try {
      await request("actions", { findingId, title: fields.namedItem("title").value, description: fields.namedItem("description").value, dueDate: fields.namedItem("dueDate").value || null });
      if (!alive()) return;
      dialog.close();
      await reload();
      if (alive()) status("Action saved.");
    } catch (error) {
      if (alive()) { formMessage.textContent = error.message || "Unable to confirm the saved action."; status("Unable to confirm the saved action. Refresh before retrying.", true); }
    } finally {
      pending = false;
      if (alive()) form.querySelector('[type="submit"]').disabled = false;
      render();
    }
  };
  async function saveStatus(id, next) {
    if (pending || !access().canWrite) return;
    const action = data.actions?.find(item => item.id === id);
    if (!action || !actionTransitions(action.status).includes(next) || action.status === next) return;
    pending = true;
    status("Saving status...");
    render();
    try {
      await request(`actions/${encodeURIComponent(id)}/status`, { status: next }, "PATCH");
      await reload();
      if (alive()) status("Action status saved.");
    } catch (error) { if (alive()) status(error.message || "Unable to confirm the status. Refresh before retrying.", true); }
    finally { pending = false; render(); }
  }
  status(Array.isArray(data.actions) ? "" : "Action plans are unavailable in this environment.", !Array.isArray(data.actions));
  render();
  return () => { disposed = true; controller.abort(); dialog.close(); };
}
