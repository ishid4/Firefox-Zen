// Shared by both sides of Touches: the background module
// (JS/firefox-zen-touches.sys.mjs) and the page side (FzTouchChild), which
// runs in web content processes and so can't import the background module.

// Services.ppmm.sharedData key holding the touches pages apply:
// [{ id, scope, css }], only the ones that are on, in order. Empty while
// Touches is off in Settings.
export const SHARED_KEY = "FzTouches";

export const SCOPE_TYPES = ["domain", "host", "prefix"];

// A page's URL without its query and hash, e.g. "https://github.com/a/b".
export function pagePath(url) {
  return url.origin + url.pathname;
}

// Whether a touch's scope covers a page.
// - domain: the host and its subdomains ("github.com" → gist.github.com too)
// - host: that host only
// - prefix: pages whose origin + path start with the value
export function matchesScope(scope, href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const value = typeof scope?.value === "string" ? scope.value : "";
  if (!value) {
    return false;
  }
  switch (scope.type) {
    case "domain":
      return host === value || host.endsWith("." + value);
    case "host":
      return host === value;
    case "prefix":
      return pagePath(url).startsWith(value);
  }
  return false;
}
