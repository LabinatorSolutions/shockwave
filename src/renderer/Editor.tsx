import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
import { markdown, insertNewlineContinueMarkupCommand, deleteMarkupBackward } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, indentUnit, LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { indentGuides } from './indentGuides.js';
import { hangingIndent, listMarkerGlyphs } from './hangingIndent.js';
// Only the SYNTAX colors come from one-dark — editor chrome (backgrounds,
// gutter, active line) is token-driven via CSS vars so dark mode matches the
// app's warm palette (polish spec §9) instead of one-dark's cool blue-gray.
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import { taskCheckboxes, taskEnterKeymap } from './taskCheckboxes.js';
import { blankLineOutdentKeymap } from './blankLineOutdent.js';
import { listContinueKeymap } from './listContinue.js';
import { bulletPoints } from './bulletPoints.js';
import { codeStyles } from './codeBlocks.js';
import { wikiLinks } from './wikiLinks.js';
import { wikiLinkCompletions } from './wikiCompletions.js';
import { hideMarkdownMarkers } from './hideMarkdownMarkers.js';
import { headingStyles } from './headingStyles.js';
import { autoLinks } from './autoLinks.js';
import { markdownLinks, findLinkAtPos } from './markdownLinks.js';
import { imagePaste } from './imagePaste.js';
import { imageWidgets } from './imageWidgets.js';
import { diffFlashExtension, flashRanges as flashRangesHelper } from './diffFlash.js';
import { EDITOR_ACTIONS, VIEW_MODES } from './constants.js';

