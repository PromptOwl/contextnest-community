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
    // Inside the topmost open dialog/menu, not <body>: a Radix focus trap
    // pulls focus back out of <body> and empties the selection. Found by
    // query, not activeElement — Safari doesn't focus a clicked button.
    const traps = document.querySelectorAll(
      '[role="dialog"], [role="alertdialog"], [role="menu"]',
    );
    const host = traps[traps.length - 1] ?? document.body;
    const prev = document.activeElement as HTMLElement | null;
    const ta = document.createElement("textarea");
    ta.value = text;
    // readonly + 12pt: iOS neither opens the keyboard nor zooms the page.
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    ta.style.fontSize = "12pt";
    host.appendChild(ta);
    try {
      ta.focus();
      ta.select();
      // iOS Safari ignores select() on its own.
      ta.setSelectionRange(0, text.length);
      return document.execCommand("copy");
    } finally {
      // execCommand can throw — always remove the hidden textarea.
      host.removeChild(ta);
      prev?.focus?.();
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
