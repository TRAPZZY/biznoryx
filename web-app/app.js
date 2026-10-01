import { renderEvidenceReport, reportControls, evidenceDialog, definitionDialog } from "./evidence-report.js";

let csrfToken;
let session;
let dashboard;
let validation;
let pendingVerification;
let billingCheckoutReference;
let navigationVersion = 0;
let activeSeriesKey;

const SIDEBAR_STORAGE_KEY = "biznoryx.sidebar.collapsed";
const SIDEBAR_DESKTOP_QUERY = "(min-width: 701px)";

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
    window.localStorage.setItem(
      SIDEBAR_STORAGE_KEY,
      collapsed ? "1" : "0",
    );
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

const icon = (name) =>
  `<i data-lucide="${name}" aria-hidden="true"></i>`;

const link = (href, text, cls = "") =>
  `<a href="#${href}" class="${cls}">${text}</a>`;

const wordmark = () =>
  link(
    "/",
    'BIZNORYX<span class="wordmark-dot">.</span>',
    "wordmark",
  );

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
    : numberValue(
        item?.metricValue ??
          Number(item?.metricCents ?? 0) / 100,
      );

const metricChangePercent = (latest, previous) => {
  if (!latest || !previous) return null;

  const current = Number(
    latest.metricCents ?? latest.revenueCents ?? 0,
  );

  const last = Number(
    previous.metricCents ?? previous.revenueCents ?? 0,
  );

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
        : pad +
          (index * (width - pad * 2)) /
            (series.length - 1);

    const y =
      height -
      pad -
      ((values[index] - min) / span) *
        (height - pad * 2);

    return { item, x, y };
  });

  const path = points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`,
    )
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
      payload.message ||
        "Unable to complete your request. Please try again.",
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

  const fallback = "https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1600&q=80";
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

function field(
  label,
  name,
  type = "text",
  value = "",
  extra = "",
) {
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
  document
    .querySelector(id)
    ?.addEventListener("submit", async (event) => {
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
        await action(
          Object.fromEntries(new FormData(form)),
          form,
        );
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
            link(
              href,
              text,
              active === href ? "active" : "",
            ),
          )
          .join("")}
      </nav>

      <div class="nav-actions">
        ${link(
          session?.authenticated
            ? "/dashboard"
            : "/sign-in",
          session?.authenticated
            ? "Open workspace"
            : "Sign in",
          "quiet-link",
        )}

        ${link(
          "/register",
          `₦40,000/mo start ${icon("arrow-up-right")}`,
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
          src="https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1600&q=80"
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

  document
    .querySelectorAll("[data-scroll]")
    .forEach((a) =>
      a.addEventListener("click", (event) => {
        event.preventDefault();

        document
          .getElementById(a.dataset.scroll)
          ?.scrollIntoView({
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

      title:
        "A business performance system, not a spreadsheet wrapper.",

      body:
        "BIZNORYX connects business profile, data intake, metric history, evidence reports and activity into one tenant-isolated workspace.",

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

      title:
        "Built for owners who need to understand what changed.",

      body:
        "Use BIZNORYX for recurring sales reports, transaction history, inventory movement, service operations and other business datasets where the question is what changed and why it matters.",

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

      title:
        "₦40,000 per month for the BIZNORYX business workspace.",

      body:
        "One simple monthly plan gives a business the workspace, verified sign-up, recurring business-data intake, evidence reporting, dashboard history and billing access.",

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

      title:
        "Tenant isolation and auditability are part of the product.",

      body:
        "The application protects workspace routes, server-side mutations, CSRF boundaries and organization access. The database model is built around tenant ownership and row-level security.",

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

      title:
        "How teams build a useful business memory.",

      body:
        "Resources explain the data preparation, reporting cadence and evidence principles that make BIZNORYX more than a one-time analyzer.",

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

  const page =
    pages[path] ?? pages["/product"];

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
        ${link(
          "/",
          `${icon("arrow-left")} Back to home`,
          "back-link",
        )}

        <div class="auth-form-wrap">
          <p class="overline">
            ${
              register
                ? "Start your workspace"
                : "Welcome back"
            }
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
                register
                  ? "new-password"
                  : "current-password"
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

            <button
              class="primary"
              type="submit"
            >
              ${
                register
                  ? "Create account"
                  : "Sign in"
              }

              ${icon("arrow-right")}
            </button>

            ${message()}
          </form>

          <p class="auth-switch">
            ${
              register
                ? "Already have an account?"
                : "New to BIZNORYX?"
            }

            ${link(
              register
                ? "/sign-in"
                : "/register",
              register
                ? "Sign in"
                : "Create an account",
            )}
          </p>
        </div>

        <p class="auth-footer">
          Your business. Your data. A better perspective.
        </p>
      </main>
    </div>
  `);

  bindForm(
    "#auth-form",
    async (data) => {
      let result;

      try {
        result = await api(
          register
            ? "register"
            : "sign-in",
          data,
        );
      } catch (error) {
        if (
          error.payload
            ?.requiresEmailVerification
        ) {
          pendingVerification = {
            email:
              error.payload.email ||
              data.email,

            reviewCode:
              error.payload
                .reviewCode || null,
          };

          go("/verify-email");
          return;
        }

        throw error;
      }

      if (
        result.requiresEmailVerification
      ) {
        pendingVerification = {
          email: result.email,

          reviewCode:
            result.reviewCode || null,
        };

        go("/verify-email");
        return;
      }

      csrfToken =
        result.csrfToken;

      session = {
        authenticated: true,
        shell: result.shell,
      };

      dashboard = null;
      validation = null;

      go(
        result.shell.state === "empty"
          ? "/business"
          : "/dashboard",
      );
    },
  );
}

