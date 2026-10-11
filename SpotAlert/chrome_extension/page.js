/** Self-contained functions injected into the selected page's isolated world. */
export async function readPage(rule, waitMs = 12000) {
  const deadline = Date.now() + waitMs;
  let lastCount = 0;
  do {
    try {
      const title = document.title || "";
      if (/just a moment|checking your browser|security verification/i.test(title)
          || document.querySelector?.('#challenge-running, #challenge-form, .cf-challenge-running')) {
        return {error: "The website is showing a verification prompt. Open the affected tab and complete it; monitoring will retry.", errorKind: "verification"};
      }
      if (document.querySelector?.('input[type="password"]') && /log ?in|sign ?in/i.test(title + (document.body?.innerText || "").slice(0, 1500))) {
        return {error: "The website requires a login. Open the affected tab and sign in; monitoring will retry.", errorKind: "login"};
      }
      const elements = rule.type === "text" ? [document.body].filter(Boolean)
        : [...document.querySelectorAll(rule.selector)];
      // South East collapses floor-plan sections and repeats them for mobile.
      // Its application-button labels remain meaningful even while collapsed.
      const applicationButtons = rule.type === "css"
        && rule.selector === 'td[data-selenium-id^="Apply_"] [data-selenium-id="ApplyNow"]';
      let visible = elements.filter((element) => applicationButtons || element.getClientRects().length > 0);
      if (applicationButtons) {
        const listings = new Map();
        visible.forEach((element, index) => {
          const key = element.closest('td[data-selenium-id^="Apply_"]')?.getAttribute("data-selenium-id") || `element-${index}`;
          const previous = listings.get(key);
          if (!previous || element.getClientRects().length > 0 || !previous.textContent?.trim()) listings.set(key, element);
        });
        visible = [...listings.values()];
      }
      lastCount = visible.length;
      if (visible.length > 100) return {error: `Selector matches ${visible.length} elements. Narrow it to at most 100.`, errorKind: "selector"};
      const samples = visible.map((element, index) => {
        const text = element.innerText?.trim() || (applicationButtons ? element.textContent?.trim() : "") || "";
        let section = element.closest('[data-selenium-id^="FProw_"]')
          || element.closest('[id^="FP_Detail_"], .accordion-inner, article, .studio-card, .floorplan, .card') || element.closest("tr");
        const nameSelector = '[data-selenium-id="FloorPlanName"], [data-selenium-id^="FPlan_"], .floor-plan-name, h2, h3';
        // Responsive layouts can put the action in a nested table or card.
        // Find its own floor-plan heading before reading the enclosing details.
        if (!section?.querySelector?.(nameSelector)) {
          let parent = element.parentElement;
          for (let depth = 0; parent && depth < 10 && parent !== document.body; depth++, parent = parent.parentElement) {
            if (parent.querySelector?.(nameSelector)) { section = parent; break; }
          }
        }
        const label = (node) => (node?.textContent || node?.innerText || "").replace(/\s+/g, " ").trim();
        const field = (selector) => label(section?.querySelector?.(selector));
        const control = element.matches?.('button, a, input') ? element : element.querySelector?.('button, a, input') || element;
        // RentCafe also embeds the floor-plan name in its contact button ID.
        const buttonName = control.id?.match(/^ContactUs\d+_(.+)$/i)?.[1]?.replace(/_mobile$/i, "").replace(/\s+/g, " ").trim();
        const name = (field(nameSelector) || buttonName || "").slice(0, 200);
        const rent = field('[data-selenium-id^="Rent_"]').replace(/\s*-\s*to\s*/gi, " – ").slice(0, 120);
        const size = field('[data-selenium-id^="Sqft_"], [data-selenium-id^="Area_"], [data-selenium-id^="SquareFeet_"]').slice(0, 80);
        const beds = field('[data-selenium-id^="Bed_"], [data-selenium-id^="Beds_"]').slice(0, 40);
        const baths = field('[data-selenium-id^="Bath_"], [data-selenium-id^="Baths_"]').slice(0, 40);
        const action = control.getAttribute?.("onclick") || "";
        const floorplanId = action.match(/myFloorPlanId=(\d+)/i)?.[1]
          || control.getAttribute?.("href")?.match(/[?&]myFloorPlanId=(\d+)/i)?.[1]
          || section?.id?.match(/^FP_Detail_(\d+)/)?.[1]
          || section?.querySelector?.('[id^="FP_Image_"]')?.id?.match(/FP_Image_(\d+)/)?.[1] || null;
        const cellId = element.getAttribute?.("data-selenium-id")
          || element.closest('td[data-selenium-id]')?.getAttribute?.("data-selenium-id") || "";
        const id = floorplanId ? `floorplan:${floorplanId}` : cellId ? `listing:${cellId.replace(/^(Availability|Apply)_/, "")}` : name || `element:${index + 1}`;
        let applicationUrl = null;
        const href = control.getAttribute?.("href") || control.getAttribute?.("data-href")
          || action.match(/(?:window\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/)?.[1];
        if (href) {
          try {
            const candidate = new URL(href, location.href);
            if (["https:", "http:"].includes(candidate.protocol) && candidate.origin === new URL(location.href).origin && !candidate.username && !candidate.password) applicationUrl = candidate.href;
          } catch { /* JavaScript actions are opened through their actual page control. */ }
        }
        const countText = field('[data-selenium-id="FloorPlanAvailability"]') || text;
        const countMatch = countText.match(/(\d+)\s*(?:available|units|apartments)|available\s*[:(]?\s*(\d+)/i);
        const availableCount = countMatch ? Number(countMatch[1] || countMatch[2]) : null;
        const details = [["Rent", rent], ["Beds", beds], ["Baths", baths]].filter(([, value]) => value).map(([title, value]) => `${title}: ${value}`).join(" · ");
        const context = details || label(section).slice(0, 220);
        const target = section?.id || control.id;
        return {
          index: index + 1, id, floorplanId, text: text.slice(0, 100000), name, rent, beds, baths, size, applicationUrl, availableCount,
          pageUrl: target ? `${location.href.split("#")[0]}#${encodeURIComponent(target)}` : location.href,
          context: context.toLowerCase() === text.toLowerCase() ? "" : context,
        };
      });
      if (samples.length && samples.every((sample) => sample.text)) {
        return {url: location.href, title: document.title, samples};
      }
    } catch (error) { return {error: `Invalid CSS selector: ${error.message}`, errorKind: "selector"}; }
    if (!waitMs) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  if (!lastCount && document.readyState === "complete") return {error: "No listing elements matched the selector on this loaded page. Open the affected tab or update the rule.", errorKind: "selector"};
  return {error: "No readable elements matched. The listing elements are empty or the page is still loading. Monitoring will retry.", errorKind: "loading"};
}

/** Open the website's real application action without inventing application URLs. */
export function openApplication(listing) {
  const controls = [...document.querySelectorAll('td[data-selenium-id^="Apply_"] [data-selenium-id="ApplyNow"], td[data-selenium-id^="Availability_"] button, td[data-selenium-id^="Availability_"] a')];
  const control = controls.find((item) => {
    const section = item.closest('[id^="FP_Detail_"], .accordion-inner, [data-selenium-id^="FProw_"]');
    const floorplan = (item.getAttribute("onclick") || "").match(/myFloorPlanId=(\d+)/i)?.[1]
      || (item.getAttribute("href") || "").match(/[?&]myFloorPlanId=(\d+)/i)?.[1]
      || section?.id?.match(/^FP_Detail_(\d+)/)?.[1]
      || section?.querySelector('[id^="FP_Image_"]')?.id?.match(/FP_Image_(\d+)/)?.[1];
    const cell = item.closest('td[data-selenium-id]')?.getAttribute("data-selenium-id");
    const id = floorplan ? `floorplan:${floorplan}` : cell ? `listing:${cell.replace(/^(Availability|Apply)_/, "")}` : null;
    return id === listing.id;
  });
  if (!control) {
    const target = listing.pageUrl?.split("#")[1];
    const section = target && document.getElementById(decodeURIComponent(target));
    section?.scrollIntoView({block: "center"});
    return {opened: false, reason: "Open this floor plan's section to use its application button."};
  }
  if (!control.getClientRects().length) {
    const pane = control.closest('[id^="FP_Detail_"], .accordion-body');
    const toggle = pane?.id && [...document.querySelectorAll('a[href]')].find((item) => item.getAttribute("href") === `#${pane.id}`);
    toggle?.click();
  }
  const text = (control.innerText || control.textContent || "").trim();
  if (control.disabled || /get notified|unavailable|sold out/i.test(text)) return {opened: false, reason: "This listing is no longer available."};
  control.click();
  return {opened: true};
}
