import { toast } from "sonner";

/**
 * Copy text to the clipboard, tolerating insecure (plain-HTTP) contexts.
 *
 * `navigator.clipboard.writeText` throws off-HTTPS, so fall back to the
 * legacy hidden-textarea + `document.execCommand("copy")` path. Returns
 * whether the copy actually succeeded — callers own user feedback.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the legacy path below.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    try {
      ta.select();
      return document.execCommand("copy");
    } finally {
      // execCommand can throw — always remove the hidden textarea.
      document.body.removeChild(ta);
    }
  } catch {
    return false;
  }
}

/**
 * `copyText`, plus an error toast when the copy fails entirely.
 * Optionally shows a success toast when `successMsg` is provided.
 * Returns the same success boolean so callers can gate their own
 * "Copied" UI states on it.
 */
export async function copyTextWithToast(
  text: string,
  successMsg?: string,
): Promise<boolean> {
  const ok = await copyText(text);
  if (!ok) {
    toast.error(
      "Couldn't copy automatically — select the text and copy it manually.",
    );
  } else if (successMsg) {
    toast.success(successMsg);
  }
  return ok;
}