// Markdown list/quote Enter + Backspace. `nonTightLists: false` makes an empty
// bullet/quote collapse immediately on Enter, instead of CM's default
// tight→loose conversion (which inserts a blank line, pushing the marker down,
// and only collapses on a *second* Enter).
//
// We must own this keymap explicitly: markdown() defaults to addKeymap:true,
// which injects its own markdownKeymap at Prec.high — that high-prec copy beats
// our manually-ordered keymap below, pre-empting taskEnterKeymap (so `- [ ]`
// never collapses) and carrying the buggy default tight-list config. We pass
// addKeymap:false to markdown() and bind these ourselves, AFTER taskEnterKeymap.
const markdownEnterKeymap = [
  { key: 'Enter', run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
  { key: 'Backspace', run: deleteMarkupBackward },
];

function computeStats(state) {
  const chars = state.doc.length;
  if (chars === 0) return { words: 0, chars: 0 };
  const text = state.doc.toString();
  const trimmed = text.trim();
  const words = trimmed === '' ? 0 : trimmed.split(/\s+/).length;
  return { words, chars };
}

/**
 * Imperative editor wrapper.
 *
 * Props:
 *   onLinkClick(name)              — wiki-link clicks
 *   onChange()                     — fired when the user changes the doc (not for programmatic load)
 *   getPageIndexRef                — ref whose .current is the latest pageIndex Map (autocomplete reads it live)
 *   getVaultPathRef                — ref whose .current is the active workspace path
 *   dark                           — boolean; when changed, the editor is recreated with the light/dark syntax highlight style
 *
 * Ref API (parent uses it to load content + read state):
 *   loadDocument(key, text, vs?)   — shows a DIFFERENT document (tab switch, back/forward,
 *                                    workspace load). Swaps in that document's own EditorState,
 *                                    so undo history is per-document — see "Per-document
 *                                    undo history" below.
 *   setContent(text, viewState?)   — replaces the text of the document already on screen,
 *                                    KEEPING its undo history (external-change reload)
 *   getText()                      — current doc text
 *   getViewState()                 — { cursor, scrollTop } snapshot
 *   clear()                        — empties the doc, resets cursor
 *   evictDocument(key)             — forget a document's parked state (file closed/deleted)
 *   renameDocument(oldKey, newKey) — re-key a parked state (file renamed/moved)
 *   clearDocuments()               — forget all parked states (workspace switch)
 *
 * Per-document undo history
 * -------------------------
 * There is ONE CodeMirror view for the whole app; tabs swap documents through it.
 * CodeMirror keeps undo history inside EditorState, so a single shared state means a
 * single shared undo stack — and pressing undo past the start of your edits in the
 * current file would walk back through the document swap itself, restoring the PREVIOUS
 * file's text into the current tab. That is not a stale render: undo is a user edit, so
 * it marks the tab dirty and the autosave then writes the wrong file's content to disk.
 *
 * The fix is CodeMirror's intended multi-document pattern: one EditorState per document,
 * swapped in with `view.setState()`. `docStatesRef` parks the outgoing document's state
 * on every switch and restores it on return, so undo history is per-document and can
 * never reach across files. Keys are DOCUMENT identity (file path; `draft:<tabId>` for
 * unsaved drafts), not tab identity — one tab navigates between files via back/forward,
 * and two tabs on the same file share one document (and one undo stack, as in VS Code).
 */

// Parked EditorStates hold their document text plus its full undo history, so the cache
// is capped rather than left to grow for every file touched in a session. Least-recently
// used is evicted first; losing a parked state only costs that file's undo history.
const MAX_DOC_STATES = 24;
const Editor = forwardRef<any, any>(function Editor(
  { onLinkClick, onChange, getCacheRef, getVaultPathRef, getActiveFilePathRef, flushDraftToDiskRef, onImageError, onRequestUrl, onSendToAgent, onStats, onHistory, dark, viewMode, isMarkdown, filePath, hideLineNumbers },
  ref,
) {
  const hostRef = useRef<any>(null);
  const viewRef = useRef<any>(null);
  const readOnlyCompartmentRef = useRef<any>(null);
  const livePreviewCompartmentRef = useRef<any>(null);
  const livePreviewExtensionsRef = useRef<any>(null);
  const languageCompartmentRef = useRef<any>(null);
  const markdownExtensionRef = useRef<any>(null);
  const linkClickRef = useRef(onLinkClick);
  const changeRef = useRef(onChange);
  const requestUrlRef = useRef(onRequestUrl);
  const sendToAgentRef = useRef(onSendToAgent);
  const imageErrorRef = useRef(onImageError);
  const statsRef = useRef(onStats);
  const historyRef = useRef(onHistory);
  const statsRafRef = useRef(0);
  const isProgrammaticRef = useRef(false);
  const langGenerationRef = useRef(0);
  // Builds a fresh EditorState carrying the CURRENT compartment configuration. Rebuilt
  // whenever the view is (dark toggle); read by loadDocument, which runs outside render.
  const makeStateRef = useRef<any>(null);
  // docKey -> parked EditorState (see "Per-document undo history" above).
  const docStatesRef = useRef<Map<any, any>>(new Map());
  const currentDocKeyRef = useRef<any>(null);
  // Compartment inputs read at state-construction time. A new state is built from
  // scratch, so it must start with what's configured NOW — not what was configured when
  // the view was created, or toggling to raw mode and switching files would silently
  // bring live preview back.
  const viewModeRef = useRef(viewMode);
  const isMarkdownRef = useRef(isMarkdown);
  const filePathRef = useRef(filePath);
  const readOnlyRef = useRef(false);

  // Swap the language grammar for the current file. Markdown is synchronous
  // (the extension is prebuilt); code grammars come from
  // @codemirror/language-data and lazy-load via dynamic import, so the file
  // shows as plain text for the first open of a filetype until the chunk
  // arrives. The generation counter guards against a stale load resolving
  // after the user has switched files (or the view was rebuilt).
  const applyLanguage = (view, langCmp, isMd, path) => {
    const gen = ++langGenerationRef.current;
    if (isMd) {
      view.dispatch({ effects: langCmp.reconfigure(markdownExtensionRef.current) });
      return;
    }
    const name = path ? path.slice(path.lastIndexOf('/') + 1) : '';
    const desc = name ? LanguageDescription.matchFilename(languages, name) : null;
    view.dispatch({ effects: langCmp.reconfigure([]) });
    if (!desc) return;
    desc.load().then((support) => {
      if (langGenerationRef.current !== gen || viewRef.current !== view) return;
      view.dispatch({ effects: langCmp.reconfigure(support) });
    }).catch(() => {});
  };

  // Park a document's state, most-recently-used last, evicting the oldest past the cap.
  const rememberDocState = (key, state) => {
    if (key == null) return;
    const map = docStatesRef.current;
    map.delete(key);
    map.set(key, state);
    while (map.size > MAX_DOC_STATES) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
    }
  };

  // Restore cursor + scroll after a document swap. The selection dispatch is kept OUT of
  // the undo history: it isn't an edit, and recording it would make the first undo in a
  // freshly-opened file do nothing but move the cursor.
  const applyViewState = (view, viewState) => {
    const cursor = Math.min(viewState?.cursor ?? 0, view.state.doc.length);
    view.dispatch({
      selection: { anchor: cursor },
      annotations: Transaction.addToHistory.of(false),
    });
    const scrollTop = viewState?.scrollTop ?? 0;
    requestAnimationFrame(() => {
      if (viewRef.current === view) view.scrollDOM.scrollTop = scrollTop;
    });
  };

  useEffect(() => { linkClickRef.current = onLinkClick; }, [onLinkClick]);
  useEffect(() => { changeRef.current = onChange; }, [onChange]);
  useEffect(() => { requestUrlRef.current = onRequestUrl; }, [onRequestUrl]);
  useEffect(() => { sendToAgentRef.current = onSendToAgent; }, [onSendToAgent]);
  useEffect(() => { imageErrorRef.current = onImageError; }, [onImageError]);
  useEffect(() => { statsRef.current = onStats; }, [onStats]);
  useEffect(() => { historyRef.current = onHistory; }, [onHistory]);

  // Toggle the live-preview decoration bundle and the language grammar without
  // rebuilding the editor. Cursor, history, scroll all survive a reconfigure.
  // Non-markdown files get their language's grammar by filename (or plain
  // text when unrecognized) and never show live preview.
  useEffect(() => {
    // Set BEFORE the readiness bail-out — a state built later must see these even if the
    // view wasn't up when the props changed.
    viewModeRef.current = viewMode;
    isMarkdownRef.current = isMarkdown;
    filePathRef.current = filePath;
    const view = viewRef.current;
    const cmp = livePreviewCompartmentRef.current;
    const live = livePreviewExtensionsRef.current;
    const langCmp = languageCompartmentRef.current;
    if (!view || !cmp || !live || !langCmp) return;
    const nextLive = (viewMode === VIEW_MODES.RAW || !isMarkdown) ? [] : live;
    view.dispatch({ effects: cmp.reconfigure(nextLive) });
    applyLanguage(view, langCmp, isMarkdown, filePath);
  }, [viewMode, isMarkdown, filePath]);

  // "Hide line numbers" doesn't actually remove the gutter — we keep its
  // reserved width so the text column doesn't shift left. The class on the
  // host element drives CSS that makes the digits + active-line highlight
  // invisible. See app.css `.editor-host-no-line-numbers`.

  const handleContextMenu = async (e) => {
    e.preventDefault();
    const view = viewRef.current;
    if (!view) return;
    const { from, to, head } = view.state.selection.main;
    const hasSelection = from !== to;
    const hasFilePath = !!(getActiveFilePathRef?.current);
    // Detect a markdown link (text or image-wrapping) under the cursor/selection
    // so the context menu can offer Edit / Remove link.
    const linkAtCursor = findLinkAtPos(view.state, hasSelection ? from : head);
    const action = await window.api.showEditorContextMenu({
      hasSelection,
      hasFilePath,
      hasLink: !!linkAtCursor,
    });
    if (!action) return;
    if (action === EDITOR_ACTIONS.ADD_LINK) {
      const selected = view.state.sliceDoc(from, to);
      const insert = `[[${selected}]]`;
      // Empty selection → cursor between brackets so the user can type the name.
      // Non-empty selection → cursor after the closing ]] so typing continues normally.
      const anchor = selected ? from + insert.length : from + 2;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor },
        scrollIntoView: true,
      });
      view.focus();
      return;
    }
    if (action === EDITOR_ACTIONS.ADD_EXTERNAL_LINK) {
      // Capture {from,to} BEFORE opening the modal — focus leaves the editor.
      const selected = view.state.sliceDoc(from, to);
      const result = await requestUrlRef.current?.();
      const url = result?.url;
      if (!url) { view.focus(); return; }
      const v2 = viewRef.current;
      if (!v2) return;
      const text = selected || url;
      const insert = `[${text}](${url})`;
      v2.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        scrollIntoView: true,
      });
      v2.focus();
      return;
    }
    if (action === EDITOR_ACTIONS.REMOVE_EXTERNAL_LINK) {
      if (!linkAtCursor) { view.focus(); return; }
      // Text link → unwrap to `text`. Image-wrapping link → unwrap to the
      // image markdown (preserves the embed, drops only the hyperlink).
      const replacement = linkAtCursor.kind === 'image'
        ? view.state.sliceDoc(linkAtCursor.imageFrom, linkAtCursor.imageTo)
        : linkAtCursor.text;
      view.dispatch({
        changes: { from: linkAtCursor.from, to: linkAtCursor.to, insert: replacement },
        selection: { anchor: linkAtCursor.from + replacement.length },
        scrollIntoView: true,
      });
      view.focus();
      return;
    }
    if (action === EDITOR_ACTIONS.EDIT_EXTERNAL_LINK) {
      if (!linkAtCursor) { view.focus(); return; }
      // For image-wrapping links, the visible "text" IS the image markdown —
      // surface it in the modal so the user can swap the entire content if
      // they want (or leave it).
      const initialText = linkAtCursor.kind === 'image'
        ? view.state.sliceDoc(linkAtCursor.imageFrom, linkAtCursor.imageTo)
        : (linkAtCursor.text ?? '');
      const result = await requestUrlRef.current?.({
        initialUrl: linkAtCursor.url,
        initialText,
      });
      if (!result?.url) { view.focus(); return; }
      const v2 = viewRef.current;
      if (!v2) return;
      const newText = result.text ?? initialText;
      const insert = `[${newText}](${result.url})`;
      v2.dispatch({
        changes: { from: linkAtCursor.from, to: linkAtCursor.to, insert },
        selection: { anchor: linkAtCursor.from + insert.length },
        scrollIntoView: true,
      });
      v2.focus();
      return;
    }
    if (action === EDITOR_ACTIONS.SEND_TO_AGENT) {
      const doc = view.state.doc;
      if (hasSelection) {
        const startLine = doc.lineAt(from);
        const endLine = doc.lineAt(to);
        sendToAgentRef.current?.({
          hasSelection: true,
          selection: view.state.sliceDoc(from, to),
          fromLine: startLine.number,
          fromCol: from - startLine.from + 1,
          toLine: endLine.number,
          toCol: to - endLine.from + 1,
        });
      } else {
        const line = doc.lineAt(head);
        sendToAgentRef.current?.({
          hasSelection: false,
          line: line.number,
          col: head - line.from + 1,
        });
      }
    }
  };

  useImperativeHandle(ref, () => ({
    getText: () => viewRef.current?.state.doc.toString() ?? '',
    getViewState: () => {
      const view = viewRef.current;
      if (!view) return null;
      return {
        cursor: view.state.selection.main.head,
        scrollTop: view.scrollDOM.scrollTop,
      };
    },
    // Show a different document. Restores that document's own EditorState when we have
    // one parked, so its undo history comes back with it; builds a fresh state otherwise.
    loadDocument: (docKey, text, viewState) => {
      const view = viewRef.current;
      const makeState = makeStateRef.current;
      if (!view || !makeState) return;
      const key = docKey ?? null;
      const currentKey = currentDocKeyRef.current;
      // Same document, same text — nothing to swap. Bailing out here is what keeps a
      // re-render from throwing away the undo history of the file you're typing in.
      if (key !== null && key === currentKey && view.state.doc.toString() === text) {
        applyViewState(view, viewState);
        return;
      }
      if (currentKey !== null && currentKey !== key) rememberDocState(currentKey, view.state);
      let next = key !== null ? docStatesRef.current.get(key) : null;
      // A parked state is only usable while it still matches what we just read from disk.
      // If the file changed underneath us (agent, git pull, another machine), its undo
      // history describes text that no longer exists — start clean instead.
      if (next && next.doc.toString() !== text) next = null;
      if (!next) next = makeState(text);
      isProgrammaticRef.current = true;
      view.setState(next);
      isProgrammaticRef.current = false;
      currentDocKeyRef.current = key;
      // setState replaces the compartment contents wholesale, so a non-markdown file's
      // lazily-loaded grammar has to be re-applied against the new state.
      const langCmp = languageCompartmentRef.current;
      if (langCmp) applyLanguage(view, langCmp, isMarkdownRef.current, filePathRef.current);
      applyViewState(view, viewState);
      statsRef.current?.(computeStats(view.state));
      historyRef.current?.({
        canUndo: undoDepth(view.state) > 0,
        canRedo: redoDepth(view.state) > 0,
      });
    },
    evictDocument: (docKey) => {
      if (docKey == null) return;
      docStatesRef.current.delete(docKey);
      if (currentDocKeyRef.current === docKey) currentDocKeyRef.current = null;
    },
    renameDocument: (oldKey, newKey) => {
      if (oldKey == null || newKey == null || oldKey === newKey) return;
      const map = docStatesRef.current;
      const parked = map.get(oldKey);
      if (parked !== undefined) {
        map.delete(oldKey);
        map.set(newKey, parked);
      }
      if (currentDocKeyRef.current === oldKey) currentDocKeyRef.current = newKey;
    },
    clearDocuments: () => {
      docStatesRef.current.clear();
      currentDocKeyRef.current = null;
    },
    // Replace the text of the document already on screen, KEEPING its undo history —
    // this is the external-change reload path, where undo should still be able to take
    // the user back to what they had before the outside writer touched the file.
    setContent: (text, viewState) => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      isProgrammaticRef.current = true;
      if (current !== text) {
        view.dispatch({ changes: { from: 0, to: current.length, insert: text } });
      }
      isProgrammaticRef.current = false;
      const len = view.state.doc.length;
      if (viewState) {
        const cursor = Math.min(viewState.cursor ?? 0, len);
        view.dispatch({ selection: { anchor: cursor } });
        requestAnimationFrame(() => {
          view.scrollDOM.scrollTop = viewState.scrollTop ?? 0;
        });
      } else {
        view.dispatch({ selection: { anchor: 0 } });
        requestAnimationFrame(() => { view.scrollDOM.scrollTop = 0; });
      }
      statsRef.current?.(computeStats(view.state));
      historyRef.current?.({
        canUndo: undoDepth(view.state) > 0,
        canRedo: redoDepth(view.state) > 0,
      });
    },
    clear: () => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      isProgrammaticRef.current = true;
      view.dispatch({ changes: { from: 0, to: current.length, insert: '' } });
      isProgrammaticRef.current = false;
      view.dispatch({ selection: { anchor: 0 } });
      statsRef.current?.({ words: 0, chars: 0 });
      historyRef.current?.({
        canUndo: undoDepth(view.state) > 0,
        canRedo: redoDepth(view.state) > 0,
      });
    },
    undo: () => {
      const view = viewRef.current;
      if (!view) return false;
      const result = undo(view);
      view.focus();
      return result;
    },
    redo: () => {
      const view = viewRef.current;
      if (!view) return false;
      const result = redo(view);
      view.focus();
      return result;
    },
    flashRanges: (ranges) => {
      const view = viewRef.current;
      if (!view) return;
      flashRangesHelper(view, ranges);
    },
    setReadOnly: (ro) => {
      readOnlyRef.current = !!ro;
      const view = viewRef.current;
      const cmp = readOnlyCompartmentRef.current;
      if (!view || !cmp) return;
      view.dispatch({ effects: cmp.reconfigure(EditorState.readOnly.of(!!ro)) });
    },
    focus: () => { viewRef.current?.focus(); },
    // Insert text at the current cursor (replacing any selection). NOT marked
    // programmatic, so it flows through the updateListener → onChange → dirty →
    // autosave path, exactly like typing. Used by the template picker.
    insertAtCursor: (text) => {
      const view = viewRef.current;
      if (!view) return;
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length },
        scrollIntoView: true,
      });
      view.focus();
    },
  }), []);

  useEffect(() => {
    if (!hostRef.current) return;
    const completionSource = wikiLinkCompletions(
      () => getCacheRef?.current,
      () => getVaultPathRef?.current ?? null,
    );

    const readOnlyCompartment = new Compartment();
    readOnlyCompartmentRef.current = readOnlyCompartment;

    const livePreviewCompartment = new Compartment();
    livePreviewCompartmentRef.current = livePreviewCompartment;

    // The language grammar lives in its own compartment so non-markdown files
    // can swap in their own grammar (matched by filename via language-data) or
    // drop highlighting entirely. `codeLanguages` gives fenced code blocks in
    // markdown the same lazy-loaded grammars.
    const languageCompartment = new Compartment();
    languageCompartmentRef.current = languageCompartment;
    const markdownExtension = markdown({ addKeymap: false, codeLanguages: languages, extensions: [{ remove: ['SetextHeading'] }] });
    markdownExtensionRef.current = markdownExtension;

    // Decorations that turn the editor into a live preview. Toggling them off
    // (raw mode) shows the underlying markdown syntax. `markdown()` syntax
    // highlighting stays on either way so headings/code keep their colors.
    // Autocomplete stays on too — `[[` completion is useful in raw mode.
    const livePreviewExtensions = [
      headingStyles,
      hideMarkdownMarkers,
      autoLinks,
      markdownLinks,
      taskCheckboxes,
      bulletPoints,
      // Tells hangingIndent the bullet marker renders as bulletPoints' glyph
      // (1ch + 6px) rather than the raw `-`, so wrapped-bullet hang lines up.
      listMarkerGlyphs.of(true),
      codeStyles,
      imageWidgets(
        () => getActiveFilePathRef?.current ?? null,
        () => getVaultPathRef?.current ?? null,
      ),
      wikiLinks(
        (name, sourcePath) => linkClickRef.current?.(name, sourcePath),
        () => getCacheRef?.current,
        () => getActiveFilePathRef?.current ?? null,
      ),
    ];
    livePreviewExtensionsRef.current = livePreviewExtensions;

    // Every document gets its own EditorState, so the extension set is a factory rather
    // than a one-off array. Compartment INSTANCES are shared across states (they're just
    // keys, so later reconfigure dispatches keep working); their initial contents are
    // read from refs at call time so a new state starts configured the way the app is
    // configured now.
    const buildExtensions = () => [
      readOnlyCompartment.of(EditorState.readOnly.of(readOnlyRef.current)),
      diffFlashExtension,
      lineNumbers(),
      highlightActiveLine(),
      history(),
      // Indent with TABS — one tab per nesting level. Rendering width comes
      // from `tab-size` on .cm-content (app.css), the one knob for ALL indent.
      indentUnit.of('\t'),
      indentOnInput(),
      indentGuides,
      // Keeps wrapped lines out at their indent instead of returning to the text
      // column. Outside the live-preview compartment — raw mode wraps too.
      hangingIndent,
      languageCompartment.of(isMarkdownRef.current ? markdownExtension : []),
      syntaxHighlighting(dark ? oneDarkHighlightStyle : defaultHighlightStyle),
      livePreviewCompartment.of(
        (viewModeRef.current === VIEW_MODES.RAW || !isMarkdownRef.current) ? [] : livePreviewExtensions,
      ),
      imagePaste({
        getActiveFilePath: () => getActiveFilePathRef?.current ?? null,
        flushDraftToDisk: () => flushDraftToDiskRef?.current?.() ?? null,
        onError: (msg) => imageErrorRef.current?.(msg),
      }),
      autocompletion({
        override: [completionSource],
        activateOnTyping: true,
        maxRenderedOptions: 30,
      }),
      keymap.of([
        indentWithTab,
        ...completionKeymap,
        ...taskEnterKeymap,
        ...listContinueKeymap,
        ...markdownEnterKeymap,
        ...blankLineOutdentKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !isProgrammaticRef.current) {
          changeRef.current?.();
        }
        if (update.docChanged) {
          // Coalesce stats + history-depth across rapid keystrokes — at most
          // one compute per frame. undoDepth/redoDepth are O(1) array-length
          // reads, so piggybacking is free.
          if (statsRafRef.current) cancelAnimationFrame(statsRafRef.current);
          statsRafRef.current = requestAnimationFrame(() => {
            statsRafRef.current = 0;
            const v = viewRef.current;
            if (!v) return;
            statsRef.current?.(computeStats(v.state));
            historyRef.current?.({
              canUndo: undoDepth(v.state) > 0,
              canRedo: redoDepth(v.state) > 0,
            });
          });
        }
      }),
      EditorView.theme({
        '&': { fontSize: '16px', backgroundColor: 'transparent' },
        '&.cm-focused': { outline: 'none' },
        '.cm-scroller': {
          overflow: 'visible',
          fontFamily: 'Inter, sans-serif',
          backgroundColor: 'transparent',
          // Comfortable-but-compact editor body (polish spec §5).
          lineHeight: '27px',
        },
        '.cm-content': { paddingLeft: '0', paddingRight: 'var(--text-col-left)' },
        // Hanging indent (hangingIndent.ts): the padding holds WRAPPED lines out
        // at the line's own indent; the negative text-indent returns the FIRST
        // line to where it has always rendered. Values come from --line-pad and
        // the plugin's per-line --hang (both in app.css).
        // This has to live in the theme rather than app.css: CodeMirror's
        // baseTheme ships `.ͼ1 .cm-line { padding: 0 2px 0 6px }`, which outranks
        // a bare `.cm-line` rule. A theme beats baseTheme, so this wins.
        '.cm-line': {
          paddingLeft: 'calc(var(--line-pad) + var(--hang))',
          textIndent: 'calc(-1 * var(--hang))',
        },
        '.cm-activeLine': { backgroundColor: 'var(--bg-active-line)' },
        '.cm-activeLineGutter': { backgroundColor: 'var(--bg-active-line)' },
        '.cm-gutters': { backgroundColor: 'transparent', borderRight: 'none', color: 'var(--text-muted-2)' },
        '.cm-lineNumbers': { paddingLeft: '0', paddingRight: '0' },
        // Gutter is 66px wide (hardcoded). CodeMirror's built-in .cm-line
        // padding-left adds 6px, so typed text lands at 72 = --text-col-left,
        // the column title and backlinks anchor to. Numbers right-align inside,
        // in tabular JetBrains Mono so digits don't shift at 10→11 (spec §5).
        '.cm-lineNumbers .cm-gutterElement': {
          minWidth: '66px',
          paddingRight: '12px',
          boxSizing: 'border-box',
          textAlign: 'right',
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: '12px',
          fontVariantNumeric: 'tabular-nums',
        },
      }),
    ];
    makeStateRef.current = (doc) => EditorState.create({ doc, extensions: buildExtensions() });

    const view = new EditorView({ state: makeStateRef.current(''), parent: hostRef.current });
    viewRef.current = view;
    const docStates = docStatesRef.current;
    // Rebuilds (dark toggle) don't re-run the reconfigure effect above, so a
    // non-markdown file's grammar must be re-applied here.
    if (!isMarkdown) applyLanguage(view, languageCompartment, false, filePath);
    statsRef.current?.({ words: 0, chars: 0 });
    historyRef.current?.({ canUndo: false, canRedo: false });
    return () => {
      if (statsRafRef.current) {
        cancelAnimationFrame(statsRafRef.current);
        statsRafRef.current = 0;
      }
      view.destroy();
      viewRef.current = null;
      readOnlyCompartmentRef.current = null;
      livePreviewCompartmentRef.current = null;
      livePreviewExtensionsRef.current = null;
      languageCompartmentRef.current = null;
      markdownExtensionRef.current = null;
      makeStateRef.current = null;
      // Parked states are bound to the extension instances of the view being torn down
      // (the highlight style is baked in, not compartmentalised), so they can't be
      // carried into the rebuilt view. Cost of a dark-mode toggle: undo history resets.
      docStates.clear();
      currentDocKeyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark]);

  return (
    <div
      ref={hostRef}
      className={`shrink-0 ${hideLineNumbers ? 'editor-host-no-line-numbers' : ''}`}
      onContextMenu={handleContextMenu}
    />
  );
});

export default Editor;
