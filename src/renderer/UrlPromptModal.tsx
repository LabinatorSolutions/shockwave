import React, { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

// Modal for "Add external link" / "Edit external link".
//
// Add mode:  initialUrl / initialText omitted → only URL field, submits string.
// Edit mode: initialUrl + initialText provided → both fields, submits
//            { url, text }.
//
// The caller's onSubmit always receives an object so the call site can
// destructure cleanly; in Add mode `text` is undefined.
export default function UrlPromptModal({ open, onSubmit, onCancel, initialUrl, initialText }: any) {
  // Latched at the open transition, NOT derived per-render. The caller clears
  // its prompt state the instant this closes, so `initialText` goes undefined
  // while the close animation is still running — deriving `isEdit` live would
  // flip the title to "Add external link" on the way out, in front of the user.
  const [isEdit, setIsEdit] = useState(false);
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const inputRef = useRef<any>(null);

  // All of this used to run on mount, because the modal was mounted only while
  // it was open. It is permanently mounted now and driven by `open` (see the
  // Dialog below), so the OPEN TRANSITION seeds the fields — otherwise the
  // clipboard read would fire once at app start and never again.
  useEffect(() => {
    if (!open) return;
    const edit = initialText !== undefined;
    setIsEdit(edit);
    setUrl(initialUrl ?? '');
    setText(initialText ?? '');
    if (edit) {
      // Pre-fill from props; select the URL so users can quickly retype.
      requestAnimationFrame(() => inputRef.current?.select());
      return;
    }
    // Pre-fill from clipboard for the Add case — saves the user a paste.
    if (navigator.clipboard?.readText) {
      navigator.clipboard.readText().then((clip) => {
        const trimmed = (clip ?? '').trim();
        if (/^https?:\/\/\S+$/i.test(trimmed)) {
          setUrl(trimmed);
          requestAnimationFrame(() => inputRef.current?.select());
        }
      }).catch(() => { /* clipboard access denied — fine */ });
    }
  }, [open, initialUrl, initialText]);

  const submit = (e) => {
    e.preventDefault();
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;
    onSubmit({ url: trimmedUrl, text: isEdit ? text : undefined });
  };

  // Controlled by `open` and never conditionally mounted — unmounting an open
  // Radix Dialog strands `pointer-events: none` on <body> and the whole app
  // stops accepting clicks. Same rule as SettingsModal, which spells out why.
  return (
    <Dialog open={!!open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit external link' : 'Add external link'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          {isEdit && (
            <Field>
              <FieldLabel htmlFor="url-prompt-text">Link text</FieldLabel>
              <Input
                id="url-prompt-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="url-prompt-input">External link URL</FieldLabel>
            <Input
              id="url-prompt-input"
              ref={inputRef}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..."
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={!url.trim()}>
              {isEdit ? 'Save' : 'Add link'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