function verifyEmail() {
  const email =
    pendingVerification?.email || "";

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
            ${esc(
              email ||
                "your work email",
            )}.
          </p>

          ${
            pendingVerification
              ?.reviewCode
              ? `
                <div class="local-code">
                  <span>
                    Local review code
                  </span>

                  <strong>
                    ${esc(
                      pendingVerification
                        .reviewCode,
                    )}
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

  bindForm(
    "#verify-form",
    async (data) => {
      const result = await api(
        "auth/verify-email",
        data,
      );

      csrfToken =
        result.csrfToken;

      session = {
        authenticated: true,
        shell: result.shell,
      };

      dashboard = null;
      validation = null;
      pendingVerification = null;

      go(
        result.shell.state === "empty"
          ? "/business"
          : "/dashboard",
      );
    },
  );

  document
    .querySelector("#resend-code")
    .onclick = async (event) => {
      const button =
        event.currentTarget;

      button.disabled = true;

      try {
        const result =
          await api(
            "auth/resend-code",
            {
              email:
                document.querySelector(
                  '[name="email"]',
                ).value,
            },
          );

        pendingVerification = {
          email:
            result.email,

          reviewCode:
            result.reviewCode ||
            null,
        };

        verifyEmail();
      } catch (error) {
        document.querySelector(
          ".form-message",
        ).textContent =
          error.message;
      } finally {
        button.disabled = false;
      }
    };
}

function shell(content, active) {
  const org =
    dashboard?.shell
      ?.activeOrganization ||
    session?.shell
      ?.activeOrganization;

  const orgs =
    dashboard?.shell
      ?.organizations ||
    session?.shell
      ?.organizations ||
    [];

  const subscription =
    dashboard?.subscription;

  const sidebarCollapsed =
    isSidebarCollapsed();

  const navigationItems = [
    [
      "/dashboard",
      "layout-dashboard",
      "Overview",
    ],

    [
      "/data",
      "database",
      "Data & uploads",
    ],

    [
      "/reports",
      "file-check-2",
      "Evidence reports",
    ],

    [
      "/business",
      "building-2",
      "Business profile",
    ],

    [
      "/billing",
      "credit-card",
      "Billing",
    ],

    [
      "/activity",
      "history",
      "Activity",
    ],
  ];

  mount(`
    <div
      class="workspace${
        sidebarCollapsed
          ? " sidebar-collapsed"
          : ""
      }"
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
              sidebarCollapsed
                ? "false"
                : "true"
            }"
            aria-label="${
              sidebarCollapsed
                ? "Expand sidebar"
                : "Collapse sidebar"
            }"
            title="${
              sidebarCollapsed
                ? "Expand sidebar"
                : "Collapse sidebar"
            }"
          >
            ${icon(
              sidebarCollapsed
                ? "panel-left-open"
                : "panel-left-close",
            )}
          </button>
        </div>

        <div
          class="org-control"
          title="${esc(
            org?.name ||
              "Your workspace",
          )}"
        >
          <span class="org-avatar">
            ${esc(
              (
                org?.name ||
                "B"
              )
                .slice(0, 1)
                .toUpperCase(),
            )}
          </span>

          <label
            class="sr-only"
            for="org-switch"
          >
            Business
          </label>

          <select
            id="org-switch"
            ${
              orgs.length
                ? ""
                : "disabled"
            }
          >
            ${
              orgs.length
                ? orgs
                    .map(
                      (o) =>
                        `<option
                          value="${esc(
                            o.id,
                          )}"
                          ${
                            o.id ===
                            org?.id
                              ? "selected"
                              : ""
                          }
                        >
                          ${esc(
                            o.name,
                          )}
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
              ([
                path,
                symbol,
                title,
              ]) => `
                <a
                  href="#${path}"
                  class="${
                    active === path
                      ? "active"
                      : ""
                  }"
                  aria-label="${esc(
                    title,
                  )}"
                  title="${esc(
                    title,
                  )}"
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

            ${esc(
              org?.name ||
                "Set up your business",
            )}
          </span>

          <div class="workspace-top-actions">
            ${
              subscription
                ? `
                  <span
                    class="subscription-pill ${
                      subscription.status ===
                      "active"
                        ? "active"
                        : ""
                    }"
                  >
                    ${esc(
                      subscription.status.replaceAll(
                        "_",
                        " ",
                      ),
                    )}
                    ·
                    ${esc(
                      subscription.priceLabel,
                    )}
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
              title="${esc(
                dashboard?.shell
                  ?.user?.email ||
                  "",
              )}"
            >
              ${esc(
                (
                  dashboard?.shell
                    ?.user
                    ?.displayName ||
                  "You"
                ).slice(0, 1),
              )}
            </span>
          </div>
        </header>

        <main class="workspace-content">
          ${subscriptionBanner(
            subscription,
          )}

          ${content}
        </main>
      </div>
    </div>
  `);

  const sidebarToggle =
    document.querySelector(
      "#sidebar-toggle",
    );

  sidebarToggle?.addEventListener(
    "click",
    () => {
      const workspace =
        document.querySelector(
          ".workspace",
        );

      if (!workspace) return;

      const collapsed =
        workspace.classList.toggle(
          "sidebar-collapsed",
        );

      setSidebarCollapsed(
        collapsed,
      );

      sidebarToggle.setAttribute(
        "aria-expanded",
        collapsed
          ? "false"
          : "true",
      );

      sidebarToggle.setAttribute(
        "aria-label",
        collapsed
          ? "Expand sidebar"
          : "Collapse sidebar",
      );

      sidebarToggle.setAttribute(
        "title",
        collapsed
          ? "Expand sidebar"
          : "Collapse sidebar",
      );

      sidebarToggle.innerHTML =
        icon(
          collapsed
            ? "panel-left-open"
            : "panel-left-close",
        );

      window.lucide?.createIcons();
    },
  );

  document
    .querySelectorAll(
      "[data-sign-out]",
    )
    .forEach((button) => {
      button.onclick =
        async (event) => {
          const target =
            event.currentTarget;

          target.disabled = true;

          try {
            await api(
              "sign-out",
              {},
            );

            session = null;
            dashboard = null;
            validation = null;
            csrfToken = null;
            activeSeriesKey =
              null;

            go("/");
          } catch (error) {
            target.textContent =
              error.message;

            target.disabled =
              false;
          }
        };
    });

  const orgSwitch =
    document.querySelector(
      "#org-switch",
    );

  if (orgSwitch) {
    orgSwitch.onchange =
      async (event) => {
        try {
          await api(
            "organizations/switch",
            {
              organizationId:
                event.target.value,
            },
          );

          validation = null;
          activeSeriesKey = null;

          await route();
        } catch (error) {
          showError(error);
        }
      };
  }
}

function subscriptionBanner(
  subscription,
) {
  if (
    !subscription ||
    subscription.status ===
      "active"
  ) {
    return "";
  }

  return `
    <div class="billing-banner">
      ${icon("credit-card")}

      <div>
        <strong>
          ${esc(
            subscription.priceLabel,
          )}
          BIZNORYX workspace
        </strong>

        <p>
          ${esc(
            subscription.nextStep,
          )}
        </p>
      </div>

      ${link(
        "/billing",
        "Review billing",
        "button secondary",
      )}
    </div>
  `;
}

function heading(
  kicker,
  title,
  subtitle,
  action = "",
) {
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
  const p =
    dashboard?.profile || {};

  const hasOrg = Boolean(
    dashboard?.shell
      ?.activeOrganization ||
      session?.shell
        ?.activeOrganization,
  );

  shell(
    `
      ${heading(
        "YOUR BUSINESS",
        hasOrg
          ? "Business profile"
          : "Make this workspace yours.",
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
            p.legalName ||
              dashboard?.shell
                ?.activeOrganization
                ?.name ||
              "",
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
              p.businessModel ||
                "",
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
                        ${
                          p.primaryCurrency ===
                          c
                            ? "selected"
                            : ""
                        }
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
                      value="${
                        i + 1
                      }"
                      ${
                        p.fiscalYearStartMonth ===
                        i + 1
                          ? "selected"
                          : ""
                      }
                    >
                      ${new Date(
                        2026,
                        i,
                        1,
                      ).toLocaleString(
                        "en",
                        {
                          month:
                            "long",
                        },
                      )}
                    </option>`,
                ).join("")}
              </select>
            </label>
          </div>

          ${field(
            "Time zone",
            "timezone",
            "text",
            p.timezone ||
              Intl.DateTimeFormat()
                .resolvedOptions()
                .timeZone,
          )}

          <div class="form-actions">
            <button
              type="submit"
              class="primary"
            >
              ${
                hasOrg
                  ? "Save business profile"
                  : "Create business"
              }

              ${icon("arrow-right")}
            </button>

            ${
              hasOrg
                ? link(
                    "/data",
                    "Continue to data",
                    "quiet-link",
                  )
                : ""
            }
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

  bindForm(
    "#business-form",
    async (data) => {
      if (
        !session?.shell
          ?.activeOrganization &&
        !dashboard?.shell
          ?.activeOrganization
      ) {
        const result =
          await api(
            "organizations",
            {
              name:
                data.legalName,
            },
          );

        session.shell =
          result.shell;
      }

      await api(
        "onboarding/profile",
        {
          ...data,

          fiscalYearStartMonth:
            Number(
              data.fiscalYearStartMonth,
            ),
        },
      );

      go("/data");
    },
  );
}

