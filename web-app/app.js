import {
  renderEvidenceReport,
  reportControls,
  evidenceDialog,
  definitionDialog,
  renderReportAnswer,
} from "./evidence-report.js";
import { mountManualEntry } from "./manual-entry.js";
import { mountTrialBilling } from "./trial-billing.js";

let csrfToken;
let session;
let dashboard;
let validation;
let pendingVerification;
let billingCheckoutReference;
let navigationVersion = 0;
let activeSeriesKey;
let dataEntryMode = "upload";
let disposeManualEntry;

const SIDEBAR_STORAGE_KEY = "biznoryx.sidebar.collapsed";
const SIDEBAR_DESKTOP_QUERY = "(min-width: 701px)";
const DEFAULT_UPLOAD_SERIES = new Set([
  "",
  "Primary performance",
  "Business data",
]);

function isSidebarCollapsed() {
  if (!window.matchMedia(SIDEBAR_DESKTOP_QUERY).matches) return false;

  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function setSidebarCollapsed(collapsed) {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // The workspace still works when storage is unavailable.
  }
}

const app = document.querySelector("#app");

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );

const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;

const link = (href, text, cls = "") =>
  `<a href="#${href}" class="${cls}">${text}</a>`;

const wordmark = () =>
  link("/", 'BIZNORYX<span class="wordmark-dot">.</span>', "wordmark");

const money = (
  cents,
  currency = dashboard?.profile?.primaryCurrency || "USD",
) =>
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

const hasMetricAmount = (item) =>
  item?.metricCents !== undefined ||
  item?.revenueCents !== undefined ||
  item?.metricValue !== undefined;

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

    const y =
      height - pad - ((values[index] - min) / span) * (height - pad * 2);

    return { item, x, y };
  });

  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");

  const area =
    `${path} ` +
    `L ${points.at(-1).x} ${height - pad} ` +
    `L ${points[0].x} ${height - pad} Z`;

  return `
    <div
      class="line-chart"
      role="img"
      aria-label="Confirmed performance over time"
    >
      <svg
        viewBox="0 0 ${width} ${height}"
        preserveAspectRatio="none"
      >
        <path
          class="line-area"
          d="${area}"
        ></path>

        <path
          class="line-path"
          d="${path}"
        ></path>

        ${points
          .map(
            (point) =>
              `<circle
                cx="${point.x}"
                cy="${point.y}"
                r="5"
              ></circle>`,
          )
          .join("")}
      </svg>

      <div class="line-points">
        ${points
          .map(
            (point) =>
              `<div style="left:${(point.x / width) * 100}%">
                <strong>${esc(point.item.period)}</strong>
                <span>${esc(metricAmount(point.item))}</span>
              </div>`,
          )
          .join("")}
      </div>
    </div>
  `;
}

