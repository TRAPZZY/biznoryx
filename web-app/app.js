import { renderEvidenceReport, reportControls, evidenceDialog, definitionDialog } from "./evidence-report.js";

let csrfToken;
let session;
let dashboard;
let validation;
let pendingVerification;
let billingCheckoutReference;
let navigationVersion = 0;
let activeSeriesKey;
const app = document.querySelector("#app");
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const link = (href, text, cls = "") =>
  `<a href="#${href}" class="${cls}">${text}</a>`;
const wordmark = () =>
  link("/", 'BIZNORYX<span class="wordmark-dot">.</span>', "wordmark");
const money = (cents, currency = dashboard?.profile?.primaryCurrency || "USD") =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number(cents) / 100);
const numberValue = (value) =>
  new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
  }).format(Number(value));
const metricAmount = (item) =>
  item?.metricType === "money"
    ? money(item.metricCents ?? item.revenueCents)
    : numberValue(item?.metricValue ?? Number(item?.metricCents ?? 0) / 100);
const metricChangePercent = (latest, previous) => {
  if (!latest || !previous) return null;
  const current = Number(latest.metricCents ?? latest.revenueCents ?? 0);
  const last = Number(previous.metricCents ?? previous.revenueCents ?? 0);
  if (last === 0) return null;
  return (((current - last) / Math.abs(last)) * 100).toFixed(1);
};
function performanceLineChart(series) {
  const width = 820;
  const height = 280;
  const pad = 42;
  const values = series.map((item) =>
    Number(item.metricCents ?? item.revenueCents ?? 0),
  );
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const span = max - min || 1;
  const points = series.map((item, index) => {
    const x =
      series.length === 1
        ? width / 2
        : pad + (index * (width - pad * 2)) / (series.length - 1);
    const y = height - pad - ((values[index] - min) / span) * (height - pad * 2);
    return { item, x, y };
  });
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
  const area = `${path} L ${points.at(-1).x} ${height - pad} L ${points[0].x} ${height - pad} Z`;
  return `<div class="line-chart" role="img" aria-label="Confirmed performance over time"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><path class="line-area" d="${area}"></path><path class="line-path" d="${path}"></path>${points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="5"></circle>`).join("")}</svg><div class="line-points">${points.map((point) => `<div style="left:${(point.x / width) * 100}%"><strong>${esc(point.item.period)}</strong><span>${esc(metricAmount(point.item))}</span></div>`).join("")}</div></div>`;
}

async function api(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(
      payload.message || "Unable to complete your request. Please try again.",
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}
function mount(html) {
  app.innerHTML = html;
  window.lucide?.createIcons();
}
function bindHeroImageFallback() {
  const image = document.querySelector(".hero-image");
  if (!image) return;
  const fallback = "/hero-dashboard.svg";
  let fallbackApplied = false;
  const applyFallback = () => {
    if (fallbackApplied || image.complete) return;
    fallbackApplied = true;
    image.src = fallback;
  };
  image.addEventListener("error", () => {
    if (fallbackApplied) return;
    fallbackApplied = true;
    image.src = fallback;
  });
  setTimeout(applyFallback, 1800);
}
function go(path) {
  if (location.hash === `#${path}`) route();
  else location.hash = path;
}
function field(label, name, type = "text", value = "", extra = "") {
  return `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra} required></label>`;
}
function message() {
  return '<p class="form-message" role="status" aria-live="polite"></p>';
}
function bindForm(id, action) {
  document.querySelector(id)?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    const output = form.querySelector(".form-message");
    button.disabled = true;
    output.textContent = "Working...";
    try {
      await action(Object.fromEntries(new FormData(form)), form);
    } catch (error) {
      output.textContent = error.message;
      output.classList.add("error-text");
    } finally {
      button.disabled = false;
    }
  });
}

function publicHeader(active = "/") {
  const items = [
    ["/product", "Product"],
    ["/solutions", "Solutions"],
    ["/pricing", "Pricing"],
    ["/security", "Security"],
    ["/resources", "Resources"],
  ];
  return `<header class="public-nav">${wordmark()}<nav aria-label="Main navigation">${items.map(([href, text]) => link(href, text, active === href ? "active" : "")).join("")}</nav><div class="nav-actions">${link(session?.authenticated ? "/dashboard" : "/sign-in", session?.authenticated ? "Open workspace" : "Sign in", "quiet-link")}${link("/register", `$20/mo start ${icon("arrow-up-right")}`, "button primary")}</div></header>`;
}

