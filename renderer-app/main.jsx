import React from 'react';
import { createRoot } from 'react-dom/client';
import Preview from './Preview.jsx';

const root = createRoot(document.getElementById('previewPlayer'));

window.showVideoPreview = (VideoComponent, compositionConfig) => {
  root.render(
    <Preview
      VideoComponent={VideoComponent}
      compositionConfig={compositionConfig}
    />
  );
};
