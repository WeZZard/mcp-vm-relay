// The review app: served by the relay's review server at /<project>/<run>/,
// it reads the run's review data and renders the page from it.
import { renderReview, reviewModelOf, type ReviewData } from "../review-page.js";
import { bind } from "./behaviour.js";

async function start() {
  const [, project = "", run = ""] = location.pathname.split("/");
  try {
    const response = await fetch(`/.api/${project}/${run}.json`);
    if (!response.ok) throw new Error(`The review server answered ${response.status}.`);
    const page = renderReview(reviewModelOf(await response.json() as ReviewData));
    document.title = page.title;
    const selection = new CSSStyleSheet();
    selection.replaceSync(page.selection);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, selection];
    document.body.innerHTML = page.html;
  } catch (error) {
    const p = document.createElement("p");
    p.className = "loading";
    p.textContent = `The trajectory could not be loaded. ${error instanceof Error ? error.message : ""}`;
    document.body.replaceChildren(p);
    return;
  }
  // The fragment was resolved before its element existed; resolve it again so
  // it selects its view.
  if (location.hash) location.replace(location.hash);
  bind();
}

void start();