function landing() {
  mount(`${publicHeader("/")}
    <main><section class="hero"><img class="hero-image" src="/hero-dashboard.svg" alt="BIZNORYX dashboard preview showing verified metrics, trends, actions and outcomes"><div class="hero-shade"></div><div class="hero-copy"><p class="overline">Business performance memory</p><h1>BIZNORYX</h1><h2>Turn business data into evidence, memory and sharper decisions.</h2><p>BIZNORYX helps a company remember how it performs over time. Upload recurring business data, confirm the source, see what moved, and keep an evidence trail behind every report.</p><div class="hero-actions">${link("/register", `Build your workspace ${icon("arrow-right")}`, "button primary")}<a class="hero-secondary" href="#/" data-scroll="story">See the product story ${icon("arrow-down")}</a></div></div><div class="hero-caption"><span>VERIFIED DATA FIRST</span><span>MEMORY OVER ONE-TIME ANALYSIS</span></div></section>
    <section class="intro-band" id="story"><p class="overline">The operating idea</p><h2>Every business deserves a memory that gets smarter every period.</h2><p>Most dashboards reset the conversation every month. BIZNORYX keeps the business profile, uploads, validation evidence, performance history, findings and action record together so every new file strengthens the same operating picture.</p></section>
    <section class="feature-grid"><article><span class="feature-number">01</span>${icon("building-2")}<h3>Business context</h3><p>Capture the model, currency, goals, terms and reporting rhythm so data is interpreted inside the business it belongs to.</p></article><article><span class="feature-number">02</span>${icon("database")}<h3>Generic data intake</h3><p>Bring sales, transactions, inventory, service or operating data into named recurring series with validation before import.</p></article><article><span class="feature-number">03</span>${icon("file-check-2")}<h3>Evidence reports</h3><p>Each confirmed file creates verified facts, movement facts, contribution facts and a source trail instead of decorative metrics.</p></article></section>
    <section class="story-split"><div><p class="overline">Evidence before intelligence</p><h2>The analyst workflow is built in.</h2><p>BIZNORYX profiles the source, checks the metric column, preserves the file checksum, compares the new period to prior confirmed periods and separates calculated facts from interpretation so leaders can trust the report.</p>${link("/product", `Explore the product ${icon("arrow-right")}`, "button dark")}</div><div class="story-panel"><span>01</span><h3>Upload business data</h3><p>Use a named series such as Monthly Sales, Transaction History or Support Tickets.</p><span>02</span><h3>Confirm validation</h3><p>Review rows, schema, metric column, source file and calculation before import.</p><span>03</span><h3>Read the report</h3><p>See what moved, which products, channels or categories contributed, and which facts support the movement.</p></div></section>
    <section class="proof-grid"><div><p class="overline">What the customer sees</p><h2>Upload, validate, compare, decide.</h2><p>The workspace is designed around the recurring management rhythm: add this week or month, compare it against the past, identify measured contributors, and keep the evidence attached to the business.</p></div><article>${icon("line-chart")}<h3>Trend memory</h3><p>Performance lines grow from confirmed periods only.</p></article><article>${icon("scan-search")}<h3>Contribution evidence</h3><p>Top products, channels and categories are calculated from uploaded rows.</p></article><article>${icon("shield-check")}<h3>Governed data</h3><p>Every import is reviewed before it becomes part of the history.</p></article></section>
    <section class="process" id="process"><div><p class="overline">From data to decisions</p><h2>A serious rhythm for running the business.</h2>${link("/register", `Create your workspace ${icon("arrow-right")}`, "button dark")}</div><ol><li><span>01</span><div><h3>Tell us about your business</h3><p>Create the organization and establish the operating profile behind the numbers.</p></div></li><li><span>02</span><div><h3>Add recurring datasets</h3><p>Upload comparable periods for each important business stream.</p></div></li><li><span>03</span><div><h3>Act from evidence</h3><p>Use verified facts and calculated movement to decide what deserves attention.</p></div></li></ol></section><section class="pricing-band"><div><p class="overline">Simple subscription</p><h2>$20/month for one business workspace.</h2><p>Start with one organization, verified email sign-up, multi-file CSV intake, evidence reports, dashboard history and secure member-ready foundations. Paystack checkout is built into the workspace billing flow.</p></div>${link("/pricing", `See pricing ${icon("arrow-right")}`, "button primary")}</section></main><footer>${wordmark()}<p>Business performance, with a memory.</p>${link("/product", "Product")}${link("/pricing", "Pricing")}${link("/security", "Security")}${link("/sign-in", "Sign in")}</footer>`);
  document.querySelectorAll("[data-scroll]").forEach((a) =>
    a.addEventListener("click", (event) => {
      event.preventDefault();
      document
        .getElementById(a.dataset.scroll)
        ?.scrollIntoView({ behavior: "smooth" });
    }),
  );
  bindHeroImageFallback();
}

function publicPage(path) {
  const pages = {
    "/product": {
      kicker: "Product",
      title: "A business performance system, not a spreadsheet wrapper.",
      body: "BIZNORYX connects business profile, data intake, metric history, evidence reports and activity into one tenant-isolated workspace.",
      image:
        "https://images.unsplash.com/photo-1551836022-d5d88e9218df?auto=format&fit=crop&w=2000&q=85",
      sections: [
        ["Business memory", "Keep context, goals, terminology and confirmed periods together."],
        ["Metric discipline", "Every displayed number comes from a confirmed upload and a recorded calculation."],
        ["Operating cadence", "Build a recurring history instead of one-off analysis files."],
      ],
    },
    "/solutions": {
      kicker: "Solutions",
      title: "Built for owners who need to understand what changed.",
      body: "Use BIZNORYX for recurring sales reports, transaction history, inventory movement, service operations and other business datasets where the question is what changed and why it matters.",
      image:
        "https://images.unsplash.com/photo-1450101499163-c8848c66ca85?auto=format&fit=crop&w=2000&q=85",
      sections: [
        ["Retail and commerce", "Track product, channel, location and transaction movement."],
        ["Service businesses", "Monitor tickets, operations, throughput and customer segments."],
        ["Finance teams", "Preserve source evidence behind management reporting."],
      ],
    },
    "/pricing": {
      kicker: "Pricing",
      title: "$20 per month for the BIZNORYX business workspace.",
      body: "One simple monthly plan gives a business the workspace, verified sign-up, recurring CSV data intake, evidence reporting, dashboard history and billing foundation.",
      image:
        "https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?auto=format&fit=crop&w=2000&q=85",
      sections: [
        ["$20/month", "A clear subscription price for public launch."],
        ["Paystack-ready", "The checkout boundary is ready for your Paystack keys and plan code."],
        ["Evidence included", "Reports and dashboards are generated from confirmed uploads."],
      ],
    },
    "/security": {
      kicker: "Security model",
      title: "Tenant isolation and auditability are part of the product.",
      body: "The application protects workspace routes, server-side mutations, CSRF boundaries and organization access. The database model is built around tenant ownership and row-level security.",
      image:
        "https://images.unsplash.com/photo-1563986768609-322da13575f3?auto=format&fit=crop&w=2000&q=85",
      sections: [
        ["Protected sessions", "Authenticated workspace access with CSRF-protected mutations."],
        ["Authorization", "Organization access is checked server-side before every tenant operation."],
        ["Audit trail", "Important data and workspace changes create tenant activity records."],
      ],
    },
    "/resources": {
      kicker: "Resources",
      title: "How teams build a useful business memory.",
      body: "Resources explain the data preparation, reporting cadence and evidence principles that make BIZNORYX more than a one-time analyzer.",
      image:
        "https://images.unsplash.com/photo-1519389950473-47ba0277781c?auto=format&fit=crop&w=2000&q=85",
      sections: [
        ["Upload guide", "Prepare clean CSV files with stable columns across periods."],
        ["Evidence guide", "Read verified facts, movement facts and source lineage."],
        ["Launch guide", "Connect provider secrets, domain, database, storage and compliance evidence."],
      ],
    },
  };
  const page = pages[path] ?? pages["/product"];
  mount(`${publicHeader(path)}<main><section class="public-page-hero"><img src="${page.image}" alt=""><div><p class="overline">${page.kicker}</p><h1>${page.title}</h1><p>${page.body}</p>${link("/register", `Start building ${icon("arrow-right")}`, "button primary")}</div></section><section class="public-detail-grid">${page.sections.map(([title, copy], index) => `<article><span>${String(index + 1).padStart(2, "0")}</span><h2>${title}</h2><p>${copy}</p></article>`).join("")}</section><section class="public-cta"><p class="overline">Ready for real business data</p><h2>Build the workspace, confirm the source, keep the evidence.</h2>${link("/register", `Create your workspace ${icon("arrow-right")}`, "button dark")}</section></main><footer>${wordmark()}<p>Business performance, with a memory.</p>${link("/sign-in", "Sign in")}</footer>`);
}

