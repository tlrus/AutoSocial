const test = require("node:test");
const assert = require("node:assert/strict");
const { isAllowedDashboardRequest } = require("../src/request-guard");

test("Sites origin must exactly match configured public URL", () => {
  const request = { method: "POST", headers: { host: "backend.example", origin: "https://my-site.example" } };
  const options = { publicUrl: "https://my-site.example/" };
  assert.equal(isAllowedDashboardRequest(request, options), true);
  request.headers.origin = "https://my-site.example.attacker.example";
  assert.equal(isAllowedDashboardRequest(request, options), false);
});

test("dashboard request guard allows safe methods", () => {
  assert.equal(
    isAllowedDashboardRequest({
      method: "GET",
      headers: { host: "127.0.0.1:3000", origin: "https://example.com" },
    }),
    true
  );
});

test("dashboard request guard allows same-origin mutations", () => {
  assert.equal(
    isAllowedDashboardRequest({
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
      },
    }),
    true
  );
});

test("dashboard request guard blocks cross-origin mutations", () => {
  assert.equal(
    isAllowedDashboardRequest({
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "https://example.com",
      },
    }),
    false
  );
});

test("dashboard request guard blocks cross-site fetch metadata without origin", () => {
  assert.equal(
    isAllowedDashboardRequest({
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        "sec-fetch-site": "cross-site",
      },
    }),
    false
  );
});
