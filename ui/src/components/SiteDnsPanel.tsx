import { Check, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";

/**
 * A host the public site wants to use (custom domain or public URL) and its
 * DNS proof: the verified badge, the records to keep at the DNS provider, and
 * "Verify DNS" until the server has found the TXT record.
 */
export interface SiteDnsPanelProps {
  host: string;
  verified: boolean;
  intro: string;
  records: Array<{ type: string; name: string; value: string }>;
  /** Shown under the records, e.g. when there is no CNAME target to give. */
  note?: string;
  busy: boolean;
  verifying: boolean;
  onVerify: () => void;
}

export function SiteDnsPanel({ host, verified, intro, records, note, busy, verifying, onVerify }: SiteDnsPanelProps) {
  return (
    <div className="space-y-2 rounded-md bg-muted/50 p-3 text-xs" data-testid="site-dns-panel">
      <div className="flex items-center gap-2">
        <span className="font-medium break-all">{host}</span>
        {verified ? (
          <Badge variant="secondary" className="gap-1">
            <Check className="h-3 w-3" /> Verified
          </Badge>
        ) : (
          <Badge variant="outline">Not verified yet</Badge>
        )}
      </div>
      {/* Records stay listed once verified: the TXT record is re-checked daily. */}
      <p>{intro}</p>
      {records.map((r) => (
        <DnsRow key={`${r.type}:${r.name}`} {...r} />
      ))}
      {note && <p className="text-muted-foreground">{note}</p>}
      {!verified && (
        <Button size="sm" variant="outline" disabled={busy} onClick={onVerify}>
          {verifying && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Verify DNS
        </Button>
      )}
    </div>
  );
}

function DnsRow({ type, name, value }: { type: string; name: string; value: string }) {
  return (
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2 font-mono">
      <span>{type}</span>
      <span className="truncate" title={name}>{name}</span>
      <span className="truncate" title={value}>{value}</span>
      <CopyButton
        text={value}
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        aria-label={`Copy ${type} value`}
      />
    </div>
  );
}