function auth(register) {
  mount(
    `<div class="auth-layout"><aside class="auth-visual">${wordmark()}<div><p class="overline">Your next chapter starts with clarity</p><h1>Know your business.<br>Build on what<br>you know.</h1><p>A continuous picture of performance, grounded in your own data.</p></div><span>BIZNORYX / BUSINESS PERFORMANCE MEMORY</span></aside><main class="auth-main">${link("/", `${icon("arrow-left")} Back to home`, "back-link")}<div class="auth-form-wrap"><p class="overline">${register ? "Start your workspace" : "Welcome back"}</p><h2>${register ? "A clearer picture starts here." : "Good to see you again."}</h2><p class="muted">${register ? "Create your account, then make it your business." : "Sign in to your business workspace."}</p><form id="auth-form">${register ? field("Full name", "displayName", "text", "", 'autocomplete="name" maxlength="120"') : ""}${field("Work email", "email", "email", "", 'autocomplete="email" maxlength="254"')}${field("Password", "password", "password", "", `minlength="12" maxlength="128" autocomplete="${register ? "new-password" : "current-password"}"`)}${register ? '<p class="input-help">Use at least 12 characters.</p>' : ""}<button class="primary" type="submit">${register ? "Create account" : "Sign in"} ${icon("arrow-right")}</button>${message()}</form><p class="auth-switch">${register ? "Already have an account?" : "New to BIZNORYX?"} ${link(register ? "/sign-in" : "/register", register ? "Sign in" : "Create an account")}</p></div><p class="auth-footer">Your business. Your data. A better perspective.</p></main></div>`,
  );
  bindForm("#auth-form", async (data) => {
    let result;
    try {
      result = await api(register ? "register" : "sign-in", data);
    } catch (error) {
      if (error.payload?.requiresEmailVerification) {
        pendingVerification = {
          email: error.payload.email || data.email,
          reviewCode: error.payload.reviewCode || null,
        };
        go("/verify-email");
        return;
      }
      throw error;
    }
    if (result.requiresEmailVerification) {
      pendingVerification = {
        email: result.email,
        reviewCode: result.reviewCode || null,
      };
      go("/verify-email");
      return;
    }
    csrfToken = result.csrfToken;
    session = { authenticated: true, shell: result.shell };
    dashboard = null;
    validation = null;
    go(result.shell.state === "empty" ? "/business" : "/dashboard");
  });
}

function verifyEmail() {
  const email = pendingVerification?.email || "";
  mount(
    `<div class="auth-layout"><aside class="auth-visual">${wordmark()}<div><p class="overline">Secure sign-up</p><h1>Verify the inbox before the workspace opens.</h1><p>This keeps business workspaces tied to confirmed work emails.</p></div><span>BIZNORYX / EMAIL VERIFICATION</span></aside><main class="auth-main">${link("/sign-in", `${icon("arrow-left")} Back to sign in`, "back-link")}<div class="auth-form-wrap"><p class="overline">One-time code</p><h2>Check your email.</h2><p class="muted">Enter the verification code sent to ${esc(email || "your work email")}.</p>${pendingVerification?.reviewCode ? `<div class="local-code"><span>Local review code</span><strong>${esc(pendingVerification.reviewCode)}</strong></div>` : ""}<form id="verify-form">${field("Work email", "email", "email", email, 'autocomplete="email" maxlength="254"')}${field("Verification code", "code", "text", "", 'inputmode="numeric" autocomplete="one-time-code" maxlength="12"')}<button class="primary" type="submit">Verify and continue ${icon("arrow-right")}</button>${message()}</form><button id="resend-code" class="text-button" type="button">${icon("refresh-cw")} Send a new code</button></div><p class="auth-footer">Codes expire after 10 minutes.</p></main></div>`,
  );
  bindForm("#verify-form", async (data) => {
    const result = await api("auth/verify-email", data);
    csrfToken = result.csrfToken;
    session = { authenticated: true, shell: result.shell };
    dashboard = null;
    validation = null;
    pendingVerification = null;
    go(result.shell.state === "empty" ? "/business" : "/dashboard");
  });
  document.querySelector("#resend-code").onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await api("auth/resend-code", {
        email: document.querySelector('[name="email"]').value,
      });
      pendingVerification = {
        email: result.email,
        reviewCode: result.reviewCode || null,
      };
      verifyEmail();
    } catch (error) {
      document.querySelector(".form-message").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
}

