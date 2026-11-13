import { renderMediaOnWeb } from '@remotion/web-renderer';

const code = document.getElementById('code');
const codeCount = document.getElementById('codeCount');
const tsxFile = document.getElementById('tsxFile');
const assets = document.getElementById('assets');

let currentVideoComponent = null;
let currentCompositionConfig = null;
const assetList = document.getElementById('assetList');

code.addEventListener('input', () => {
  codeCount.textContent = code.value.length.toLocaleString() + ' characters';
});

tsxFile.addEventListener('change', async () => {
  const file = tsxFile.files[0];
  if (!file) return;
  code.value = await file.text();
  code.dispatchEvent(new Event('input'));
});

assets.addEventListener('change', () => {
  const files = [...assets.files];
  if (!files.length) return;
  assetList.innerHTML = '';
  files.forEach(file => {
    const row = document.createElement('div');
    row.className = 'asset-item';
    row.textContent = '✓ ' + file.name + ' (' + Math.round(file.size / 1024) + ' KB)';
    assetList.appendChild(row);
  });
});

document.getElementById('previewBtn').addEventListener('click', async () => {
  if (!code.value.trim()) {
    alert('Please paste or import your TSX code first.');
    return;
  }

  const button = document.getElementById('previewBtn');
  button.textContent = 'Preparing preview...';
  button.disabled = true;

  try {
    const response = await fetch('/__save-tsx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.value })
    });

    if (!response.ok) throw new Error(await response.text());

    const module = await import(/* @vite-ignore */ '/user-video.tsx?t=' + Date.now());

    if (typeof module.default !== 'function') {
      throw new Error('Your TSX file must have a default exported React component.');
    }

    if (typeof window.showVideoPreview !== 'function') {
      throw new Error('Preview player is not ready. Refresh the page and try again.');
    }

    currentVideoComponent = module.default;
    currentCompositionConfig = module.compositionConfig || null;

    window.showVideoPreview(currentVideoComponent, currentCompositionConfig);

    document.querySelector('#preview > p')?.remove();
    document.querySelector('#preview > small')?.remove();
    document.getElementById('preview').scrollIntoView({ behavior: 'smooth' });
  } catch (error) {
    alert('Preview error: ' + error.message);
  } finally {
    button.textContent = 'Prepare Preview';
    button.disabled = false;
  }
});

document.getElementById('renderBtn').addEventListener('click', async () => {
  if (!code.value.trim()) {
    alert('Please import or paste your TSX animation first.');
    return;
  }

  const button = document.getElementById('renderBtn');
  const status = document.getElementById('renderStatus');
  const progressText = document.getElementById('progressText');
  const progressBar = document.getElementById('progressBar');

  button.disabled = true;
  button.textContent = 'Rendering...';
  status.textContent = 'Preparing your animation...';
  progressText.textContent = '0%';
  progressBar.style.width = '0%';

  try {
    if (!currentVideoComponent) {
      const response = await fetch('/__save-tsx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.value })
      });

      if (!response.ok) throw new Error(await response.text());

      const module = await import(/* @vite-ignore */ '/user-video.tsx?t=' + Date.now());

      if (typeof module.default !== 'function') {
        throw new Error('Your TSX file must have a default exported React component.');
      }

      currentVideoComponent = module.default;
      currentCompositionConfig = module.compositionConfig || null;
    }

    const config = currentCompositionConfig || {};
    const fps = config.fps || 30;
    const width = config.width || 1920;
    const height = config.height || 1080;
    const durationInFrames =
      config.durationInFrames ||
      Math.round((config.durationInSeconds || 5) * fps);

    // Automatic export: fit the longest side within 1280 pixels.
    const scale = Math.min(1, 1280 / Math.max(width, height));

    status.textContent = 'Rendering MP4...';

    const result = await renderMediaOnWeb({
      composition: {
        id: config.id || 'MyVideo',
        component: currentVideoComponent,
        width,
        height,
        fps,
        durationInFrames
      },
      videoCodec: 'h264',
      container: 'mp4',
      muted: false,
      scale,
      outputTarget: 'arraybuffer',
      onProgress: ({ progress }) => {
        const percent = Math.round(progress * 100);
        progressBar.style.width = percent + '%';
        progressText.textContent = percent + '%';
        status.textContent = 'Rendering your video...';
      }
    });

    status.textContent = 'Preparing MP4 download...';

    const blob = await result.getBlob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = (config.id || 'MyVideo') + '.mp4';
    document.body.appendChild(link);
    link.click();
    link.remove();

    status.textContent = 'MP4 rendering completed!';
    progressText.textContent = '100%';
    progressBar.style.width = '100%';

    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    console.error(error);
    status.textContent = 'Rendering failed: ' + error.message;
    alert('MP4 rendering failed: ' + error.message);
  } finally {
    button.disabled = false;
    button.textContent = '▶  Render Video';
  }
});