function dataPage() {
  const uploads =
    Array.isArray(
      dashboard?.uploads,
    )
      ? dashboard.uploads
      : [];

  shell(
    `
      ${heading(
        "DATA WORKSPACE",
        "Good decisions start with good data.",
        "Add one or more reporting files to your business history.",
      )}

      <div class="data-layout">
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
              new Date()
                .toISOString()
                .slice(0, 7),
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
            ${esc(
              dashboard.profile
                ?.primaryCurrency ||
                "USD",
            )}
          </p>

          ${link(
            "/business",
            "Edit business profile",
            "inline-link",
          )}
        </aside>
      </div>

      <div id="validation-result">
        ${
          validation
            ? validationHtml(
                validation,
              )
            : ""
        }
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
                              ${icon(
                                "file-spreadsheet",
                              )}

                              ${esc(
                                u.fileName,
                              )}
                            </td>

                            <td>
                              ${esc(
                                u.sourceFormat ||
                                  u.dataKind ||
                                  "Business file",
                              )}
                            </td>

                            <td>
                              ${esc(
                                u.dataSeries ||
                                  "Primary performance",
                              )}
                            </td>

                            <td>
                              ${esc(
                                u.period ||
                                  u.periodLabel ||
                                  "—",
                              )}
                            </td>

                            <td>
                              ${esc(
                                u.metricLabel ||
                                  "Metric",
                              )}

                              ${
                                u.status ===
                                  "confirmed" ||
                                u.status ===
                                  "awaiting_confirmation"
                                  ? `
                                    <small>
                                      ${esc(
                                        metricAmount(
                                          u,
                                        ),
                                      )}
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
                                  ].includes(
                                    u.status,
                                  )
                                    ? "success"
                                    : ""
                                }"
                              >
                                ${esc(
                                  String(
                                    u.status ||
                                      "unknown",
                                  ).replaceAll(
                                    "_",
                                    " ",
                                  ),
                                )}
                              </span>
                            </td>

                            <td>
                              <button
                                class="text-button review-upload"
                                data-id="${
                                  u.id
                                }"
                                type="button"
                              >
                                Review
                                ${icon(
                                  "arrow-up-right",
                                )}
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

  const fileInput =
    document.querySelector(
      '[name="file"]',
    );

  if (fileInput) {
    fileInput.onchange = () => {
      const files = [
        ...fileInput.files,
      ];

      const fileLabel =
        document.querySelector(
          "#file-label",
        );

      if (fileLabel) {
        fileLabel.textContent =
          files.length
            ? `${files.length} file${
                files.length === 1
                  ? ""
                  : "s"
              } selected`
            : "Choose business files";
      }
    };
  }

  const drop =
    document.querySelector(
      "#dropzone",
    );

  if (
    drop &&
    fileInput
  ) {
    drop.ondragover = (e) => {
      e.preventDefault();

      drop.classList.add(
        "dragging",
      );
    };

    drop.ondragleave = () =>
      drop.classList.remove(
        "dragging",
      );

    drop.ondrop = (e) => {
      e.preventDefault();

      drop.classList.remove(
        "dragging",
      );

      try {
        fileInput.files =
          e.dataTransfer.files;
      } catch {
        return;
      }

      fileInput.onchange();
    };
  }

  bindForm(
    "#upload-form",
    async (data) => {
      const files = [
        ...document.querySelector(
          '[name="file"]',
        ).files,
      ];

      if (!files.length) {
        throw new Error(
          "Choose at least one business file.",
        );
      }

      if (
        files.some(
          (file) =>
            file.size >
            25 *
              1024 *
              1024,
        )
      ) {
        throw new Error(
          "Choose files smaller than 25 MB each.",
        );
      }

      const result =
        await api(
          "ingestion/upload",
          {
            files:
              await Promise.all(
                files.map(
                  readFilePayload,
                ),
              ),

            period:
              data.period,

            dataSeries:
              data.dataSeries,

            dataKind:
              data.dataKind,

            metricColumn:
              data.metricColumn,
          },
        );

      validation =
        result?.upload ||
        (
          Array.isArray(
            result?.uploads,
          )
            ? result.uploads[0] ||
              null
            : null
        );

      dashboard =
        await api(
          "dashboard",
        );

      dataPage();

      document
        .querySelector(
          "#validation-result",
        )
        ?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
    },
  );

  document
    .querySelectorAll(
      ".review-upload",
    )
    .forEach(
      (button) => {
        button.onclick = () => {
          validation =
            uploads.find(
              (upload) =>
                upload.id ===
                button.dataset.id,
            ) ||
            null;

          dataPage();

          document
            .querySelector(
              "#validation-result",
            )
            ?.scrollIntoView({
              behavior:
                "smooth",
            });
        };
      },
    );

  bindForm(
    "#confirm-form",
    async () => {
      if (
        !validation?.id
      ) {
        throw new Error(
          "No upload is selected for confirmation.",
        );
      }

      await api(
        "ingestion/confirm",
        {
          uploadId:
            validation.id,
        },
      );

      validation = null;

      go("/dashboard");
    },
  );
}

async function readFilePayload(
  file,
) {
  const extension =
    file.name
      .split(".")
      .pop()
      ?.toLowerCase() ||
    "";

  const textLike = [
    "csv",
    "tsv",
    "json",
    "txt",
  ].includes(extension);

  const payload = {
    fileName: file.name,

    contentType:
      file.type ||
      "application/octet-stream",

    sizeBytes: file.size,
  };

  if (textLike) {
    payload.content =
      await file.text();

    return payload;
  }

  payload.contentBase64 =
    await fileToBase64(file);

  return payload;
}

async function fileToBase64(
  file,
) {
  const buffer =
    await file.arrayBuffer();

  let binary = "";

  const bytes =
    new Uint8Array(buffer);

  for (
    let index = 0;
    index < bytes.length;
    index += 0x8000
  ) {
    binary +=
      String.fromCharCode(
        ...bytes.subarray(
          index,
          index + 0x8000,
        ),
      );
  }

  return btoa(binary);
}

