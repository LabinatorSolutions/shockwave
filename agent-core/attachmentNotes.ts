// What the agent is TOLD about a file the user sent — the bracketed notes and
// the message they are composed into.
//
// Split from `attachmentPolicy.ts` beside this for one reason: this half is
// strings and nothing else — no `node:path`, no `Buffer`, no filesystem — so the
// RENDERER can import it. The desktop composer builds its prompt in the renderer
// while the bytes are sniffed and written in main, and without this seam the
// renderer would need either a bundler polyfill or a second copy of the wording.
//
// The wording is the load-bearing part and is copied from hermes-agent
// (`gateway/run.py:1875`). An earlier version there told the agent to "ask the
// user what they'd like you to do with it", and it did exactly that — you sent a
// PDF and got back a question you had already answered. Telling it to act, and to
// ask only when the intent is genuinely unclear, is what makes a bare path
// pointer work at all.

/** Inline a text file's contents rather than pointing at it, up to this size. */
export const MAX_TEXT_INLINE_BYTES = 100 * 1024;

// Extensions whose contents are safe to paste into the prompt. This is an
// EXTENSION gate, never "did the bytes happen to decode as UTF-8" — PDF, zip and
// docx all begin with decodable ASCII headers and would be pasted in as garbage.
// Anything not listed is still saved and still described; this only chooses
// inline-vs-pointer.
export const TEXT_INLINE_EXTS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.log',
  '.json', '.jsonl', '.ndjson', '.xml', '.yaml', '.yml', '.toml',
  '.ini', '.cfg', '.conf', '.env', '.properties',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.py', '.pyi', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat',
  '.c', '.h', '.cpp', '.cc', '.hpp', '.cs', '.java', '.kt',
  '.go', '.rs', '.rb', '.php', '.pl', '.lua', '.r', '.jl',
  '.swift', '.m', '.scala', '.clj', '.ex', '.exs', '.erl',
  '.sql', '.graphql', '.proto', '.tf', '.hcl',
  '.dockerfile', '.makefile', '.cmake', '.gradle',
  '.rst', '.tex', '.srt', '.vtt', '.diff', '.patch',
]);

/** The shape the notes read off — whatever wrote the file supplies it. */
export interface DescribedAttachment {
  kind: string;
  path: string;
  displayName: string;
  inlineText?: string;
}

export function documentNote(a: DescribedAttachment) {
  if (a.inlineText !== undefined) {
    return `[The user sent a text document: '${a.displayName}'. Its content has been included below. `
      + `The file is also saved at: ${a.path}]`;
  }
  return `[The user sent a document: '${a.displayName}'. It is saved at: ${a.path}. `
    + `Its text is not inlined here (it's a binary format such as PDF or DOCX). `
    + `To read it, extract the document's text yourself — for example with the terminal tool — `
    + `before answering, instead of asking the user to paste the contents.]`;
}

export function audioFileNote(a: DescribedAttachment) {
  return `[The user sent an audio file attachment: '${a.displayName}'. It is saved at: ${a.path}. `
    + `Its content is not inlined here. If the user's request involves what the audio contains, `
    + `transcribe or process it yourself — for example by passing the path to a transcription or `
    + `media tool — instead of asking the user to describe it. Only ask what to do with it if their `
    + `intent is genuinely unclear.]`;
}

export function videoNote(a: DescribedAttachment) {
  return `[The user sent a video attachment: '${a.displayName}'. It is saved at: ${a.path}. `
    + `Its content is not inlined here. If the user's request involves what the video contains, `
    + `inspect or process it yourself — for example by passing the path to a video analysis or `
    + `media tool — instead of asking the user to describe it. Only ask what to do with it if their `
    + `intent is genuinely unclear.]`;
}

/**
 * The image note.
 *
 * `visible` says whether the pixels were also attached for the model to see. When
 * they were, the path is still given — the agent needs a string handle to move,
 * copy or commit the file without another round trip. When they weren't, saying
 * so stops it claiming to have looked at something it cannot see.
 */
export function imageNote(a: DescribedAttachment, visible: boolean) {
  return visible
    ? `[Image attached at: ${a.path}]`
    : `[The user sent an image: '${a.displayName}'. It is saved at: ${a.path}. `
      + `This model cannot view images, so describe what you can do with the file rather than its contents.]`;
}

/** Notes, then any inlined file contents, then what the user actually typed. */
export function composeMessage(
  attachments: DescribedAttachment[] | null | undefined,
  userText: string,
  visionAvailable: boolean,
) {
  const notes: string[] = [];
  const inlined: string[] = [];

  for (const a of attachments || []) {
    if (a.kind === 'image') notes.push(imageNote(a, visionAvailable));
    else if (a.kind === 'video') notes.push(videoNote(a));
    else if (a.kind === 'audio') notes.push(audioFileNote(a));
    else notes.push(documentNote(a));
    if (a.inlineText !== undefined) inlined.push(`[Content of ${a.displayName}]:\n${a.inlineText}`);
  }

  return [...notes, ...inlined, userText].filter((s) => s && s.trim()).join('\n\n');
}
