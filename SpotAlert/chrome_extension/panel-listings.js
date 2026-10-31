import { element } from "./panel-dom.js";
import { safeListingUrl } from "./core.js";
import { resultStatus } from "./ui.js";

/** Render saved listings; callbacks leave selection and commands with the panel. */
export function renderListings({
  monitor,
  listingFilter,
  showAllSamples,
  listingButton,
  onShowAll,
  onFilter,
}) {
  const sampleSection = element("section", { class: "detail-section" });
  const sampleHeader = element(
    "div",
    { class: "section-heading" },
    element(
      "h3",
      {},
      `Floor plans ${monitor.samples.length ? `· ${monitor.samples.filter((sample) => sample.included !== false).length}` : ""}`,
    ),
  );
  const visibleSamples = [...monitor.samples]
    .filter(
      (sample) =>
        listingFilter === "all" ||
        (listingFilter === "available"
          ? sample.matched
          : sample.apartmentType === listingFilter),
    )
    .sort(
      (a, b) =>
        Number(Boolean(b.matched)) - Number(Boolean(a.matched)) ||
        a.index - b.index,
    );
  if (visibleSamples.length > 8)
    sampleHeader.append(
      element(
        "button",
        {
          class: "text-button",
          onclick: () => {
            onShowAll();
          },
        },
        showAllSamples ? "Show fewer" : `Show all ${visibleSamples.length}`,
      ),
    );
  sampleSection.append(sampleHeader);
  const chips = element("div", {
    class: "listing-filters",
    role: "group",
    "aria-label": "Filter floor plans",
  });
  for (const [key, label] of [
    ["all", "All"],
    ["available", "Available"],
    ["studio", "Studios"],
    ["1-bedroom", "1 bedroom"],
    ["2-bedroom", "2 bedrooms"],
    ["3-plus", "3+ bedrooms"],
  ]) {
    chips.append(
      element(
        "button",
        {
          class: "filter-chip",
          "data-action": `filter-${key}`,
          "aria-pressed": String(listingFilter === key),
          onclick: () => {
            onFilter(key);
          },
        },
        label,
      ),
    );
  }
  sampleSection.append(chips);
  if (monitor.samples.length && !visibleSamples.length)
    sampleSection.append(
      element("p", { class: "empty-note" }, "No floor plans match this view."),
    );
  else if (visibleSamples.length)
    sampleSection.append(
      element(
        "div",
        { class: "sample-grid" },
        ...visibleSamples.slice(0, showAllSamples ? 100 : 8).map((sample) => {
          const details = [
            [
              "Bedrooms",
              {
                studio: "Studio",
                "1-bedroom": "1",
                "2-bedroom": "2",
                "3-plus": sample.beds || "3+",
              }[sample.apartmentType] || sample.beds,
            ],
            ["Size", sample.size],
            ["Bathrooms", sample.baths],
          ].filter(([, value]) => value);
          return element(
            "article",
            { class: `sample${sample.matched ? " matched" : ""}` },
            element(
              "div",
              { class: "sample-top" },
              element(
                "h4",
                { class: "sample-name" },
                sample.name || "Floor plan description unavailable",
              ),
              element(
                "span",
                { class: `pill${sample.matched ? " available" : ""}` },
                sample.included === false
                  ? "Filtered out"
                  : sample.matched
                    ? resultStatus(monitor).historical
                      ? "Previously available"
                      : "Available"
                    : resultStatus(monitor).historical
                      ? "Previous result"
                      : "Not available",
              ),
            ),
            element(
              "p",
              { class: "listing-rent" },
              sample.rent || "Rent not published",
            ),
            element("p", { class: "listing-location" }, monitor.name),
            element(
              "p",
              { class: "sample-type" },
              {
                studio: "Studio",
                "1-bedroom": "1 bedroom",
                "2-bedroom": "2 bedrooms",
                "3-plus": "3+ bedrooms",
              }[sample.apartmentType] || "",
            ),
            details.length
              ? element(
                  "dl",
                  { class: "listing-details" },
                  ...details.map(([label, value]) =>
                    element(
                      "div",
                      {},
                      element("dt", {}, label),
                      element("dd", {}, value),
                    ),
                  ),
                )
              : null,
            Boolean(sample.preferenceReasons?.length) &&
              element(
                "p",
                { class: "sample-context" },
                sample.preferenceReasons.join(" · "),
              ),
            element(
              "div",
              { class: "listing-actions" },
              element(
                "a",
                {
                  class: "secondary-button",
                  href:
                    safeListingUrl(
                      sample.pageUrl || sample.applicationUrl,
                      monitor.url,
                    ) || monitor.url,
                  target: "_blank",
                  rel: "noopener noreferrer",
                },
                "View apartment ↗",
              ),
              sample.matched && listingButton(monitor, sample),
            ),
          );
        }),
      ),
    );
  return monitor.samples.length ? sampleSection : null;
}
