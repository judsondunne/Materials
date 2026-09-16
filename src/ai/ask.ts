/**
 * A one-way channel for "ask the copilot this".
 *
 * Several places in the workspace offer a question that only makes sense as a
 * prompt — clicking a region of a component and asking what it is, or following
 * up on a comparison. They should not all need a reference to the conversation,
 * and the conversation should not have to live in the application store. One
 * module-level emitter keeps both of those true.
 */

type Listener = (prompt: string) => void;

const listeners = new Set<Listener>();

export function onAsk(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function askCopilot(prompt: string): void {
  for (const listener of listeners) listener(prompt);
}
