// Diagnostic only. Run from the Locker project root with:
//   node worker/diagnoseSites.js
// Reuses existing MSPT credentials without printing passwords, tokens, or site names.
const actualFetch = global.fetch;
if (typeof actualFetch !== "function") {
  throw new Error("Node 18+ is required (fetch is unavailable).");
}

global.fetch = async function diagnosticsFetch(url, options) {
  const response = await actualFetch(url, options);
  if (String(url).includes("/api/Site/GetSites")) {
    let value;
    let parsing = "valid JSON";
    try { value = await response.clone().json(); }
    catch { parsing = "not valid JSON"; }
    const bodyType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const keys = value && typeof value === "object" ? Object.keys(value) : [];
    const responseShape = { httpStatus: response.status, bodyType, parsing, itemCount: keys.length };
    if (value && !Array.isArray(value) && typeof value === "object") {
      // Property names only. Never log site names or any response values.
      responseShape.isSite1086Present = Object.hasOwn(value, "1086");
      responseShape.topLevelKeyCount = keys.length;
    }
    console.log("MSPT GetSites diagnostics:", responseShape);
  }
  return response;
};

const { login } = require("./msptApi");
login().then(() => {
  console.log("Site discovery and login succeeded.");
}).catch(error => {
  console.error("Site discovery/login did not finish:", error?.message || String(error));
  process.exitCode = 1;
});
