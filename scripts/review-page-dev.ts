// Development server for the review app (src/review-app/, src/review-page.ts).
//
// It is the review server that `relay_trajectory` runs, on a fixed port and
// with the app built from source on every request, so a reload shows an edit
// to the app; under `tsx watch`, an edit to the server or the page model
// restarts it. Nothing in the packages is changed.
//
//   npm run dev:review-page -- <package-dir>...
//
// Each package is served at /<project>/<run timestamp>-<run id>/ (see
// src/review-server.ts). PORT selects the port (default 8765).
import { buildReviewApp } from "../src/review-app/build.js";
import { ReviewServer } from "../src/review-server.js";

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error("usage: npm run dev:review-page -- <package-dir>...");
  process.exit(2);
}
const server = new ReviewServer(buildReviewApp, Number(process.env.PORT ?? 8765));
for (const dir of dirs) await server.add(dir);
for (const address of await server.addresses()) console.log(address);
// The server does not hold the process open by itself; this one exists to serve.
setInterval(() => {}, 1 << 30);
