const $ = id => document.getElementById(id);

let currentSoundProject = null;

async function checkSoundBackend() {
  const status = $('soundStatus');
  try {
    const response = await fetch('/api/sound/status');
    const data = await response.json();
    const ok = data.available && data.projectManager && data.generator &&
      data.mixer && data.controller;
    status.textContent = ok
      ? 'Sound Designer backend connected. GLM-5.3-Flash-Free is configured.'
      : 'Sound Designer backend is incomplete. Check the local installation.';
  } catch {
    status.textContent = 'Backend unavailable. Restart What If Studio to load the new backend.';
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read ' + file.name));
    reader.readAsDataURL(file);
  });
}

async function refreshProjectList() {
  const select = $('soundProjectSelect');
  try {
    const response = await fetch('/api/sound/projects');
    const data = await response.json();
    select.innerHTML = '';
    for (const project of data.projects || []) {
      const option = document.createElement('option');
      option.value = project.projectPath;
      const flags = [
        project.hasPreview ? 'preview ✓' : null,
        project.status !== 'created' ? project.status : null
      ].filter(Boolean).join(', ');
      option.textContent = `${project.title} — ${flags || 'no preview yet'}`;
      option.dataset.title = project.title;
      select.appendChild(option);
    }
    if (!select.options.length) {
      select.innerHTML = '<option value="">No projects found</option>';
    }
  } catch {
    select.innerHTML = '<option value="">Could not load projects</option>';
  }
}