async function api(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",

    headers: {
      "Content-Type": "application/json",
      ...(csrfToken
        ? {
            "X-CSRF-Token": csrfToken,
          }
        : {}),
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
  if (location.hash === `#${path}`) {
    route();
  } else {
    location.hash = path;
  }
}

function workspaceEntryPath(shellState) {
  return shellState?.state === "empty" ? "/business" : "/dashboard";
}

function field(label, name, type = "text", value = "", extra = "") {
  return `
    <label>
      ${label}
      <input
        name="${name}"
        type="${type}"
        value="${esc(value)}"
        ${extra}
        required
      >
    </label>
  `;
}

function message() {
  return `
    <p
      class="form-message"
      role="status"
      aria-live="polite"
    ></p>
  `;
}

function bindForm(id, action) {
  document.querySelector(id)?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    const output = form.querySelector(".form-message");

    button.disabled = true;

    if (output) {
      output.textContent = "Working...";
      output.classList.remove("error-text");
    }

    try {
      await action(Object.fromEntries(new FormData(form)), form);
    } catch (error) {
      if (output) {
        output.textContent = error.message;
        output.classList.add("error-text");
      }
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

  return `
    <header class="public-nav">
      ${wordmark()}

      <nav aria-label="Main navigation">
        ${items
          .map(([href, text]) =>
            link(href, text, active === href ? "active" : ""),
          )
          .join("")}
      </nav>

      <div class="nav-actions">
        ${link(
          session?.authenticated ? "/dashboard" : "/sign-in",
          session?.authenticated ? "Open workspace" : "Sign in",
          "quiet-link",
        )}

        ${link(
          "/register",
          `Get started ${icon("arrow-up-right")}`,
          "button primary",
        )}
      </div>
    </header>
  `;
}

function landing() {
  mount(`
    ${publicHeader("/")}

    <main>
      <section class="hero">
        <img
          class="hero-image"
          src="/hero-office.jpg"
          alt="Open office workspace with staff collaborating at desks in a modern professional environment"
        >

        <div class="hero-shade"></div>

        <div class="hero-copy">
          <p class="overline">
            Business performance memory
          </p>

          <h1>BIZNORYX</h1>

          <h2>
            Turn business data into evidence,
            memory and sharper decisions.
          </h2>

          <p>
            BIZNORYX helps a company remember how it
            performs over time. Upload recurring business
            data, confirm the source, see what moved, and
            keep an evidence trail behind every report.
          </p>

          <div class="hero-actions">
            ${link(
              "/register",
              `Build your workspace ${icon("arrow-right")}`,
              "button primary",
            )}

            <a
              class="hero-secondary"
              href="#/"
              data-scroll="story"
            >
              See the product story
              ${icon("arrow-down")}
            </a>
          </div>
        </div>

        <div class="hero-caption">
          <span>VERIFIED DATA FIRST</span>
          <span>MEMORY OVER ONE-TIME ANALYSIS</span>
        </div>
      </section>

      <section
        class="intro-band"
        id="story"
      >
        <p class="overline">
          The operating idea
        </p>

        <h2>
          Every business deserves a memory that gets
          smarter every period.
        </h2>

        <p>
          Most dashboards reset the conversation every
          month. BIZNORYX keeps the business profile,
          uploads, validation evidence, performance
          history, findings and action record together so
          every new file strengthens the same operating
          picture.
        </p>
      </section>

      <section class="feature-grid">
        <article>
          <span class="feature-number">01</span>
          ${icon("building-2")}

          <h3>Business context</h3>

          <p>
            Capture the model, currency, goals, terms and
            reporting rhythm so data is interpreted inside
            the business it belongs to.
          </p>
        </article>

        <article>
          <span class="feature-number">02</span>
          ${icon("database")}

          <h3>Generic data intake</h3>

          <p>
            Bring sales, transactions, inventory, service
            or operating data into named recurring series
            with validation before import.
          </p>
        </article>

        <article>
          <span class="feature-number">03</span>
          ${icon("file-check-2")}

          <h3>Evidence reports</h3>

          <p>
            Each confirmed file creates verified facts,
            movement facts, contribution facts and a source
            trail instead of decorative metrics.
          </p>
        </article>
      </section>

      <section class="story-split">
        <div>
          <p class="overline">
            Evidence before intelligence
          </p>

          <h2>
            The analyst workflow is built in.
          </h2>

          <p>
            BIZNORYX profiles the source, checks the metric
            column, preserves the file checksum, compares
            the new period to prior confirmed periods and
            separates calculated facts from interpretation
            so leaders can trust the report.
          </p>

          ${link(
            "/product",
            `Explore the product ${icon("arrow-right")}`,
            "button dark",
          )}
        </div>

        <div class="story-panel">
          <span>01</span>

          <h3>Upload business data</h3>

          <p>
            Use a named series such as Monthly Sales,
            Transaction History or Support Tickets.
          </p>

          <span>02</span>

          <h3>Confirm validation</h3>

          <p>
            Review rows, schema, metric column, source file
            and calculation before import.
          </p>

          <span>03</span>

          <h3>Read the report</h3>

          <p>
            See what moved, which products, channels or
            categories contributed, and which facts support
            the movement.
          </p>
        </div>
      </section>

      <section class="proof-grid">
        <div>
          <p class="overline">
            What the customer sees
          </p>

          <h2>
            Upload, validate, compare, decide.
          </h2>

          <p>
            The workspace is designed around the recurring
            management rhythm: add this week or month,
            compare it against the past, identify measured
            contributors, and keep the evidence attached to
            the business.
          </p>
        </div>

        <article>
          ${icon("line-chart")}
          <h3>Trend memory</h3>
          <p>
            Performance lines grow from confirmed periods
            only.
          </p>
        </article>

        <article>
          ${icon("scan-search")}
          <h3>Contribution evidence</h3>
          <p>
            Top products, channels and categories are
            calculated from uploaded rows.
          </p>
        </article>

        <article>
          ${icon("shield-check")}
          <h3>Governed data</h3>
          <p>
            Every import is reviewed before it becomes part
            of the history.
          </p>
        </article>
      </section>

      <section
        class="process"
        id="process"
      >
        <div>
          <p class="overline">
            From data to decisions
          </p>

          <h2>
            A serious rhythm for running the business.
          </h2>

          ${link(
            "/register",
            `Create your workspace ${icon("arrow-right")}`,
            "button dark",
          )}
        </div>

        <ol>
          <li>
            <span>01</span>

            <div>
              <h3>
                Tell us about your business
              </h3>

              <p>
                Create the organization and establish the
                operating profile behind the numbers.
              </p>
            </div>
          </li>

          <li>
            <span>02</span>

            <div>
              <h3>
                Add recurring datasets
              </h3>

              <p>
                Upload comparable periods for each
                important business stream.
              </p>
            </div>
          </li>

          <li>
            <span>03</span>

            <div>
              <h3>
                Act from evidence
              </h3>

              <p>
                Use verified facts and calculated movement
                to decide what deserves attention.
              </p>
            </div>
          </li>
        </ol>
      </section>

      <section class="pricing-band">
        <div>
          <p class="overline">
            Simple subscription
          </p>

          <h2>
            ₦40,000/month for one business workspace.
          </h2>

          <p>
            Start with one organization, verified email
            sign-up, multi-file CSV intake, evidence
            reports, dashboard history and secure
            member-ready foundations. Paystack checkout is
            built into the workspace billing flow.
          </p>
        </div>

        ${link(
          "/pricing",
          `See pricing ${icon("arrow-right")}`,
          "button primary",
        )}
      </section>
    </main>

    <footer>
      ${wordmark()}

      <p>
        Business performance, with a memory.
      </p>

      ${link("/product", "Product")}
      ${link("/pricing", "Pricing")}
      ${link("/security", "Security")}
      ${link("/sign-in", "Sign in")}
    </footer>
  `);

  document.querySelectorAll("[data-scroll]").forEach((a) =>
    a.addEventListener("click", (event) => {
      event.preventDefault();

      document.getElementById(a.dataset.scroll)?.scrollIntoView({
        behavior: "smooth",
      });
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
        [
          "Business memory",
          "Keep context, goals, terminology and confirmed periods together.",
        ],

        [
          "Metric discipline",
          "Every displayed number comes from a confirmed upload and a recorded calculation.",
        ],

        [
          "Operating cadence",
          "Build a recurring history instead of one-off analysis files.",
        ],
      ],
    },

    "/solutions": {
      kicker: "Solutions",

      title: "Built for owners who need to understand what changed.",

      body: "Use BIZNORYX for recurring sales reports, transaction history, inventory movement, service operations and other business datasets where the question is what changed and why it matters.",

      image:
        "https://images.unsplash.com/photo-1450101499163-c8848c66ca85?auto=format&fit=crop&w=2000&q=85",

      sections: [
        [
          "Retail and commerce",
          "Track product, channel, location and transaction movement.",
        ],

        [
          "Service businesses",
          "Monitor tickets, operations, throughput and customer segments.",
        ],

        [
          "Finance teams",
          "Preserve source evidence behind management reporting.",
        ],
      ],
    },

    "/pricing": {
      kicker: "Pricing",

      title: "₦40,000 per month for the BIZNORYX business workspace.",

      body: "One simple monthly plan gives a business the workspace, verified sign-up, recurring business-data intake, evidence reporting, dashboard history and billing access.",

      image:
        "https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?auto=format&fit=crop&w=2000&q=85",

      sections: [
        [
          "₦40,000/month",
          "One clear monthly subscription for your BIZNORYX business workspace.",
        ],

        [
          "Secure payments",
          "Monthly subscription payments are processed securely through Paystack.",
        ],

        [
          "Evidence included",
          "Reports and dashboards are generated from verified business data.",
        ],
      ],
    },

    "/security": {
      kicker: "Security model",

      title: "Tenant isolation and auditability are part of the product.",

      body: "The application protects workspace routes, server-side mutations, CSRF boundaries and organization access. The database model is built around tenant ownership and row-level security.",

      image:
        "https://images.unsplash.com/photo-1563986768609-322da13575f3?auto=format&fit=crop&w=2000&q=85",

      sections: [
        [
          "Protected sessions",
          "Authenticated workspace access with CSRF-protected mutations.",
        ],

        [
          "Authorization",
          "Organization access is checked server-side before every tenant operation.",
        ],

        [
          "Audit trail",
          "Important data and workspace changes create tenant activity records.",
        ],
      ],
    },

    "/resources": {
      kicker: "Resources",

      title: "How teams build a useful business memory.",

      body: "Resources explain the data preparation, reporting cadence and evidence principles that make BIZNORYX more than a one-time analyzer.",

      image:
        "https://images.unsplash.com/photo-1519389950473-47ba0277781c?auto=format&fit=crop&w=2000&q=85",

      sections: [
        [
          "Upload guide",
          "Prepare clean CSV files with stable columns across periods.",
        ],

        [
          "Evidence guide",
          "Read verified facts, movement facts and source lineage.",
        ],

        [
          "Launch guide",
          "Connect provider secrets, domain, database, storage and compliance evidence.",
        ],
      ],
    },
  };

  const page = pages[path] ?? pages["/product"];

  mount(`
    ${publicHeader(path)}

    <main>
      <section class="public-page-hero">
        <img
          src="${page.image}"
          alt=""
        >

        <div>
          <p class="overline">
            ${page.kicker}
          </p>

          <h1>
            ${page.title}
          </h1>

          <p>
            ${page.body}
          </p>

          ${link(
            "/register",
            `Start building ${icon("arrow-right")}`,
            "button primary",
          )}
        </div>
      </section>

      <section class="public-detail-grid">
        ${page.sections
          .map(
            ([title, copy], index) => `
              <article>
                <span>
                  ${String(index + 1).padStart(2, "0")}
                </span>

                <h2>
                  ${title}
                </h2>

                <p>
                  ${copy}
                </p>
              </article>
            `,
          )
          .join("")}
      </section>

      <section class="public-cta">
        <p class="overline">
          Ready for real business data
        </p>

        <h2>
          Build the workspace, confirm the source, keep
          the evidence.
        </h2>

        ${link(
          "/register",
          `Create your workspace ${icon("arrow-right")}`,
          "button dark",
        )}
      </section>
    </main>

    <footer>
      ${wordmark()}

      <p>
        Business performance, with a memory.
      </p>

      ${link("/sign-in", "Sign in")}
    </footer>
  `);
}

function auth(register) {
  mount(`
    <div class="auth-layout">
      <aside class="auth-visual">
        ${wordmark()}

        <div>
          <p class="overline">
            Your next chapter starts with clarity
          </p>

          <h1>
            Know your business.<br>
            Build on what<br>
            you know.
          </h1>

          <p>
            A continuous picture of performance,
            grounded in your own data.
          </p>
        </div>

        <span>
          BIZNORYX / BUSINESS PERFORMANCE MEMORY
        </span>
      </aside>

      <main class="auth-main">
        ${link("/", `${icon("arrow-left")} Back to home`, "back-link")}

        <div class="auth-form-wrap">
          <p class="overline">
            ${register ? "Start your workspace" : "Welcome back"}
          </p>

          <h2>
            ${
              register
                ? "A clearer picture starts here."
                : "Good to see you again."
            }
          </h2>

          <p class="muted">
            ${
              register
                ? "Create your account, then make it your business."
                : "Sign in to your business workspace."
            }
          </p>

          <form id="auth-form">
            ${
              register
                ? field(
                    "Full name",
                    "displayName",
                    "text",
                    "",
                    'autocomplete="name" maxlength="120"',
                  )
                : ""
            }

            ${field(
              "Work email",
              "email",
              "email",
              "",
              'autocomplete="email" maxlength="254"',
            )}

            ${field(
              "Password",
              "password",
              "password",
              "",
              `minlength="12" maxlength="128" autocomplete="${
                register ? "new-password" : "current-password"
              }"`,
            )}

            ${
              register
                ? `
                  <p class="input-help">
                    Use at least 12 characters.
                  </p>
                `
                : ""
            }

            ${
              register
                ? ""
                : link(
                    "/password-reset",
                    "Forgot password?",
                    "auth-recovery-link",
                  )
            }

            <button
              class="primary"
              type="submit"
            >
              ${register ? "Create account" : "Sign in"}

              ${icon("arrow-right")}
            </button>

            ${message()}
          </form>

          <p class="auth-switch">
            ${register ? "Already have an account?" : "New to BIZNORYX?"}

            ${link(
              register ? "/sign-in" : "/register",
              register ? "Sign in" : "Create an account",
            )}
          </p>

        </div>

        <p class="auth-footer">
          Your business. Your data. A better perspective.
        </p>
      </main>
    </div>
  `);

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

    session = {
      authenticated: true,
      shell: result.shell,
    };

    dashboard = null;
    validation = null;

    go(workspaceEntryPath(result.shell));
  });

  if (
    !register &&
    new URLSearchParams(location.hash.split("?")[1] ?? "").get("reset") ===
      "success"
  ) {
    document.querySelector("#auth-form .form-message").textContent =
      "Password reset. Sign in with your new password.";
  }
}

function passwordReset() {
  mount(`
    <div class="auth-layout">
      <aside class="auth-visual">
        ${wordmark()}

        <div>
          <p class="overline">Account recovery</p>
          <h1>Get back to your business with a secure reset.</h1>
          <p>We will send a one-time code to your verified email address.</p>
        </div>

        <span>BIZNORYX / ACCOUNT SECURITY</span>
      </aside>

      <main class="auth-main">
        ${link(
          "/sign-in",
          `${icon("arrow-left")} Back to sign in`,
          "back-link",
        )}

        <div class="auth-form-wrap">
          <p class="overline">Password recovery</p>
          <h2>Reset your password.</h2>
          <p class="muted">Request a one-time code, then choose a new password.</p>

          <form id="password-reset-request">
            ${field(
              "Work email",
              "email",
              "email",
              "",
              'autocomplete="email" maxlength="254"',
            )}
            <button class="secondary" type="submit">Send reset code ${icon("mail")}</button>
            ${message()}
          </form>

          <div class="reset-code-preview" hidden></div>

          <form id="password-reset-confirm" hidden>
            <input type="hidden" name="email">
            <label>
              One-time code
              <input name="code" inputmode="numeric" autocomplete="one-time-code" minlength="8" maxlength="8" pattern="[0-9]{8}" required>
            </label>
            <label>
              New password
              <input name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required>
            </label>
            <button class="primary" type="submit">Reset password ${icon("arrow-right")}</button>
            ${message()}
          </form>
        </div>

        <p class="auth-footer">Your business. Your data. A better perspective.</p>
      </main>
    </div>
  `);

  const requestForm = document.querySelector("#password-reset-request");
  const confirmForm = document.querySelector("#password-reset-confirm");
  const preview = document.querySelector(".reset-code-preview");

  bindForm("#password-reset-request", async ({ email }) => {
    const result = await api("auth/password-reset/request", { email });
    confirmForm.elements.email.value = email;
    confirmForm.hidden = false;
    if (result.reviewCode) {
      preview.hidden = false;
      preview.innerHTML = `<span>Local review code</span><strong>${esc(result.reviewCode)}</strong>`;
    }
    requestForm.querySelector("[role=status]").textContent = result.message;
  });

  bindForm("#password-reset-confirm", async ({ email, code, newPassword }) => {
    await api("auth/password-reset/confirm", { email, code, newPassword });
    location.hash = "/sign-in?reset=success";
  });
}

function verifyEmail() {
  const email = pendingVerification?.email || "";

  mount(`
    <div class="auth-layout">
      <aside class="auth-visual">
        ${wordmark()}

        <div>
          <p class="overline">
            Secure sign-up
          </p>

          <h1>
            Verify the inbox before the workspace opens.
          </h1>

          <p>
            This keeps business workspaces tied to
            confirmed work emails.
          </p>
        </div>

        <span>
          BIZNORYX / EMAIL VERIFICATION
        </span>
      </aside>

      <main class="auth-main">
        ${link(
          "/sign-in",
          `${icon("arrow-left")} Back to sign in`,
          "back-link",
        )}

        <div class="auth-form-wrap">
          <p class="overline">
            One-time code
          </p>

          <h2>
            Check your email.
          </h2>

          <p class="muted">
            Enter the verification code sent to
            ${esc(email || "your work email")}.
          </p>

          ${
            pendingVerification?.reviewCode
              ? `
                <div class="local-code">
                  <span>
                    Local review code
                  </span>

                  <strong>
                    ${esc(pendingVerification.reviewCode)}
                  </strong>
                </div>
              `
              : ""
          }

          <form id="verify-form">
            ${field(
              "Work email",
              "email",
              "email",
              email,
              'autocomplete="email" maxlength="254"',
            )}

            ${field(
              "Verification code",
              "code",
              "text",
              "",
              'inputmode="numeric" autocomplete="one-time-code" maxlength="12"',
            )}

            ${field(
              "Choose account password",
              "newPassword",
              "password",
              "",
              'autocomplete="new-password" minlength="12" maxlength="128"',
            )}

            <button
              class="primary"
              type="submit"
            >
              Verify and continue
              ${icon("arrow-right")}
            </button>

            ${message()}
          </form>

          <button
            id="resend-code"
            class="text-button"
            type="button"
          >
            ${icon("refresh-cw")}
            Send a new code
          </button>
        </div>

        <p class="auth-footer">
          Codes expire after 10 minutes.
        </p>
      </main>
    </div>
  `);

  bindForm("#verify-form", async (data) => {
    const result = await api("auth/verify-email", data);

    csrfToken = result.csrfToken;

    session = {
      authenticated: true,
      shell: result.shell,
    };

    dashboard = null;
    validation = null;
    pendingVerification = null;

    go(workspaceEntryPath(result.shell));
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

function policyOnboarding() {
  const policy = session?.shell?.policy || {};

  mount(`
    <div class="policy-gate">
      <div
        class="policy-gate-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="policy-title"
      >
        <aside class="policy-gate-rail">
          ${wordmark()}

          <div>
            <p class="overline">
              ACCOUNT SETUP
            </p>

            <h1>
              Start with clear rules.
            </h1>

            <p>
              Before business data enters the workspace,
              confirm how the account will be used and how
              recurring datasets should be prepared.
            </p>
          </div>

          <div class="policy-progress">
            <span class="active" data-policy-progress="1">
              <strong>01</strong>
              Data & account terms
            </span>

            <span data-policy-progress="2">
              <strong>02</strong>
              Prepare recurring data
            </span>
          </div>

          <button
            id="policy-sign-out"
            class="policy-sign-out"
            type="button"
          >
            ${icon("log-out")}
            Sign out
          </button>
        </aside>

        <main class="policy-gate-main">
          <section
            id="policy-step-one"
            class="policy-step"
          >
            <div class="policy-step-heading">
              <div>
                <p class="overline">
                  1 OF 2 · ACCOUNT & DATA TERMS
                </p>

                <h2 id="policy-title">
                  Before you bring business data into BIZNORYX.
                </h2>
              </div>

              <span class="policy-version">
                Effective
                ${esc(policy.effectiveDate || "2026-10-03")}
              </span>
            </div>

            <p class="policy-lead">
              BIZNORYX processes the business data you
              choose to upload so the workspace can
              validate sources, calculate metrics, compare
              reporting periods and produce evidence-backed
              reports. Your organization remains
              responsible for having a lawful and
              contractual right to submit that data.
            </p>

            <div class="policy-notice-grid">
              <details open>
                <summary>
                  Terms of Use
                </summary>

                <div>
                  <p>
                    Use BIZNORYX only for lawful business
                    purposes and only with information your
                    organization is authorized to process.
                    Source accuracy, business decisions,
                    accounting treatment, tax treatment and
                    regulatory obligations remain the
                    responsibility of your organization.
                  </p>

                  <p>
                    BIZNORYX provides analytical and
                    evidence-management tools. It does not
                    replace legal, accounting, tax,
                    regulatory or professional advice.
                  </p>
                </div>
              </details>

              <details>
                <summary>
                  Data & Privacy Notice
                </summary>

                <div>
                  <p>
                    Uploaded files are processed to provide
                    the workspace features you request,
                    including validation, storage,
                    historical comparison, metrics and
                    evidence reports.
                  </p>

                  <p>
                    Do not upload passwords, authentication
                    secrets, payment-card data, government
                    identity documents, medical records or
                    other highly sensitive personal
                    information unless your organization
                    has a documented lawful basis and the
                    product has been configured for that
                    specific use.
                  </p>
                </div>
              </details>

              <details>
                <summary>
                  Regional responsibility
                </summary>

                <div>
                  <p>
                    Privacy, data-protection, employment,
                    financial, contractual and sector rules
                    differ by country and industry. Your
                    organization is responsible for
                    determining which requirements apply to
                    the data it uploads and for obtaining
                    any required notices, permissions or
                    consents.
                  </p>

                  <p>
                    This acknowledgement records account
                    acceptance; it is not a claim that a
                    particular regulatory framework applies
                    to every BIZNORYX customer.
                  </p>
                </div>
              </details>
            </div>

            <div class="policy-checks">
              <label>
                <input
                  id="policy-terms"
                  type="checkbox"
                >
                <span>
                  I agree to the BIZNORYX Terms of Use.
                </span>
              </label>

              <label>
                <input
                  id="policy-privacy"
                  type="checkbox"
                >
                <span>
                  I have read the Data & Privacy Notice.
                </span>
              </label>

              <label>
                <input
                  id="policy-authority"
                  type="checkbox"
                >
                <span>
                  I confirm I am authorized to upload and
                  process the data I submit.
                </span>
              </label>
            </div>

            <div class="policy-actions">
              <span>
                Acceptance is recorded against this
                account and the current policy version.
              </span>

              <button
                id="policy-next"
                class="primary"
                type="button"
                disabled
              >
                Continue to data guide
                ${icon("arrow-right")}
              </button>
            </div>
          </section>

          <section
            id="policy-step-two"
            class="policy-step"
            hidden
          >
            <div class="policy-step-heading">
              <div>
                <p class="overline">
                  2 OF 2 · DATA SETUP
                </p>

                <h2>
                  Build one reliable history at a time.
                </h2>
              </div>

              <span class="policy-version">
                Current production intake: CSV
              </span>
            </div>

            <p class="policy-lead">
              BIZNORYX becomes more useful when the same
              type of business dataset is uploaded
              repeatedly over time. A data series is the
              history for one kind of information.
            </p>

            <div class="data-guide-rules">
              <article>
                <span>01</span>
                <div>
                  <h3>
                    One dataset type per series
                  </h3>

                  <p>
                    Keep Monthly Sales, Transaction
                    History, Inventory Movement and other
                    datasets in separate named series.
                  </p>
                </div>
              </article>

              <article>
                <span>02</span>
                <div>
                  <h3>
                    Keep the structure stable
                  </h3>

                  <p>
                    If January uses date, product,
                    quantity, revenue and cost, use the
                    same core columns and compatible data
                    types in February and March.
                  </p>
                </div>
              </article>

              <article>
                <span>03</span>
                <div>
                  <h3>
                    Match the reporting month
                  </h3>

                  <p>
                    A file submitted as 2026-09 should
                    represent the September reporting
                    period for that series.
                  </p>
                </div>
              </article>

              <article>
                <span>04</span>
                <div>
                  <h3>
                    Use a meaningful numeric metric
                  </h3>

                  <p>
                    Revenue, amount, sales, gross profit,
                    cost, quantity or total are typical
                    metrics when they exist in the source.
                  </p>
                </div>
              </article>
            </div>

            <div class="series-example">
              <div class="series-example-head">
                <div>
                  <p class="overline">
                    GOOD RECURRING SERIES
                  </p>

                  <h3>
                    Monthly Sales
                  </h3>
                </div>

                <span>
                  Same structure · new period
                </span>
              </div>

              <div class="series-periods">
                <div>
                  <strong>
                    January 2026
                  </strong>
                  <code>
                    date, order_id, product, quantity, revenue, cost
                  </code>
                </div>

                <div>
                  <strong>
                    February 2026
                  </strong>
                  <code>
                    date, order_id, product, quantity, revenue, cost
                  </code>
                </div>

                <div>
                  <strong>
                    March 2026
                  </strong>
                  <code>
                    date, order_id, product, quantity, revenue, cost
                  </code>
                </div>
              </div>
            </div>

            <div class="series-separation">
              <div>
                <strong>
                  Monthly Sales
                </strong>
                <span>
                  Jan → Feb → Mar
                </span>
              </div>

              <div>
                <strong>
                  Transaction History
                </strong>
                <span>
                  Jan → Feb → Mar
                </span>
              </div>

              <div>
                <strong>
                  Inventory Movement
                </strong>
                <span>
                  Jan → Feb → Mar
                </span>
              </div>
            </div>

            <div class="production-upload-note">
              ${icon("file-spreadsheet")}

              <div>
                <strong>
                  Production upload rule
                </strong>

                <p>
                  Use CSV for the current verified
                  recurring-data workflow. Keep each file
                  below 25 MB, include a header row and at
                  least one data row, and avoid duplicate
                  or empty column names.
                </p>
              </div>
            </div>

            <label class="policy-guide-check">
              <input
                id="policy-guide"
                type="checkbox"
              >

              <span>
                I understand that each recurring data
                series should keep a stable structure
                across reporting periods.
              </span>
            </label>

            <p
              id="policy-message"
              class="form-message"
              role="status"
              aria-live="polite"
            ></p>

            <div class="policy-actions">
              <button
                id="policy-back"
                class="secondary"
                type="button"
              >
                ${icon("arrow-left")}
                Back
              </button>

              <button
                id="policy-finish"
                class="primary"
                type="button"
                disabled
              >
                Finish setup
                ${icon("check")}
              </button>
            </div>
          </section>
        </main>
      </div>
    </div>
  `);

  const stepOne = document.querySelector("#policy-step-one");

  const stepTwo = document.querySelector("#policy-step-two");

  const next = document.querySelector("#policy-next");

  const back = document.querySelector("#policy-back");

  const finish = document.querySelector("#policy-finish");

  const messageBox = document.querySelector("#policy-message");

  const terms = document.querySelector("#policy-terms");

  const privacy = document.querySelector("#policy-privacy");

  const authority = document.querySelector("#policy-authority");

  const guide = document.querySelector("#policy-guide");

  const syncFirstStep = () => {
    next.disabled = !(terms.checked && privacy.checked && authority.checked);
  };

  [terms, privacy, authority].forEach((input) => {
    input.addEventListener("change", syncFirstStep);
  });

  guide.addEventListener("change", () => {
    finish.disabled = !guide.checked;
  });

  next.onclick = () => {
    if (next.disabled) {
      return;
    }

    stepOne.hidden = true;
    stepTwo.hidden = false;

    document
      .querySelector('[data-policy-progress="1"]')
      ?.classList.remove("active");

    document
      .querySelector('[data-policy-progress="2"]')
      ?.classList.add("active");

    window.scrollTo(0, 0);
  };

  back.onclick = () => {
    stepTwo.hidden = true;
    stepOne.hidden = false;

    document
      .querySelector('[data-policy-progress="2"]')
      ?.classList.remove("active");

    document
      .querySelector('[data-policy-progress="1"]')
      ?.classList.add("active");

    window.scrollTo(0, 0);
  };

  finish.onclick = async () => {
    if (finish.disabled || !guide.checked) {
      return;
    }

    finish.disabled = true;

    messageBox.textContent = "Saving your account acknowledgement...";

    messageBox.classList.remove("error-text");

    try {
      const result = await api("account/policy-acceptance", {
        termsAccepted: terms.checked,
        privacyAccepted: privacy.checked,
        dataAuthorityAccepted: authority.checked,
        guideAcknowledged: guide.checked,
      });

      session = {
        authenticated: true,
        shell: result.shell,
      };

      dashboard = null;
      validation = null;

      go(workspaceEntryPath(result.shell));
    } catch (error) {
      finish.disabled = !guide.checked;

      messageBox.textContent =
        error?.message || "The acknowledgement could not be saved.";

      messageBox.classList.add("error-text");
    }
  };

  document
    .querySelector("#policy-sign-out")
    ?.addEventListener("click", async () => {
      try {
        await api("sign-out", {});
      } finally {
        session = null;
        dashboard = null;
        validation = null;
        csrfToken = null;
        go("/sign-in");
      }
    });
}

function shell(content, active) {
  const org =
    dashboard?.shell?.activeOrganization || session?.shell?.activeOrganization;

  const orgs =
    dashboard?.shell?.organizations || session?.shell?.organizations || [];

  const subscription = dashboard?.subscription;

  const sidebarCollapsed = isSidebarCollapsed();

  const mobileSidebar = !window.matchMedia(SIDEBAR_DESKTOP_QUERY).matches;

  const navigationItems = [
    ["/dashboard", "layout-dashboard", "Overview"],

    ["/data", "database", "Data & uploads"],

    ["/reports", "file-check-2", "Evidence reports"],

    ["/business", "building-2", "Business profile"],

    ["/billing", "credit-card", "Billing"],

    ["/activity", "history", "Activity"],
  ];

  mount(`
    <div
      class="workspace${sidebarCollapsed ? " sidebar-collapsed" : ""}"
    >
      <aside
        class="sidebar"
        id="workspace-sidebar"
        aria-label="Workspace navigation"
      >
        <div class="sidebar-header">
          ${wordmark()}

          <a
            class="sidebar-compact-brand"
            href="#/"
            aria-label="BIZNORYX home"
          >
            B<span>.</span>
          </a>

          <button
            id="sidebar-toggle"
            class="sidebar-toggle"
            type="button"
            aria-controls="workspace-sidebar"
            aria-expanded="${
              mobileSidebar || sidebarCollapsed ? "false" : "true"
            }"
            aria-label="${
              mobileSidebar
                ? "Open workspace menu"
                : sidebarCollapsed
                  ? "Expand sidebar"
                  : "Collapse sidebar"
            }"
            title="${
              mobileSidebar
                ? "Open workspace menu"
                : sidebarCollapsed
                  ? "Expand sidebar"
                  : "Collapse sidebar"
            }"
          >
            ${icon(
              mobileSidebar
                ? "menu"
                : sidebarCollapsed
                  ? "panel-left-open"
                  : "panel-left-close",
            )}
          </button>
        </div>

        <div
          class="org-control"
          title="${esc(org?.name || "Your workspace")}"
        >
          <span class="org-avatar">
            ${esc((org?.name || "B").slice(0, 1).toUpperCase())}
          </span>

          <label
            class="sr-only"
            for="org-switch"
          >
            Business
          </label>

          <select
            id="org-switch"
            ${orgs.length ? "" : "disabled"}
          >
            ${
              orgs.length
                ? orgs
                    .map(
                      (o) =>
                        `<option
                          value="${esc(o.id)}"
                          ${o.id === org?.id ? "selected" : ""}
                        >
                          ${esc(o.name)}
                        </option>`,
                    )
                    .join("")
                : `
                  <option>
                    Your workspace
                  </option>
                `
            }
          </select>
        </div>

        <p class="nav-label">
          WORKSPACE
        </p>

        <nav aria-label="Workspace">
          ${navigationItems
            .map(
              ([path, symbol, title]) => `
                <a
                  href="#${path}"
                  class="${active === path ? "active" : ""}"
                  aria-label="${esc(title)}"
                  title="${esc(title)}"
                >
                  ${icon(symbol)}

                  <span>
                    ${esc(title)}
                  </span>
                </a>
              `,
            )
            .join("")}
        </nav>

        <div class="sidebar-bottom">
          <p>
            Build a history.<br>
            Make better decisions.
          </p>

          <a
            id="sidebar-help-link"
            class="text-button sidebar-help"
            href="/help.html"
            title="Help & support"
            aria-label="Help & support"
          >
            ${icon("life-buoy")}

            <span>
              Help
            </span>
          </a>

          <button
            data-sign-out
            class="text-button sidebar-sign-out"
            type="button"
            title="Sign out"
            aria-label="Sign out"
          >
            ${icon("log-out")}

            <span>
              Sign out
            </span>
          </button>
        </div>
      </aside>

      <div class="workspace-main">
        <header class="workspace-top">
          <span>
            Workspace

            <span class="divider">
              /
            </span>

            ${esc(org?.name || "Set up your business")}
          </span>

          <div class="workspace-top-actions">
            ${
              subscription
                ? `
                  <span
                    class="subscription-pill ${
                      subscription.status === "active" ? "active" : ""
                    }"
                  >
                    ${esc(subscription.status.replaceAll("_", " "))}
                    ·
                    ${esc(subscription.priceLabel)}
                  </span>
                `
                : ""
            }

            <button
              data-sign-out
              class="top-sign-out"
              type="button"
            >
              ${icon("log-out")}
              Sign out
            </button>

            <span
              class="account-avatar"
              title="${esc(dashboard?.shell?.user?.email || "")}"
            >
              ${esc((dashboard?.shell?.user?.displayName || "You").slice(0, 1))}
            </span>
          </div>
        </header>

        <main class="workspace-content">
          ${subscriptionBanner(subscription)}

          ${content}
        </main>
      </div>
    </div>
  `);

  const sidebarToggle = document.querySelector("#sidebar-toggle");

  document.querySelector("#sidebar-help")?.addEventListener("click", () => {
    const widget = document.querySelector(
      "call-us-selector, call-us, #wp-live-chat-by-3CX",
    );

    if (widget && typeof widget.click === "function") {
      widget.click();
    }

    widget?.scrollIntoView?.({
      block: "end",
      inline: "end",
    });
  });

  sidebarToggle?.addEventListener("click", () => {
    const workspace = document.querySelector(".workspace");

    if (!workspace) {
      return;
    }

    const isMobile = !window.matchMedia(SIDEBAR_DESKTOP_QUERY).matches;

    if (isMobile) {
      const open = workspace.classList.toggle("mobile-nav-open");

      sidebarToggle.setAttribute("aria-expanded", open ? "true" : "false");

      sidebarToggle.setAttribute(
        "aria-label",
        open ? "Close workspace menu" : "Open workspace menu",
      );

      sidebarToggle.setAttribute(
        "title",
        open ? "Close workspace menu" : "Open workspace menu",
      );

      sidebarToggle.innerHTML = icon(open ? "x" : "menu");

      window.lucide?.createIcons();

      return;
    }

    const collapsed = workspace.classList.toggle("sidebar-collapsed");

    setSidebarCollapsed(collapsed);

    sidebarToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");

    sidebarToggle.setAttribute(
      "aria-label",
      collapsed ? "Expand sidebar" : "Collapse sidebar",
    );

    sidebarToggle.setAttribute(
      "title",
      collapsed ? "Expand sidebar" : "Collapse sidebar",
    );

    sidebarToggle.innerHTML = icon(
      collapsed ? "panel-left-open" : "panel-left-close",
    );

    window.lucide?.createIcons();
  });

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

  const orgSwitch = document.querySelector("#org-switch");

  if (orgSwitch) {
    orgSwitch.onchange = async (event) => {
      try {
        await api("organizations/switch", {
          organizationId: event.target.value,
        });

        validation = null;
        activeSeriesKey = null;

        await route();
      } catch (error) {
        showError(error);
      }
    };
  }
}

function subscriptionBanner(subscription) {
  if (!subscription || subscription.status === "active") {
    return "";
  }

  return `
    <div class="billing-banner">
      ${icon("credit-card")}

      <div>
        <strong>
          ${esc(subscription.priceLabel)}
          BIZNORYX workspace
        </strong>

        <p>
          ${esc(subscription.nextStep)}
        </p>
      </div>

      ${link("/billing", "Review billing", "button secondary")}
    </div>
  `;
}

function heading(kicker, title, subtitle, action = "") {
  return `
    <div class="page-heading">
      <div>
        <p class="overline">
          ${kicker}
        </p>

        <h1>
          ${title}
        </h1>

        <p class="muted">
          ${subtitle}
        </p>
      </div>

      ${action}
    </div>
  `;
}

function business() {
  const p = dashboard?.profile || {};

  const hasOrg = Boolean(
    dashboard?.shell?.activeOrganization || session?.shell?.activeOrganization,
  );

  shell(
    `
      ${heading(
        "YOUR BUSINESS",
        hasOrg ? "Business profile" : "Make this workspace yours.",
        "The context behind your performance starts here.",
      )}

      <div class="setup-progress">
        <span class="complete">
          ${icon("check")}
          Account
        </span>

        <span class="current">
          02 &nbsp; Business
        </span>

        <span>
          03 &nbsp; Your data
        </span>
      </div>

      <div class="form-layout">
        <form
          id="business-form"
          class="business-form"
        >
          <h2>
            Business essentials
          </h2>

          ${field(
            "Business name",
            "legalName",
            "text",
            p.legalName || dashboard?.shell?.activeOrganization?.name || "",
            'maxlength="120"',
          )}

          <div class="form-row">
            ${field(
              "Industry",
              "industry",
              "text",
              p.industry || "",
              'placeholder="e.g. Retail, consulting, hospitality" maxlength="120"',
            )}

            ${field(
              "Business model",
              "businessModel",
              "text",
              p.businessModel || "",
              'placeholder="e.g. Online product sales" maxlength="200"',
            )}
          </div>

          <div class="form-row">
            <label>
              Reporting currency

              <select name="primaryCurrency">
                ${[
                  "USD",
                  "GBP",
                  "EUR",
                  "NGN",
                  "CAD",
                  "AUD",
                  "INR",
                  "GHS",
                  "KES",
                  "ZAR",
                ]
                  .map(
                    (c) =>
                      `<option
                        ${p.primaryCurrency === c ? "selected" : ""}
                      >
                        ${c}
                      </option>`,
                  )
                  .join("")}
              </select>
            </label>

            <label>
              Fiscal year begins

              <select name="fiscalYearStartMonth">
                ${Array.from(
                  {
                    length: 12,
                  },
                  (_, i) =>
                    `<option
                      value="${i + 1}"
                      ${p.fiscalYearStartMonth === i + 1 ? "selected" : ""}
                    >
                      ${new Date(2026, i, 1).toLocaleString("en", {
                        month: "long",
                      })}
                    </option>`,
                ).join("")}
              </select>
            </label>
          </div>

          ${field(
            "Time zone",
            "timezone",
            "text",
            p.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
          )}

          <div class="form-actions">
            <button
              type="submit"
              class="primary"
            >
              ${hasOrg ? "Save business profile" : "Create business"}

              ${icon("arrow-right")}
            </button>

            ${hasOrg ? link("/data", "Continue to data", "quiet-link") : ""}
          </div>

          ${message()}
        </form>

        <aside class="context-note">
          ${icon("fingerprint")}

          <h3>
            More than a company name.
          </h3>

          <p>
            Your reporting currency and business context
            keep your performance history consistent from
            the first upload onward.
          </p>

          <hr>

          <p>
            Confirmed by you.<br>
            Connected to your business.
          </p>
        </aside>
      </div>
    `,
    "/business",
  );

  bindForm("#business-form", async (data) => {
    if (
      !session?.shell?.activeOrganization &&
      !dashboard?.shell?.activeOrganization
    ) {
      const result = await api("organizations", {
        name: data.legalName,
      });

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
  disposeManualEntry?.();
  disposeManualEntry = null;
  const uploads = Array.isArray(dashboard?.uploads) ? dashboard.uploads : [];

  shell(
    `
      ${heading(
        "DATA WORKSPACE",
        "Good decisions start with good data.",
        "Add one or more reporting files to your business history.",
      )}

      <div class="data-input-modes" role="tablist" aria-label="Add business data">
        <button id="upload-mode" type="button" role="tab" aria-selected="${dataEntryMode === "upload"}" aria-controls="file-upload-panel">${icon("cloud-upload")} Upload file</button>
        <button id="manual-mode" type="button" role="tab" aria-selected="${dataEntryMode === "manual"}" aria-controls="manual-entry-panel">${icon("table-2")} Enter data</button>
      </div>

      <div id="manual-entry-panel" role="tabpanel" ${dataEntryMode === "manual" ? "" : "hidden"}></div>
      <div id="file-upload-panel" role="tabpanel" class="data-layout" ${dataEntryMode === "upload" ? "" : "hidden"}>
        <form
          id="upload-form"
          class="upload-form"
        >
          <h2>
            Upload business data
          </h2>

          <label
            class="dropzone"
            id="dropzone"
          >
            ${icon("cloud-upload")}

            <strong id="file-label">
              Choose business files
            </strong>

            <span>
              or drop them here
            </span>

            <small>
              CSV, TSV, JSON, TXT, PDF, XLSX
              &middot; up to 25 MB each
            </small>

            <input
              type="file"
              name="file"
              accept=".csv,.tsv,.json,.txt,.pdf,.xlsx,.xls,text/csv,application/json,application/pdf,text/plain"
              multiple
              required
            >
          </label>

          <div class="form-row">
            ${field(
              "Data series",
              "dataSeries",
              "text",
              "Primary performance",
              'maxlength="120"',
            )}

            <label>
              Data type

              <select name="dataKind">
                <option>
                  Sales performance
                </option>

                <option>
                  Transaction history
                </option>

                <option>
                  Bank statement
                </option>

                <option>
                  Inventory movement
                </option>

                <option>
                  Service operations
                </option>

                <option>
                  Business dataset
                </option>
              </select>
            </label>
          </div>

          <div class="form-row">
            ${field(
              "Reporting month",
              "period",
              "month",
              new Date().toISOString().slice(0, 7),
            )}

            <label>
              Metric column

              <input
                name="metricColumn"
                type="text"
                placeholder="Auto-detect, or enter revenue / amount / quantity"
              >
            </label>
          </div>

          <p class="input-help">
            Use the same data series and column layout for
            recurring periods. CSV, TSV, JSON, TXT and
            text-based PDF statements can be analyzed now.
            Excel files are accepted for intake review and
            should be exported as CSV until the audited
            spreadsheet parser is connected.
          </p>

          <button
            type="submit"
            class="primary"
          >
            Validate files
            ${icon("arrow-right")}
          </button>

          ${message()}
        </form>

        <aside class="context-note">
          ${icon("shield-check")}

          <h3>
            A review before every import.
          </h3>

          <p>
            Check the source rows, metric column, schema and
            reporting period before confirming. Only
            confirmed data appears in your overview and
            reports.
          </p>

          <hr>

          <h4>
            Your reporting currency
          </h4>

          <p>
            ${esc(dashboard.profile?.primaryCurrency || "USD")}
          </p>

          ${link("/business", "Edit business profile", "inline-link")}
        </aside>
      </div>

      <div id="validation-result">
        ${validation ? validationHtml(validation) : ""}
      </div>

      <section class="table-section">
        <div class="section-heading">
          <h2>
            Upload history
          </h2>

          <span>
            ${uploads.length} files
          </span>
        </div>

        ${
          uploads.length
            ? `
              <div class="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Type</th>
                      <th>Series</th>
                      <th>Period</th>
                      <th>Metric</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>

                  <tbody>
                    ${uploads
                      .map(
                        (u) => `
                          <tr>
                            <td>
                              ${icon("file-spreadsheet")}

                              ${esc(u.fileName)}
                            </td>

                            <td>
                              ${esc(
                                u.sourceFormat || u.dataKind || "Business file",
                              )}
                            </td>

                            <td>
                              ${esc(u.dataSeries || "Primary performance")}
                            </td>

                            <td>
                              ${esc(u.period || u.periodLabel || "—")}
                            </td>

                            <td>
                              ${esc(u.metricLabel || "Metric")}

                              ${
                                u.status === "confirmed" ||
                                u.status === "awaiting_confirmation"
                                  ? `
                                    <small>
                                      ${esc(metricAmount(u))}
                                    </small>
                                  `
                                  : ""
                              }
                            </td>

                            <td>
                              <span
                                class="status ${
                                  [
                                    "confirmed",
                                    "validated",
                                    "processed",
                                    "ready",
                                  ].includes(u.status)
                                    ? "success"
                                    : ""
                                }"
                              >
                                ${esc(
                                  String(u.status || "unknown").replaceAll(
                                    "_",
                                    " ",
                                  ),
                                )}
                              </span>
                            </td>

                            <td>
                              <button
                                class="text-button review-upload"
                                data-id="${u.id}"
                                type="button"
                              >
                                Review
                                ${icon("arrow-up-right")}
                              </button>
                            </td>
                          </tr>
                        `,
                      )
                      .join("")}
                  </tbody>
                </table>
              </div>
            `
            : `
              <div class="small-empty">
                No uploads yet. Your first confirmed file
                establishes the baseline for a data series.
              </div>
            `
        }
      </section>
    `,
    "/data",
  );

  const manualPanel = document.querySelector("#manual-entry-panel");
  const uploadPanel = document.querySelector("#file-upload-panel");
  const setInputMode = (mode) => {
    dataEntryMode = mode;
    manualPanel.hidden = mode !== "manual";
    uploadPanel.hidden = mode !== "upload";
    document.querySelector("#upload-mode").setAttribute("aria-selected", String(mode === "upload"));
    document.querySelector("#manual-mode").setAttribute("aria-selected", String(mode === "manual"));
    if (mode === "manual" && !disposeManualEntry) {
      disposeManualEntry = mountManualEntry({
        container: manualPanel,
        api,
        onSubmitted: async () => { dashboard = await api("dashboard"); },
      });
    }
  };
  document.querySelector("#upload-mode").onclick = () => setInputMode("upload");
  document.querySelector("#manual-mode").onclick = () => setInputMode("manual");
  setInputMode(dataEntryMode);

  const fileInput = document.querySelector('[name="file"]');

  if (fileInput) {
    fileInput.onchange = () => {
      const files = [...fileInput.files];

      const fileLabel = document.querySelector("#file-label");

      if (fileLabel) {
        fileLabel.textContent = files.length
          ? `${files.length} file${files.length === 1 ? "" : "s"} selected`
          : "Choose business files";
      }
    };
  }

  const dataKindSelect = document.querySelector('[name="dataKind"]');

  const dataSeriesInput = document.querySelector('[name="dataSeries"]');

  if (dataKindSelect && dataSeriesInput) {
    dataKindSelect.onchange = () => {
      if (
        dataKindSelect.value !== "Sales performance" &&
        DEFAULT_UPLOAD_SERIES.has(dataSeriesInput.value.trim())
      ) {
        dataSeriesInput.value = dataKindSelect.value;
      }
    };
  }

  const drop = document.querySelector("#dropzone");

  if (drop && fileInput) {
    drop.ondragover = (e) => {
      e.preventDefault();

      drop.classList.add("dragging");
    };

    drop.ondragleave = () => drop.classList.remove("dragging");

    drop.ondrop = (e) => {
      e.preventDefault();

      drop.classList.remove("dragging");

      try {
        fileInput.files = e.dataTransfer.files;
      } catch {
        return;
      }

      fileInput.onchange();
    };
  }

  bindForm("#upload-form", async (data) => {
    const files = [...document.querySelector('[name="file"]').files];

    if (!files.length) {
      throw new Error("Choose at least one business file.");
    }

    if (files.some((file) => file.size > 25 * 1024 * 1024)) {
      throw new Error("Choose files smaller than 25 MB each.");
    }

    const result = await api("ingestion/upload", {
      files: await Promise.all(files.map(readFilePayload)),

      period: data.period,

      dataSeries: data.dataSeries,

      dataKind: data.dataKind,

      metricColumn: data.metricColumn,
    });

    validation =
      result?.upload ||
      (Array.isArray(result?.uploads) ? result.uploads[0] || null : null);

    dashboard = await api("dashboard");

    dataPage();

    document.querySelector("#validation-result")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  });

  document.querySelectorAll(".review-upload").forEach((button) => {
    button.onclick = () => {
      validation =
        uploads.find((upload) => upload.id === button.dataset.id) || null;

      dataPage();

      document.querySelector("#validation-result")?.scrollIntoView({
        behavior: "smooth",
      });
    };
  });

  bindForm("#confirm-form", async () => {
    if (!validation?.id) {
      throw new Error("No upload is selected for confirmation.");
    }

    await api("ingestion/confirm", {
      uploadId: validation.id,
    });

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
  if (!u) {
    return "";
  }

  const issues = Array.isArray(u.issues) ? u.issues : [];

  const columns = Array.isArray(u.columns) ? u.columns : [];

  const preview = Array.isArray(u.preview) ? u.preview : [];

  const rowCount = Number.isFinite(Number(u.rowCount ?? u.sourceRowCount))
    ? Number(u.rowCount ?? u.sourceRowCount)
    : 0;

  const isConfirmed = ["confirmed", "validated", "processed", "ready"].includes(
    u.status,
  );

  return `
    <section class="validation">
      <div class="section-heading">
        <div>
          <p class="overline">
            VALIDATION REVIEW
          </p>

          <h2>
            ${
              issues.length
                ? "A few things need attention."
                : isConfirmed
                  ? "This source has passed validation."
                  : "Your data is ready to review."
            }
          </h2>
        </div>

        ${icon(issues.length ? "circle-alert" : "circle-check")}
      </div>

      <p>
        ${esc(u.fileName || "Business file")}
        &middot;
        ${esc(u.sourceFormat || u.dataSeries || "Business file")}
        &middot;
        ${rowCount} rows
        &middot;
        ${esc(u.period || u.periodLabel || "Reporting period")}
      </p>

      ${
        issues.length
          ? `
            <ul class="validation-errors">
              ${issues
                .map(
                  (issue) => `
                    <li>
                      ${issue?.row ? `Row ${esc(issue.row)}: ` : ""}

                      ${esc(issue?.message || "Validation issue")}
                    </li>
                  `,
                )
                .join("")}
            </ul>
          `
          : `
            <div class="validation-summary">
              <span>
                Data type
                <strong>
                  ${esc(u.dataKind || u.sourceFormat || "Business dataset")}
                </strong>
              </span>

              <span>
                Metric column
                <strong>
                  ${esc(u.metricColumn || u.sourceColumn || "Auto-detected")}
                </strong>
              </span>

              <span>
                ${
                  hasMetricAmount(u)
                    ? `${esc(u.metricLabel || "Metric")} total`
                    : "Processing status"
                }

                <strong>
                  ${
                    hasMetricAmount(u)
                      ? esc(metricAmount(u))
                      : esc(
                          String(u.status || "validated").replaceAll("_", " "),
                        )
                  }
                </strong>
              </span>

              <span>
                Rows checked
                <strong>
                  ${rowCount}
                </strong>
              </span>
            </div>

            ${
              rowCount || columns.length || u.checksum
                ? `
                  <div class="evidence-preview">
                    <h3>
                      Evidence captured
                    </h3>

                    <ul>
                      <li>
                        <strong>
                          VERIFIED FACT
                        </strong>

                        <span>
                          ${rowCount}
                          row(s),
                          ${columns.length}
                          column(s)${
                            u.checksum
                              ? `, checksum ${esc(
                                  String(u.checksum).slice(0, 12),
                                )}`
                              : ""
                          }
                        </span>
                      </li>

                      <li>
                        <strong>
                          VERIFIED FACT
                        </strong>

                        <span>
                          Source processed as
                          ${esc(u.sourceFormat || "business file")}.
                        </span>
                      </li>

                      ${
                        u.metricColumn || u.sourceColumn
                          ? `
                            <li>
                              <strong>
                                VERIFIED FACT
                              </strong>

                              <span>
                                Metric source:
                                ${esc(u.metricColumn || u.sourceColumn)}.
                              </span>
                            </li>
                          `
                          : ""
                      }

                      <li>
                        <strong>
                          REPORT READY
                        </strong>

                        <span>
                          Verified processing adds this source
                          to the business evidence history${
                            hasMetricAmount(u)
                              ? "."
                              : " after the worker derives metrics."
                          }
                        </span>
                      </li>
                    </ul>
                  </div>

                  ${profileSummaryHtml(u)}
                `
                : ""
            }
          `
      }

      ${
        columns.length && preview.length
          ? `
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    ${columns
                      .map(
                        (column) =>
                          `<th>
                            ${esc(column)}
                          </th>`,
                      )
                      .join("")}
                  </tr>
                </thead>

                <tbody>
                  ${preview
                    .map(
                      (row) => `
                        <tr>
                          ${columns
                            .map(
                              (column) =>
                                `<td>
                                  ${esc(row?.[column])}
                                </td>`,
                            )
                            .join("")}
                        </tr>
                      `,
                    )
                    .join("")}
                </tbody>
              </table>
            </div>

            <p class="input-help">
              First
              ${preview.length}
              rows of
              ${rowCount}.
              Original content is retained with the
              import.
            </p>
          `
          : `
            <p class="input-help">
              This source is retained for review. A table
              preview is shown when structured rows are
              available.
            </p>
          `
      }

      ${
        u.status === "awaiting_confirmation"
          ? `
            <form id="confirm-form">
              <button
                class="primary"
                type="submit"
                ${issues.length ? "disabled" : ""}
              >
                Confirm and add to dashboard
                ${icon("check")}
              </button>

              ${message()}
            </form>
          `
          : ""
      }
    </section>
  `;
}

function profileSummaryHtml(u) {
  const numeric = (u.numericProfile || []).slice(0, 4);

  const dimensions = (u.dimensionProfile || []).slice(0, 3);

  const drivers = (u.dimensionBreakdowns || []).slice(0, 3);

  if (!numeric.length && !dimensions.length && !drivers.length) {
    return "";
  }

  return `
    <div class="profile-summary">
      ${
        numeric.length
          ? `
            <div>
              <h3>
                Numeric profile
              </h3>

              ${numeric
                .map(
                  (item) => `
                    <p>
                      <strong>
                        ${esc(item.label)}
                      </strong>

                      <span>
                        ${
                          item.valueType === "money"
                            ? money(item.sumCents)
                            : numberValue(Number(item.sumCents) / 100)
                        }
                        total
                      </span>
                    </p>
                  `,
                )
                .join("")}
            </div>
          `
          : ""
      }

      ${
        dimensions.length
          ? `
            <div>
              <h3>
                Dimension profile
              </h3>

              ${dimensions
                .map(
                  (item) => `
                    <p>
                      <strong>
                        ${esc(item.label)}
                      </strong>

                      <span>
                        ${item.uniqueCount}
                        unique value(s)
                      </span>
                    </p>
                  `,
                )
                .join("")}
            </div>
          `
          : ""
      }

      ${
        drivers.length
          ? `
            <div>
              <h3>
                Contribution preview
              </h3>

              ${drivers
                .map(
                  (item) => `
                    <p>
                      <strong>
                        ${esc(item.label)}
                      </strong>

                      <span>
                        ${esc(item.topValues[0]?.value || "")}
                        ·
                        ${esc(
                          u.metricType === "money"
                            ? money(item.topValues[0]?.sumCents || 0)
                            : numberValue(
                                Number(item.topValues[0]?.sumCents || 0) / 100,
                              ),
                        )}
                      </span>
                    </p>
                  `,
                )
                .join("")}
            </div>
          `
          : ""
      }
    </div>
  `;
}

function dashboardGuideHtml() {
  const hasProfile = Boolean(dashboard.profile);

  const confirmed = dashboard.uploads.filter(
    (u) => u.status === "confirmed",
  ).length;

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

  return `
    <section class="dashboard-guide">
      <div>
        <p class="overline">
          How to use BIZNORYX
        </p>

        <h2>
          Upload. Confirm. Read evidence. Repeat.
        </h2>

        <p>
          BIZNORYX becomes useful when each business dataset
          is added as a recurring series. The system will
          not show performance figures until your source is
          validated and confirmed.
        </p>
      </div>

      <ol>
        ${steps
          .map(
            ([title, copy, done, href], index) => `
              <li
                class="${done ? "done" : ""}"
              >
                <span>
                  ${done ? icon("check") : String(index + 1).padStart(2, "0")}
                </span>

                <div>
                  <h3>
                    ${title}
                  </h3>

                  <p>
                    ${copy}
                  </p>

                  ${link(href, "Open", "inline-link")}
                </div>
              </li>
            `,
          )
          .join("")}
      </ol>
    </section>
  `;
}

function seriesPickerHtml(groups, activeGroup) {
  if (!groups.length) {
    return "";
  }

  return `
    <section
      class="series-picker"
      aria-label="Choose data series"
    >
      ${groups
        .map(
          (group) => `
            <button
              type="button"
              data-series-key="${esc(group.key)}"
              class="${group.key === activeGroup?.key ? "active" : ""}"
            >
              <span>
                ${esc(group.dataKind)}
              </span>

              <strong>
                ${esc(group.name)}
              </strong>

              <small>
                ${group.points.length}
                period(s)
              </small>
            </button>
          `,
        )
        .join("")}
    </section>
  `;
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
  const profile = dashboard?.profile || {};

  const uploads = Array.isArray(dashboard?.uploads) ? dashboard.uploads : [];

  const reports = Array.isArray(dashboard?.evidenceReports)
    ? dashboard.evidenceReports
    : [];

  const metricSeries = Array.isArray(dashboard?.series)
    ? dashboard.series
        .filter(
          (item) => item && Array.isArray(item.points) && item.points.length,
        )
        .map((item) => ({
          ...item,
          points: [...item.points].sort((left, right) => {
            const leftTime = new Date(
              left?.periodStart || left?.createdAt || 0,
            ).getTime();

            const rightTime = new Date(
              right?.periodStart || right?.createdAt || 0,
            ).getTime();

            return leftTime - rightTime;
          }),
        }))
    : [];

  const organization =
    dashboard?.shell?.activeOrganization ||
    session?.shell?.activeOrganization ||
    null;

  const businessName =
    organization?.name || profile.legalName || "Your business";

  const currency = profile.primaryCurrency || "USD";

  const preferredMetricColumns = [
    "net_revenue",
    "revenue",
    "sales",
    "gross_sales",
    "gross_profit",
    "profit",
    "total_amount",
    "amount",
    "quantity",
  ];

  const metricPriority = (item) => {
    const sourceColumn = String(item?.sourceColumn || "")
      .trim()
      .toLowerCase();

    const index = preferredMetricColumns.indexOf(sourceColumn);

    return index === -1 ? preferredMetricColumns.length : index;
  };

  const orderedSeries = [...metricSeries].sort(
    (left, right) =>
      metricPriority(left) - metricPriority(right) ||
      String(left?.dataStream?.displayName || "").localeCompare(
        String(right?.dataStream?.displayName || ""),
      ) ||
      String(left?.label || "").localeCompare(String(right?.label || "")),
  );

  const activeMetric =
    orderedSeries.find((item) => item.id === activeSeriesKey) ||
    orderedSeries[0] ||
    null;

  activeSeriesKey = activeMetric?.id || null;

  const points = activeMetric?.points || [];

  const latest = points.at(-1) || null;

  const previous = points.at(-2) || null;

  const numericValue = (value) => {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  };

  const isCurrencyMetric = (item) =>
    /\b(revenue|sales|income|profit|cost|amount|price|refund|spend|expense|value)\b/i.test(
      String(item?.sourceColumn || item?.label || "").replaceAll("_", " "),
    );

  const formatMetricValue = (value, item = activeMetric) => {
    const parsed = numericValue(value);

    if (parsed === null) {
      return "—";
    }

    if (item?.unit === "percent") {
      return `${numberValue(parsed)}%`;
    }

    if (item?.unit === "count" || !isCurrencyMetric(item)) {
      return numberValue(parsed);
    }

    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        maximumFractionDigits: 2,
      }).format(parsed);
    } catch {
      return `${currency} ${numberValue(parsed)}`;
    }
  };

  const formatPeriod = (point) => {
    if (point?.periodLabel) {
      return String(point.periodLabel);
    }

    const raw = String(point?.periodStart || "");

    if (!raw) {
      return "Period";
    }

    const monthlyMatch = raw.match(/^(\d{4})-(\d{2})/);

    if (monthlyMatch) {
      const year = Number(monthlyMatch[1]);

      const month = Number(monthlyMatch[2]);

      if (Number.isInteger(year) && month >= 1 && month <= 12) {
        return new Intl.DateTimeFormat(undefined, {
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(Date.UTC(year, month - 1, 1)));
      }
    }

    return raw.slice(0, 10);
  };

  const latestValue = numericValue(latest?.value);

  const previousValue = numericValue(previous?.value);

  const changePercent =
    latest?.dataStatus !== "partial" && previous?.dataStatus !== "partial" &&
    latestValue !== null && previousValue !== null && previousValue !== 0
      ? ((latestValue - previousValue) / Math.abs(previousValue)) * 100
      : null;

  const acceptedUploadStatuses = new Set([
    "validated",
    "confirmed",
    "processed",
    "ready",
  ]);

  const validatedUploads = uploads.filter((upload) =>
    acceptedUploadStatuses.has(upload?.status),
  ).length;

  const rejectedUploads = uploads.filter(
    (upload) => upload?.status === "rejected",
  ).length;

  const schemaWarnings = uploads.filter((upload) =>
    Boolean(upload?.schemaDrift),
  ).length;

  const verifiedPeriods = new Set(
    metricSeries.flatMap((item) =>
      item.points.map((point) =>
        String(
          point?.reportingPeriodId ||
            point?.periodStart ||
            point?.periodLabel ||
            "",
        ),
      ),
    ),
  ).size;

  const latestSourceRows = Number.isFinite(Number(latest?.sourceRowCount))
    ? Number(latest.sourceRowCount)
    : null;

  const findingCollections = [
    ["Focus", "focus", dashboard?.focusAreas],
    ["Opportunity", "opportunity", dashboard?.opportunities],
    ["Signal", "signal", dashboard?.signals],
    ["Risk", "risk", dashboard?.risks],
  ];

  const findings = findingCollections
    .flatMap(([label, kind, items]) =>
      Array.isArray(items)
        ? items.map((item) => ({
            label,
            kind,
            item,
          }))
        : [],
    )
    .filter((entry) => entry.item && (entry.item.title || entry.item.summary));

  const primaryFinding = findings[0] || null;

  const trendChartHtml = points.length
    ? (() => {
        const width = 820;
        const height = 270;
        const padX = 44;
        const padTop = 24;
        const padBottom = 54;

        const chartPoints = points
          .map((point, index) => ({
            point,
            value: numericValue(point?.value),
            index,
          }))
          .filter((item) => item.value !== null);

        if (!chartPoints.length) {
          return "";
        }

        const values = chartPoints.map((item) => item.value);

        const min = Math.min(...values);

        const max = Math.max(...values);

        const span = max - min || Math.abs(max) || 1;

        const plotted = chartPoints.map((item, index) => {
          const x =
            chartPoints.length === 1
              ? width / 2
              : padX + (index * (width - padX * 2)) / (chartPoints.length - 1);

          const y =
            padTop +
            ((max - item.value) / span) * (height - padTop - padBottom);

          return {
            ...item,
            x,
            y,
          };
        });

        const linePath = plotted
          .map(
            (point, index) =>
              `${index === 0 ? "M" : "L"} ${point.x.toFixed(
                2,
              )} ${point.y.toFixed(2)}`,
          )
          .join(" ");

        const areaPath =
          `${linePath} ` +
          `L ${plotted.at(-1).x.toFixed(2)} ${(height - padBottom).toFixed(
            2,
          )} ` +
          `L ${plotted[0].x.toFixed(2)} ${(height - padBottom).toFixed(2)} Z`;

        return `
            <div
              class="overview-trend-chart"
              role="img"
              aria-label="${esc(
                activeMetric?.label || "Business metric",
              )} over ${plotted.length} verified period${
                plotted.length === 1 ? "" : "s"
              }"
            >
              <svg
                viewBox="0 0 ${width} ${height}"
                preserveAspectRatio="none"
              >
                <path
                  class="overview-trend-area"
                  d="${areaPath}"
                ></path>

                <path
                  class="overview-trend-line"
                  d="${linePath}"
                ></path>

                ${plotted
                  .map(
                    (point) => `
                      <circle
                        cx="${point.x.toFixed(2)}"
                        cy="${point.y.toFixed(2)}"
                        r="5"
                      ></circle>
                    `,
                  )
                  .join("")}
              </svg>

              <div
                class="overview-trend-labels"
              >
                ${plotted
                  .map(
                    (point) => `
                      <div>
                        <span>
                          ${esc(formatPeriod(point.point))}
                        </span>

                        <strong>
                          ${esc(formatMetricValue(point.value))}
                        </strong>
                      </div>
                    `,
                  )
                  .join("")}
              </div>
            </div>
          `;
      })()
    : "";

  const businessContext = [
    profile.industry ? ["Industry", profile.industry] : null,

    profile.businessModel ? ["Business model", profile.businessModel] : null,

    ["Currency", currency],

    ["Verified periods", String(verifiedPeriods)],
  ].filter(Boolean);

  const heroSummary =
    primaryFinding?.item?.summary ||
    (latest
      ? `${activeMetric?.label || "Performance"} is ${formatMetricValue(
          latest.value,
        )} for ${formatPeriod(latest)}${
          changePercent === null
            ? latest.dataStatus === "partial" ? ". This month contains partial records." : "."
            : `, ${changePercent >= 0 ? "up" : "down"} ${Math.abs(
                changePercent,
              ).toFixed(1)}% from the previous verified period.`
        }`
      : "No verified performance history is available yet. Add comparable business data to establish the first baseline.");

  shell(
    `
      <section
        class="overview-v2"
      >
        <header
          class="overview-v2-hero"
        >
          <div>
            <p class="overline">
              BUSINESS OVERVIEW
            </p>

            <h1>
              ${esc(businessName)}
            </h1>

            <p
              class="overview-v2-summary"
            >
              ${esc(heroSummary)}
            </p>
          </div>

          <div
            class="overview-v2-actions"
          >
            ${link("/data", `${icon("plus")} Add data`, "button primary")}

            ${
              reports.length
                ? link(
                    "/reports",
                    `Evidence ${icon("arrow-right")}`,
                    "button secondary",
                  )
                : ""
            }
          </div>
        </header>

        ${
          !profile || !Object.keys(profile).length
            ? `
              <div
                class="notice"
              >
                ${icon("building-2")}

                <div>
                  <strong>
                    Complete the business profile.
                  </strong>

                  <p>
                    Add industry, business model and currency
                    so BIZNORYX can present the workspace in
                    the right context.
                  </p>
                </div>

                ${link("/business", "Complete profile", "button secondary")}
              </div>
            `
            : ""
        }

        <section
          class="overview-v2-stats"
          aria-label="Business performance summary"
        >
          <article
            class="overview-v2-stat primary-stat"
          >
            <div>
              <span>
                ${esc(activeMetric?.label || "Primary metric")}
              </span>

              ${icon("activity")}
            </div>

            <strong>
              ${latest ? esc(formatMetricValue(latest.value)) : "—"}
            </strong>

            <small>
              ${latest ? `${esc(formatPeriod(latest))}${latest.dataStatus === "partial" ? " (partial)" : ""}` : "No verified period"}
            </small>
          </article>

          <article
            class="overview-v2-stat"
          >
            <div>
              <span>
                Period change
              </span>

              ${icon(
                changePercent !== null && changePercent < 0
                  ? "trending-down"
                  : "trending-up",
              )}
            </div>

            <strong
              class="${
                changePercent === null
                  ? ""
                  : changePercent < 0
                    ? "negative"
                    : "positive"
              }"
            >
              ${
                changePercent === null
                  ? "—"
                  : `${changePercent > 0 ? "+" : ""}${changePercent.toFixed(
                      1,
                    )}%`
              }
            </strong>

            <small>
              ${
                previous
                  ? `vs ${esc(formatPeriod(previous))}`
                  : "Needs two periods"
              }
            </small>
          </article>

          <article
            class="overview-v2-stat"
          >
            <div>
              <span>
                Evidence reports
              </span>

              ${icon("file-check-2")}
            </div>

            <strong>
              ${reports.length}
            </strong>

            <small>
              ${
                reports.length
                  ? "Source-backed reports ready"
                  : "No report ready yet"
              }
            </small>
          </article>

          <article
            class="overview-v2-stat"
          >
            <div>
              <span>
                Source rows
              </span>

              ${icon("rows-3")}
            </div>

            <strong>
              ${latestSourceRows === null ? "—" : numberValue(latestSourceRows)}
            </strong>

            <small>
              ${validatedUploads}
              validated upload${validatedUploads === 1 ? "" : "s"}
            </small>
          </article>
        </section>

        <section
          class="overview-v2-main"
        >
          <article
            class="overview-v2-panel overview-v2-performance"
          >
            <div
              class="overview-v2-panel-head"
            >
              <div>
                <p class="overline">
                  PERFORMANCE
                </p>

                <h2>
                  ${esc(activeMetric?.label || "Verified performance")}
                </h2>

                <p>
                  ${esc(
                    activeMetric?.dataStream?.displayName ||
                      activeMetric?.dataStream?.name ||
                      "Primary performance",
                  )}
                </p>
              </div>

              <span
                class="overview-v2-period-count"
              >
                ${points.length}
                period${points.length === 1 ? "" : "s"}
              </span>
            </div>

            ${
              orderedSeries.length > 1
                ? `
                  <div
                    class="overview-v2-metric-tabs"
                    aria-label="Choose metric"
                  >
                    ${orderedSeries
                      .slice(0, 8)
                      .map(
                        (item) => `
                          <button
                            type="button"
                            data-overview-series="${esc(item.id)}"
                            class="${
                              item.id === activeMetric?.id ? "active" : ""
                            }"
                          >
                            ${esc(item.label || item.sourceColumn || "Metric")}
                          </button>
                        `,
                      )
                      .join("")}
                  </div>
                `
                : ""
            }

            ${
              trendChartHtml ||
              `
                <div
                  class="overview-v2-empty"
                >
                  ${icon("chart-no-axes-combined")}

                  <h3>
                    No verified trend yet.
                  </h3>

                  <p>
                    Once the production worker has processed
                    validated data, verified metric history
                    will appear here.
                  </p>

                  ${link("/data", "Open data workspace", "inline-link")}
                </div>
              `
            }
          </article>

          <aside
            class="overview-v2-panel overview-v2-reading"
          >
            <div
              class="overview-v2-panel-head"
            >
              <div>
                <p class="overline">
                  BUSINESS READING
                </p>

                <h2>
                  ${
                    primaryFinding
                      ? esc(
                          primaryFinding.item.title ||
                            "What deserves attention",
                        )
                      : "What deserves attention"
                  }
                </h2>
              </div>

              ${icon("scan-search")}
            </div>

            <p
              class="overview-v2-reading-copy"
            >
              ${esc(
                primaryFinding?.item?.summary ||
                  (latest
                    ? `BIZNORYX has verified ${points.length} period${
                        points.length === 1 ? "" : "s"
                      } for ${activeMetric?.label || "this metric"}. Add more comparable periods to strengthen the business reading.`
                    : "There is not enough verified history to identify a movement yet."),
              )}
            </p>

            ${
              findings.length
                ? `
                  <div
                    class="overview-v2-findings"
                  >
                    ${findings
                      .slice(0, 3)
                      .map(
                        ({ label, kind, item }) => `
                          <article
                            class="overview-v2-finding ${kind}"
                          >
                            <span>
                              ${esc(label)}
                            </span>

                            <strong>
                              ${esc(item.title || label)}
                            </strong>

                            <p>
                              ${esc(
                                item.summary ||
                                  "Evidence-backed finding available.",
                              )}
                            </p>
                          </article>
                        `,
                      )
                      .join("")}
                  </div>
                `
                : `
                  <div
                    class="overview-v2-no-findings"
                  >
                    ${icon("shield-check")}

                    <p>
                      No evidence-backed signal, risk or
                      opportunity is available yet.
                    </p>
                  </div>
                `
            }
          </aside>
        </section>

        <section
          class="overview-v2-bottom"
        >
          <article
            class="overview-v2-panel"
          >
            <div
              class="overview-v2-panel-head"
            >
              <div>
                <p class="overline">
                  BUSINESS CONTEXT
                </p>

                <h2>
                  Workspace profile
                </h2>
              </div>

              ${icon("building-2")}
            </div>

            <dl
              class="overview-v2-context"
            >
              ${businessContext
                .map(
                  ([label, value]) => `
                    <div>
                      <dt>
                        ${esc(label)}
                      </dt>

                      <dd>
                        ${esc(value)}
                      </dd>
                    </div>
                  `,
                )
                .join("")}
            </dl>
          </article>

          <article
            class="overview-v2-panel"
          >
            <div
              class="overview-v2-panel-head"
            >
              <div>
                <p class="overline">
                  DATA HEALTH
                </p>

                <h2>
                  ${
                    rejectedUploads || schemaWarnings
                      ? "Review needed"
                      : "Sources in good standing"
                  }
                </h2>
              </div>

              ${icon(
                rejectedUploads || schemaWarnings
                  ? "circle-alert"
                  : "circle-check",
              )}
            </div>

            <div
              class="overview-v2-health"
            >
              <div>
                <strong>
                  ${uploads.length}
                </strong>

                <span>
                  Uploads
                </span>
              </div>

              <div>
                <strong>
                  ${validatedUploads}
                </strong>

                <span>
                  Validated
                </span>
              </div>

              <div>
                <strong>
                  ${rejectedUploads}
                </strong>

                <span>
                  Rejected
                </span>
              </div>

              <div>
                <strong>
                  ${schemaWarnings}
                </strong>

                <span>
                  Schema warnings
                </span>
              </div>
            </div>
          </article>
        </section>
      </section>
    `,
    "/dashboard",
  );

  document.querySelectorAll("[data-overview-series]").forEach((button) => {
    button.onclick = () => {
      activeSeriesKey = button.dataset.overviewSeries;

      overview();
    };
  });
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

  shell(
    reportPageHeader() +
      `
        <p
          class="er-loading"
          role="status"
        >
          Reading the evidence...
        </p>
      `,
    "/reports",
  );

  try {
    const result = await api(
      "evidence-report?" + new URLSearchParams(reportOptions),
    );

    if (
      requestVersion !== reportRequestVersion ||
      routeVersion !== navigationVersion
    ) {
      return;
    }

    currentReport = result.report;

    if (!currentReport) {
      shell(
        reportPageHeader() +
          `
            <section class="empty-state">
              <h3>
                No evidence reports yet.
              </h3>

              <p>
                Confirm a source with a measurable numeric
                column to begin.
              </p>

              ${link("/data", "Upload business data", "button dark")}
            </section>
          `,
        "/reports",
      );

      return;
    }

    const report = currentReport;

    reportOptions = {
      source: report.sourceId,

      metric: report.metric.column,

      period: report.current.period,

      compare: report.previous?.period || "none",

      ...(report.controls.dateColumn
        ? {
            dateColumn: report.controls.dateColumn,
          }
        : {}),

      ...(report.controls.dimension
        ? {
            dimension: report.controls.dimension,
          }
        : {}),
    };

    shell(
      reportPageHeader(true) +
        reportControls(report) +
        `
          <p
            class="er-status"
            role="status"
            aria-live="polite"
          ></p>
        ` +
        renderEvidenceReport(report),
      "/reports",
    );

    bindReportControls();
  } catch (error) {
    if (
      requestVersion !== reportRequestVersion ||
      routeVersion !== navigationVersion
    ) {
      return;
    }

    shell(
      reportPageHeader() +
        `
          <div
            class="er-error"
            role="alert"
          >
            <p>
              ${esc(error.message)}
            </p>

            <button
              class="secondary"
              id="report-retry"
            >
              Retry report
            </button>
          </div>
        `,
      "/reports",
    );

    const retry = document.querySelector("#report-retry");

    if (retry) {
      retry.onclick = () => {
        reportOptions = {};
        reports();
      };
    }
  }
}

function reportPageHeader(ready = false) {
  return `
    <header class="er-workspace-header">
      <div>
        <p class="overline">
          EVIDENCE REPORTS
        </p>

        <h1>
          Evidence behind every decision.
        </h1>
      </div>

      ${
        ready
          ? `
            <div class="er-toolbar">
              <button
                class="er-icon-button"
                type="button"
                data-report-refresh
                title="Refresh report"
                aria-label="Refresh report"
              >
                ${icon("refresh-cw")}
              </button>

              <button
                class="er-icon-button"
                type="button"
                data-definition
                title="Metric definition"
                aria-label="Metric definition"
              >
                ${icon("settings-2")}
              </button>

              <button
                class="er-icon-button"
                type="button"
                data-report-print
                title="Print report"
                aria-label="Print report"
              >
                ${icon("printer")}
              </button>

              <button
                class="er-icon-button"
                type="button"
                data-report-export="csv"
                title="Export comparison CSV"
                aria-label="Export comparison CSV"
              >
                ${icon("table-2")}
              </button>

              <button
                class="primary"
                type="button"
                data-report-export="pdf"
              >
                ${icon("download")}
                Export PDF
              </button>

              <button
                class="secondary"
                type="button"
                data-report-export="html"
              >
                ${icon("file-code")}
                Shareable report
              </button>
            </div>
          `
          : ""
      }
    </header>
  `;
}

function bindReportControls() {
  document
    .querySelector("#report-controls")
    ?.addEventListener("change", async (event) => {
      const key = event.target.name;

      const value = event.target.value;

      if (key === "source") {
        reportOptions = {
          source: value,
        };
      } else if (key === "metric") {
        reportOptions = {
          source: reportOptions.source,

          metric: value,
        };
      } else if (key === "dateColumn") {
        reportOptions = {
          source: reportOptions.source,

          metric: reportOptions.metric,

          dateColumn: value,
        };
      } else {
        reportOptions[key] = value;

        if (key === "period") {
          delete reportOptions.compare;
        }
      }

      await reports();

      document.querySelector('#report-controls [name="' + key + '"]')?.focus();
    });

  const refresh = document.querySelector("[data-report-refresh]");

  if (refresh) {
    refresh.onclick = () => reports();
  }

  const print = document.querySelector("[data-report-print]");

  if (print) {
    print.onclick = () => {
      const closed = [
        ...document.querySelectorAll(".evidence-report details:not([open])"),
      ];

      closed.forEach((details) => (details.open = true));

      window.addEventListener(
        "afterprint",
        () => closed.forEach((details) => (details.open = false)),
        {
          once: true,
        },
      );

      window.print();
    };
  }

  const bindEvidence = (root = document) => root.querySelectorAll("[data-evidence]").forEach((button) => {
    button.onclick = () =>
      openReportDialog(
        evidenceDialog(currentReport, button.dataset.evidence),
        button,
      );
  });
  bindEvidence();
  document.querySelector("[data-report-question]")?.addEventListener("change", (event) => {
    const answer = document.querySelector("#er-answer");
    answer.innerHTML = renderReportAnswer(currentReport, event.target.value);
    bindEvidence(answer);
    window.lucide?.createIcons();
  });

  document.querySelectorAll("[data-definition]").forEach((button) => {
    button.onclick = () => {
      openReportDialog(definitionDialog(currentReport), button);

      const definitionForm = document.querySelector("#report-definition");
      const enableBreakdown = definitionForm.elements.enableRevenueBreakdown;
      const updateMappingFields = () => {
        const supported = currentReport.controls.dimensions.length > 0 && currentReport.controls.metrics.length > 1;
        enableBreakdown.disabled = definitionForm.elements.unit.value !== "currency" || !supported;
        if (enableBreakdown.disabled) enableBreakdown.checked = false;
        const fields = definitionForm.querySelector("[data-revenue-fields]");
        fields.disabled = !enableBreakdown.checked;
        fields.hidden = !enableBreakdown.checked;
      };
      enableBreakdown.addEventListener("change", updateMappingFields);
      definitionForm.elements.unit.addEventListener("change", updateMappingFields);
      updateMappingFields();

      bindForm("#report-definition", async (form) => {
        await api("evidence-report/definition", {
          ...form,
          revenueBreakdown: form.enableRevenueBreakdown ? {
            productColumn: form.productColumn,
            quantityColumn: form.quantityColumn,
            quantityUnit: form.quantityUnit,
            currency: currentReport.metric.currency,
            confirmed: form.confirmRevenueMapping === "on",
          } : null,

          source: currentReport.sourceId,

          metric: currentReport.metric.column,

          expectedVersion: currentReport.metric.policy?.version ?? 0,
        });

        document.querySelector("#definition-dialog")?.close();

        await reports();

        const status = document.querySelector(".er-status");

        if (status) {
          status.textContent =
            "Metric definition approved. The report has been recalculated.";
        }
      });
    };
  });

  document.querySelectorAll("[data-report-export]").forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;

      const status = document.querySelector(".er-status");

      if (status) {
        status.textContent = "Preparing the report...";
      }

      try {
        const format = button.dataset.reportExport;

        const response = await fetch(
          "/api/evidence-report?" +
            new URLSearchParams({
              ...reportOptions,
              format,
            }),
          {
            credentials: "same-origin",
          },
        );

        if (!response.ok) {
          let payload = {};

          try {
            payload = await response.json();
          } catch {
            payload = {};
          }

          throw new Error(payload.message || "Export failed. Try again.");
        }

        const blob = await response.blob();

        const url = URL.createObjectURL(blob);

        const anchor = document.createElement("a");

        anchor.href = url;

        anchor.download =
          "biznoryx-evidence-" + currentReport.current.period + "." + format;

        anchor.click();

        setTimeout(() => URL.revokeObjectURL(url), 30000);

        if (status) {
          status.textContent = "Report downloaded.";
        }
      } catch (error) {
        if (status) {
          status.textContent = error.message;
        }
      } finally {
        button.disabled = false;
      }
    };
  });
}

function openReportDialog(html, trigger) {
  document.querySelectorAll(".er-dialog").forEach((dialog) => dialog.remove());

  document.body.insertAdjacentHTML("beforeend", html);

  window.lucide?.createIcons();

  const dialog = document.querySelector(".er-dialog");

  if (!dialog) {
    return;
  }

  const close = dialog.querySelector("[data-close-dialog]");

  if (close) {
    close.onclick = () => dialog.close();
  }

  dialog.addEventListener(
    "close",
    () => {
      dialog.remove();
      trigger?.focus();
    },
    {
      once: true,
    },
  );

  dialog.showModal();
}

function renderBillingHistory(payments) {
  if (payments === null) {
    return `
      <div class="billing-empty-history billing-history-error">
        ${icon("circle-alert")}
        <div>
          <strong>Payment history is unavailable</strong>
          <p>We could not load confirmed payments for this workspace. No payment status has been inferred.</p>
        </div>
      </div>
    `;
  }

  if (payments.length === 0) {
    return `
      <div class="billing-empty-history">
        ${icon("receipt")}
        <div>
          <strong>No completed payments yet</strong>
          <p>Confirmed Paystack payments will appear here after the provider verifies them.</p>
        </div>
      </div>
    `;
  }

  return `
    <div class="billing-history-table-wrap">
      <table class="billing-history-table">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Payment</th>
            <th scope="col">Method</th>
            <th scope="col">Reference</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${payments
            .map(
              (payment) => `
            <tr>
              <td><time datetime="${esc(payment.paidAt)}">${esc(new Date(payment.paidAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }))}</time></td>
              <td><span class="billing-payment-status">${esc(payment.status === "success" ? "Paid" : payment.status)}</span></td>
              <td>${esc(payment.channel || payment.provider || "Paystack")}</td>
              <td class="billing-payment-reference">${esc(payment.reference)}</td>
              <td class="billing-payment-amount">${esc(formatBillingPaymentAmount(payment.amountMinor, payment.currency))}</td>
            </tr>
          `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function formatBillingPaymentAmount(amountMinor, currency) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(Number(amountMinor) / 100);
  } catch {
    return `${currency} ${(Number(amountMinor) / 100).toFixed(2)}`;
  }
}

