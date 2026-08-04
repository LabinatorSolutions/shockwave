// `open_file` on the companion: the tool exists, and it cannot work here.
//
// The real one lives in `src/main/openFileExtension.ts` and opens a tab in the
// app window. There is no window on a server, so there is nothing for this side
// to do — but the tool still has to be REGISTERED, because the system prompt is
// written once when a chat is created and lists the whole catalog. A tool the
// prompt names and pi never registered is one the agent is told it has and
// doesn't: asked what it can do, it answers honestly that `open_file` is
// missing, and any attempt to call it gets pi's bare "Tool open_file not found"
// instead of a sentence saying why.
//
// `execute` is unreachable in practice — `DENIED` refuses `open_file` on
// telegram and cron runs, and the gate blocks the call before a tool ever runs.
// It is written out anyway rather than left to throw, because "unreachable"
// depends on a table in another file staying the way it is.

export const OPEN_FILE_STUB = {
  name: 'open_file',
  label: 'Open File',
  description: "Opens a file in the Shockwave app UI in a new tab so the user can see it. Call this when the user asks you to open, show, or display a file. The path is relative to your working directory (the workspace root). Only files inside the workspace that the app can display (.md, images, video, .excalidraw) can be opened; opening does not modify the file.",
  promptSnippet: 'Open a file in the app UI (new tab) when the user asks to see it.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path to the file to open, e.g. "Diagrams/Flow.excalidraw".' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async execute() {
    return {
      content: [{
        type: 'text',
        text: 'open_file only works in the Shockwave desktop app — this run has no app window to open a tab in. Send the file to the user instead, or describe what is in it.',
      }],
      isError: true,
    };
  },
};
