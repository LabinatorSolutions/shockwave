import React from 'react';
import {
  Dialog as UIDialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// Reusable dialog. Thin wrapper over the shadcn/radix Dialog that keeps the
// legacy prop API so existing call sites don't change:
//
//   open         — boolean, controls whether the dialog renders
//   onClose      — called when the user dismisses (Esc / outside click / X)
//   title        — optional heading at the top of the panel
//   children     — body content
//   footer       — buttons / actions row at the bottom
//   labelledBy   — optional id of the element that labels the dialog
//   className    — optional override on the panel; the one thing it's for is
//                  width. A dialog that hosts a CredentialRow sets it so the
//                  panel's content column is the same 360px measure the settings
//                  pages use — otherwise the same token box is 464px here and
//                  360px there.
//
// Radix supplies the portal, overlay, focus trap, and focus restore.
export default function Dialog({ open, onClose, title, children, footer, labelledBy, className }: any) {
  return (
    <UIDialog open={!!open} onOpenChange={(next) => { if (!next) onClose?.(); }}>
      <DialogContent aria-labelledby={labelledBy} className={className}>
        {title ? (
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
        ) : (
          <DialogTitle className="sr-only">Dialog</DialogTitle>
        )}
        {children !== undefined && <div className="text-sm">{children}</div>}
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </UIDialog>
  );
}
