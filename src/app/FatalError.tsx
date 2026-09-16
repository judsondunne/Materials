export function FatalError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="fatal">
      <div className="fatal__card">
        <h1>The dataset could not be read</h1>
        <p className="fatal__msg mono">{message}</p>
        <p className="fatal__hint">
          The file must be an object of experiments, each with an <code>inputs</code> and an{' '}
          <code>outputs</code> object of numeric values.
        </p>
      </div>
    </div>
  );
}