function billingPage() {
  const paymentHistoryRequest = api("billing/history");
  const subscription = dashboard?.subscription ?? null;

  const uploads = Array.isArray(dashboard?.uploads) ? dashboard.uploads : [];

  const evidenceReports = Array.isArray(dashboard?.evidenceReports)
    ? dashboard.evidenceReports
    : [];

  const status = subscription?.status || "not_started";

  const isActive = status === "active";

  const isPending = status === "pending_checkout";

  const isNonRenewing = status === "non_renewing";

  const providerConfigured = Boolean(subscription?.providerConfigured);

  const isLocalReviewHost = ["localhost", "127.0.0.1", "::1"].includes(
    location.hostname,
  );

  const canStartCheckout = providerConfigured || isLocalReviewHost;

  const canCancelSubscription = Boolean(subscription?.canCancel);

  const priceLabel = subscription?.priceLabel || "₦40,000/mo";

  const planName = subscription?.planName || "BIZNORYX Monthly";

  const statusDetails = {
    active: {
      label: "Active",
      tone: "active",
      description:
        "Your BIZNORYX subscription is active and your paid workspace is enabled.",
    },

    pending_checkout: {
      label: "Payment pending",
      tone: "pending",
      description:
        "Your checkout has started. Complete payment to activate the subscription.",
    },

    trialing: {
      label: subscription?.trial?.cardSetup?.verified ? "Trial" : "Not active",
      tone: "trial",
      description: subscription?.trial?.cardSetup?.verified
        ? "Your verified trial ends on the date shown below."
        : "Start a verified trial or activate a subscription to process business data.",
    },

    past_due: {
      label: "Past due",
      tone: "danger",
      description:
        "A subscription payment needs attention before paid access can continue.",
    },

    non_renewing: {
      label: "Non-renewing",
      tone: "warning",
      description:
        "Your subscription remains available until the current billing period ends.",
    },

    canceled: {
      label: "Canceled",
      tone: "neutral",
      description: "This subscription is no longer renewing.",
    },

    not_started: {
      label: "Not active",
      tone: "neutral",
      description:
        "Activate BIZNORYX when billing is available for this workspace.",
    },
  }[status] || {
    label: String(status).replaceAll("_", " "),

    tone: "neutral",

    description: "Review the current subscription status.",
  };

  const renewalLabel = subscription?.currentPeriodEnd
    ? new Date(subscription.currentPeriodEnd).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : isActive
      ? "Current period active"
      : "After activation";

  const retainedBytes = uploads.reduce((total, upload) => {
    const size = Number(upload?.sourceSizeBytes ?? upload?.sizeBytes ?? 0);

    return Number.isFinite(size) && size > 0 ? total + size : total;
  }, 0);

  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "—";
    }

    const units = ["B", "KB", "MB", "GB", "TB"];

    let value = bytes;
    let index = 0;

    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }

    return `${
      value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)
    } ${units[index]}`;
  };

  const featureRows = [
    ["database", "Recurring business-data processing"],

    ["line-chart", "Verified metrics and historical comparisons"],

    ["file-check-2", "Evidence reports backed by source data"],

    ["download", "Professional report exports"],

    ["history", "Persistent business performance history"],
  ];

  shell(
    `
      <section class="billing-v2">
        <header class="billing-v2-hero">
          <div>
            <p class="overline">
              BILLING & SUBSCRIPTION
            </p>

            <h1>
              Manage your BIZNORYX plan.
            </h1>

            <p>
              Keep your workspace, verified analytics,
              reports and business history connected
              under one subscription.
            </p>
          </div>

          <span
            class="billing-status ${esc(statusDetails.tone)}"
          >
            <span
              aria-hidden="true"
            ></span>

            ${esc(statusDetails.label)}
          </span>
        </header>

        <div class="billing-v2-grid">
          <article class="billing-plan-card">
            <div class="billing-plan-top">
              <div>
                <p class="overline">
                  CURRENT PLAN
                </p>

                <h2>
                  ${esc(planName)}
                </h2>
              </div>

              <span class="billing-plan-chip">
                Monthly
              </span>
            </div>

            <div class="billing-price-row">
              <strong>
                ${esc(priceLabel.replace(/\/mo$/i, ""))}
              </strong>

              <span>
                / month
              </span>
            </div>

            <p class="billing-plan-description">
              One workspace for turning recurring business
              data into verified performance evidence,
              historical context and decision-ready reports.
            </p>

            <div class="billing-feature-list">
              ${featureRows
                .map(
                  ([featureIcon, label]) => `
                    <div class="billing-feature-row">
                      <span>
                        ${icon(featureIcon)}
                      </span>

                      <p>
                        ${esc(label)}
                      </p>
                    </div>
                  `,
                )
                .join("")}
            </div>

            <div class="billing-plan-actions">
              ${
                isActive
                  ? `
                    <div class="billing-active-confirmation">
                      ${icon("circle-check")}

                      <div>
                        <strong>
                          Subscription active
                        </strong>

                        <span>
                          Your paid workspace is currently enabled.
                        </span>
                      </div>
                    </div>

                    <button
                      id="cancel-billing-subscription"
                      class="secondary billing-secondary-action"
                      type="button"
                      ${canCancelSubscription ? "" : "disabled"}
                    >
                      ${icon("x-circle")}

                      Cancel subscription
                    </button>
                  `
                  : isNonRenewing
                    ? `
                      <div class="billing-active-confirmation billing-nonrenewing-confirmation">
                        ${icon("calendar-x")}

                        <div>
                          <strong>
                            Subscription will not renew
                          </strong>

                          <span>
                            Paid access remains available until the current period ends.
                          </span>
                        </div>
                      </div>

                      <button
                        id="renew-billing-subscription"
                        class="primary billing-primary-action"
                        type="button"
                      >
                        Resume automatic renewal
                      </button>

                      <p
                        id="billing-renewal-message"
                        class="form-message"
                        role="status"
                        aria-live="polite"
                      ></p>
                    `
                    : subscription && canStartCheckout
                      ? `
                      <button
                        id="open-billing-checkout"
                        class="primary billing-primary-action"
                        type="button"
                      >
                        ${icon("credit-card")}

                        ${
                          isPending
                            ? "Continue payment"
                            : "Activate subscription"
                        }
                      </button>
                    `
                      : `
                      <button
                        class="primary billing-primary-action"
                        type="button"
                        disabled
                      >
                        ${icon("lock")}

                        ${
                          subscription
                            ? "Payments unavailable"
                            : "Billing setup in progress"
                        }
                      </button>
                    `
              }

              <p class="billing-security-note">
                ${icon("shield-check")}

                Secure checkout powered by Paystack.
                BIZNORYX does not store your card details.
                ${
                  isActive && !canCancelSubscription
                    ? " Live support can help cancel this subscription while Paystack identity sync completes."
                    : ""
                }
              </p>
            </div>
          </article>

          <div class="billing-side-stack">
            <article class="billing-summary-card">
              <div class="billing-card-heading">
                <div>
                  <p class="overline">
                    SUBSCRIPTION
                  </p>

                  <h2>
                    Account status
                  </h2>
                </div>

                ${icon("credit-card")}
              </div>

              <p class="billing-status-description">
                ${esc(statusDetails.description)}
              </p>

              <dl class="billing-summary-list">
                <div>
                  <dt>
                    Status
                  </dt>

                  <dd>
                    ${esc(statusDetails.label)}
                  </dd>
                </div>

                <div>
                  <dt>
                    Payment provider
                  </dt>

                  <dd>
                    ${esc(
                      providerConfigured
                        ? "Paystack"
                        : isLocalReviewHost
                          ? "Development review"
                          : "Unavailable",
                    )}
                  </dd>
                </div>

                <div>
                  <dt>
                    Next renewal
                  </dt>

                  <dd>
                    ${esc(renewalLabel)}
                  </dd>
                </div>

                <div>
                  <dt>
                    Billing interval
                  </dt>

                  <dd>
                    ${esc(subscription?.interval || "monthly")}
                  </dd>
                </div>
              </dl>
            </article>

            <article class="billing-summary-card">
              <div class="billing-card-heading">
                <div>
                  <p class="overline">
                    WORKSPACE
                  </p>

                  <h2>
                    Current usage
                  </h2>
                </div>

                ${icon("bar-chart-3")}
              </div>

              <div class="billing-usage-grid">
                <div class="billing-usage-item">
                  <span>
                    Uploads
                  </span>

                  <strong>
                    ${uploads.length}
                  </strong>

                  <small>
                    Data sources retained
                  </small>
                </div>

                <div class="billing-usage-item">
                  <span>
                    Evidence reports
                  </span>

                  <strong>
                    ${evidenceReports.length}
                  </strong>

                  <small>
                    Report sources available
                  </small>
                </div>

                <div class="billing-usage-item">
                  <span>
                    Source data
                  </span>

                  <strong>
                    ${esc(formatBytes(retainedBytes))}
                  </strong>

                  <small>
                    Tracked file storage
                  </small>
                </div>
              </div>
            </article>
          </div>
        </div>

        <section class="billing-history-card">
          <div class="billing-card-heading">
            <div>
              <p class="overline">
                PAYMENTS
              </p>

              <h2>
                Billing history
              </h2>
            </div>

            ${icon("receipt")}
          </div>

          <div id="billing-history-content" aria-live="polite">
            <div class="billing-empty-history">
              ${icon("loader-circle")}
              <div>
                <strong>Loading payment history</strong>
                <p>Checking confirmed payments for this workspace.</p>
              </div>
            </div>
          </div>
        </section>

        ${
          isLocalReviewHost &&
          !providerConfigured &&
          subscription?.checkoutReference &&
          !isActive
            ? `
              <section class="billing-test-panel">
                <div>
                  <p class="overline">
                    TEST ENVIRONMENT
                  </p>

                  <strong>
                    Local checkout completion is available
                    for development.
                  </strong>

                  <p>
                    This control disappears when Paystack
                    is configured for the workspace.
                  </p>
                </div>

                <button
                  id="complete-review-checkout"
                  class="secondary"
                  type="button"
                >
                  ${icon("check")}

                  Complete test checkout
                </button>
              </section>
            `
            : ""
        }

        <p
          id="billing-page-message"
          class="form-message billing-page-message"
          role="status"
          aria-live="polite"
        ></p>

        <dialog
          id="billing-checkout-dialog"
          class="billing-dialog"
          aria-labelledby="billing-dialog-title"
        >
          <div class="billing-dialog-card">
            <div class="billing-dialog-head">
              <div>
                <p class="overline">
                  CONFIRM SUBSCRIPTION
                </p>

                <h2
                  id="billing-dialog-title"
                >
                  Activate ${esc(planName)}
                </h2>
              </div>

              <button
                class="billing-dialog-close"
                type="button"
                data-billing-dialog-close
                aria-label="Close billing confirmation"
              >
                ${icon("x")}
              </button>
            </div>

            <div class="billing-dialog-plan">
              <div>
                <span>
                  Monthly subscription
                </span>

                <strong>
                  ${esc(priceLabel)}
                </strong>
              </div>

              ${icon("shield-check")}
            </div>

            <div class="billing-dialog-features">
              ${featureRows
                .map(
                  ([, label]) => `
                    <div>
                      ${icon("check")}

                      <span>
                        ${esc(label)}
                      </span>
                    </div>
                  `,
                )
                .join("")}
            </div>

            <p class="billing-dialog-note">
              You will continue to Paystack to complete
              payment securely. Subscription access is
              activated only after BIZNORYX confirms the
              payment with the billing provider.
            </p>

            <p
              id="billing-checkout-message"
              class="form-message"
              role="status"
              aria-live="polite"
            ></p>

            <div class="billing-dialog-actions">
              <button
                class="secondary"
                type="button"
                data-billing-dialog-close
              >
                Cancel
              </button>

              <button
                id="confirm-billing-checkout"
                class="primary"
                type="button"
              >
                ${icon("lock")}

                Continue to payment
              </button>
            </div>
          </div>
        </dialog>
      </section>
    `,
    "/billing",
  );

  const historyContent = document.querySelector("#billing-history-content");
  mountTrialBilling({
    container: document.querySelector(".billing-plan-actions"),
    api,
    subscription,
    onChanged: async () => { dashboard = await api("dashboard"); billingPage(); },
  });

  paymentHistoryRequest
    .then(({ payments }) => {
      if (historyContent && location.hash.startsWith("#/billing")) {
        historyContent.innerHTML = renderBillingHistory(
          Array.isArray(payments) ? payments : [],
        );
        window.lucide?.createIcons({ root: historyContent });
      }
    })
    .catch(() => {
      if (historyContent && location.hash.startsWith("#/billing")) {
        historyContent.innerHTML = renderBillingHistory(null);
      }
    });

  const dialog = document.querySelector("#billing-checkout-dialog");

  const openCheckout = document.querySelector("#open-billing-checkout");

  const confirmCheckout = document.querySelector("#confirm-billing-checkout");

  const cancelSubscription = document.querySelector(
    "#cancel-billing-subscription",
  );

  const renewSubscription = document.querySelector(
    "#renew-billing-subscription",
  );

  const renewalMessage = document.querySelector("#billing-renewal-message");

  const pageMessage = document.querySelector("#billing-page-message");

  const checkoutMessage = () =>
    document.querySelector("#billing-checkout-message");

  const closeDialog = () => {
    if (dialog?.open) {
      dialog.close();
    }
  };

  document.querySelectorAll("[data-billing-dialog-close]").forEach((button) => {
    button.onclick = closeDialog;
  });

  if (dialog) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        closeDialog();
      }
    });
  }

  if (openCheckout && dialog) {
    openCheckout.onclick = () => {
      const output = checkoutMessage();

      if (output) {
        output.textContent = "";

        output.classList.remove("error-text");
      }

      if (!dialog.open) {
        dialog.showModal();
      }
    };
  }

  if (confirmCheckout) {
    confirmCheckout.onclick = async () => {
      const output = checkoutMessage();

      confirmCheckout.disabled = true;

      if (output) {
        output.textContent = "Preparing secure checkout...";

        output.classList.remove("error-text");
      }

      try {
        const result = await api("billing/checkout", {});

        if (!result?.checkout?.reference) {
          throw new Error("Billing checkout did not return a valid reference.");
        }

        billingCheckoutReference = result.checkout.reference;

        if (result.checkout.provider === "paystack") {
          if (!result.checkout.authorizationUrl) {
            throw new Error("Paystack checkout did not return a payment URL.");
          }

          if (output) {
            output.textContent = "Redirecting to secure payment...";
          }

          location.href = result.checkout.authorizationUrl;

          return;
        }

        closeDialog();

        dashboard = await api("dashboard");

        billingPage();
      } catch (error) {
        if (output) {
          output.textContent =
            error?.message || "Checkout could not be started.";

          output.classList.add("error-text");
        }
      } finally {
        confirmCheckout.disabled = false;
      }
    };
  }

  if (renewSubscription) {
    renewSubscription.onclick = async () => {
      const confirmed = window.confirm(
        "Resume automatic renewal? Paystack will restore your existing subscription. No payment is taken today; the next charge remains on your normal billing date.",
      );

      if (!confirmed) {
        return;
      }

      const originalLabel = renewSubscription.textContent.trim();

      renewSubscription.disabled = true;

      renewSubscription.textContent = "Connecting to Paystack...";

      if (renewalMessage) {
        renewalMessage.textContent =
          "Connecting securely to Paystack to restore automatic renewal...";

        renewalMessage.classList.remove("error-text");
      }

      try {
        await api("billing/renew", {});

        /*
         * A successful response means the server-side
         * Paystack enable call completed successfully.
         */
        renewSubscription.textContent = "Renewal restored";

        if (renewalMessage) {
          renewalMessage.textContent =
            "Paystack confirmed automatic renewal. No payment was taken today. Your subscription will charge again on its normal next billing date.";
        }

        dashboard = await api("dashboard");

        /*
         * Give the customer enough time to see the
         * provider confirmation before the billing
         * screen refreshes into Active status.
         */
        window.setTimeout(() => {
          billingPage();
        }, 2200);
      } catch (error) {
        renewSubscription.disabled = false;

        renewSubscription.textContent = originalLabel;

        const providerMessage =
          error?.message || "Paystack could not restore automatic renewal.";

        if (renewalMessage) {
          renewalMessage.textContent = providerMessage;

          renewalMessage.classList.add("error-text");
        }

        if (pageMessage) {
          pageMessage.textContent = providerMessage;

          pageMessage.classList.add("error-text");
        }
      }
    };
  }

  if (cancelSubscription) {
    cancelSubscription.onclick = async () => {
      const confirmed = window.confirm(
        "Cancel this BIZNORYX subscription? Paid access remains available until the current billing period ends.",
      );

      if (!confirmed) {
        return;
      }

      cancelSubscription.disabled = true;

      if (pageMessage) {
        pageMessage.textContent = "Canceling subscription...";

        pageMessage.classList.remove("error-text");
      }

      try {
        await api("billing/cancel", {});

        dashboard = await api("dashboard");

        billingPage();
      } catch (error) {
        if (pageMessage) {
          pageMessage.textContent =
            error?.message || "Subscription could not be canceled.";

          pageMessage.classList.add("error-text");
        }
      } finally {
        cancelSubscription.disabled = false;
      }
    };
  }

  const complete = document.querySelector("#complete-review-checkout");

  if (complete) {
    complete.onclick = async () => {
      complete.disabled = true;

      if (pageMessage) {
        pageMessage.textContent = "Completing test checkout...";

        pageMessage.classList.remove("error-text");
      }

      try {
        const reference =
          billingCheckoutReference ||
          dashboard?.subscription?.checkoutReference;

        if (!reference) {
          throw new Error("No checkout reference is available.");
        }

        await api("billing/review-complete", {
          reference,
        });

        dashboard = await api("dashboard");

        billingPage();
      } catch (error) {
        if (pageMessage) {
          pageMessage.textContent =
            error?.message || "Test checkout could not be completed.";

          pageMessage.classList.add("error-text");
        }
      } finally {
        complete.disabled = false;
      }
    };
  }
}

