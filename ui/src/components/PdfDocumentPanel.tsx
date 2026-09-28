/**
 * The PDF half of a `pdf` document: the embedded viewer, the file's facts, a
 * warning when it has no text layer, and Download / Replace PDF.
 *
 * The extracted text (the node body — what agents read) is rendered below
 * this by the ordinary document view; it is read-only, because it changes
 * only when a new PDF is uploaded. Replacing the PDF is a new version of the
 * same document, governed like any edit (draft → review where stewardship
 * applies).
 *
 * The viewer is the browser's own PDF viewer in an iframe on the same-origin
 * binary route. The server decides which version a caller gets (a public
 * reader always gets the approved one), so this component never picks.
 */
import { useRef, useState } from "react";
import { AlertTriangle, Download, FileType, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import * as api from "../lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { UploadingOverlay } from "./UploadingOverlay";

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function PdfDocumentPanel({
  nestId,
  nodeId,
  title,
  pdf,
  approvedOnly = false,
  canReplace = false,
  onReplaced,
}: {
  nestId: string;
  nodeId: string;
  title: string;
  pdf?: api.PdfMeta | null;
  /** Ask for the approved version (the owner's "as the public sees it" view). */
  approvedOnly?: boolean;
  /** Editors (not viewers/reviewers, not while locked for review). */
  canReplace?: boolean;
  /** Called after a successful replace so the page reloads the node. */
  onReplaced?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Name of the PDF being uploaded as the replacement, or null when idle.
  const [replacing, setReplacing] = useState<string | null>(null);
  // Optional note for the new version, asked for before the file is picked.
  const [noteOpen, setNoteOpen] = useState(false);
  const [changeNote, setChangeNote] = useState("");
  const src = api.pdfUrl(nestId, nodeId, { approvedOnly });

  const replace = async (file: File) => {
    setReplacing(file.name);
    try {
      await api.createPdfNode(nestId, file, { nodeId, changeNote });
      toast.success("PDF replaced — saved as a new version.");
      onReplaced?.();
    } catch (e: any) {
      toast.error(e?.message || "Couldn't replace the PDF.");
    } finally {
      setReplacing(null);
      setChangeNote("");
    }
  };

  return (
    <div className="mb-6 space-y-3" data-testid="pdf-document-panel">
      {replacing && <UploadingOverlay title="Replacing PDF…" detail={replacing} />}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground/80">
          <FileType className="h-3.5 w-3.5 text-rose-500" />
          PDF
        </span>
        {pdf && (
          <span>
            {pdf.pages} {pdf.pages === 1 ? "page" : "pages"} · {formatBytes(pdf.bytes)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button asChild variant="outline" size="sm" className="h-7">
            <a
              href={api.pdfUrl(nestId, nodeId, { approvedOnly, download: true })}
              data-testid="pdf-download"
            >
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Download
            </a>
          </Button>
          {canReplace && (
            <>
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void replace(f);
                }}
              />
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                disabled={!!replacing}
                onClick={() => setNoteOpen(true)}
                title="Upload a new PDF — the text is re-extracted and saved as a new version"
                data-testid="pdf-replace"
              >
                {replacing ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5 mr-1.5" />
                )}
                Replace PDF
              </Button>
              <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
                <DialogContent className="max-w-md">
                  <DialogHeader>
                    <DialogTitle>Replace PDF</DialogTitle>
                    <DialogDescription>
                      The new file is saved as a new version. Say what changed, if you like.
                    </DialogDescription>
                  </DialogHeader>
                  <Input
                    autoFocus
                    value={changeNote}
                    onChange={(e) => setChangeNote(e.target.value)}
                    placeholder="Change note (optional)"
                    data-testid="pdf-replace-note"
                  />
                  <DialogFooter>
                    <Button variant="ghost" onClick={() => setNoteOpen(false)}>
                      Cancel
                    </Button>
                    <Button
                      onClick={() => {
                        setNoteOpen(false);
                        inputRef.current?.click();
                      }}
                    >
                      <Upload className="h-4 w-4 mr-1.5" />
                      Choose PDF
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          )}
        </div>
      </div>

      {pdf && !pdf.text_layer && (
        <div
          className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50/70 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-200"
          data-testid="pdf-no-text-layer"
        >
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            This PDF has no text layer — it looks like a scan, so no text could be
            extracted and agents can't read its contents. Upload a version with
            selectable text to make it searchable.
          </span>
        </div>
      )}

      <iframe
        // Remount on a new binary so the browser's viewer drops the old one.
        key={pdf?.sha256 ?? "pdf"}
        src={src}
        title={`${title || "PDF"} (PDF)`}
        className="h-[75vh] w-full rounded-lg border bg-muted"
        data-testid="pdf-viewer"
      />

      <div className="text-xs font-medium text-muted-foreground">
        Extracted text (read-only — what agents read)
      </div>
    </div>
  );
}
