import app from "./api";
import { startEngine } from "./api/lib/journey-engine";

const port = Number(process.env.PORT ?? 3000);
const distDir = `${import.meta.dirname}/../dist`;
const indexPath = `${distDir}/index.html`;

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api")) {
      return app.fetch(request);
    }

    const filePath = getStaticFilePath(url.pathname);
    const file = Bun.file(filePath);

    if (await file.exists()) {
      return new Response(file);
    }

    const index = Bun.file(indexPath);
    if (await index.exists()) {
      return new Response(index, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Build output not found. Run `bun run build` first.", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
});

console.log(`Web server listening on http://localhost:${server.port}`);

/**
 * The journey engine ticks inside this process, and ONLY this process.
 *
 * Deliberately not started from `api/index.ts`: that module is also loaded by
 * the Vite dev server, and a sandbox dev server pointing at the production
 * database would send real email to real customers. The published server is
 * the single sender. `MARKETING_ENGINE=off` stops it without a code change.
 */
if (process.env.MARKETING_ENGINE !== "off") {
  startEngine();
} else {
  console.log("[journeys] engine disabled by MARKETING_ENGINE=off");
}

function getStaticFilePath(pathname: string) {
  const cleanPath = decodeURIComponent(pathname).replace(/^\/+/, "").replaceAll("..", "");

  return cleanPath ? `${distDir}/${cleanPath}` : indexPath;
}
