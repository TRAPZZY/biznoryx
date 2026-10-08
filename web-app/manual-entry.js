import { parse } from "/vendor/csv-parse.js";

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const clone = (value) => structuredClone(value);
const localMonth = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};

export function mountManualEntry({ container, api, onSubmitted }) {
  let disposed = false;
  let timer;
  let saveInFlight;
  let changed = 0;
  let saved = 0;
  let busy = false;
  let context = { drafts: [], series: [] };
  let draft = { dataSeries: "Sales", period: localMonth(), entryDate: null, columns: [
    { name: "date", type: "date" }, { name: "product", type: "text" },
    { name: "quantity", type: "number" }, { name: "revenue", type: "number" },
  ], rows: [] };
  let issues = [];
  let history = [];
  let future = [];
  let status = "";
  let statusError = false;
  let review = null;
  let retryDispose;

  const current = () => !disposed && container.isConnected;
  const emptyRow = () => draft.columns.map(() => "");
  const icons = () => window.lucide?.createIcons({ root: container });
  const report = (text, error = false) => {
    status = text;
    statusError = error;
    const output = container.querySelector("#entry-status");
    if (output) {
      output.textContent = text;
      output.classList.toggle("error-text", error);
    }
  };
  const record = () => {
    history.push(clone({ columns: draft.columns, rows: draft.rows }));
    if (history.length > 30) history.shift();
    future = [];
  };
  const dirty = () => {
    changed += 1;
    issues = [];
    report("Unsaved changes");
    clearTimeout(timer);
    timer = setTimeout(() => saveDraft().catch(() => {}), 1200);
    updateControls();
  };
  const updateControls = () => {
    for (const node of container.querySelectorAll("button, input, select")) node.disabled = busy;
    const undo = container.querySelector("[data-entry-undo]");
    const redo = container.querySelector("[data-entry-redo]");
    if (undo) undo.disabled = busy || !history.length;
    if (redo) redo.disabled = busy || !future.length;
    for (const button of container.querySelectorAll("[data-move-column]")) {
      const destination = Number(button.dataset.moveColumn) + Number(button.dataset.direction);
      button.disabled = busy || destination < 0 || destination >= draft.columns.length;
    }
  };

  async function saveDraft() {
    clearTimeout(timer);
    if (saveInFlight) {
      await saveInFlight;
      if (saved === changed) return draft;
    }
    if (saved === changed && draft.id) return draft;
    const revision = changed;
    const payload = clone(draft);
    report("Saving draft...");
    saveInFlight = (async () => {
      try {
        const result = await api("ingestion/manual/draft", payload);
        draft.id = result.draft.id;
        draft.version = result.draft.version;
        saved = revision;
        if (current()) {
          report(saved === changed ? "Draft saved" : "Unsaved changes");
          const existing = context.drafts.findIndex((item) => item.id === draft.id);
          if (existing < 0) context.drafts.push(result.draft);
          else context.drafts[existing] = result.draft;
        }
        return draft;
      } catch (error) {
        if (current()) report(error.message, true);
        throw error;
      } finally {
        saveInFlight = null;
      }
    })();
    await saveInFlight;
    if (saved !== changed && current()) {
      timer = setTimeout(() => saveDraft().catch(() => {}), 1200);
    }
    return draft;
  }

  function renderGrid() {
    const scroll = container.querySelector("#entry-grid-scroll");
    const focused = document.activeElement;
    const focusCell = focused?.matches("[data-entry-cell]")
      ? [focused.dataset.row, focused.dataset.column, focused.selectionStart] : null;
    const position = scroll?.scrollLeft ?? 0;
    const host = container.querySelector("#entry-grid");
    if (!host) return;
    host.innerHTML = `<table class="entry-grid" style="min-width:${Math.max(760, draft.columns.length * 180 + 88)}px" aria-label="Business records">
      <thead><tr><th class="entry-row-number" scope="col">#</th>${draft.columns.map((column, index) => `
        <th scope="col"><div class="entry-column-heading"><span>${escape(column.name)}</span>
        <span class="entry-column-actions">
          <button type="button" data-move-column="${index}" data-direction="-1" class="entry-icon-button" aria-label="Move ${escape(column.name)} left" title="Move column left" ${index === 0 ? "disabled" : ""}>${icon("arrow-left")}</button>
          <button type="button" data-move-column="${index}" data-direction="1" class="entry-icon-button" aria-label="Move ${escape(column.name)} right" title="Move column right" ${index === draft.columns.length - 1 ? "disabled" : ""}>${icon("arrow-right")}</button>
        </span></div><small>${escape(column.type)}</small></th>`).join("")}<th scope="col" class="entry-row-action"><span class="sr-only">Remove row</span></th></tr></thead>
      <tbody>${draft.rows.map((row, index) => `<tr><th scope="row" class="entry-row-number">${index + 1}</th>${draft.columns.map((column, col) => {
        const cellIssues = issues.filter((issue) => issue.row === index + 1 && (issue.column === column.name || issue.column === col + 1));
        return `<td class="${cellIssues.length ? "entry-cell-invalid" : ""}"><input data-entry-cell data-row="${index}" data-column="${col}" aria-label="Row ${index + 1}, ${escape(column.name)}" ${["number", "decimal", "numeric", "integer"].includes(column.type) ? 'inputmode="decimal"' : ""} value="${escape(row[col] ?? "")}" maxlength="1000" ${cellIssues.length ? `aria-invalid="true" aria-describedby="entry-error-${index}-${col}"` : ""}>
        ${cellIssues.length ? `<small id="entry-error-${index}-${col}" class="entry-cell-error">${escape(cellIssues[0].message)}</small>` : ""}</td>`;
      }).join("")}<td class="entry-row-action"><button type="button" class="entry-icon-button" data-remove-row="${index}" aria-label="Remove row ${index + 1}" title="Remove row">${icon("trash-2")}</button></td></tr>`).join("")}</tbody>
    </table>`;
    icons();
    if (scroll) scroll.scrollLeft = position;
    if (focusCell) {
      const target = host.querySelector(`[data-row="${focusCell[0]}"][data-column="${focusCell[1]}"]`);
      target?.focus({ preventScroll: true });
      target?.setSelectionRange(focusCell[2], focusCell[2]);
    }
    updateControls();
    for (const button of host.querySelectorAll("[data-move-column]")) {
      const index = Number(button.dataset.moveColumn);
      button.disabled = busy || index + Number(button.dataset.direction) < 0 || index + Number(button.dataset.direction) >= draft.columns.length;
    }
    container.querySelector("#entry-row-count").textContent = `${draft.rows.length} rows`;
  }

  function render() {
    container.innerHTML = `<section class="manual-entry">
      <div class="section-heading"><div><h2>Enter business data</h2></div><span id="entry-row-count">${draft.rows.length} rows</span></div>
      <div class="entry-setup">
        <label>Data series<input id="entry-series" value="${escape(draft.dataSeries)}" maxlength="120" list="entry-series-list" required></label>
        <datalist id="entry-series-list">${context.series.map((series) => `<option value="${escape(series.name || series.displayName)}"></option>`).join("")}</datalist>
        <label>Reporting month<input id="entry-period" type="month" value="${escape(draft.period)}" required></label>
        <label>Saved drafts<select id="entry-drafts"><option value="">New entry</option>${context.drafts.map((item) => `<option value="${escape(item.id)}" ${item.id === draft.id ? "selected" : ""}>${escape(item.dataSeries)} &middot; ${escape(item.period)}${item.correctionOf ? " (correction)" : ""}</option>`).join("")}</select></label>
      </div>
      ${!draft.columns.some((column) => column.type === "date") ? `<label class="entry-date-field">Entry date<input type="date" id="entry-date" value="${escape(draft.entryDate || "")}" required></label>` : ""}
      ${draft.correctionOf ? '<p class="entry-notice">Correction of a submitted batch. The original records remain in your history.</p>' : ""}
      <div class="entry-toolbar">
        <div class="entry-toolbar-group">
          <button type="button" class="secondary" data-add-row>${icon("plus")} Add row</button>
          <button type="button" class="entry-icon-button" data-entry-undo title="Undo" aria-label="Undo">${icon("undo-2")}</button>
          <button type="button" class="entry-icon-button" data-entry-redo title="Redo" aria-label="Redo">${icon("redo-2")}</button>
        </div>
        <button type="button" class="secondary" data-save-draft>${icon("save")} Save draft</button>
      </div>
      <div id="entry-grid-scroll" class="entry-grid-scroll" tabindex="0" aria-label="Record table"><div id="entry-grid"></div></div>
      <div id="entry-issues" class="entry-issues" role="alert"></div>
      <div class="entry-footer"><p id="entry-status" class="form-message ${statusError ? "error-text" : ""}" role="status" aria-live="polite">${escape(status)}</p>
        <button type="button" class="primary" data-validate-entry>${icon("check-check")} Review and submit</button>
      </div>
      <div id="entry-submissions"></div>
      <dialog id="entry-review-dialog" class="entry-review-dialog"><form method="dialog"><div class="section-heading"><h2>Review records</h2><button class="entry-icon-button" title="Close review" aria-label="Close review">${icon("x")}</button></div>
        <div id="entry-review-content"></div><p id="entry-review-message" role="status" class="form-message"></p>
        <div class="form-actions"><button class="secondary" value="cancel">Back to editing</button><button type="button" class="primary" id="entry-confirm-submit">${icon("check")} Submit records</button></div></form></dialog>
    </section>`;
    renderGrid();
    renderSubmissions();
    bind();
  }

  function renderSubmissions() {
    const submissions = context.submissions || [];
    const host = container.querySelector("#entry-submissions");
    host.innerHTML = submissions.length ? `<section class="entry-submission-history"><div class="section-heading"><h3>Submitted entries</h3></div>
      <div class="table-scroll"><table><thead><tr><th>Series</th><th>Month</th><th>Rows</th><th>Submitted</th><th></th></tr></thead><tbody>
      ${submissions.map((entry) => `<tr><td>${escape(entry.dataSeries)}</td><td>${escape(entry.period)}</td><td>${escape(entry.rowCount ?? entry.rows?.length ?? "")}</td><td>${escape(entry.submittedAt ? new Date(entry.submittedAt).toLocaleString() : "")}</td><td><button class="text-button" type="button" data-correct-entry="${escape(entry.id)}">Correct entry</button></td></tr>`).join("")}</tbody></table></div></section>` : "";
  }

  async function switchDraft(id) {
    busy = true;
    updateControls();
    try {
      if (changed !== saved) await saveDraft();
      const result = id ? await api(`ingestion/manual?draftId=${encodeURIComponent(id)}`) : null;
      if (!current()) return;
      draft = result?.draft ? clone(result.draft) : { dataSeries: draft.dataSeries, period: draft.period, columns: clone(draft.columns), rows: [emptyRow()] };
      changed = 0; saved = 0; history = []; future = []; issues = [];
      status = id ? "Draft loaded" : ""; statusError = false;
      busy = false;
      render();
    } catch (error) {
      report(error.message, true);
    } finally {
      busy = false;
      if (current()) updateControls();
    }
  }

  function bind() {
    const grid = container.querySelector("#entry-grid");
    grid.addEventListener("input", (event) => {
      if (!event.target.matches("[data-entry-cell]")) return;
      const row = Number(event.target.dataset.row);
      const column = Number(event.target.dataset.column);
      record();
      draft.rows[row][column] = event.target.value;
      dirty();
    });
    grid.addEventListener("keydown", (event) => {
      if (!event.target.matches("[data-entry-cell]")) return;
      if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const row = Number(event.target.dataset.row) + (event.key === "ArrowUp" ? -1 : 1);
        const column = event.target.dataset.column;
        if (row === draft.rows.length) { record(); draft.rows.push(emptyRow()); dirty(); renderGrid(); }
        grid.querySelector(`[data-row="${row}"][data-column="${column}"]`)?.focus();
      }
    });
    grid.addEventListener("paste", (event) => {
      if (!event.target.matches("[data-entry-cell]")) return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!/[\t\r\n]/.test(text)) return;
      event.preventDefault();
      let rows;
      try {
        if (text.length > 2_000_000) throw new Error("Paste a smaller range.");
        rows = parse(text, { delimiter: "\t", relax_column_count: true, max_record_size: 32_000, skip_empty_lines: true });
      } catch {
        report("This range could not be read. Check its cells and paste a smaller range.", true);
        return;
      }
      const startRow = Number(event.target.dataset.row);
      const startColumn = Number(event.target.dataset.column);
      if (rows.length + startRow > 1000 || rows.some((row) => row.length + startColumn > draft.columns.length || row.some((cell) => cell.length > 1000))) {
        report("The pasted range exceeds this table. Use the same columns and no more than 1,000 rows.", true);
        return;
      }
      record();
      while (draft.rows.length < rows.length + startRow) draft.rows.push(emptyRow());
      rows.forEach((row, r) => row.forEach((cell, c) => { draft.rows[startRow + r][startColumn + c] = cell; }));
      dirty();
      renderGrid();
    });
    grid.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-remove-row]");
      const move = event.target.closest("[data-move-column]");
      if (remove) { record(); draft.rows.splice(Number(remove.dataset.removeRow), 1); dirty(); renderGrid(); }
      if (move && !move.disabled) {
        record();
        const from = Number(move.dataset.moveColumn); const to = from + Number(move.dataset.direction);
        [draft.columns[from], draft.columns[to]] = [draft.columns[to], draft.columns[from]];
        draft.rows.forEach((row) => { [row[from], row[to]] = [row[to], row[from]]; });
        dirty(); renderGrid();
      }
    });
    container.querySelector("[data-add-row]").onclick = () => {
      if (draft.rows.length >= 1000) return report("Each entry can contain up to 1,000 rows.", true);
      record(); draft.rows.push(emptyRow()); dirty(); renderGrid();
      grid.querySelector(`[data-row="${draft.rows.length - 1}"][data-column="0"]`)?.focus();
    };
    for (const attribute of ["data-entry-undo", "data-entry-redo"]) {
      container.querySelector(`[${attribute}]`).onclick = () => {
        const source = attribute === "data-entry-undo" ? history : future;
        const destination = attribute === "data-entry-undo" ? future : history;
        if (!source.length) return;
        destination.push(clone({ columns: draft.columns, rows: draft.rows }));
        const value = source.pop(); draft.columns = value.columns; draft.rows = value.rows;
        // Undo and redo preserve each other's history.
        changed += 1; issues = []; clearTimeout(timer);
        timer = setTimeout(() => saveDraft().catch(() => {}), 1200);
        report("Unsaved changes"); renderGrid();
      };
    }
    container.querySelector("[data-save-draft]").onclick = () => saveDraft().catch(() => {});
    const entryDate = container.querySelector("#entry-date");
    if (entryDate) entryDate.onchange = (event) => { draft.entryDate = event.target.value || null; dirty(); };
    container.querySelector("#entry-series").onchange = async (event) => {
      const value = event.target.value.trim();
      if (draft.id) {
        event.target.value = draft.dataSeries;
        return report("Start a new entry to change its data series.", true);
      }
      const matching = context.series.find((series) => (series.name || series.displayName) === value);
      if (matching?.columns?.length && draft.rows.some((row) => row.some((cell) => cell !== ""))) {
        event.target.value = draft.dataSeries;
        return report("Save these records first, then start a new entry for another series.", true);
      }
      draft.dataSeries = value;
      if (matching?.columns?.length) {
        draft.columns = clone(matching.columns);
        draft.rows = [emptyRow()];
        render();
      }
      dirty();
    };
    container.querySelector("#entry-period").onchange = (event) => {
      if (draft.id) { event.target.value = draft.period; return report("Start a new entry to change its reporting month.", true); }
      draft.period = event.target.value; dirty();
    };
    container.querySelector("#entry-drafts").onchange = (event) => switchDraft(event.target.value);
    container.querySelector("[data-validate-entry]").onclick = async () => {
      busy = true; updateControls(); report("Validating records...");
      try {
        await saveDraft();
        review = await api("ingestion/manual/validate", { draftId: draft.id, version: draft.version });
        if (!current()) return;
        const canonicalColumns = context.drafts.find((item) => item.id === draft.id)?.columns || draft.columns;
        issues = (review.issues || []).map((issue) => ({ ...issue, column: typeof issue.column === "number"
          ? canonicalColumns[issue.column - 1]?.name : issue.column }));
        renderGrid();
        container.querySelector("#entry-issues").textContent = issues.map((issue) => `${issue.row ? `Row ${issue.row}: ` : ""}${issue.message}`).join(" ");
        if (!review.valid) { report("Check the highlighted records before submitting.", true); return; }
        const rowCount = review.rowCount ?? draft.rows.filter((row) => row.some((cell) => cell.trim())).length;
        container.querySelector("#entry-review-content").innerHTML = `<dl class="entry-review-facts"><div><dt>Data series</dt><dd>${escape(draft.dataSeries)}</dd></div><div><dt>Reporting month</dt><dd>${escape(draft.period)}</dd></div><div><dt>New records</dt><dd>${rowCount}</dd></div></dl><p>These records will be added to your monthly history.${draft.correctionOf ? " This correction replaces the selected batch in the monthly total." : ""} Monthly coverage remains partial.</p>`;
        container.querySelector("#entry-review-message").textContent = "";
        container.querySelector("#entry-review-dialog").showModal();
        report("Records validated");
      } catch (error) { report(error.message, true); }
      finally { busy = false; if (current()) updateControls(); }
    };
    container.querySelector("#entry-confirm-submit").onclick = async () => {
      const button = container.querySelector("#entry-confirm-submit");
      const output = container.querySelector("#entry-review-message");
      busy = true; updateControls(); output.textContent = "Submitting records...";
      try {
        const result = await api("ingestion/manual/submit", { draftId: draft.id, version: draft.version, validationId: review.validationId });
        if (!current()) return;
        container.querySelector("#entry-review-dialog").close();
        report("Records submitted. Monthly totals are processing.");
        draft = { dataSeries: draft.dataSeries, period: draft.period, columns: clone(draft.columns), rows: [emptyRow()] };
        changed = 0; saved = 0; history = []; future = []; issues = [];
        try {
          context = await api("ingestion/manual");
          await onSubmitted?.(result);
        } catch {
          context.drafts = context.drafts.filter((item) => item.id !== result.submission?.draftId);
          report("Records submitted. Reload this page to refresh history; do not submit the same records again.", true);
        }
        if (current()) { busy = false; render(); }
      } catch (error) {
        output.textContent = error.message;
        output.classList.add("error-text");
      } finally { busy = false; if (current()) { button.disabled = false; updateControls(); } }
    };
    for (const button of container.querySelectorAll("[data-correct-entry]")) button.onclick = async () => {
      busy = true; updateControls();
      try {
        if (changed !== saved) await saveDraft();
        const result = await api(`ingestion/manual?submissionId=${encodeURIComponent(button.dataset.correctEntry)}`);
        if (!current()) return;
        const entry = result.submission;
        draft = { dataSeries: entry.dataSeries, period: entry.period, columns: clone(entry.columns), rows: clone(entry.rows), entryDate: entry.entryDate ?? null, correctionOf: entry.id };
        changed = 1; saved = 0; history = []; future = []; issues = []; status = "Correction draft";
        busy = false; render();
        await saveDraft();
      } catch (error) { report(error.message, true); }
      finally { busy = false; if (current()) updateControls(); }
    };
  }

  container.innerHTML = '<div class="entry-loading" role="status">Loading data entry...</div>';
  api("ingestion/manual").then((result) => {
    if (!current()) return;
    context = result;
    context.drafts ||= []; context.series ||= [];
    if (result.template?.columns?.length) draft.columns = clone(result.template.columns);
    draft.rows = [emptyRow()];
    render();
  }).catch((error) => {
    if (!current()) return;
    container.innerHTML = `<div class="entry-loading"><p class="error-text" role="alert">${escape(error.message)}</p><button type="button" class="secondary" id="retry-entry">${icon("rotate-cw")} Retry</button></div>`;
    container.querySelector("#retry-entry").onclick = () => {
      disposed = true;
      retryDispose = mountManualEntry({ container, api, onSubmitted });
    };
    icons();
  });
  return () => {
    retryDispose?.();
    clearTimeout(timer);
    if (!disposed && changed !== saved) saveDraft().catch(() => {});
    disposed = true;
    container.querySelector("#entry-review-dialog")?.close();
  };
}
