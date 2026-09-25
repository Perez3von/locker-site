const crypto = require("crypto");

const API_BASE = "https://api.istmspt.com";

// Same UniversalAes values used by MSPT.
const KEY_BASE64 =
  "YE8w8Lj9fb05QRam7dEg0X4s6mu9Bpw7XmMkND+CK0I=";

const IV_BASE64 =
  "TP6FUlBBwisr5Rf+ST1C9Q==";

// We already established this username.
// Put your current password here for the trial.
const USERNAME = "eperez12737";
const PASSWORD = "Raincomingsoon25!";

function getEasternTimestamp() {
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (type) =>
    parts.find((p) => p.type === type)?.value;

  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");

  // MSPT needs an ISO-style timestamp.
  // Exact offset isn't important for authentication
  // as long as this represents the current eastern time.
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000-04:00`;
}

function createAuthModel(password, siteId = null, siteName = null) {
  return {
    Username: USERNAME,
    Password: password,
    Token: null,
    IsLockedout: false,
    SiteId: siteId,
    SiteName: siteName,
    TimeZoneId: "America/New_York",
    OktaSub: null,
    Email: null,
    IsAuthenticated: false,
    Id: "00000000-0000-0000-0000-000000000000",
    SyncFlag: null,
    SyncBy: null,
    RightsLevel: null,
    LastUpdatedTime: getEasternTimestamp(),
    Archived: null,
  };
}

function encryptMspt(plainText) {
  const key = Buffer.from(KEY_BASE64, "base64");
  const iv = Buffer.from(IV_BASE64, "base64");

  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    key,
    iv
  );

  cipher.setAutoPadding(true);

  return Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]).toString("base64");
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",

    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },

    body: JSON.stringify(body),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `MSPT ${response.status}: ${text}`
    );
  }

  // MSPT loginAD returns the JWT as raw text,
  // while other endpoints return JSON.
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function login() {
  if (PASSWORD === "PUT_YOUR_PASSWORD_HERE") {
    throw new Error(
      "Put your MSPT password in worker/msptApi.js first."
    );
  }

  console.log("MSPT: verifying credentials");

  const verifyModel = createAuthModel(PASSWORD);

  const verifyCipher = encryptMspt(
    JSON.stringify(verifyModel)
  );

  const verified = await postJson(
    `${API_BASE}/api/UserAuthentication/verifyCredential`,
    verifyCipher
  );

  if (verified !== true) {
    throw new Error(
      `MSPT credential verification returned ${verified}`
    );
  }

  console.log("MSPT: credentials verified");

  const sites = await postJson(
    `${API_BASE}/api/Site/GetSites`,
    {
      userName: USERNAME,
    }
  );

  const siteEntries = Object.entries(sites);

  if (!siteEntries.length) {
    throw new Error("MSPT returned no sites.");
  }

  let selected;

  // Same behavior as the working script.
  if (sites["1086"]) {
    selected = [
      "1086",
      sites["1086"],
    ];
  } else if (siteEntries.length === 1) {
    selected = siteEntries[0];
  } else {
    throw new Error(
      `Multiple MSPT sites returned and 1086 wasn't present: ${siteEntries
        .map(([id, name]) => `${id}:${name}`)
        .join(", ")}`
    );
  }

  const [siteId, siteName] = selected;

  console.log(
    `MSPT: using site ${siteId} - ${siteName}`
  );

  const loginModel = createAuthModel(
    PASSWORD,
    Number(siteId),
    siteName
  );

  const loginCipher = encryptMspt(
    JSON.stringify(loginModel)
  );

  const token = await postJson(
    `${API_BASE}/api/UserAuthentication/loginAD`,
    loginCipher
  );

  if (
    typeof token !== "string" ||
    token.split(".").length !== 3
  ) {
    throw new Error(
      "MSPT loginAD did not return a JWT."
    );
  }

  console.log("MSPT: login successful");

  return {
    token,
    siteId: Number(siteId),
    siteName,
  };
}

async function authenticatedGet(token, path) {
  const response = await fetch(
    `${API_BASE}${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `MSPT ${response.status}: ${await response.text()}`
    );
  }

  return response.json();
}

async function findPackage(token, internalId) {
  console.log(
    `MSPT: searching package ${internalId}`
  );

  const path =
    `/api/IncomingPackage/search` +
    `?Keyword=` +
    `&TrackingNumber=` +
    `&InternalID=${encodeURIComponent(internalId)}`;

  const result = await authenticatedGet(
    token,
    path
  );

  const rows = Array.isArray(result)
    ? result
    : [result];

  const matches = rows.filter(
    (pkg) =>
      String(pkg.incomingPackageId) ===
      String(internalId)
  );

  if (matches.length === 0) {
    throw new Error(
      `Package ${internalId} was not found.`
    );
  }

  if (matches.length > 1) {
    throw new Error(
      `Multiple exact matches found for ${internalId}.`
    );
  }

  return matches[0];
}

module.exports = {
  login,
  findPackage,
  API_BASE,
};