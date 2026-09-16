/**
 * The banner over the main workspace.
 *
 * The step trail that used to live in this file now lives in `Reasoning`,
 * beside the answer it belongs to.
 *
 * The AI is operating the workspace, so the workspace says so — and offers a way
 * out. Kept to one line of text and a button: a glowing overlay would obscure
 * the very thing the user is meant to be watching.
 */
export function AgentBanner({
  activity,
  onStop,
}: {
  activity: string | null;
  onStop: () => void;
}) {
  if (!activity) return null;
  return (
    <div className="cp__banner" role="status" aria-live="polite">
      <span className="cp__bannerPulse" aria-hidden="true" />
      <span className="cp__bannerText">{activity}</span>
      <button type="button" className="cp__bannerStop" onClick={onStop}>
        Stop
      </button>
    </div>
  );
}