function validationHtml(u) {
  if (!u) {
    return "";
  }

  const issues =
    Array.isArray(u.issues)
      ? u.issues
      : [];

  const columns =
    Array.isArray(u.columns)
      ? u.columns
      : [];

  const preview =
    Array.isArray(u.preview)
      ? u.preview
      : [];

  const rowCount =
    Number.isFinite(
      Number(
        u.rowCount ??
          u.sourceRowCount,
      ),
    )
      ? Number(
          u.rowCount ??
            u.sourceRowCount,
        )
      : 0;

  const isConfirmed =
    [
      "confirmed",
      "validated",
      "processed",
      "ready",
    ].includes(
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

        ${icon(
          issues.length
            ? "circle-alert"
            : "circle-check",
        )}
      </div>

      <p>
        ${esc(
          u.fileName ||
            "Business file",
        )}
        &middot;
        ${esc(
          u.sourceFormat ||
            u.dataSeries ||
            "Business file",
        )}
        &middot;
        ${rowCount} rows
        &middot;
        ${esc(
          u.period ||
            u.periodLabel ||
            "Reporting period",
        )}
      </p>

      ${
        issues.length
          ? `
            <ul class="validation-errors">
              ${issues
                .map(
                  (issue) => `
                    <li>
                      ${
                        issue?.row
                          ? `Row ${esc(
                              issue.row,
                            )}: `
                          : ""
                      }

                      ${esc(
                        issue?.message ||
                          "Validation issue",
                      )}
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
                  ${esc(
                    u.dataKind ||
                      u.sourceFormat ||
                      "Business dataset",
                  )}
                </strong>
              </span>

              <span>
                Metric column
                <strong>
                  ${esc(
                    u.metricColumn ||
                      u.sourceColumn ||
                      "Auto-detected",
                  )}
                </strong>
              </span>

              <span>
                ${esc(
                  u.metricLabel ||
                    "Metric",
                )}
                total

                <strong>
                  ${esc(
                    metricAmount(
                      u,
                    ),
                  )}
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
              rowCount ||
              columns.length ||
              u.checksum
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
                                  String(
                                    u.checksum,
                                  ).slice(
                                    0,
                                    12,
                                  ),
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
                          ${esc(
                            u.sourceFormat ||
                              "business file",
                          )}.
                        </span>
                      </li>

                      ${
                        u.metricColumn ||
                        u.sourceColumn
                          ? `
                            <li>
                              <strong>
                                VERIFIED FACT
                              </strong>

                              <span>
                                Metric source:
                                ${esc(
                                  u.metricColumn ||
                                    u.sourceColumn,
                                )}.
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
                          to the business evidence history.
                        </span>
                      </li>
                    </ul>
                  </div>

                  ${profileSummaryHtml(
                    u,
                  )}
                `
                : ""
            }
          `
      }

      ${
        columns.length &&
        preview.length
          ? `
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    ${columns
                      .map(
                        (column) =>
                          `<th>
                            ${esc(
                              column,
                            )}
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
                                  ${esc(
                                    row?.[
                                      column
                                    ],
                                  )}
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
        u.status ===
          "awaiting_confirmation"
          ? `
            <form id="confirm-form">
              <button
                class="primary"
                type="submit"
                ${
                  issues.length
                    ? "disabled"
                    : ""
                }
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
  const numeric = (
    u.numericProfile || []
  ).slice(0, 4);

  const dimensions = (
    u.dimensionProfile || []
  ).slice(0, 3);

  const drivers = (
    u.dimensionBreakdowns ||
    []
  ).slice(0, 3);

  if (
    !numeric.length &&
    !dimensions.length &&
    !drivers.length
  ) {
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
                        ${esc(
                          item.label,
                        )}
                      </strong>

                      <span>
                        ${
                          item.valueType ===
                          "money"
                            ? money(
                                item.sumCents,
                              )
                            : numberValue(
                                Number(
                                  item.sumCents,
                                ) /
                                  100,
                              )
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
                        ${esc(
                          item.label,
                        )}
                      </strong>

                      <span>
                        ${
                          item.uniqueCount
                        }
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
                        ${esc(
                          item.label,
                        )}
                      </strong>

                      <span>
                        ${esc(
                          item
                            .topValues[
                            0
                          ]?.value ||
                            "",
                        )}
                        ·
                        ${esc(
                          u.metricType ===
                          "money"
                            ? money(
                                item
                                  .topValues[
                                  0
                                ]
                                  ?.sumCents ||
                                  0,
                              )
                            : numberValue(
                                Number(
                                  item
                                    .topValues[
                                    0
                                  ]
                                    ?.sumCents ||
                                    0,
                                ) /
                                  100,
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
  const hasProfile =
    Boolean(
      dashboard.profile,
    );

  const confirmed =
    dashboard.uploads.filter(
      (u) =>
        u.status ===
        "confirmed",
    ).length;

  const reports =
    dashboard.evidenceReports
      ?.length ?? 0;

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
        ? `${confirmed} confirmed source file${
            confirmed === 1
              ? ""
              : "s"
          }`
        : "CSV, TSV, JSON, TXT and text-based PDF statements",

      confirmed > 0,

      "/data",
    ],

    [
      "Read the evidence report",

      reports
        ? `${reports} fact-based report${
            reports === 1
              ? ""
              : "s"
          } ready`
        : "Confirm a source to generate verified facts",

      reports > 0,

      "/reports",
    ],

    [
      "Repeat next period",

      dashboard.series
        ?.length > 1
        ? "Trend memory is active"
        : "Add the next month to reveal movement",

      dashboard.series
        ?.length > 1,

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
            ([
              title,
              copy,
              done,
              href,
            ], index) => `
              <li
                class="${
                  done
                    ? "done"
                    : ""
                }"
              >
                <span>
                  ${
                    done
                      ? icon(
                          "check",
                        )
                      : String(
                          index +
                            1,
                        ).padStart(
                          2,
                          "0",
                        )
                  }
                </span>

                <div>
                  <h3>
                    ${title}
                  </h3>

                  <p>
                    ${copy}
                  </p>

                  ${link(
                    href,
                    "Open",
                    "inline-link",
                  )}
                </div>
              </li>
            `,
          )
          .join("")}
      </ol>
    </section>
  `;
}

function seriesPickerHtml(
  groups,
  activeGroup,
) {
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
              data-series-key="${esc(
                group.key,
              )}"
              class="${
                group.key ===
                activeGroup?.key
                  ? "active"
                  : ""
              }"
            >
              <span>
                ${esc(
                  group.dataKind,
                )}
              </span>

              <strong>
                ${esc(
                  group.name,
                )}
              </strong>

              <small>
                ${
                  group.points
                    .length
                }
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
  document
    .querySelectorAll(
      "[data-series-key]",
    )
    .forEach((button) => {
      button.onclick = () => {
        activeSeriesKey =
          button.dataset
            .seriesKey;

        overview();
      };
    });
}

function overview() {
  const profile =
    dashboard?.profile ||
    {};

  const uploads =
    Array.isArray(
      dashboard?.uploads,
    )
      ? dashboard.uploads
      : [];

  const reports =
    Array.isArray(
      dashboard?.evidenceReports,
    )
      ? dashboard.evidenceReports
      : [];

  const metricSeries =
    Array.isArray(
      dashboard?.series,
    )
      ? dashboard.series
          .filter(
            (item) =>
              item &&
              Array.isArray(
                item.points,
              ) &&
              item.points.length,
          )
          .map(
            (item) => ({
              ...item,
              points: [
                ...item.points,
              ].sort(
                (left, right) => {
                  const leftTime =
                    new Date(
                      left?.periodStart ||
                        left?.createdAt ||
                        0,
                    ).getTime();

                  const rightTime =
                    new Date(
                      right?.periodStart ||
                        right?.createdAt ||
                        0,
                    ).getTime();

                  return (
                    leftTime -
                    rightTime
                  );
                },
              ),
            }),
          )
      : [];

  const organization =
    dashboard?.shell
      ?.activeOrganization ||
    session?.shell
      ?.activeOrganization ||
    null;

  const businessName =
    organization?.name ||
    profile.legalName ||
    "Your business";

  const currency =
    profile.primaryCurrency ||
    "USD";

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

  const metricPriority = (
    item,
  ) => {
    const sourceColumn =
      String(
        item?.sourceColumn ||
          "",
      )
        .trim()
        .toLowerCase();

    const index =
      preferredMetricColumns.indexOf(
        sourceColumn,
      );

    return index === -1
      ? preferredMetricColumns.length
      : index;
  };

  const orderedSeries = [
    ...metricSeries,
  ].sort(
    (left, right) =>
      metricPriority(left) -
        metricPriority(right) ||
      String(
        left?.dataStream
          ?.displayName ||
          "",
      ).localeCompare(
        String(
          right?.dataStream
            ?.displayName ||
            "",
        ),
      ) ||
      String(
        left?.label ||
          "",
      ).localeCompare(
        String(
          right?.label ||
            "",
        ),
      ),
  );

  const activeMetric =
    orderedSeries.find(
      (item) =>
        item.id ===
        activeSeriesKey,
    ) ||
    orderedSeries[0] ||
    null;

  activeSeriesKey =
    activeMetric?.id ||
    null;

  const points =
    activeMetric?.points ||
    [];

  const latest =
    points.at(-1) ||
    null;

  const previous =
    points.at(-2) ||
    null;

  const numericValue = (
    value,
  ) => {
    const parsed =
      Number(value);

    return Number.isFinite(
      parsed,
    )
      ? parsed
      : null;
  };

  const isCurrencyMetric = (
    item,
  ) =>
    /\b(revenue|sales|income|profit|cost|amount|price|refund|spend|expense|value)\b/i.test(
      String(
        item?.sourceColumn ||
          item?.label ||
          "",
      ).replaceAll(
        "_",
        " ",
      ),
    );

  const formatMetricValue = (
    value,
    item = activeMetric,
  ) => {
    const parsed =
      numericValue(value);

    if (parsed === null) {
      return "—";
    }

    if (
      item?.unit ===
      "percent"
    ) {
      return `${numberValue(
        parsed,
      )}%`;
    }

    if (
      item?.unit ===
        "count" ||
      !isCurrencyMetric(
        item,
      )
    ) {
      return numberValue(
        parsed,
      );
    }

    try {
      return new Intl.NumberFormat(
        undefined,
        {
          style:
            "currency",
          currency,
          maximumFractionDigits:
            2,
        },
      ).format(
        parsed,
      );
    } catch {
      return `${currency} ${numberValue(
        parsed,
      )}`;
    }
  };

  const formatPeriod = (
    point,
  ) => {
    if (
      point?.periodLabel
    ) {
      return String(
        point.periodLabel,
      );
    }

    const raw =
      String(
        point?.periodStart ||
          "",
      );

    if (!raw) {
      return "Period";
    }

    const monthlyMatch =
      raw.match(
        /^(\d{4})-(\d{2})/,
      );

    if (
      monthlyMatch
    ) {
      const year =
        Number(
          monthlyMatch[1],
        );

      const month =
        Number(
          monthlyMatch[2],
        );

      if (
        Number.isInteger(
          year,
        ) &&
        month >= 1 &&
        month <= 12
      ) {
        return new Intl.DateTimeFormat(
          undefined,
          {
            month:
              "short",
            year:
              "numeric",
            timeZone:
              "UTC",
          },
        ).format(
          new Date(
            Date.UTC(
              year,
              month - 1,
              1,
            ),
          ),
        );
      }
    }

    return raw.slice(
      0,
      10,
    );
  };

  const latestValue =
    numericValue(
      latest?.value,
    );

  const previousValue =
    numericValue(
      previous?.value,
    );

  const changePercent =
    latestValue !==
      null &&
    previousValue !==
      null &&
    previousValue !==
      0
      ? ((latestValue -
          previousValue) /
          Math.abs(
            previousValue,
          )) *
        100
      : null;

  const acceptedUploadStatuses =
    new Set([
      "validated",
      "confirmed",
      "processed",
      "ready",
    ]);

  const validatedUploads =
    uploads.filter(
      (upload) =>
        acceptedUploadStatuses.has(
          upload?.status,
        ),
    ).length;

  const rejectedUploads =
    uploads.filter(
      (upload) =>
        upload?.status ===
        "rejected",
    ).length;

  const schemaWarnings =
    uploads.filter(
      (upload) =>
        Boolean(
          upload?.schemaDrift,
        ),
    ).length;

  const verifiedPeriods =
    new Set(
      metricSeries.flatMap(
        (item) =>
          item.points.map(
            (point) =>
              String(
                point?.reportingPeriodId ||
                  point?.periodStart ||
                  point?.periodLabel ||
                  "",
              ),
          ),
      ),
    ).size;

  const latestSourceRows =
    Number.isFinite(
      Number(
        latest?.sourceRowCount,
      ),
    )
      ? Number(
          latest
            .sourceRowCount,
        )
      : null;

  const findingCollections = [
    [
      "Focus",
      "focus",
      dashboard?.focusAreas,
    ],
    [
      "Opportunity",
      "opportunity",
      dashboard?.opportunities,
    ],
    [
      "Signal",
      "signal",
      dashboard?.signals,
    ],
    [
      "Risk",
      "risk",
      dashboard?.risks,
    ],
  ];

  const findings =
    findingCollections
      .flatMap(
        ([
          label,
          kind,
          items,
        ]) =>
          Array.isArray(
            items,
          )
            ? items.map(
                (item) => ({
                  label,
                  kind,
                  item,
                }),
              )
            : [],
      )
      .filter(
        (entry) =>
          entry.item &&
          (entry.item.title ||
            entry.item
              .summary),
      );

  const primaryFinding =
    findings[0] ||
    null;

  const trendChartHtml =
    points.length
      ? (() => {
          const width =
            820;
          const height =
            270;
          const padX =
            44;
          const padTop =
            24;
          const padBottom =
            54;

          const chartPoints =
            points
              .map(
                (
                  point,
                  index,
                ) => ({
                  point,
                  value:
                    numericValue(
                      point?.value,
                    ),
                  index,
                }),
              )
              .filter(
                (item) =>
                  item.value !==
                  null,
              );

          if (
            !chartPoints.length
          ) {
            return "";
          }

          const values =
            chartPoints.map(
              (item) =>
                item.value,
            );

          const min =
            Math.min(
              ...values,
            );

          const max =
            Math.max(
              ...values,
            );

          const span =
            max - min ||
            Math.abs(max) ||
            1;

          const plotted =
            chartPoints.map(
              (
                item,
                index,
              ) => {
                const x =
                  chartPoints.length ===
                  1
                    ? width /
                      2
                    : padX +
                      (index *
                        (width -
                          padX *
                            2)) /
                        (chartPoints.length -
                          1);

                const y =
                  padTop +
                  ((max -
                    item.value) /
                    span) *
                    (height -
                      padTop -
                      padBottom);

                return {
                  ...item,
                  x,
                  y,
                };
              },
            );

          const linePath =
            plotted
              .map(
                (
                  point,
                  index,
                ) =>
                  `${
                    index ===
                    0
                      ? "M"
                      : "L"
                  } ${point.x.toFixed(
                    2,
                  )} ${point.y.toFixed(
                    2,
                  )}`,
              )
              .join(
                " ",
              );

          const areaPath =
            `${linePath} ` +
            `L ${plotted
              .at(-1)
              .x.toFixed(
                2,
              )} ${(
              height -
              padBottom
            ).toFixed(
              2,
            )} ` +
            `L ${plotted[0].x.toFixed(
              2,
            )} ${(
              height -
              padBottom
            ).toFixed(
              2,
            )} Z`;

          return `
            <div
              class="overview-trend-chart"
              role="img"
              aria-label="${esc(
                activeMetric?.label ||
                  "Business metric",
              )} over ${
                plotted.length
              } verified period${
                plotted.length ===
                1
                  ? ""
                  : "s"
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
                        cx="${point.x.toFixed(
                          2,
                        )}"
                        cy="${point.y.toFixed(
                          2,
                        )}"
                        r="5"
                      ></circle>
                    `,
                  )
                  .join(
                    "",
                  )}
              </svg>

              <div
                class="overview-trend-labels"
              >
                ${plotted
                  .map(
                    (point) => `
                      <div>
                        <span>
                          ${esc(
                            formatPeriod(
                              point.point,
                            ),
                          )}
                        </span>

                        <strong>
                          ${esc(
                            formatMetricValue(
                              point.value,
                            ),
                          )}
                        </strong>
                      </div>
                    `,
                  )
                  .join(
                    "",
                  )}
              </div>
            </div>
          `;
        })()
      : "";

  const businessContext = [
    profile.industry
      ? [
          "Industry",
          profile.industry,
        ]
      : null,

    profile.businessModel
      ? [
          "Business model",
          profile.businessModel,
        ]
      : null,

    [
      "Currency",
      currency,
    ],

    [
      "Verified periods",
      String(
        verifiedPeriods,
      ),
    ],
  ].filter(
    Boolean,
  );

  const heroSummary =
    primaryFinding
      ?.item?.summary ||
    (
      latest
        ? `${activeMetric?.label || "Performance"} is ${formatMetricValue(
            latest.value,
          )} for ${formatPeriod(
            latest,
          )}${
            changePercent ===
            null
              ? "."
              : `, ${
                  changePercent >=
                  0
                    ? "up"
                    : "down"
                } ${Math.abs(
                  changePercent,
                ).toFixed(
                  1,
                )}% from the previous verified period.`
          }`
        : "No verified performance history is available yet. Add comparable business data to establish the first baseline."
    );

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
              ${esc(
                businessName,
              )}
            </h1>

            <p
              class="overview-v2-summary"
            >
              ${esc(
                heroSummary,
              )}
            </p>
          </div>

          <div
            class="overview-v2-actions"
          >
            ${link(
              "/data",
              `${icon(
                "plus",
              )} Add data`,
              "button primary",
            )}

            ${
              reports.length
                ? link(
                    "/reports",
                    `Evidence ${icon(
                      "arrow-right",
                    )}`,
                    "button secondary",
                  )
                : ""
            }
          </div>
        </header>

        ${
          !profile ||
          !Object.keys(
            profile,
          ).length
            ? `
              <div
                class="notice"
              >
                ${icon(
                  "building-2",
                )}

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

                ${link(
                  "/business",
                  "Complete profile",
                  "button secondary",
                )}
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
                ${esc(
                  activeMetric?.label ||
                    "Primary metric",
                )}
              </span>

              ${icon(
                "activity",
              )}
            </div>

            <strong>
              ${
                latest
                  ? esc(
                      formatMetricValue(
                        latest.value,
                      ),
                    )
                  : "—"
              }
            </strong>

            <small>
              ${
                latest
                  ? esc(
                      formatPeriod(
                        latest,
                      ),
                    )
                  : "No verified period"
              }
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
                changePercent !==
                    null &&
                  changePercent <
                    0
                  ? "trending-down"
                  : "trending-up",
              )}
            </div>

            <strong
              class="${
                changePercent ===
                null
                  ? ""
                  : changePercent <
                      0
                    ? "negative"
                    : "positive"
              }"
            >
              ${
                changePercent ===
                null
                  ? "—"
                  : `${
                      changePercent >
                      0
                        ? "+"
                        : ""
                    }${changePercent.toFixed(
                      1,
                    )}%`
              }
            </strong>

            <small>
              ${
                previous
                  ? `vs ${esc(
                      formatPeriod(
                        previous,
                      ),
                    )}`
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

              ${icon(
                "file-check-2",
              )}
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

              ${icon(
                "rows-3",
              )}
            </div>

            <strong>
              ${
                latestSourceRows ===
                null
                  ? "—"
                  : numberValue(
                      latestSourceRows,
                    )
              }
            </strong>

            <small>
              ${validatedUploads}
              validated upload${
                validatedUploads ===
                1
                  ? ""
                  : "s"
              }
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
                  ${esc(
                    activeMetric?.label ||
                      "Verified performance",
                  )}
                </h2>

                <p>
                  ${esc(
                    activeMetric
                      ?.dataStream
                      ?.displayName ||
                      activeMetric
                        ?.dataStream
                        ?.name ||
                      "Primary performance",
                  )}
                </p>
              </div>

              <span
                class="overview-v2-period-count"
              >
                ${points.length}
                period${
                  points.length ===
                  1
                    ? ""
                    : "s"
                }
              </span>
            </div>

            ${
              orderedSeries.length >
              1
                ? `
                  <div
                    class="overview-v2-metric-tabs"
                    aria-label="Choose metric"
                  >
                    ${orderedSeries
                      .slice(
                        0,
                        8,
                      )
                      .map(
                        (item) => `
                          <button
                            type="button"
                            data-overview-series="${esc(
                              item.id,
                            )}"
                            class="${
                              item.id ===
                              activeMetric?.id
                                ? "active"
                                : ""
                            }"
                          >
                            ${esc(
                              item.label ||
                                item.sourceColumn ||
                                "Metric",
                            )}
                          </button>
                        `,
                      )
                      .join(
                        "",
                      )}
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
                  ${icon(
                    "chart-no-axes-combined",
                  )}

                  <h3>
                    No verified trend yet.
                  </h3>

                  <p>
                    Once the production worker has processed
                    validated data, verified metric history
                    will appear here.
                  </p>

                  ${link(
                    "/data",
                    "Open data workspace",
                    "inline-link",
                  )}
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
                          primaryFinding
                            .item
                            .title ||
                            "What deserves attention",
                        )
                      : "What deserves attention"
                  }
                </h2>
              </div>

              ${icon(
                "scan-search",
              )}
            </div>

            <p
              class="overview-v2-reading-copy"
            >
              ${esc(
                primaryFinding
                  ?.item
                  ?.summary ||
                  (
                    latest
                      ? `BIZNORYX has verified ${points.length} period${
                          points.length ===
                          1
                            ? ""
                            : "s"
                        } for ${activeMetric?.label || "this metric"}. Add more comparable periods to strengthen the business reading.`
                      : "There is not enough verified history to identify a movement yet."
                  ),
              )}
            </p>

            ${
              findings.length
                ? `
                  <div
                    class="overview-v2-findings"
                  >
                    ${findings
                      .slice(
                        0,
                        3,
                      )
                      .map(
                        ({
                          label,
                          kind,
                          item,
                        }) => `
                          <article
                            class="overview-v2-finding ${kind}"
                          >
                            <span>
                              ${esc(
                                label,
                              )}
                            </span>

                            <strong>
                              ${esc(
                                item.title ||
                                  label,
                              )}
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
                      .join(
                        "",
                      )}
                  </div>
                `
                : `
                  <div
                    class="overview-v2-no-findings"
                  >
                    ${icon(
                      "shield-check",
                    )}

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

              ${icon(
                "building-2",
              )}
            </div>

            <dl
              class="overview-v2-context"
            >
              ${businessContext
                .map(
                  ([
                    label,
                    value,
                  ]) => `
                    <div>
                      <dt>
                        ${esc(
                          label,
                        )}
                      </dt>

                      <dd>
                        ${esc(
                          value,
                        )}
                      </dd>
                    </div>
                  `,
                )
                .join(
                  "",
                )}
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
                    rejectedUploads ||
                    schemaWarnings
                      ? "Review needed"
                      : "Sources in good standing"
                  }
                </h2>
              </div>

              ${icon(
                rejectedUploads ||
                  schemaWarnings
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

  document
    .querySelectorAll(
      "[data-overview-series]",
    )
    .forEach(
      (button) => {
        button.onclick =
          () => {
            activeSeriesKey =
              button.dataset
                .overviewSeries;

            overview();
          };
      },
    );
}

let reportOptions = {};
let reportOrganizationId;
let reportRequestVersion = 0;
let currentReport;

async function reports() {
  const organizationId =
    dashboard.shell
      .activeOrganization?.id;

  if (
    organizationId !==
    reportOrganizationId
  ) {
    reportOrganizationId =
      organizationId;

    reportOptions = {};
  }

  const requestVersion =
    ++reportRequestVersion;

  const routeVersion =
    navigationVersion;

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
    const result =
      await api(
        "evidence-report?" +
          new URLSearchParams(
            reportOptions,
          ),
      );

    if (
      requestVersion !==
        reportRequestVersion ||
      routeVersion !==
        navigationVersion
    ) {
      return;
    }

    currentReport =
      result.report;

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

              ${link(
                "/data",
                "Upload business data",
                "button dark",
              )}
            </section>
          `,
        "/reports",
      );

      return;
    }

    const report =
      currentReport;

    reportOptions = {
      source:
        report.sourceId,

      metric:
        report.metric.column,

      period:
        report.current.period,

      compare:
        report.previous
          ?.period ||
        "none",

      ...(report.controls
        .dateColumn
        ? {
            dateColumn:
              report.controls
                .dateColumn,
          }
        : {}),

      ...(report.controls
        .dimension
        ? {
            dimension:
              report.controls
                .dimension,
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
        renderEvidenceReport(
          report,
        ),
      "/reports",
    );

    bindReportControls();
  } catch (error) {
    if (
      requestVersion !==
        reportRequestVersion ||
      routeVersion !==
        navigationVersion
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
              ${esc(
                error.message,
              )}
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

    const retry =
      document.querySelector(
        "#report-retry",
      );

    if (retry) {
      retry.onclick = () => {
        reportOptions = {};
        reports();
      };
    }
  }
}

function reportPageHeader(
  ready = false,
) {
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
                ${icon(
                  "refresh-cw",
                )}
              </button>

              <button
                class="er-icon-button"
                type="button"
                data-definition
                title="Metric definition"
                aria-label="Metric definition"
              >
                ${icon(
                  "settings-2",
                )}
              </button>

              <button
                class="er-icon-button"
                type="button"
                data-report-print
                title="Print report"
                aria-label="Print report"
              >
                ${icon(
                  "printer",
                )}
              </button>

              <button
                class="er-icon-button"
                type="button"
                data-report-export="csv"
                title="Export comparison CSV"
                aria-label="Export comparison CSV"
              >
                ${icon(
                  "table-2",
                )}
              </button>

              <button
                class="primary"
                type="button"
                data-report-export="pdf"
              >
                ${icon(
                  "download",
                )}
                Export PDF
              </button>

              <button
                class="secondary"
                type="button"
                data-report-export="html"
              >
                ${icon(
                  "file-code",
                )}
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
    .querySelector(
      "#report-controls",
    )
    ?.addEventListener(
      "change",
      async (event) => {
        const key =
          event.target.name;

        const value =
          event.target.value;

        if (key === "source") {
          reportOptions = {
            source: value,
          };
        } else if (
          key === "metric"
        ) {
          reportOptions = {
            source:
              reportOptions.source,

            metric: value,
          };
        } else if (
          key === "dateColumn"
        ) {
          reportOptions = {
            source:
              reportOptions.source,

            metric:
              reportOptions.metric,

            dateColumn:
              value,
          };
        } else {
          reportOptions[key] =
            value;

          if (
            key === "period"
          ) {
            delete reportOptions.compare;
          }
        }

        await reports();

        document
          .querySelector(
            '#report-controls [name="' +
              key +
              '"]',
          )
          ?.focus();
      },
    );

  const refresh =
    document.querySelector(
      "[data-report-refresh]",
    );

  if (refresh) {
    refresh.onclick = () =>
      reports();
  }

  const print =
    document.querySelector(
      "[data-report-print]",
    );

  if (print) {
    print.onclick = () => {
      const closed = [
        ...document.querySelectorAll(
          ".evidence-report details:not([open])",
        ),
      ];

      closed.forEach(
        (details) =>
          (details.open = true),
      );

      window.addEventListener(
        "afterprint",
        () =>
          closed.forEach(
            (details) =>
              (details.open =
                false),
          ),
        {
          once: true,
        },
      );

      window.print();
    };
  }

  document
    .querySelectorAll(
      "[data-evidence]",
    )
    .forEach((button) => {
      button.onclick = () =>
        openReportDialog(
          evidenceDialog(
            currentReport,
            button.dataset
              .evidence,
          ),
          button,
        );
    });

  document
    .querySelectorAll(
      "[data-definition]",
    )
    .forEach((button) => {
      button.onclick = () => {
        openReportDialog(
          definitionDialog(
            currentReport,
          ),
          button,
        );

        bindForm(
          "#report-definition",
          async (form) => {
            await api(
              "evidence-report/definition",
              {
                ...form,

                source:
                  currentReport
                    .sourceId,

                metric:
                  currentReport
                    .metric
                    .column,

                expectedVersion:
                  currentReport
                    .metric
                    .policy
                    ?.version ??
                  0,
              },
            );

            document
              .querySelector(
                "#definition-dialog",
              )
              ?.close();

            await reports();

            const status =
              document.querySelector(
                ".er-status",
              );

            if (status) {
              status.textContent =
                "Metric definition approved. The report has been recalculated.";
            }
          },
        );
      };
    });

  document
    .querySelectorAll(
      "[data-report-export]",
    )
    .forEach((button) => {
      button.onclick =
        async () => {
          button.disabled =
            true;

          const status =
            document.querySelector(
              ".er-status",
            );

          if (status) {
            status.textContent =
              "Preparing the report...";
          }

          try {
            const format =
              button.dataset
                .reportExport;

            const response =
              await fetch(
                "/api/evidence-report?" +
                  new URLSearchParams(
                    {
                      ...reportOptions,
                      format,
                    },
                  ),
                {
                  credentials:
                    "same-origin",
                },
              );

            if (
              !response.ok
            ) {
              let payload = {};

              try {
                payload =
                  await response.json();
              } catch {
                payload = {};
              }

              throw new Error(
                payload.message ||
                  "Export failed. Try again.",
              );
            }

            const blob =
              await response.blob();

            const url =
              URL.createObjectURL(
                blob,
              );

            const anchor =
              document.createElement(
                "a",
              );

            anchor.href = url;

            anchor.download =
              "biznoryx-evidence-" +
              currentReport
                .current.period +
              "." +
              format;

            anchor.click();

            setTimeout(
              () =>
                URL.revokeObjectURL(
                  url,
                ),
              30000,
            );

            if (status) {
              status.textContent =
                "Report downloaded.";
            }
          } catch (error) {
            if (status) {
              status.textContent =
                error.message;
            }
          } finally {
            button.disabled =
              false;
          }
        };
    });
}

function openReportDialog(
  html,
  trigger,
) {
  document
    .querySelectorAll(
      ".er-dialog",
    )
    .forEach((dialog) =>
      dialog.remove(),
    );

  document.body.insertAdjacentHTML(
    "beforeend",
    html,
  );

  window.lucide?.createIcons();

  const dialog =
    document.querySelector(
      ".er-dialog",
    );

  if (!dialog) {
    return;
  }

  const close =
    dialog.querySelector(
      "[data-close-dialog]",
    );

  if (close) {
    close.onclick = () =>
      dialog.close();
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

function billingPage() {
  const subscription =
    dashboard?.subscription ?? null;

  const uploads =
    Array.isArray(dashboard?.uploads)
      ? dashboard.uploads
      : [];

  const evidenceReports =
    Array.isArray(
      dashboard?.evidenceReports,
    )
      ? dashboard.evidenceReports
      : [];

  const status =
    subscription?.status ||
    "not_started";

  const isActive =
    status === "active";

  const isPending =
    status === "pending_checkout";

  const providerConfigured =
    Boolean(
      subscription?.providerConfigured,
    );

  const isLocalReviewHost =
    [
      "localhost",
      "127.0.0.1",
      "::1",
    ].includes(
      location.hostname,
    );

  const canStartCheckout =
    providerConfigured ||
    isLocalReviewHost;

  const priceLabel =
    subscription?.priceLabel ||
    "₦40,000/mo";

  const planName =
    subscription?.planName ||
    "BIZNORYX Monthly";

  const statusDetails =
    {
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
        label: "Trial",
        tone: "trial",
        description:
          "Your workspace is currently using trial access.",
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
        description:
          "This subscription is no longer renewing.",
      },

      not_started: {
        label: "Not active",
        tone: "neutral",
        description:
          "Activate BIZNORYX when billing is available for this workspace.",
      },
    }[status] || {
      label:
        String(status).replaceAll(
          "_",
          " ",
        ),

      tone: "neutral",

      description:
        "Review the current subscription status.",
    };

  const renewalLabel =
    subscription?.currentPeriodEnd
      ? new Date(
          subscription.currentPeriodEnd,
        ).toLocaleDateString(
          undefined,
          {
            year: "numeric",
            month: "short",
            day: "numeric",
          },
        )
      : isActive
        ? "Current period active"
        : "After activation";

  const retainedBytes =
    uploads.reduce(
      (total, upload) => {
        const size =
          Number(
            upload?.sourceSizeBytes ??
              upload?.sizeBytes ??
              0,
          );

        return Number.isFinite(
          size,
        ) &&
          size > 0
          ? total + size
          : total;
      },
      0,
    );

  const formatBytes =
    (bytes) => {
      if (
        !Number.isFinite(
          bytes,
        ) ||
        bytes <= 0
      ) {
        return "—";
      }

      const units = [
        "B",
        "KB",
        "MB",
        "GB",
        "TB",
      ];

      let value = bytes;
      let index = 0;

      while (
        value >= 1024 &&
        index <
          units.length - 1
      ) {
        value /= 1024;
        index += 1;
      }

      return `${
        value >= 10 ||
        index === 0
          ? value.toFixed(0)
          : value.toFixed(1)
      } ${units[index]}`;
    };

  const featureRows = [
    [
      "database",
      "Recurring business-data processing",
    ],

    [
      "line-chart",
      "Verified metrics and historical comparisons",
    ],

    [
      "file-check-2",
      "Evidence reports backed by source data",
    ],

    [
      "download",
      "Professional report exports",
    ],

    [
      "history",
      "Persistent business performance history",
    ],
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
            class="billing-status ${esc(
              statusDetails.tone,
            )}"
          >
            <span
              aria-hidden="true"
            ></span>

            ${esc(
              statusDetails.label,
            )}
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
                  ${esc(
                    planName,
                  )}
                </h2>
              </div>

              <span class="billing-plan-chip">
                Monthly
              </span>
            </div>

            <div class="billing-price-row">
              <strong>
                ${esc(
                  priceLabel.replace(
                    /\/mo$/i,
                    "",
                  ),
                )}
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
                  ([
                    featureIcon,
                    label,
                  ]) => `
                    <div class="billing-feature-row">
                      <span>
                        ${icon(
                          featureIcon,
                        )}
                      </span>

                      <p>
                        ${esc(
                          label,
                        )}
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
                      ${icon(
                        "circle-check",
                      )}

                      <div>
                        <strong>
                          Subscription active
                        </strong>

                        <span>
                          Your paid workspace is currently enabled.
                        </span>
                      </div>
                    </div>
                  `
                  : subscription &&
                      canStartCheckout
                    ? `
                      <button
                        id="open-billing-checkout"
                        class="primary billing-primary-action"
                        type="button"
                      >
                        ${icon(
                          "credit-card",
                        )}

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
                        ${icon(
                          "lock",
                        )}

                        ${
                          subscription
                            ? "Payments unavailable"
                            : "Billing setup in progress"
                        }
                      </button>
                    `
              }

              <p class="billing-security-note">
                ${icon(
                  "shield-check",
                )}

                Secure checkout powered by Paystack.
                BIZNORYX does not store your card details.
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

                ${icon(
                  "credit-card",
                )}
              </div>

              <p class="billing-status-description">
                ${esc(
                  statusDetails.description,
                )}
              </p>

              <dl class="billing-summary-list">
                <div>
                  <dt>
                    Status
                  </dt>

                  <dd>
                    ${esc(
                      statusDetails.label,
                    )}
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
                    ${esc(
                      renewalLabel,
                    )}
                  </dd>
                </div>

                <div>
                  <dt>
                    Billing interval
                  </dt>

                  <dd>
                    ${esc(
                      subscription?.interval ||
                        "monthly",
                    )}
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

                ${icon(
                  "bar-chart-3",
                )}
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
                    ${esc(
                      formatBytes(
                        retainedBytes,
                      ),
                    )}
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

            ${icon(
              "receipt",
            )}
          </div>

          <div class="billing-empty-history">
            ${icon(
              "receipt",
            )}

            <div>
              <strong>
                No payment history to show yet
              </strong>

              <p>
                Successful subscription payments and
                receipts will appear here.
              </p>
            </div>
          </div>
        </section>

        ${
          isLocalReviewHost &&
          !providerConfigured &&
          subscription
            ?.checkoutReference &&
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
                  ${icon(
                    "check",
                  )}

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
                  Activate ${esc(
                    planName,
                  )}
                </h2>
              </div>

              <button
                class="billing-dialog-close"
                type="button"
                data-billing-dialog-close
                aria-label="Close billing confirmation"
              >
                ${icon(
                  "x",
                )}
              </button>
            </div>

            <div class="billing-dialog-plan">
              <div>
                <span>
                  Monthly subscription
                </span>

                <strong>
                  ${esc(
                    priceLabel,
                  )}
                </strong>
              </div>

              ${icon(
                "shield-check",
              )}
            </div>

            <div class="billing-dialog-features">
              ${featureRows
                .map(
                  ([
                    ,
                    label,
                  ]) => `
                    <div>
                      ${icon(
                        "check",
                      )}

                      <span>
                        ${esc(
                          label,
                        )}
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
                ${icon(
                  "lock",
                )}

                Continue to payment
              </button>
            </div>
          </div>
        </dialog>
      </section>
    `,
    "/billing",
  );

  const dialog =
    document.querySelector(
      "#billing-checkout-dialog",
    );

  const openCheckout =
    document.querySelector(
      "#open-billing-checkout",
    );

  const confirmCheckout =
    document.querySelector(
      "#confirm-billing-checkout",
    );

  const pageMessage =
    document.querySelector(
      "#billing-page-message",
    );

  const checkoutMessage =
    () =>
      document.querySelector(
        "#billing-checkout-message",
      );

  const closeDialog =
    () => {
      if (
        dialog?.open
      ) {
        dialog.close();
      }
    };

  document
    .querySelectorAll(
      "[data-billing-dialog-close]",
    )
    .forEach(
      (button) => {
        button.onclick =
          closeDialog;
      },
    );

  if (dialog) {
    dialog.addEventListener(
      "click",
      (event) => {
        if (
          event.target ===
          dialog
        ) {
          closeDialog();
        }
      },
    );
  }

  if (
    openCheckout &&
    dialog
  ) {
    openCheckout.onclick =
      () => {
        const output =
          checkoutMessage();

        if (output) {
          output.textContent =
            "";

          output.classList.remove(
            "error-text",
          );
        }

        if (
          !dialog.open
        ) {
          dialog.showModal();
        }
      };
  }

  if (confirmCheckout) {
    confirmCheckout.onclick =
      async () => {
        const output =
          checkoutMessage();

        confirmCheckout.disabled =
          true;

        if (output) {
          output.textContent =
            "Preparing secure checkout...";

          output.classList.remove(
            "error-text",
          );
        }

        try {
          const result =
            await api(
              "billing/checkout",
              {},
            );

          if (
            !result?.checkout
              ?.reference
          ) {
            throw new Error(
              "Billing checkout did not return a valid reference.",
            );
          }

          billingCheckoutReference =
            result.checkout.reference;

          if (
            result.checkout
              .provider ===
            "paystack"
          ) {
            if (
              !result.checkout
                .authorizationUrl
            ) {
              throw new Error(
                "Paystack checkout did not return a payment URL.",
              );
            }

            if (output) {
              output.textContent =
                "Redirecting to secure payment...";
            }

            location.href =
              result.checkout
                .authorizationUrl;

            return;
          }

          closeDialog();

          dashboard =
            await api(
              "dashboard",
            );

          billingPage();
        } catch (error) {
          if (output) {
            output.textContent =
              error?.message ||
              "Checkout could not be started.";

            output.classList.add(
              "error-text",
            );
          }
        } finally {
          confirmCheckout.disabled =
            false;
        }
      };
  }

  const complete =
    document.querySelector(
      "#complete-review-checkout",
    );

  if (complete) {
    complete.onclick =
      async () => {
        complete.disabled =
          true;

        if (pageMessage) {
          pageMessage.textContent =
            "Completing test checkout...";

          pageMessage.classList.remove(
            "error-text",
          );
        }

        try {
          const reference =
            billingCheckoutReference ||
            dashboard
              ?.subscription
              ?.checkoutReference;

          if (!reference) {
            throw new Error(
              "No checkout reference is available.",
            );
          }

          await api(
            "billing/review-complete",
            {
              reference,
            },
          );

          dashboard =
            await api(
              "dashboard",
            );

          billingPage();
        } catch (error) {
          if (pageMessage) {
            pageMessage.textContent =
              error?.message ||
              "Test checkout could not be completed.";

            pageMessage.classList.add(
              "error-text",
            );
          }
        } finally {
          complete.disabled =
            false;
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

  let auditTrail =
    [];

  let loadError =
    null;

  try {
    const result =
      await api(
        "activity",
      );

    auditTrail =
      Array.isArray(
        result?.events,
      )
        ? result.events
        : [];
  } catch (error) {
    loadError =
      error;
  }

  const currentPath =
    (
      location.hash
        .slice(1)
        .split("?")[0] ||
      "/"
    );

  if (
    currentPath !==
    "/activity"
  ) {
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
                              ${esc(
                                item.label,
                              )}
                            </td>

                            <td>
                              ${esc(
                                item.detail,
                              )}
                            </td>

                            <td>
                              ${esc(
                                new Date(
                                  item.createdAt,
                                ).toLocaleString(),
                              )}
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

  const retry =
    document.querySelector(
      "#retry-activity",
    );

  if (retry) {
    retry.onclick =
      () => {
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
        ${esc(
          error?.message ||
            "An unexpected error occurred.",
        )}
      </p>

      <button
        id="retry"
        class="primary"
        type="button"
      >
        Try again
      </button>

      ${link(
        "/sign-in",
        "Return to sign in",
        "quiet-link",
      )}
    </main>
  `);

  const retry =
    document.querySelector(
      "#retry",
    );

  if (retry) {
    retry.onclick = () =>
      route();
  }
}