async function activity() {
  shell(
    `
      ${heading(
        "BUSINESS MEMORY",
        "Workspace activity",
        "Loading the latest activity for this business.",
      )}

      <div class="empty-state">
        <h3>
          Loading activity...
        </h3>

        <p>
          Reading the activity history for this workspace.
        </p>
      </div>
    `,
    "/activity",
  );

  let auditTrail = [];

  let loadError = null;

  try {
    const result = await api("activity");

    auditTrail = Array.isArray(result?.events) ? result.events : [];
  } catch (error) {
    loadError = error;
  }

  const currentPath = location.hash.slice(1).split("?")[0] || "/";

  if (currentPath !== "/activity") {
    return;
  }

  shell(
    `
      ${heading(
        "BUSINESS MEMORY",
        "Workspace activity",
        "A record of real changes made in this business.",
      )}

      ${
        loadError
          ? `
            <div class="empty-state">
              <h3>
                Activity is temporarily unavailable.
              </h3>

              <p>
                ${esc(
                  loadError.message ||
                    "The activity history could not be loaded.",
                )}
              </p>

              <button
                id="retry-activity"
                class="secondary"
                type="button"
              >
                Try again
              </button>
            </div>
          `
          : auditTrail.length
            ? `
              <div class="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>
                        Event
                      </th>

                      <th>
                        Record
                      </th>

                      <th>
                        When
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    ${auditTrail
                      .map(
                        (item) => `
                          <tr>
                            <td>
                              ${esc(item.label)}
                            </td>

                            <td>
                              ${esc(item.detail)}
                            </td>

                            <td>
                              ${esc(new Date(item.createdAt).toLocaleString())}
                            </td>
                          </tr>
                        `,
                      )
                      .join("")}
                  </tbody>
                </table>
              </div>
            `
            : `
              <div class="empty-state">
                <h3>
                  No customer activity yet.
                </h3>

                <p>
                  Uploads, business changes, evidence
                  actions and account activity will
                  appear here.
                </p>
              </div>
            `
      }
    `,
    "/activity",
  );

  const retry = document.querySelector("#retry-activity");

  if (retry) {
    retry.onclick = () => {
      activity();
    };
  }
}

