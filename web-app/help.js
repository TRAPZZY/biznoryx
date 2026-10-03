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

const searchForm = document.querySelector("#help-search-form");

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

const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "do",
  "does",
  "for",
  "how",
  "i",
  "in",
  "is",
  "it",
  "my",
  "of",
  "on",
  "the",
  "to",
  "what",
  "when",
  "why",
  "with",
]);

function searchTerms(value) {
  return normalized(value)
    .split(/[^a-z0-9]+/i)
    .filter((term) => term.length > 1 && !SEARCH_STOP_WORDS.has(term));
}

function searchScore(article, query, terms) {
  const searchable = articleText(article);

  const heading = normalized(article.querySelector("summary")?.textContent);

  let score = 0;

  if (query && searchable.includes(query)) {
    score += 30;
  }

  for (const term of terms) {
    if (heading.includes(term)) {
      score += 8;
      continue;
    }

    if (searchable.includes(term)) {
      score += 3;
    }
  }

  return score;
}

function resetSearchCategory() {
  activeFilter = "all";

  for (const filter of filters) {
    filter.classList.toggle("active", filter.dataset.filter === "all");
  }
}

function updateArticles({ focusFirst = false } = {}) {
  const query = normalized(input?.value);

  const terms = searchTerms(query);

  const searching = query.length > 0;

  let visible = 0;
  let bestArticle = null;
  let bestScore = -1;

  for (const article of articles) {
    const score = searching ? searchScore(article, query, terms) : 0;

    /*
     * Search uses relevance instead of requiring
     * every word to occur.
     *
     * Example:
     * "how do I renew my subscription"
     * correctly finds the renewal article.
     */
    const queryMatch = !searching || score > 0;

    const categoryMatch =
      searching ||
      activeFilter === "all" ||
      article.dataset.category === activeFilter;

    const show = queryMatch && categoryMatch;

    article.hidden = !show;

    if (searching) {
      article.open = false;
    }

    if (!show) {
      continue;
    }

    visible += 1;

    if (searching && score > bestScore) {
      bestScore = score;

      bestArticle = article;
    }
  }

  if (noResults) {
    noResults.hidden = visible !== 0;
  }

  if (resultStatus) {
    if (!searching) {
      resultStatus.textContent = "";
    } else if (visible === 0) {
      resultStatus.textContent = "No matching articles found.";
    } else {
      resultStatus.textContent =
        visible === 1 ? "1 matching article" : visible + " matching articles";
    }
  }

  if (focusFirst && bestArticle) {
    bestArticle.open = true;

    window.requestAnimationFrame(() => {
      bestArticle.scrollIntoView({
        behavior: "smooth",

        block: "center",
      });
    });
  }

  return {
    visible,
    bestArticle,
  };
}

input?.addEventListener("input", () => {
  if (normalized(input.value)) {
    resetSearchCategory();
  }

  updateArticles();
});

searchForm?.addEventListener("submit", (event) => {
  event.preventDefault();

  if (normalized(input?.value)) {
    resetSearchCategory();
  }

  updateArticles({
    focusFirst: true,
  });
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
