import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import './styles/app.css';
import './styles/data.css';
import './styles/product.css';
import { App } from './app/App';
import { FatalError } from './app/FatalError';
import { parseDataset } from './domain/parse';
import raw from './data/dataset.json';
import type { RawDataset } from './domain/types';

const root = createRoot(document.getElementById('root')!);

try {
  const dataset = parseDataset(raw as RawDataset);
  root.render(
    <StrictMode>
      <App ds={dataset} />
    </StrictMode>,
  );
} catch (err) {
  root.render(<FatalError error={err} />);
}