function showError(error) {
  mount(`
    <main class="error-page">
      ${wordmark()}

      ${icon("circle-alert")}

      <h1>
        We could not load your workspace.
      </h1>

      <p>
        ${esc(error?.message || "An unexpected error occurred.")}
      </p>

      <button
        id="retry"
        class="primary"
        type="button"
      >
        Try again
      </button>

      ${link("/sign-in", "Return to sign in", "quiet-link")}
    </main>
  `);

  const retry = document.querySelector("#retry");

  if (retry) {
    retry.onclick = () => route();
  }
}

async function route() {
  const version = ++navigationVersion;
  disposeManualEntry?.();
  disposeManualEntry = null;

  const rawPath = location.hash.slice(1) || "/";

  const [path, hashQuery = ""] = rawPath.split("?");

  const params = new URLSearchParams(hashQuery);

  if (params.get("checkout")) {
    billingCheckoutReference = params.get("checkout");
  }

  try {
    if (path === "/") {
      return landing();
    }

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
    ) {
      return publicPage(path);
    }

    if (path === "/verify-email") {
      return verifyEmail();
    }

    if (path === "/password-reset") {
      return passwordReset();
    }

    if (path === "/sign-in" || path === "/register") {
      return auth(path === "/register");
    }

    if (!session?.authenticated) {
      return go("/sign-in");
    }

    if (session.shell.state === "policy_required") {
      return policyOnboarding();
    }

    if (session.shell.state === "empty") {
      return business();
    }

    app.setAttribute("aria-busy", "true");

    const nextDashboard = await api("dashboard");

    if (version !== navigationVersion) {
      return;
    }

    dashboard = nextDashboard;

    if (path === "/business") {
      business();
    } else if (path === "/data") {
      dataPage();
    } else if (path === "/reports") {
      await reports();
    } else if (path === "/billing") {
      billingPage();
    } else if (path === "/activity") {
      await activity();
    } else {
      overview();
    }

    window.scrollTo(0, 0);
  } catch (error) {
    if (version !== navigationVersion) {
      return;
    }

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