async function openProject(projectPath) {
  const status = $('soundStatus');
  try {
    status.textContent = 'Loading project...';
    const response = await fetch(
      `/api/sound/project-state?projectPath=${encodeURIComponent(projectPath)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load project');

    currentSoundProject = projectPath;
    await window.WhatIfTimeline.load(projectPath, data);
    applyApprovalControls(data);

    status.textContent = `Project loaded: ${data.manifest.title}. ` +
      (data.outputs.previewExists
        ? 'Preview available — review the timeline or ask GLM for changes.'
        : 'No preview yet — use Production step 1 & 2, or just ask GLM to handle it.');
    restoreChatGreeting(data);
  } catch (error) {
    status.textContent = 'Sound Designer: ' + error.message;
  }
}

function applyApprovalControls(data) {
  const approved = data.approval.approved && !data.approval.stale;
  $('soundApprove').textContent = approved ? 'Approval recorded ✓' : '3 · Approve Final';
  $('soundApprove').disabled = approved;
  $('soundExport').disabled = !approved;
  $('soundExport').textContent = data.approval.stale
    ? '4 · Export (re-approve first)' : '4 · Export Final Video';
}

function restoreChatGreeting(data) {
  const messages = $('soundChatMessages');
  messages.innerHTML = '';
  addChatMessage('assistant',
    `Project "${data.manifest.title}" is loaded. I can see the video, the sound plan ` +
    `(${data.plan ? data.plan.events.length : 0} events) and ${data.assets.length} generated assets. ` +
    'Tell me what you want to change, or use the Production buttons.');
}

/* ---------- busy / progress panel ---------- */

let busyTimer = null;
let busyStarted = 0;

function showBusy(label) {
  const panel = $('glmBusy');
  $('glmBusyLabel').textContent = label;
  panel.hidden = false;
  busyStarted = Date.now();
  clearInterval(busyTimer);
  busyTimer = setInterval(() => {
    const seconds = Math.round((Date.now() - busyStarted) / 1000);
    $('glmBusyElapsed').textContent =
      seconds < 60 ? `${seconds}s elapsed` : `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed`;
  }, 500);
  $('glmBusyElapsed').textContent = '0s elapsed';
}

function updateBusy(label) {
  if (!$('glmBusy').hidden) $('glmBusyLabel').textContent = label;
}

function hideBusy() {
  clearInterval(busyTimer);
  busyTimer = null;
  $('glmBusy').hidden = true;
}

/* ---------- project creation ---------- */

$('soundStart').addEventListener('click', async () => {
  const button = $('soundStart');
  const status = $('soundStatus');
  const video = $('soundVideo').files[0];
  const tsx = $('soundTsx').files[0];

  if (!video) {
    status.textContent = 'Please select the rendered MP4 first.';
    return;
  }

  if (video.size > 30 * 1024 * 1024) {
    status.textContent = 'This upload endpoint currently supports MP4 files up to 30 MB.';
    return;
  }

  button.disabled = true;
  status.textContent = 'Preparing your video for the Sound Designer...';
  showBusy('Creating your project…');

  try {
    const videoBase64 = await fileToBase64(video);
    const tsxBase64 = tsx ? await fileToBase64(tsx) : undefined;

    updateBusy('Creating an isolated sound-design project…');

    const createResponse = await fetch('/api/sound/create-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: $('projectName')?.value || video.name,
        videoBase64,
        tsxBase64
      })
    });

    const project = await createResponse.json();

    if (!createResponse.ok || !project.success || !project.projectPath) {
      throw new Error(project.error || 'Project creation failed. ' + (project.output || ''));
    }

    updateBusy('GLM is watching your video and planning the sounds…');

    const analysisResponse = await fetch('/api/sound/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath: project.projectPath,
        instructions: [
          $('soundPrompt').value,
          'Sound effects: yes. Ambience/music/narration: only if the user asked for them.',
          'Give every event a clear generation prompt or library reuse choice.',
          'Do not generate audio, call ElevenLabs, mix, or export.'
        ].join('\n')
      })
    });

    const analysis = await analysisResponse.json();
    if (!analysisResponse.ok || !analysis.success) {
      throw new Error(analysis.error || 'GLM analysis failed.');
    }

    await refreshProjectList();
    await openProject(project.projectPath);
    status.textContent = 'Project created and analyzed. Review the timeline, or ask GLM to start production.';
  } catch (error) {
    status.textContent = 'Sound Designer: ' + error.message;
  } finally {
    button.disabled = false;
    hideBusy();
  }
});

/* ---------- production controls ---------- */

function showLog(text) {
  const log = $('productionLog');
  log.hidden = false;
  log.textContent = text;
}

async function productionAction(endpoint, confirmMessage) {
  if (!currentSoundProject) {
    $('soundStatus').textContent = 'Open or create a project first.';
    return;
  }
  if (confirmMessage && !window.confirm(confirmMessage)) return;

  const dryRun = $('dryRunCheck').checked;
  const labels = {
    generate: dryRun ? 'Checking what would be generated (dry run)…'
      : 'GLM is generating your sounds with ElevenLabs…',
    mix: 'Building the preview mix with FFmpeg…'
  };
  $('soundStatus').textContent = 'Working... this can take a while. Watch the log.';
  showBusy(labels[endpoint] || 'Working…');
  showLog('Running...');

  try {
    const response = await fetch(`/api/sound/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: currentSoundProject, dryRun })
    });
    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || `${endpoint} failed`);
    }

    showLog(data.output || 'Done.');
    if (data.state) {
      window.WhatIfTimeline.refresh(data.state);
      applyApprovalControls(data.state);
    }
    $('soundStatus').textContent = dryRun
      ? `${endpoint} dry run finished — nothing was generated or written.`
      : `${endpoint} completed.`;
  } catch (error) {
    showLog('FAILED:\n' + error.message);
    $('soundStatus').textContent = `${endpoint}: ${error.message.slice(0, 200)}`;
  } finally {
    hideBusy();
  }
}

$('soundGenerate').addEventListener('click', () => {
  const dryRun = $('dryRunCheck').checked;
  productionAction('generate', dryRun ? null :
    'Real generation calls ElevenLabs and may use paid API credits.\nContinue?');
});

$('soundMix').addEventListener('click', () => {
  productionAction('mix', null);
});

$('soundApprove').addEventListener('click', async () => {
  if (!currentSoundProject) return;
  if (!window.confirm('Approve this preview as the final mix?\nYou can still request changes afterwards (approval is then cancelled).')) return;

  try {
    const response = await fetch('/api/sound/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: currentSoundProject, approved: true })
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'Approval failed');
    applyApprovalControls(data.state);
    window.WhatIfTimeline.refresh(data.state);
    $('soundStatus').textContent = 'Preview approved. Use Export to produce the final video.';
  } catch (error) {
    $('soundStatus').textContent = 'Approve: ' + error.message;
  }
});