function shell(content, active) {
  const org =
    dashboard?.shell?.activeOrganization || session?.shell?.activeOrganization;
  const orgs =
    dashboard?.shell?.organizations || session?.shell?.organizations || [];
  const subscription = dashboard?.subscription;
  mount(
    `<div class="workspace"><aside class="sidebar">${wordmark()}<div class="org-control"><span class="org-avatar">${esc((org?.name || "B").slice(0, 1).toUpperCase())}</span><label class="sr-only" for="org-switch">Business</label><select id="org-switch" ${orgs.length ? "" : "disabled"}>${orgs.length ? orgs.map((o) => `<option value="${esc(o.id)}" ${o.id === org.id ? "selected" : ""}>${esc(o.name)}</option>`).join("") : "<option>Your workspace</option>"}</select></div><p class="nav-label">WORKSPACE</p><nav aria-label="Workspace">${[
      ["/dashboard", "layout-dashboard", "Overview"],
      ["/data", "database", "Data & uploads"],
      ["/reports", "file-check-2", "Evidence reports"],
      ["/business", "building-2", "Business profile"],
      ["/billing", "credit-card", "Billing"],
      ["/activity", "history", "Activity"],
    ]
      .map(([path, symbol, title]) =>
        link(
          path,
          `${icon(symbol)}<span>${title}</span>`,
          active === path ? "active" : "",
        ),
      )
      .join(
        "",
      )}</nav><div class="sidebar-bottom"><p>Build a history.<br>Make better decisions.</p><button data-sign-out class="text-button">${icon("log-out")} Sign out</button></div></aside><div class="workspace-main"><header class="workspace-top"><span>Workspace <span class="divider">/</span> ${esc(org?.name || "Set up your business")}</span><div class="workspace-top-actions">${subscription ? `<span class="subscription-pill ${subscription.status === "active" ? "active" : ""}">${esc(subscription.status.replaceAll("_", " "))} · ${esc(subscription.priceLabel)}</span>` : ""}<button data-sign-out class="top-sign-out" type="button">${icon("log-out")} Sign out</button><span class="account-avatar" title="${esc(dashboard?.shell?.user?.email || "")}">${esc((dashboard?.shell?.user?.displayName || "You").slice(0, 1))}</span></div></header><main class="workspace-content">${subscriptionBanner(subscription)}${content}</main></div></div>`,
  );
  document.querySelectorAll("[data-sign-out]").forEach((button) => {
    button.onclick = async (event) => {
      const target = event.currentTarget;
      target.disabled = true;
      try {
        await api("sign-out", {});
        session = null;
        dashboard = null;
        validation = null;
        csrfToken = null;
        activeSeriesKey = null;
        go("/");
      } catch (error) {
        target.textContent = error.message;
        target.disabled = false;
      }
    };
  });
  document.querySelector("#org-switch").onchange = async (event) => {
    try {
      await api("organizations/switch", { organizationId: event.target.value });
      validation = null;
      activeSeriesKey = null;
      await route();
    } catch (error) {
      showError(error);
    }
  };
}
function subscriptionBanner(subscription) {
  if (!subscription || subscription.status === "active") return "";
  return `<div class="billing-banner">${icon("credit-card")}<div><strong>${esc(subscription.priceLabel)} BIZNORYX workspace</strong><p>${esc(subscription.nextStep)}</p></div>${link("/billing", "Review billing", "button secondary")}</div>`;
}
function heading(kicker, title, subtitle, action = "") {
  return `<div class="page-heading"><div><p class="overline">${kicker}</p><h1>${title}</h1><p class="muted">${subtitle}</p></div>${action}</div>`;
}

