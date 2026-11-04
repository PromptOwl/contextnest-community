/**
 * The reset page a sealed-nest owner's emailed link opens (re-review R4-H1).
 *
 * The link is `/auth/reset#t=<token>`. The token is in the URL fragment, which
 * a browser never sends to the server, so it can't reach a request path, the
 * activity trace, an access log or a Referer header. This page reads it,
 * removes it from the address bar at once, and POSTs it in the request body
 * with the new password. Static HTML and one nonce'd inline script; no
 * external resources.
 */
import { randomBytes } from "crypto";

export function ownerResetPage(): { html: string; csp: string } {
  const nonce = randomBytes(16).toString("base64");
  const script = `(function () {
  var m = /(?:^#|&)t=([A-Za-z0-9_-]+)/.exec(location.hash || "");
  var token = m ? m[1] : "";
  try { history.replaceState(null, "", location.pathname); } catch (e) {}
  var f = document.getElementById("f");
  var msg = document.getElementById("msg");
  if (!token) {
    f.hidden = true;
    msg.textContent = "This link is missing its code. Open the link from your email again.";
    return;
  }
  f.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var p = f.elements.password.value;
    if (p !== f.elements.confirm.value) { msg.textContent = "The two passwords don't match."; return; }
    msg.textContent = "Saving...";
    fetch("/auth/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ token: token, password: p })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; });
    }).then(function (x) {
      if (x.ok) {
        f.hidden = true;
        token = "";
        msg.textContent = "Your password is set. You can sign in now.";
      } else {
        msg.textContent = (x.j && x.j.error) || "That didn't work. Try again.";
      }
    }).catch(function () { msg.textContent = "Couldn't reach the server. Try again."; });
  });
})();`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Reset your password</title>
<style>
  :root { --bg: #f7f7f8; --card: #fff; --ink: #1f2328; --muted: #57606a; --line: #d0d7de; --accent: #3b3fd8; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1115; --card: #171a21; --ink: #e6e8eb; --muted: #9aa4af; --line: #2d333b; --accent: #8b8ff5; } }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 380px; margin: 12vh auto; padding: 28px 24px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: var(--muted); margin: 0 0 18px; }
  label { display: block; font-size: 14px; margin: 12px 0 4px; }
  input { width: 100%; box-sizing: border-box; padding: 9px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); font-size: 15px; }
  button { margin-top: 18px; width: 100%; padding: 10px; border: 0; border-radius: 6px; background: var(--accent); color: #fff; font-size: 15px; cursor: pointer; }
  #msg { margin-top: 16px; color: var(--ink); min-height: 1.5em; }
</style>
</head>
<body>
<main>
  <h1>Choose a new password</h1>
  <p>This link works once. After you save, sign in with the new password.</p>
  <form id="f" autocomplete="off">
    <label for="password">New password</label>
    <input id="password" name="password" type="password" autocomplete="new-password" required>
    <label for="confirm">Repeat it</label>
    <input id="confirm" name="confirm" type="password" autocomplete="new-password" required>
    <button type="submit">Save password</button>
  </form>
  <div id="msg" role="status"></div>
</main>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
  return { html, csp };
}
