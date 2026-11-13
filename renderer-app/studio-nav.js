const sections = [...document.querySelectorAll('main > section')];

const views = {
  dashboard: sections,
  video: sections,
  sound: [],
  library: [],
  projects: []
};

const navItems = [
  ['dashboard', '⌂', 'Dashboard'],
  ['video', '▶', 'Video Studio'],
  ['sound', '♫', 'Sound Designer'],
  ['library', '▤', 'Audio Library'],
  ['projects', '▣', 'Projects & Backup']
];

const main = document.querySelector('main');
const originalSections = [...main.children];

const nav = document.createElement('nav');
nav.className = 'studio-nav';
nav.setAttribute('aria-label', 'Studio navigation');

nav.innerHTML = navItems.map(([id, icon, label]) =>
  `<button type="button" data-view="${id}"><span>${icon}</span>${label}</button>`
).join('');

main.before(nav);

const soundView = document.createElement('section');
soundView.className = 'card studio-view';
soundView.dataset.panel = 'sound';
soundView.innerHTML = `
  <div class="section-title"><span>07</span><h2>Sound Designer</h2></div>
  <p class="sub">GLM adds synchronized sound to your rendered video. You review and approve.</p>

  <div class="sd-setup">
    <div class="sd-setup-new">
      <h3>New project</h3>
      <label for="soundVideo">Rendered MP4</label>
      <input id="soundVideo" type="file" accept="video/mp4">
      <label for="soundTsx">Optional TSX source</label>
      <input id="soundTsx" type="file" accept=".tsx,.ts,.jsx,.js">
      <label for="projectName">Project name</label>
      <input id="projectName" type="text" placeholder="My video">
      <label for="soundPrompt">Instructions for the sound designer</label>
      <textarea id="soundPrompt" rows="2" placeholder="Describe the sound you want..."></textarea>
      <button type="button" class="primary" id="soundStart">Create Project &amp; Analyze</button>
    </div>
    <div class="sd-setup-open">
      <h3>Continue a project</h3>
      <label for="soundProjectSelect">Existing sound projects</label>
      <select id="soundProjectSelect"></select>
      <button type="button" class="secondary" id="soundOpenProject">Open Project</button>
      <button type="button" class="secondary" id="soundRefreshProjects">Refresh List</button>
    </div>
  </div>

  <div id="soundStatus" class="asset-list" aria-live="polite">Ready.</div>

  <div id="reviewWorkspace" hidden>
    <div class="section-title"><span>•</span><h3 id="reviewTitle">Review workspace</h3></div>

    <div class="review-video">
      <video id="reviewVideo" playsinline preload="metadata"></video>
    </div>
    <div class="review-controls">
      <button type="button" class="primary" id="reviewPlay">▶ Play</button>
      <input id="reviewScrub" type="range" min="0" max="1000" value="0" step="1">
      <span id="reviewTime" class="review-time">0.0 / 0.0 s</span>
      <label class="review-toggle"><input type="checkbox" id="reviewSourceAudio"> Source audio</label>
      <label class="review-toggle"><input type="checkbox" id="reviewUsePreview" disabled> Mixed preview</label>
    </div>

    <p id="audioStatus" class="audio-status" hidden></p>

    <div class="timeline" id="timeline">
      <div class="timeline-head" id="timelineHead"></div>
      <div class="timeline-body" id="timelineBody">
        <div class="timeline-ruler" id="timelineRuler"></div>
        <div class="timeline-lanes" id="timelineLanes"></div>
        <div class="timeline-playhead" id="timelinePlayhead"></div>
      </div>
    </div>
    <p class="note">Tap a clip to select it · drag it to move it · use the panel below to edit or delete.</p>

    <div id="timelineActions" class="timeline-actions" hidden>
      <button type="button" class="primary" id="applyChangesBtn">✔ Apply Changes &amp; Rebuild Preview</button>
      <button type="button" class="secondary" id="discardChangesBtn">✕ Discard Changes</button>
    </div>

    <div id="clipInfo" class="clip-info" hidden></div>

    <div id="glmBusy" class="glm-busy" hidden>
      <div class="glm-busy-spinner"></div>
      <div class="glm-busy-text">
        <strong id="glmBusyLabel">Working…</strong>
        <span id="glmBusyElapsed">0s elapsed</span>
      </div>
    </div>

    <div class="production-controls">
      <h3>Production</h3>
      <label class="review-toggle"><input type="checkbox" id="dryRunCheck" checked> Dry run (no API credits, no files written)</label>
      <div class="production-buttons">
        <button type="button" class="secondary" id="soundGenerate">1 · Generate Sounds</button>
        <button type="button" class="secondary" id="soundMix">2 · Build Preview</button>
        <button type="button" class="secondary" id="soundApprove" disabled>3 · Approve Final</button>
        <button type="button" class="secondary" id="soundExport" disabled>4 · Export Final Video</button>
      </div>
      <p class="note">Export stays blocked until you approve the preview. Any new preview cancels a previous approval.</p>
      <pre id="productionLog" class="sound-report" hidden></pre>
    </div>

    <div id="soundChatPanel">
      <h3>Chat with GLM — your Chief Production Agent</h3>
      <p class="sub">Ask for changes: "make kick_2 quieter", "move trap_3 slightly earlier", "add rain ambience". GLM applies them and updates the timeline.</p>
      <div id="soundChatMessages" aria-live="polite"></div>
      <label for="soundChatInput">Your message</label>
      <textarea id="soundChatInput" rows="3" placeholder="Tell GLM what you want to change..."></textarea>
      <button type="button" class="primary" id="soundChatSend">Send Message</button>
      <p id="soundChatStatus" class="asset-list" aria-live="polite"></p>
    </div>
  </div>
`;

const libraryView = document.createElement('section');
libraryView.className = 'card studio-view';
libraryView.dataset.panel = 'library';
libraryView.innerHTML = `
  <div class="section-title"><span>08</span><h2>Audio Library</h2></div>
  <p class="sub">Your reusable sound effects library.</p>
  <div id="audioLibraryStatus">Local SFX library will appear here.</div>
`;

const projectsView = document.createElement('section');
projectsView.className = 'card studio-view';
projectsView.dataset.panel = 'projects';
projectsView.innerHTML = `
  <div class="section-title"><span>09</span><h2>Projects & Backup</h2></div>
  <p class="sub">Your video and sound-design projects will be listed here.</p>
  <div id="projectList">No projects loaded yet.</div>
`;

main.append(soundView, libraryView, projectsView);

const dashboard = document.createElement('section');
dashboard.className = 'card studio-view';
dashboard.dataset.panel = 'dashboard';
dashboard.innerHTML = `
  <div class="section-title"><span>00</span><h2>What If Studio</h2></div>
  <p class="sub">Your complete local video creation and sound-design workspace.</p>
  <div class="dashboard-actions">
    <button type="button" class="primary" data-open="video">▶ Open Video Studio</button>
    <button type="button" class="secondary" data-open="sound">♫ Open Sound Designer</button>
  </div>
`;
main.prepend(dashboard);

function showView(view) {
  originalSections.forEach(section => {
    section.hidden = view !== 'video';
  });

  document.querySelectorAll('.studio-view').forEach(panel => {
    panel.hidden = panel.dataset.panel !== view;
  });

  nav.querySelectorAll('button').forEach(button => {
    button.classList.toggle('active', button.dataset.view === view);
  });

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

nav.addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (button) showView(button.dataset.view);
});

dashboard.addEventListener('click', event => {
  const button = event.target.closest('[data-open]');
  if (button) showView(button.dataset.open);
});

showView('dashboard');
