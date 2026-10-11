/**
 * What in this nest does not fit its saved rules today. Existing content is
 * grandfathered: it stays readable and editable, so this is a to-do list,
 * not an error.
 */
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { StructureViolation } from "../../lib/api";

/** Codes whose path is a document (the rest are folders). */
const DOCUMENT_CODES = new Set(["FILE_NAME", "TYPE_NOT_ALLOWED", "MISSING_SECTION"]);

export function ComplianceTab({
  nestName,
  violations,
  loading,
  dirty,
  openDocument,
}: {
  nestName: string;
  violations: StructureViolation[] | undefined;
  loading: boolean;
  dirty: boolean;
  openDocument: (nodeId: string) => void;
}) {
  if (loading || !violations) {
    return (
      <div className="space-y-2" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-10 animate-pulse rounded bg-muted" />
        ))}
      </div>
    );
  }
  const rows = [...violations].sort((a, b) => a.code.localeCompare(b.code) || a.path.localeCompare(b.path));
  return (
    <div className="space-y-2">
      {dirty && <p className="text-xs text-muted-foreground">This reflects the saved rules, not your unsaved changes.</p>}
      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          Everything in {nestName} fits its rules.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Code</th>
                <th scope="col" className="px-3 py-2 font-medium">Path</th>
                <th scope="col" className="px-3 py-2 font-medium">What's wrong</th>
                <th scope="col" className="px-3 py-2 font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v, i) => (
                <tr key={`${v.code}:${v.path}:${i}`} className="border-t">
                  <td className="whitespace-nowrap px-3 py-2">
                    <code className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">{v.code}</code>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{v.path}</td>
                  <td className="px-3 py-2">{v.message}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {DOCUMENT_CODES.has(v.code) && (
                      <Button variant="outline" size="sm" className="h-7" onClick={() => openDocument(`nodes/${v.path}`)}>
                        <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                        Open
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