function business() {
  const p = dashboard?.profile || {};
  const hasOrg = Boolean(
    dashboard?.shell?.activeOrganization || session?.shell?.activeOrganization,
  );
  shell(
    `${heading("YOUR BUSINESS", hasOrg ? "Business profile" : "Make this workspace yours.", "The context behind your performance starts here.")}<div class="setup-progress"><span class="complete">${icon("check")} Account</span><span class="current">02 &nbsp; Business</span><span>03 &nbsp; Your data</span></div><div class="form-layout"><form id="business-form" class="business-form"><h2>Business essentials</h2>${field("Business name", "legalName", "text", p.legalName || dashboard?.shell?.activeOrganization?.name || "", 'maxlength="120"')}<div class="form-row">${field("Industry", "industry", "text", p.industry || "", 'placeholder="e.g. Retail, consulting, hospitality" maxlength="120"')}${field("Business model", "businessModel", "text", p.businessModel || "", 'placeholder="e.g. Online product sales" maxlength="200"')}</div><div class="form-row"><label>Reporting currency<select name="primaryCurrency">${["USD", "GBP", "EUR", "NGN", "CAD", "AUD", "INR", "GHS", "KES", "ZAR"].map((c) => `<option ${p.primaryCurrency === c ? "selected" : ""}>${c}</option>`).join("")}</select></label><label>Fiscal year begins<select name="fiscalYearStartMonth">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${p.fiscalYearStartMonth === i + 1 ? "selected" : ""}>${new Date(2026, i, 1).toLocaleString("en", { month: "long" })}</option>`).join("")}</select></label></div>${field("Time zone", "timezone", "text", p.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)}<div class="form-actions"><button type="submit" class="primary">${hasOrg ? "Save business profile" : "Create business"} ${icon("arrow-right")}</button>${hasOrg ? link("/data", "Continue to data", "quiet-link") : ""}</div>${message()}</form><aside class="context-note">${icon("fingerprint")}<h3>More than a company name.</h3><p>Your reporting currency and business context keep your performance history consistent from the first upload onward.</p><hr><p>Confirmed by you.<br>Connected to your business.</p></aside></div>`,
    "/business",
  );
  bindForm("#business-form", async (data) => {
    if (
      !session?.shell?.activeOrganization &&
      !dashboard?.shell?.activeOrganization
    ) {
      const result = await api("organizations", { name: data.legalName });
      session.shell = result.shell;
    }
    await api("onboarding/profile", {
      ...data,
      fiscalYearStartMonth: Number(data.fiscalYearStartMonth),
    });
    go("/data");
  });
}

function dataPage() {
  const uploads = dashboard.uploads;
  shell(
    `${heading("DATA WORKSPACE", "Good decisions start with good data.", "Add one or more reporting files to your business history.")}<div class="data-layout"><form id="upload-form" class="upload-form"><h2>Upload business data</h2><label class="dropzone" id="dropzone">${icon("cloud-upload")}<strong id="file-label">Choose business files</strong><span>or drop them here</span><small>CSV, TSV, JSON, TXT, PDF, XLSX &middot; up to 25 MB each</small><input type="file" name="file" accept=".csv,.tsv,.json,.txt,.pdf,.xlsx,.xls,text/csv,application/json,application/pdf,text/plain" multiple required></label><div class="form-row">${field("Data series", "dataSeries", "text", "Primary performance", 'maxlength="120"')}<label>Data type<select name="dataKind"><option>Sales performance</option><option>Transaction history</option><option>Bank statement</option><option>Inventory movement</option><option>Service operations</option><option>Business dataset</option></select></label></div><div class="form-row">${field("Reporting month", "period", "month", new Date().toISOString().slice(0, 7))}<label>Metric column<input name="metricColumn" type="text" placeholder="Auto-detect, or enter revenue / amount / quantity"></label></div><p class="input-help">Use the same data series and column layout for recurring periods. CSV, TSV, JSON, TXT and text-based PDF statements can be analyzed now. Excel files are accepted for intake review and should be exported as CSV until the audited spreadsheet parser is connected.</p><button type="submit" class="primary">Validate files ${icon("arrow-right")}</button>${message()}</form><aside class="context-note">${icon("shield-check")}<h3>A review before every import.</h3><p>Check the source rows, metric column, schema and reporting period before confirming. Only confirmed data appears in your overview and reports.</p><hr><h4>Your reporting currency</h4><p>${esc(dashboard.profile?.primaryCurrency || "USD")}</p>${link("/business", "Edit business profile", "inline-link")}</aside></div><div id="validation-result">${validation ? validationHtml(validation) : ""}</div><section class="table-section"><div class="section-heading"><h2>Upload history</h2><span>${uploads.length} files</span></div>${uploads.length ? `<div class="table-scroll"><table><thead><tr><th>File</th><th>Type</th><th>Series</th><th>Period</th><th>Metric</th><th>Status</th><th></th></tr></thead><tbody>${uploads.map((u) => `<tr><td>${icon("file-spreadsheet")} ${esc(u.fileName)}</td><td>${esc(u.sourceFormat || u.dataKind || "Business file")}</td><td>${esc(u.dataSeries || "Primary performance")}</td><td>${esc(u.period)}</td><td>${esc(u.metricLabel || "Metric")} ${u.status === "confirmed" || u.status === "awaiting_confirmation" ? `<small>${esc(metricAmount(u))}</small>` : ""}</td><td><span class="status ${u.status === "confirmed" ? "success" : ""}">${esc(u.status.replaceAll("_", " "))}</span></td><td><button class="text-button review-upload" data-id="${u.id}">Review ${icon("arrow-up-right")}</button></td></tr>`).join("")}</tbody></table></div>` : '<div class="small-empty">No uploads yet. Your first confirmed file establishes the baseline for a data series.</div>'}</section>`,
    "/data",
  );
  const fileInput = document.querySelector('[name="file"]');
  fileInput.onchange = () => {
    const files = [...fileInput.files];
    document.querySelector("#file-label").textContent = files.length
      ? `${files.length} file${files.length === 1 ? "" : "s"} selected`
      : "Choose business files";
  };
  const drop = document.querySelector("#dropzone");
  drop.ondragover = (e) => {
    e.preventDefault();
    drop.classList.add("dragging");
  };
  drop.ondragleave = () => drop.classList.remove("dragging");
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove("dragging");
    fileInput.files = e.dataTransfer.files;
    fileInput.onchange();
  };
  bindForm("#upload-form", async (data) => {
    const files = [...document.querySelector('[name="file"]').files];
    if (!files.length) throw new Error("Choose at least one business file.");
    if (files.some((file) => file.size > 25 * 1024 * 1024))
      throw new Error("Choose files smaller than 25 MB each.");
    const result = await api("ingestion/upload", {
      files: await Promise.all(files.map(readFilePayload)),
      period: data.period,
      dataSeries: data.dataSeries,
      dataKind: data.dataKind,
      metricColumn: data.metricColumn,
    });
    validation = result.upload;
    dashboard = await api("dashboard");
    dataPage();
    document
      .querySelector("#validation-result")
      .scrollIntoView({ behavior: "smooth", block: "start" });
  });
  document.querySelectorAll(".review-upload").forEach(
    (b) =>
      (b.onclick = () => {
        validation = uploads.find((u) => u.id === b.dataset.id);
        dataPage();
        document
          .querySelector("#validation-result")
          .scrollIntoView({ behavior: "smooth" });
      }),
  );
  bindForm("#confirm-form", async () => {
    await api("ingestion/confirm", { uploadId: validation.id });
    validation = null;
    go("/dashboard");
  });
}

async function readFilePayload(file) {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  const textLike = ["csv", "tsv", "json", "txt"].includes(extension);
  const payload = {
    fileName: file.name,
    contentType: file.type || "application/octet-stream",
    sizeBytes: file.size,
  };
  if (textLike) {
    payload.content = await file.text();
    return payload;
  }
  payload.contentBase64 = await fileToBase64(file);
  return payload;
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function validationHtml(u) {
  return `<section class="validation"><div class="section-heading"><div><p class="overline">VALIDATION REVIEW</p><h2>${u.issues.length ? "A few things need attention." : u.status === "confirmed" ? "This period is confirmed." : "Your data is ready to review."}</h2></div>${icon(u.issues.length ? "circle-alert" : "circle-check")}</div><p>${esc(u.fileName)} &middot; ${esc(u.sourceFormat || u.dataSeries || "Business file")} &middot; ${u.rowCount} rows &middot; ${esc(u.period)}</p>${u.issues.length ? `<ul class="validation-errors">${u.issues.map((i) => `<li>${i.row ? `Row ${i.row}: ` : ""}${esc(i.message)}</li>`).join("")}</ul>` : `<div class="validation-summary"><span>Data type <strong>${esc(u.dataKind || "Business dataset")}</strong></span><span>Metric column <strong>${esc(u.metricColumn)}</strong></span><span>${esc(u.metricLabel || "Metric")} total <strong>${esc(metricAmount(u))}</strong></span><span>Rows checked <strong>${u.rowCount}</strong></span></div><div class="evidence-preview"><h3>Evidence captured</h3><ul><li><strong>VERIFIED FACT</strong><span>${u.rowCount} row(s), ${u.columns.length} column(s), checksum ${esc(String(u.checksum).slice(0, 12))}</span></li><li><strong>VERIFIED FACT</strong><span>Source processed as ${esc(u.sourceFormat || "business file")}.</span></li><li><strong>VERIFIED FACT</strong><span>Calculation uses sum(${esc(u.metricColumn)}) for ${esc(u.dataSeries || "Primary performance")}.</span></li><li><strong>REPORT READY</strong><span>Confirm this file to generate the evidence report and compare it with prior periods.</span></li></ul></div>${profileSummaryHtml(u)}`}${u.columns?.length ? `<div class="table-scroll"><table><thead><tr>${u.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${u.preview.map((r) => `<tr>${u.columns.map((c) => `<td>${esc(r[c])}</td>`).join("")}</tr>`).join("")}</tbody></table></div><p class="input-help">First ${u.preview.length} rows of ${u.rowCount}. Original content is retained with the import.</p>` : '<p class="input-help">This source is retained for review, but no table rows were extracted for confirmation.</p>'}<form id="confirm-form"><button class="primary" type="submit" ${u.issues.length || u.status === "confirmed" ? "disabled" : ""}>Confirm and add to dashboard ${icon("check")}</button>${message()}</form></section>`;
}

function profileSummaryHtml(u) {
  const numeric = (u.numericProfile || []).slice(0, 4);
  const dimensions = (u.dimensionProfile || []).slice(0, 3);
  const drivers = (u.dimensionBreakdowns || []).slice(0, 3);
  if (!numeric.length && !dimensions.length && !drivers.length) return "";
  return `<div class="profile-summary">${numeric.length ? `<div><h3>Numeric profile</h3>${numeric.map((item) => `<p><strong>${esc(item.label)}</strong><span>${item.valueType === "money" ? money(item.sumCents) : numberValue(Number(item.sumCents) / 100)} total</span></p>`).join("")}</div>` : ""}${dimensions.length ? `<div><h3>Dimension profile</h3>${dimensions.map((item) => `<p><strong>${esc(item.label)}</strong><span>${item.uniqueCount} unique value(s)</span></p>`).join("")}</div>` : ""}${drivers.length ? `<div><h3>Contribution preview</h3>${drivers.map((item) => `<p><strong>${esc(item.label)}</strong><span>${esc(item.topValues[0]?.value || "")} · ${esc(u.metricType === "money" ? money(item.topValues[0]?.sumCents || 0) : numberValue(Number(item.topValues[0]?.sumCents || 0) / 100))}</span></p>`).join("")}</div>` : ""}</div>`;
}

function dashboardGuideHtml() {
  const hasProfile = Boolean(dashboard.profile);
  const confirmed = dashboard.uploads.filter((u) => u.status === "confirmed").length;
  const reports = dashboard.evidenceReports?.length ?? 0;
  const steps = [
    [
      "Set the business context",
      hasProfile
        ? "Business profile saved"
        : "Add your currency, industry and operating model",
      hasProfile,
      "/business",
    ],
    [
      "Upload source data",
      confirmed
        ? `${confirmed} confirmed source file${confirmed === 1 ? "" : "s"}`
        : "CSV, TSV, JSON, TXT and text-based PDF statements",
      confirmed > 0,
      "/data",
    ],
    [
      "Read the evidence report",
      reports
        ? `${reports} fact-based report${reports === 1 ? "" : "s"} ready`
        : "Confirm a source to generate verified facts",
      reports > 0,
      "/reports",
    ],
    [
      "Repeat next period",
      dashboard.series?.length > 1
        ? "Trend memory is active"
        : "Add the next month to reveal movement",
      dashboard.series?.length > 1,
      "/data",
    ],
  ];
  return `<section class="dashboard-guide"><div><p class="overline">How to use BIZNORYX</p><h2>Upload. Confirm. Read evidence. Repeat.</h2><p>BIZNORYX becomes useful when each business dataset is added as a recurring series. The system will not show performance figures until your source is validated and confirmed.</p></div><ol>${steps.map(([title, copy, done, href], index) => `<li class="${done ? "done" : ""}"><span>${done ? icon("check") : String(index + 1).padStart(2, "0")}</span><div><h3>${title}</h3><p>${copy}</p>${link(href, "Open", "inline-link")}</div></li>`).join("")}</ol></section>`;
}

function seriesPickerHtml(groups, activeGroup) {
  if (!groups.length) return "";
  return `<section class="series-picker" aria-label="Choose data series">${groups.map((group) => `<button type="button" data-series-key="${esc(group.key)}" class="${group.key === activeGroup?.key ? "active" : ""}"><span>${esc(group.dataKind)}</span><strong>${esc(group.name)}</strong><small>${group.points.length} period(s)</small></button>`).join("")}</section>`;
}

function bindSeriesPicker() {
  document.querySelectorAll("[data-series-key]").forEach((button) => {
    button.onclick = () => {
      activeSeriesKey = button.dataset.seriesKey;
      overview();
    };
  });
}

function overview() {
  const groups = dashboard.seriesGroups || [];
  const activeGroup =
    groups.find((group) => group.key === activeSeriesKey) ||
    groups.find((group) => group.points.length) ||
    null;
  activeSeriesKey = activeGroup?.key ?? null;
  const series = activeGroup?.points || [];
  const latest = series.at(-1);
  const previous = series.at(-2);
  const change = metricChangePercent(latest, previous);
  shell(
    `${heading("BUSINESS PULSE", "Your business, in perspective.", latest ? `Latest confirmed period: ${esc(latest.period)} · ${esc(activeGroup?.name || latest.dataSeries || "Primary performance")}` : "A fresh start for your performance history.", link("/data", `${icon("plus")} Add data`, "button primary"))}${!dashboard.profile ? `<div class="notice">${icon("building-2")}<div><strong>Let us get to know your business.</strong><p>Set your business context and currency before uploading data.</p></div>${link("/business", "Complete profile", "button secondary")}</div>` : ""}${dashboardGuideHtml()}${seriesPickerHtml(groups, activeGroup)}<div class="metrics-grid"><article><p>${esc(latest?.metricLabel || "Primary metric")} ${icon("activity")}</p><strong>${latest ? metricAmount(latest) : "&mdash;"}</strong><span>${change === null ? "A confirmed period establishes your baseline" : `${Number(change) >= 0 ? "+" : ""}${change}% vs ${esc(previous.period)}`}</span></article><article><p>Source rows ${icon("rows-3")}</p><strong>${latest?.rowCount ?? "&mdash;"}</strong><span>${latest ? `Rows from ${esc(latest.sourceFormat || "confirmed source")}` : "No confirmed data yet"}</span></article><article><p>Evidence reports ${icon("file-check-2")}</p><strong>${dashboard.evidenceReports?.length ?? 0}<small> reports</small></strong><span>${dashboard.evidenceReports?.length ? "Every confirmed file has a source trail" : "Reports generate after confirmation"}</span></article></div><section class="trend-section"><div class="section-heading"><div><h2>${esc(activeGroup?.name || "Primary performance")} over time</h2><p class="muted">${esc(latest?.metricLabel || "Confirmed metric")} · ${esc(activeGroup?.dataKind || "Business data")}</p></div><span class="legend"><i></i> ${esc(latest?.metricLabel || "Metric")}</span></div>${series.length ? performanceLineChart(series) : `<div class="empty-state">${icon("chart-no-axes-combined")}<h3>Your story starts with the first period.</h3><p>Upload and confirm business data to see a verified baseline.<br>Each comparable period adds to the same history.</p>${link("/data", `Upload your first file ${icon("arrow-right")}`, "button dark")}</div>`}</section><section class="series-section"><div class="section-heading"><h2>Business data series</h2>${icon("database")}</div>${groups.length ? `<div class="series-grid">${groups.map((group) => `<article><p>${esc(group.dataKind)}</p><h3>${esc(group.name)}</h3><strong>${group.points.length} period(s)</strong><span>${esc(group.metricLabel)}</span></article>`).join("")}</div>` : '<p class="muted">No confirmed series yet.</p>'}</section><section class="overview-bottom"><div><div class="section-heading"><h2>Data health</h2>${icon("activity")}</div><dl><div><dt>Confirmed files</dt><dd>${dashboard.uploads.filter((u) => u.status === "confirmed").length}</dd></div><div><dt>Awaiting review</dt><dd>${dashboard.uploads.filter((u) => u.status === "awaiting_confirmation").length}</dd></div><div><dt>Needs attention</dt><dd>${dashboard.uploads.filter((u) => u.status === "rejected").length}</dd></div><div><dt>File types seen</dt><dd>${new Set(dashboard.uploads.map((u) => u.sourceFormat || u.fileExtension || "File")).size}</dd></div></dl></div><div><div class="section-heading"><h2>Latest evidence</h2>${icon("file-check-2")}</div>${latest ? `<p class="evidence-name">${esc(latest.fileName)}</p><p class="muted">${latest.rowCount} source rows &middot; ${esc(latest.period)} &middot; ${esc(latest.sourceFormat || latest.dataKind)}</p><span class="verified">${icon("check")} VERIFIED FACT &middot; sum(${esc(latest.metricColumn)})</span>${link("/reports", "Open evidence reports", "inline-link")}` : '<p class="muted">No confirmed sources yet. Figures appear only after you review and confirm your data.</p>'}</div></section>`,
    "/dashboard",
  );
  bindSeriesPicker();
}
let reportOptions = {};
let reportOrganizationId;
let reportRequestVersion = 0;
let currentReport;
async function reports() {
  const organizationId = dashboard.shell.activeOrganization?.id;
  if (organizationId !== reportOrganizationId) {
    reportOrganizationId = organizationId;
    reportOptions = {};
  }
  const requestVersion = ++reportRequestVersion;
  const routeVersion = navigationVersion;
  shell(reportPageHeader() + '<p class="er-loading" role="status">Reading the evidence...</p>', "/reports");
  try {
    const result = await api("evidence-report?" + new URLSearchParams(reportOptions));
    if (requestVersion !== reportRequestVersion || routeVersion !== navigationVersion) return;
    currentReport = result.report;
    if (!currentReport) {
      shell(reportPageHeader() + '<section class="empty-state"><h3>No evidence reports yet.</h3><p>Confirm a source with a measurable numeric column to begin.</p>' + link("/data", "Upload business data", "button dark") + '</section>', "/reports");
      return;
    }
    const report = currentReport;
    reportOptions = { source: report.sourceId, metric: report.metric.column, period: report.current.period,
      compare: report.previous?.period || "none",
      ...(report.controls.dateColumn ? { dateColumn: report.controls.dateColumn } : {}),
      ...(report.controls.dimension ? { dimension: report.controls.dimension } : {}) };
    shell(reportPageHeader(true) + reportControls(report) + '<p class="er-status" role="status" aria-live="polite"></p>' + renderEvidenceReport(report), "/reports");
    bindReportControls();
  } catch (error) {
    if (requestVersion !== reportRequestVersion || routeVersion !== navigationVersion) return;
    shell(reportPageHeader() + '<div class="er-error" role="alert"><p>' + esc(error.message) + '</p><button class="secondary" id="report-retry">Retry report</button></div>', "/reports");
    document.querySelector("#report-retry").onclick = () => { reportOptions = {}; reports(); };
  }
}

function reportPageHeader(ready = false) {
  return '<header class="er-workspace-header"><div><p class="overline">EVIDENCE REPORTS</p><h1>Evidence behind every decision.</h1></div>' + (ready ? '<div class="er-toolbar"><button class="er-icon-button" type="button" data-report-refresh title="Refresh report" aria-label="Refresh report">' + icon("refresh-cw") + '</button><button class="er-icon-button" type="button" data-definition title="Metric definition" aria-label="Metric definition">' + icon("settings-2") + '</button><button class="er-icon-button" type="button" data-report-print title="Print report" aria-label="Print report">' + icon("printer") + '</button><button class="er-icon-button" type="button" data-report-export="csv" title="Export comparison CSV" aria-label="Export comparison CSV">' + icon("table-2") + '</button><button class="primary" type="button" data-report-export="pdf">' + icon("download") + 'Export PDF</button><button class="secondary" type="button" data-report-export="html">' + icon("file-code") + 'Shareable report</button></div>' : "") + '</header>';
}

function bindReportControls() {
  document.querySelector("#report-controls")?.addEventListener("change", async (event) => {
    const key = event.target.name;
    const value = event.target.value;
    if (key === "source") reportOptions = { source: value };
    else if (key === "metric") reportOptions = { source: reportOptions.source, metric: value };
    else if (key === "dateColumn") reportOptions = { source: reportOptions.source, metric: reportOptions.metric, dateColumn: value };
    else {
      reportOptions[key] = value;
      if (key === "period") delete reportOptions.compare;
    }
    await reports();
    document.querySelector('#report-controls [name="' + key + '"]')?.focus();
  });
  document.querySelector("[data-report-refresh]").onclick = () => reports();
  document.querySelector("[data-report-print]").onclick = () => {
    const closed = [...document.querySelectorAll(".evidence-report details:not([open])")];
    closed.forEach((details) => details.open = true);
    window.addEventListener("afterprint", () => closed.forEach((details) => details.open = false), { once: true });
    window.print();
  };
  document.querySelectorAll("[data-evidence]").forEach((button) => {
    button.onclick = () => openReportDialog(evidenceDialog(currentReport, button.dataset.evidence), button);
  });
  document.querySelectorAll("[data-definition]").forEach((button) => {
    button.onclick = () => {
      openReportDialog(definitionDialog(currentReport), button);
      bindForm("#report-definition", async (form) => {
        await api("evidence-report/definition", { ...form, source: currentReport.sourceId, metric: currentReport.metric.column,
          expectedVersion: currentReport.metric.policy?.version ?? 0 });
        document.querySelector("#definition-dialog").close();
        await reports();
        document.querySelector(".er-status").textContent = "Metric definition approved. The report has been recalculated.";
      });
    };
  });
  document.querySelectorAll("[data-report-export]").forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      const status = document.querySelector(".er-status");
      status.textContent = "Preparing the report...";
      try {
        const format = button.dataset.reportExport;
        const response = await fetch("/api/evidence-report?" + new URLSearchParams({ ...reportOptions, format }), { credentials: "same-origin" });
        if (!response.ok) throw new Error((await response.json()).message || "Export failed. Try again.");
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "biznoryx-evidence-" + currentReport.current.period + "." + format;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        status.textContent = "Report downloaded.";
      } catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    };
  });
}

function openReportDialog(html, trigger) {
  document.querySelectorAll(".er-dialog").forEach((dialog) => dialog.remove());
  document.body.insertAdjacentHTML("beforeend", html);
  window.lucide?.createIcons();
  const dialog = document.querySelector(".er-dialog");
  dialog.querySelector("[data-close-dialog]").onclick = () => dialog.close();
  dialog.addEventListener("close", () => { dialog.remove(); trigger?.focus(); }, { once: true });
  dialog.showModal();
}
function billingPage() {
  const subscription = dashboard.subscription;
  shell(
    `${heading("BILLING", "Subscription and checkout", "BIZNORYX is priced at one clear monthly subscription.", subscription?.status === "active" ? "" : `<button id="start-checkout" class="primary" type="button">${icon("credit-card")} Start ${esc(subscription?.priceLabel || "$20.00/mo")} checkout</button>`)}<section class="billing-layout"><article class="billing-plan"><p class="overline">Current plan</p><h2>${esc(subscription?.planName || "BIZNORYX Monthly")}</h2><strong>${esc(subscription?.priceLabel || "$20.00/mo")}</strong><p>${esc(subscription?.nextStep || "Review billing status")}</p><dl><div><dt>Status</dt><dd>${esc(subscription?.status?.replaceAll("_", " ") || "not started")}</dd></div><div><dt>Payment provider</dt><dd>${esc(subscription?.providerConfigured ? "Paystack configured" : "Local review mode")}</dd></div><div><dt>Next renewal</dt><dd>${subscription?.currentPeriodEnd ? esc(new Date(subscription.currentPeriodEnd).toLocaleDateString()) : "After activation"}</dd></div></dl></article><article class="billing-plan muted-plan"><p class="overline">Launch configuration</p><h2>Connect your Paystack account before public launch.</h2><p>The checkout API is ready for PAYSTACK_SECRET_KEY, PAYSTACK_PLAN_CODE, PAYSTACK_CURRENCY, and PUBLIC_APP_URL. Local review uses a simulated completion button so the product flow can be tested safely.</p>${subscription?.checkoutReference && subscription.status !== "active" ? `<button id="complete-review-checkout" class="secondary" type="button">${icon("check")} Complete local review checkout</button>` : ""}<p class="form-message" role="status" aria-live="polite"></p></article></section>`,
    "/billing",
  );
  const start = document.querySelector("#start-checkout");
  if (start) {
    start.onclick = async () => {
      start.disabled = true;
      try {
        const result = await api("billing/checkout", {});
        billingCheckoutReference = result.checkout.reference;
        if (result.checkout.provider === "paystack") {
          location.href = result.checkout.authorizationUrl;
          return;
        }
        dashboard = await api("dashboard");
        billingPage();
      } catch (error) {
        document.querySelector(".form-message").textContent = error.message;
      } finally {
        start.disabled = false;
      }
    };
  }
  const complete = document.querySelector("#complete-review-checkout");
  if (complete) {
    complete.onclick = async () => {
      complete.disabled = true;
      try {
        await api("billing/review-complete", {
          reference:
            billingCheckoutReference || dashboard.subscription.checkoutReference,
        });
        dashboard = await api("dashboard");
        billingPage();
      } catch (error) {
        document.querySelector(".form-message").textContent = error.message;
      } finally {
        complete.disabled = false;
      }
    };
  }
}
function activity() {
  shell(
    `${heading("BUSINESS MEMORY", "Workspace activity", "A record of real changes made in this business.")}${dashboard.auditTrail.length ? `<div class="table-scroll"><table><thead><tr><th>Event</th><th>Record</th><th>When</th></tr></thead><tbody>${dashboard.auditTrail.map((a) => `<tr><td>${esc(a.label)}</td><td>${esc(a.detail)}</td><td>${esc(new Date(a.createdAt).toLocaleString())}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty-state"><h3>No customer activity yet.</h3><p>Business profile changes, uploads, evidence imports, billing actions and member actions will appear here.</p></div>'}`,
    "/activity",
  );
}
function showError(error) {
  mount(
    `<main class="error-page">${wordmark()}${icon("circle-alert")}<h1>We could not load your workspace.</h1><p>${esc(error.message)}</p><button id="retry" class="primary">Try again</button>${link("/sign-in", "Return to sign in", "quiet-link")}</main>`,
  );
  document.querySelector("#retry").onclick = () => route();
}
async function route() {
  const version = ++navigationVersion;
  const rawPath = location.hash.slice(1) || "/";
  const [path, hashQuery = ""] = rawPath.split("?");
  const params = new URLSearchParams(hashQuery);
  if (params.get("checkout")) billingCheckoutReference = params.get("checkout");
  try {
    if (path === "/") return landing();
    if (
      [
        "/product",
        "/solutions",
        "/pricing",
        "/security",
        "/resources",
        "/platform",
        "/evidence",
        "/data-types",
      ].includes(path)
    )
      return publicPage(path);
    if (path === "/verify-email") return verifyEmail();
    if (path === "/sign-in" || path === "/register")
      return auth(path === "/register");
    if (!session?.authenticated) return go("/sign-in");
    if (session.shell.state === "empty") return business();
    app.setAttribute("aria-busy", "true");
    const nextDashboard = await api("dashboard");
    if (version !== navigationVersion) return;
    dashboard = nextDashboard;
    if (path === "/business") business();
    else if (path === "/data") dataPage();
    else if (path === "/reports") await reports();
    else if (path === "/billing") billingPage();
    else if (path === "/activity") activity();
    else overview();
    window.scrollTo(0, 0);
  } catch (error) {
    if (version !== navigationVersion) return;
    if (error.status === 401) {
      session = null;
      dashboard = null;
      validation = null;
      csrfToken = null;
      return go("/sign-in");
    }
    showError(error);
  } finally {
    app.removeAttribute("aria-busy");
  }
}
window.addEventListener("hashchange", route);
try {
  session = await api("session");
  csrfToken = session.csrfToken;
} catch {
  session = null;
}
route();
