import { build } from "esbuild";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const origin = new URL(process.env.MOBILE_API_ORIGIN || "https://biznoryx.com");
if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
  throw new Error("MOBILE_API_ORIGIN must be an HTTPS origin without credentials, path or query.");
}
const config = {apiOrigin:origin.origin,applePublicKey:process.env.MOBILE_REVENUECAT_APPLE_KEY || "",googlePublicKey:process.env.MOBILE_REVENUECAT_GOOGLE_KEY || ""};
for (const [key,prefix] of [[config.applePublicKey,"appl_"],[config.googlePublicKey,"goog_"]]) {
  if (key && !(new RegExp(`^${prefix}[A-Za-z0-9]+$`)).test(key)) throw new Error("Use the matching RevenueCat public SDK key for each store; secret keys must not enter the app.");
}
const output = join(process.cwd(),"mobile","www");
await mkdir(join(output,"vendor"),{recursive:true});
await build({entryPoints:["mobile/native-entry.js"],outfile:join(output,"native.js"),bundle:true,format:"esm",target:"es2022",minify:true,
  plugins:[{name:"csv-browser",setup(builder){builder.onResolve({filter:/^\/vendor\/csv-parse\.js$/},()=>({path:require.resolve("csv-parse/browser/esm/sync")}));}}],
  define:{__BIZNORYX_MOBILE_CONFIG__:JSON.stringify(config)}});
for (const name of ["styles.css","evidence-report.css","data-entry.css","mobile.css"]) await copyFile(join("web-app",name),join(output,name));
await copyFile("node_modules/lucide/dist/umd/lucide.js",join(output,"vendor","lucide.js"));
await writeFile(join(output,"index.html"),`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'"><title>BIZNORYX</title>${["styles.css","evidence-report.css","data-entry.css","mobile.css"].map(name=>`<link rel="stylesheet" href="/${name}">`).join("")}</head><body><div id="app"><main class="loading" role="status">Loading BIZNORYX...</main></div><script src="/vendor/lucide.js"></script><script type="module" src="/native.js"></script></body></html>`);
console.info("Bundled native frontend without remote executable scripts or server secrets.");
if (!config.googlePublicKey) console.info("Android store SDK key is not configured; Android purchasing remains unavailable.");
if (!config.applePublicKey) console.info("iOS store SDK key is not configured; iOS purchasing remains unavailable.");
