import React from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import App from './App.jsx';

// NOTE: window.EXCALIDRAW_ASSET_PATH is set by an inline <script> in index.html,
// NOT here. ES import hoisting evaluates `import App` (which transitively loads
// @excalidraw/excalidraw and bakes its font-URL registry from the global) BEFORE
// this module's body runs — so setting it here is too late and Excalidraw falls
// back to the esm.sh CDN. The inline script runs before the bundle loads.

// Block default file-drop behavior at the window level. Without this, a file
// dropped anywhere outside an explicit drop target causes Chromium to
// navigate the renderer to the file's URL, blanking the app. Components that
// want to accept drops (the editor, the tree) handle the event themselves
// and stop propagation; everything else falls through to here and is ignored.
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
    e.preventDefault();
  }
});
window.addEventListener('drop', (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
    e.preventDefault();
  }
});

// Fallback right-click menu: cut/copy/paste for any surface that doesn't
// build its own (chat sidebar, settings fields). Surfaces with their own menu
// (editor, file tree, sort bar, ...) call e.preventDefault() in their
// handlers, so by the time the event bubbles here defaultPrevented tells us
// to stay out. Electron shows no native menu on its own, so without this a
// right-click on those surfaces does nothing at all.
document.addEventListener('contextmenu', (e) => {
  if (e.defaultPrevented) return;
  e.preventDefault();
  const target = e.target instanceof HTMLElement ? e.target : null;
  const field = target?.closest('input, textarea') as HTMLInputElement | HTMLTextAreaElement | null;
  const isEditable = !!field || !!target?.isContentEditable;
  let hasSelection = false;
  if (field && typeof field.selectionStart === 'number') {
    hasSelection = field.selectionStart !== field.selectionEnd;
  } else {
    hasSelection = !!window.getSelection()?.toString();
  }
  if (!isEditable && !hasSelection) return;
  void window.api.showFallbackContextMenu({ isEditable, hasSelection });
});

createRoot(document.getElementById('root')!).render(<App />);