async function route() {
  const version =
    ++navigationVersion;

  const rawPath =
    location.hash.slice(1) ||
    "/";

  const [
    path,
    hashQuery = "",
  ] =
    rawPath.split("?");

  const params =
    new URLSearchParams(
      hashQuery,
    );

  if (
    params.get("checkout")
  ) {
    billingCheckoutReference =
      params.get(
        "checkout",
      );
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

    if (
      path ===
      "/verify-email"
    ) {
      return verifyEmail();
    }

    if (
      path ===
        "/sign-in" ||
      path ===
        "/register"
    ) {
      return auth(
        path ===
          "/register",
      );
    }

    if (
      !session
        ?.authenticated
    ) {
      return go(
        "/sign-in",
      );
    }

    if (
      session.shell
        .state ===
      "empty"
    ) {
      return business();
    }

    app.setAttribute(
      "aria-busy",
      "true",
    );

    const nextDashboard =
      await api(
        "dashboard",
      );

    if (
      version !==
      navigationVersion
    ) {
      return;
    }

    dashboard =
      nextDashboard;

    if (
      path ===
      "/business"
    ) {
      business();
    } else if (
      path ===
      "/data"
    ) {
      dataPage();
    } else if (
      path ===
      "/reports"
    ) {
      await reports();
    } else if (
      path ===
      "/billing"
    ) {
      billingPage();
    } else if (
      path ===
      "/activity"
    ) {
      await activity();
    } else {
      overview();
    }

    window.scrollTo(
      0,
      0,
    );
  } catch (error) {
    if (
      version !==
      navigationVersion
    ) {
      return;
    }

    if (
      error.status ===
      401
    ) {
      session = null;
      dashboard = null;
      validation = null;
      csrfToken = null;

      return go(
        "/sign-in",
      );
    }

    showError(error);
  } finally {
    app.removeAttribute(
      "aria-busy",
    );
  }
}

window.addEventListener(
  "hashchange",
  route,
);

try {
  session =
    await api("session");

  csrfToken =
    session.csrfToken;
} catch {
  session = null;
}

route();