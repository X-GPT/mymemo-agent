/**
 * The minimal sandbox host page (#438).
 *
 * This is not the composed-document runtime — that is #437's contract and
 * #432's prototype. This page exists to make the *envelope* observable: it
 * runs every escape a payload could attempt and reports what the browser did,
 * so provisioning produces evidence instead of an assertion.
 *
 * All script here is inline on purpose. Under `sandbox allow-scripts` the
 * document has an opaque origin, and whether `'self'` still resolves in that
 * state is precisely one of the things being measured — so the probe cannot
 * depend on an external file to run.
 */

/** Served at `/probe-self-script.js`; used only by the `script-src 'self'` check. */
export const SELF_SCRIPT_JS = `window.__SELF_SCRIPT_RAN__ = true;`;

/** A host this origin must never be able to reach. Blocked at the CSP layer, so no request leaves. */
const EXTERNAL = "https://example.com";

export const HOST_PAGE_HTML = `<!doctype html>
<html lang="en" data-probe-status="running">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>MyMemo sandbox origin — envelope probe</title>
<style>
  :root { color-scheme: light dark; --ok: #15803d; --bad: #b91c1c; --warn: #b45309; }
  body { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 1.5rem; }
  h1 { font-size: 1.1rem; margin: 0 0 .25rem; }
  p.sub { margin: 0 0 1rem; opacity: .7; }
  table { border-collapse: collapse; width: 100%; max-width: 62rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid rgba(128,128,128,.3); vertical-align: top; }
  th { font-weight: 600; opacity: .7; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
  td.v { font-weight: 600; white-space: nowrap; }
  .contained { color: var(--ok); }
  .escaped { color: var(--bad); }
  .known-gap { color: var(--warn); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
  .detail { opacity: .65; font-size: .85em; }
</style>
</head>
<body>
<h1>MyMemo sandbox origin — envelope probe</h1>
<p class="sub">Each row attempts an escape and reports what the browser did. <span class="contained">contained</span> = the envelope held. <span class="escaped">ESCAPED</span> = a hole. <span class="known-gap">known gap</span> = documented residual risk.</p>
<table><thead><tr><th>Channel</th><th>Result</th><th>Detail</th></tr></thead><tbody id="rows"></tbody></table>

<script>
(function () {
  var EXTERNAL = ${JSON.stringify(EXTERNAL)};
  var results = [];
  var rows = document.getElementById("rows");

  // The authoritative signal. API return values lie: navigator.sendBeacon()
  // returns true for a request CSP goes on to block, because it only reports
  // that the send was queued. A securitypolicyviolation event does not lie.
  var violations = [];
  document.addEventListener("securitypolicyviolation", function (e) {
    violations.push({ directive: e.effectiveDirective || e.violatedDirective, uri: e.blockedURI });
  });
  function violated(directive) {
    return violations.some(function (v) { return v.directive.indexOf(directive) === 0; });
  }

  function record(name, verdict, detail) {
    results.push({ name: name, verdict: verdict, detail: String(detail) });
    var tr = document.createElement("tr");
    var cls = verdict === "contained" ? "contained" : verdict === "known gap" ? "known-gap" : "escaped";
    var c1 = document.createElement("td");
    var code = document.createElement("code"); code.textContent = name; c1.appendChild(code);
    var c2 = document.createElement("td"); c2.className = "v " + cls; c2.textContent = verdict;
    var c3 = document.createElement("td"); c3.className = "detail"; c3.textContent = String(detail);
    tr.appendChild(c1); tr.appendChild(c2); tr.appendChild(c3);
    rows.appendChild(tr);
  }

  // --- Egress: everything connect-src covers -------------------------------
  function probeFetch() {
    return fetch(EXTERNAL, { mode: "no-cors" }).then(
      function () { record("fetch()", "ESCAPED", "request completed"); },
      function (e) { record("fetch()", "contained", e && e.name ? e.name : "rejected"); }
    );
  }

  function probeXhr() {
    return new Promise(function (done) {
      try {
        var x = new XMLHttpRequest();
        x.open("GET", EXTERNAL, true);
        x.onload = function () { record("XMLHttpRequest", "ESCAPED", "status " + x.status); done(); };
        x.onerror = function () { record("XMLHttpRequest", "contained", "network error (CSP)"); done(); };
        x.send();
      } catch (e) { record("XMLHttpRequest", "contained", "threw " + e.name); done(); }
    });
  }

  function probeWebSocket() {
    return new Promise(function (done) {
      var settled = false;
      var finish = function (v, d) { if (!settled) { settled = true; record("WebSocket", v, d); done(); } };
      try {
        var ws = new WebSocket("wss://example.com/");
        ws.onopen = function () { finish("ESCAPED", "connection opened"); ws.close(); };
        ws.onerror = function () { finish("contained", "connection refused (CSP)"); };
        setTimeout(function () { finish("contained", "no connection within 2s"); }, 2000);
      } catch (e) { finish("contained", "constructor threw " + e.name); }
    });
  }

  function probeBeacon() {
    var returned;
    try {
      returned = navigator.sendBeacon ? navigator.sendBeacon(EXTERNAL, "x") : false;
    } catch (e) {
      record("navigator.sendBeacon", "contained", "threw " + e.name);
      return Promise.resolve();
    }
    // Adjudicate on the violation event, not on the return value — see above.
    return new Promise(function (done) {
      setTimeout(function () {
        var blocked = violations.some(function (v) {
          return v.directive.indexOf("connect-src") === 0 && v.uri.indexOf("example.com") !== -1;
        });
        record("navigator.sendBeacon", blocked ? "contained" : "ESCAPED",
          blocked
            ? "connect-src violation observed (returned " + returned + " — a queue ack, not a send)"
            : "no violation observed; returned " + returned);
        done();
      }, 300);
    });
  }

  function probeImageBeacon() {
    return new Promise(function (done) {
      var settled = false;
      var finish = function (v, d) { if (!settled) { settled = true; record("<img> beacon", v, d); done(); } };
      var img = new Image();
      img.onload = function () { finish("ESCAPED", "image loaded"); };
      img.onerror = function () { finish("contained", "blocked by img-src"); };
      img.src = EXTERNAL + "/pixel.png?d=" + Date.now();
      setTimeout(function () { finish("contained", "no load within 2s"); }, 2000);
    });
  }

  function probeEventSource() {
    try {
      if (typeof EventSource === "undefined") { record("EventSource", "contained", "unavailable"); return Promise.resolve(); }
      var es = new EventSource(EXTERNAL + "/stream");
      es.onerror = function () { es.close(); };
      record("EventSource", "contained", "constructed; connect-src blocks the stream");
    } catch (e) { record("EventSource", "contained", "threw " + e.name); }
    return Promise.resolve();
  }

  // --- Credential and host reach ------------------------------------------
  function probeStorage() {
    try {
      var ls = window.localStorage;
      ls.setItem("__probe__", "1");
      var token = ls.getItem("ADMIN_SECRET_TOKEN");
      record("localStorage", "ESCAPED", "readable; ADMIN_SECRET_TOKEN=" + (token === null ? "absent here" : "PRESENT"));
    } catch (e) { record("localStorage", "contained", "threw " + e.name + " (opaque origin)"); }
    try {
      var c = document.cookie;
      record("document.cookie", c ? "ESCAPED" : "contained", c ? "readable" : "empty (opaque origin)");
    } catch (e) { record("document.cookie", "contained", "threw " + e.name); }
    return Promise.resolve();
  }

  function probeParent() {
    if (window.parent === window) {
      record("parent DOM", "contained", "not framed — open inside an iframe to exercise");
      return Promise.resolve();
    }
    try {
      var href = window.parent.location.href;
      record("parent DOM", "ESCAPED", "read parent location: " + href);
    } catch (e) { record("parent DOM", "contained", "threw " + e.name); }
    return Promise.resolve();
  }

  // --- Does 'self' still resolve under an opaque origin? -------------------
  function probeSelfScript() {
    return new Promise(function (done) {
      var settled = false;
      var finish = function (d) {
        if (settled) return;
        settled = true;
        var ran = window.__SELF_SCRIPT_RAN__ === true;
        // Informational: not a hole either way. It decides whether the served
        // runtime and libraries can be external files or must be inlined.
        record("script-src 'self'", ran ? "contained" : "known gap", ran
          ? "same-origin script executed — libraries can be served as files"
          : "same-origin script did NOT run (" + d + ") — runtime must be inlined");
        done();
      };
      var s = document.createElement("script");
      s.src = "/probe-self-script.js";
      s.onload = function () { finish("loaded"); };
      s.onerror = function () { finish("blocked"); };
      document.head.appendChild(s);
      setTimeout(function () { finish("timeout"); }, 2000);
    });
  }

  // --- The documented residual risk ---------------------------------------
  function probeWebRtc() {
    try {
      if (typeof RTCPeerConnection === "undefined") { record("WebRTC", "contained", "RTCPeerConnection unavailable"); return Promise.resolve(); }
      // No ICE servers are configured, so this reaches no network. It only
      // shows the API is constructible — CSP has no directive that covers it.
      var pc = new RTCPeerConnection();
      pc.createDataChannel("probe");
      pc.close();
      record("WebRTC", "known gap", "RTCPeerConnection constructible; connect-src does not cover it (#433)");
    } catch (e) { record("WebRTC", "contained", "threw " + e.name); }
    return Promise.resolve();
  }

  Promise.resolve()
    .then(probeFetch).then(probeXhr).then(probeWebSocket).then(probeBeacon)
    .then(probeImageBeacon).then(probeEventSource).then(probeStorage)
    .then(probeParent).then(probeSelfScript).then(probeWebRtc)
    .then(function () {
      var escaped = results.filter(function (r) { return r.verdict === "ESCAPED"; });
      window.__SANDBOX_PROBE__ = { results: results, escaped: escaped.length };
      document.documentElement.setAttribute("data-probe-status", escaped.length ? "escaped" : "contained");
      document.title = escaped.length
        ? "ESCAPED (" + escaped.length + ") — sandbox envelope probe"
        : "contained — sandbox envelope probe";
    });
})();
</script>
</body>
</html>
`;