$('soundExport').addEventListener('click', async () => {
  if (!currentSoundProject) return;
  if (!window.confirm('Export the approved preview as the final sound-designed video?\nA copy will also be saved to your phone (Download/WhatIfStudio).')) return;

  $('soundStatus').textContent = 'Exporting final video...';
  showBusy('Exporting the final video and saving a copy to your phone…');
  try {
    const response = await fetch('/api/sound/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath: currentSoundProject,
        confirm: 'EXPORT FINAL VIDEO'
      })
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'Export failed');
    window.WhatIfTimeline.refresh(data.state);
    const phoneNote = data.phoneCopy
      ? ` Also saved to your phone: Download/${data.phoneCopy}.`
      : (data.phoneCopyError ? ` Phone copy failed: ${data.phoneCopyError}` : '');
    $('soundStatus').textContent = `Final video exported: ${data.finalOutput}.${phoneNote}`;
  } catch (error) {
    $('soundStatus').textContent = 'Export: ' + error.message;
  } finally {
    hideBusy();
  }
});

/* ---------- GLM chat ---------- */

const chatMessages = $('soundChatMessages');
const chatInput = $('soundChatInput');
const chatSend = $('soundChatSend');
const chatStatus = $('soundChatStatus');

function addChatMessage(role, message) {
  const item = document.createElement('div');
  item.className = 'sound-chat-message ' + role;
  const label = document.createElement('strong');
  label.textContent = role === 'user' ? 'You' : 'GLM';
  const content = document.createElement('p');
  content.textContent = message;
  item.append(label, content);
  chatMessages.appendChild(item);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function sendSoundChatMessage() {
  const message = chatInput.value.trim();

  if (!message) return;

  if (!currentSoundProject) {
    chatStatus.textContent = 'Please open or create a Sound Designer project first.';
    return;
  }

  chatSend.disabled = true;
  chatInput.disabled = true;
  showBusy('GLM is working on your request… (production tasks can take a few minutes)');
  chatStatus.textContent = 'GLM is working... production tasks can take several minutes.';
  addChatMessage('user', message);
  chatInput.value = '';

  try {
    const response = await fetch('/api/sound/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath: currentSoundProject,
        message
      })
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || 'GLM could not reply.');
    }

    addChatMessage('assistant', data.reply || 'GLM returned an empty reply.');
    if (data.toolsUsed && data.toolsUsed.length) {
      addChatMessage('assistant', 'Operations GLM ran: ' + data.toolsUsed.join(' | '));
    }
    if (data.state) {
      window.WhatIfTimeline.refresh(data.state);
      applyApprovalControls(data.state);
    }
    chatStatus.textContent = 'Ready.';
  } catch (error) {
    addChatMessage('assistant', 'Message failed: ' + error.message);
    chatStatus.textContent = 'Please try again.';
  } finally {
    chatSend.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
    hideBusy();
  }
}

chatSend.addEventListener('click', sendSoundChatMessage);

chatInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendSoundChatMessage();
  }
});

/* ---------- direct timeline edits (drag / delete / property changes) ---------- */

window.WhatIfTimeline.onApplyChanges = async (events) => {
  const status = $('soundStatus');
  if (!currentSoundProject) {
    status.textContent = 'Open or create a project first.';
    window.WhatIfTimeline.render();
    return;
  }

  showBusy('Saving your timeline changes…');
  status.textContent = 'Applying your timeline edits...';
  try {
    const response = await fetch('/api/sound/plan-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: currentSoundProject, events })
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Could not apply the timeline changes');
    }

    updateBusy('Changes saved. Rebuilding the preview mix…');
    status.textContent = 'Changes applied. Rebuilding the preview...';

    const mixResponse = await fetch('/api/sound/mix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: currentSoundProject, dryRun: false })
    });
    const mixData = await mixResponse.json();
    if (!mixResponse.ok || !mixData.success) {
      throw new Error(mixData.error || 'Preview rebuild failed');
    }

    if (mixData.state) {
      window.WhatIfTimeline.refresh(mixData.state);
      applyApprovalControls(mixData.state);
    }
    status.textContent = 'Timeline changes applied and preview rebuilt. Play it to hear the difference. ' +
      'Note: a new preview cancels a previous approval.';
    showLog('Timeline edit applied by the user.\n' + (mixData.output || ''));
  } catch (error) {
    status.textContent = 'Timeline edit failed: ' + error.message;
    window.WhatIfTimeline.render();
  } finally {
    hideBusy();
  }
};

/* ---------- misc ---------- */

$('soundOpenProject').addEventListener('click', () => {
  const select = $('soundProjectSelect');
  if (select.value) openProject(select.value);
});

$('soundRefreshProjects').addEventListener('click', refreshProjectList);

refreshProjectList();
checkSoundBackend();
