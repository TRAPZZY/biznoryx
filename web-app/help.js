"use strict";

const localhost = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);

/*
 * 3CX requires a secure browser context.
 */
if (!localhost && location.protocol === "http:") {
  location.replace(
    "https://" +
      location.host +
      location.pathname +
      location.search +
      location.hash,
  );
}

const input = document.querySelector("#help-search");

const articles = [...document.querySelectorAll(".article")];

const filters = [...document.querySelectorAll("[data-filter]")];

const resultStatus = document.querySelector("#result-status");

const noResults = document.querySelector("#no-results");

let activeFilter = "all";

function normalized(value) {
  return String(value ?? "")
    .toLowerCase()
    .trim();
}

function articleText(article) {
  return normalized(
    [
      article.textContent,
      article.dataset.keywords,
      article.dataset.category,
    ].join(" "),
  );
}

function searchTerms(value) {
  return normalized(value)
    .split(/[^a-z0-9]+/i)
    .filter((term) => term.length > 1);
}

function updateArticles() {
  const query = normalized(input?.value);

  const terms = searchTerms(query);

  let visible = 0;

  for (const article of articles) {
    const searchable = articleText(article);

    /*
     * A typed search searches the entire Help Center,
     * regardless of the category selected previously.
     */
    const categoryMatch =
      terms.length > 0 ||
      activeFilter === "all" ||
      article.dataset.category === activeFilter;

    /*
     * Natural multi-word search.
     *
     * "upload rejected" now matches an article containing
     * both words even when they are not adjacent.
     */
    const queryMatch =
      terms.length === 0 || terms.every((term) => searchable.includes(term));

    const show = categoryMatch && queryMatch;

    article.hidden = !show;

    /*
     * Open matching articles automatically so the
     * answer itself is immediately visible.
     */
    if (terms.length > 0) {
      article.open = show;
    }

    if (show) {
      visible += 1;
    }
  }

  if (noResults) {
    noResults.hidden = visible !== 0;
  }

  if (resultStatus) {
    resultStatus.textContent =
      terms.length > 0
        ? visible === 1
          ? "1 matching article"
          : visible + " matching articles"
        : "";
  }
}

input?.addEventListener("input", () => {
  /*
   * Searching should not remain trapped inside a
   * category the customer selected earlier.
   */
  if (normalized(input.value)) {
    activeFilter = "all";

    for (const filter of filters) {
      filter.classList.toggle("active", filter.dataset.filter === "all");
    }
  }

  updateArticles();
});

for (const filter of filters) {
  filter.addEventListener("click", () => {
    activeFilter = filter.dataset.filter ?? "all";

    for (const item of filters) {
      item.classList.toggle("active", item === filter);
    }

    updateArticles();
  });
}

const threeCxStatus = document.querySelector("#threecx-status");

const threeCxScript = document.querySelector("#tcx-callus-js");

function mark3cxReady() {
  if (!threeCxStatus) {
    return;
  }

  if (!window.isSecureContext && !localhost) {
    threeCxStatus.textContent = "Secure HTTPS connection required";

    return;
  }

  threeCxStatus.textContent = "3CX live support ready";
}

function mark3cxError() {
  if (!threeCxStatus) {
    return;
  }

  threeCxStatus.textContent = "Live support unavailable";
}

if (threeCxScript) {
  threeCxScript.addEventListener("load", mark3cxReady);

  threeCxScript.addEventListener("error", mark3cxError);
}

if (customElements.get("call-us-selector")) {
  mark3cxReady();
} else {
  customElements
    .whenDefined("call-us-selector")
    .then(mark3cxReady)
    .catch(mark3cxError);
}

updateArticles();
