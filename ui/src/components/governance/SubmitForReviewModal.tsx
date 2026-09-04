/**
 * SubmitForReviewModal — ported from packages/ui-components/src/stewardship/SubmitForReviewModal.tsx
 */
import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Send, AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { ReviewRequestPriority } from "./ReviewQueue";

interface SubmitForReviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  documentTitle: string;
  currentVersion: number;
  onSubmit: (note: string, priority: ReviewRequestPriority) => Promise<void>;
}

export function SubmitForReviewModal({
  isOpen,
  onClose,
  documentTitle,
  currentVersion,
  onSubmit,
}: SubmitForReviewModalProps) {
  const [note, setNote] = useState("");
  const [priority, setPriority] = useState<ReviewRequestPriority>("normal");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(note, priority);
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit for review");
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!submitting) {
      setNote("");
      setPriority("normal");
      setError(null);
      onClose();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Publish &ldquo;{documentTitle}&rdquo; (requires approval)</DialogTitle>
          <DialogDescription>
            Publishing in this nest goes through stewardship. Version {currentVersion}{" "}
            will move to <strong>pending review</strong>; once a steward approves it,
            this version becomes the AI-readable copy.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="priority">Priority</Label>
            <Select
              value={priority}
              onValueChange={(v) => setPriority(v as ReviewRequestPriority)}
              disabled={submitting}
            >
              <SelectTrigger id="priority">
                <SelectValue placeholder="Select priority" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="urgent">Urgent</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="note">Note for Reviewer (optional)</Label>
            <Textarea
              id="note"
              placeholder="Add context or specific areas to review..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={submitting}
              className="min-h-[100px]"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Send className="h-4 w-4 mr-2" />
            )}
            Submit for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
