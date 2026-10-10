const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function getHeader(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") {
    return headers.get(name) || "";
  }
  return headers[name.toLowerCase()] || headers[name] || "";
}

function hasSameHost(urlValue, host) {
  if (!urlValue || !host || urlValue === "null") {
    return false;
  }

  try {
    const parsed = new URL(urlValue);
    return parsed.host.toLowerCase() === String(host).toLowerCase();
  } catch {
    return false;
  }
}

function isAllowedDashboardRequest({ method, headers }, { publicUrl = "" } = {}) {
  if (SAFE_METHODS.has(String(method || "").toUpperCase())) {
    return true;
  }

  const host = getHeader(headers, "host");
  const origin = getHeader(headers, "origin");
  const referer = getHeader(headers, "referer");
  const fetchSite = getHeader(headers, "sec-fetch-site").toLowerCase();

  if (origin) {
    if (publicUrl) {
      try { if (new URL(origin).origin === new URL(publicUrl).origin) return true; } catch {}
    }
    return hasSameHost(origin, host);
  }

  if (referer) {
    return hasSameHost(referer, host);
  }

  if (fetchSite === "cross-site") {
    return false;
  }

  return true;
}

function createDashboardRequestGuard(options = {}) {
  return (req, res, next) => {
    if (isAllowedDashboardRequest({ method: req.method, headers: req.headers }, options)) {
      next();
      return;
    }

    res.status(403).json({
      ok: false,
      error: "Cross-origin dashboard requests are blocked.",
    });
  };
}

module.exports = {
  createDashboardRequestGuard,
  isAllowedDashboardRequest,
};
