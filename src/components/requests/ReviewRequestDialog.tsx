import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Check, X } from "lucide-react";

interface Props {
  requestId: string;
  itemName: string;
  quantity: number;
  unit: string;
  purpose: string;
  mode: "approve" | "reject";
  onClose: () => void;
  onDone: () => Promise<void>;
}

export function ReviewRequestDialog({
  requestId,
  itemName,
  quantity,
  unit,
  purpose,
  mode,
  onClose,
  onDone,
}: Props) {
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  async function submit() {
    if (mode === "reject" && !notes.trim()) {
      setErrorMessage("A rejection reason is required");
      return;
    }
    setErrorMessage("");
    setSaving(true);
    const { error } =
      mode === "approve"
        ? await supabase.rpc("approve_stock_request", {
            _request_id: requestId,
            _notes: notes.trim() || undefined,
          })
        : await supabase.rpc("reject_stock_request", {
            _request_id: requestId,
            _notes: notes.trim(),
          });
    setSaving(false);
    if (error) {
      setErrorMessage(error.message);
      toast.error(error.message);
      return;
    }
    toast.success(
      mode === "approve" ? "Approved — stock issued and requester notified" : "Request rejected",
    );
    await onDone();
    onClose();
  }

  const isApprove = mode === "approve";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isApprove ? "Approve stock request" : "Reject stock request"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md bg-muted p-3 space-y-1 text-sm">
            <div className="font-medium">{itemName}</div>
            <div className="font-mono text-xs text-muted-foreground">
              {quantity} {unit}
            </div>
            <div className="text-muted-foreground text-xs">{purpose}</div>
          </div>
          {isApprove && (
            <p className="text-xs text-muted-foreground">
              Approving will immediately deduct{" "}
              <span className="font-mono">
                {quantity} {unit}
              </span>{" "}
              from inventory and record a stock-out movement against this request.
            </p>
          )}
          <div>
            <Label>{isApprove ? "Notes (optional)" : "Reason"}</Label>
            <Textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={
                isApprove ? "e.g. Issue by 4pm, use FIFO" : "Why is this being rejected?"
              }
            />
          </div>
          {errorMessage && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={saving}
            className={
              isApprove
                ? "bg-emerald-600 text-white hover:bg-emerald-700"
                : "bg-red-600 text-white hover:bg-red-700"
            }
          >
            {isApprove ? <Check className="size-4 mr-1" /> : <X className="size-4 mr-1" />}
            {saving ? "Saving…" : isApprove ? "Approve & issue stock" : "Reject request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
