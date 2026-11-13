import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SOUND_HOME = path.resolve(process.env.HOME, 'video-sound-designer');
const PROJECTS = path.join(SOUND_HOME, 'projects');
const LIBRARY_DIRS = [
  path.join(SOUND_HOME, 'sound-effects'),
  path.resolve(SOUND_HOME, '..', 'what-if', 'what-if-studio', 'library', 'sfx')
];

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;

    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

function run(command, args, cwd, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PWD: cwd },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Process timed out'));
    }, timeout);

    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(
        `Process exited with code ${code}\nSTDERR:\n${stderr.slice(-6000)}\nSTDOUT:\n${stdout.slice(-6000)}`
      ));
    });
  });
}

function isValidProjectPath(projectPath) {
  return projectPath.startsWith(PROJECTS + path.sep) &&
    fs.existsSync(path.join(projectPath, 'project.json'));
}

/* Copy a finished export into the phone's shared Downloads folder so the
 * user's Files/Gallery apps can see it (Termux exposes ~/storage/downloads
 * when storage permission was granted). Never throws — export must succeed
 * even if the phone copy fails. */
function copyToPhoneDownloads(sourceFile) {
  try {
    const downloads = path.join(process.env.HOME || '', 'storage', 'downloads');
    if (!fs.existsSync(downloads)) {
      return { saved: false, error: 'Downloads folder not accessible (storage permission?)' };
    }
    let dir = path.join(downloads, 'WhatIfStudio');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      dir = downloads; // fall back to plain Downloads
    }
    const base = path.basename(sourceFile);
    let target = path.join(dir, base);
    if (fs.existsSync(target)) {
      const ext = path.extname(base);
      const stem = base.slice(0, -ext.length || undefined);
      let version = 2;
      while (fs.existsSync(path.join(dir, `${stem}_v${version}${ext}`))) version++;
      target = path.join(dir, `${stem}_v${version}${ext}`);
    }
    fs.copyFileSync(sourceFile, target);
    return { saved: true, phonePath: path.relative(path.join(process.env.HOME, 'storage'), target) };
  } catch (error) {
    return { saved: false, error: error.message };
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listDirFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(name => !name.startsWith('.'))
      .map(name => {
        const full = path.join(dir, name);
        return { name, size: fs.statSync(full).size, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function appendHistory(projectPath, action, detail) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      action,
      detail: String(detail).slice(0, 500)
    };
    fs.appendFileSync(
      path.join(projectPath, 'history.jsonl'),
      JSON.stringify(entry) + '\n'
    );
  } catch {
    // History is best-effort; never fail an operation because of it.
  }
}

function readHistory(projectPath, limit = 10) {
  const file = path.join(projectPath, 'history.jsonl');
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map(line => {
        try { return JSON.parse(line); } catch { return { raw: line.slice(0, 300) }; }
      });
  } catch {
    return [];
  }
}

function resolveEventAsset(projectPath, event) {
  const name = String(event.reuse || event.id || '').trim();
  if (!name) return null;
  const safe = name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!safe) return null;

  const folders = [
    path.join(projectPath, 'sound-effects'),
    path.join(SOUND_HOME, 'sound-effects'),
    ...LIBRARY_DIRS
  ];

  for (const folder of folders) {
    for (const ext of ['.mp3', '.wav', '.m4a', '.aac']) {
      const candidate = path.join(folder, safe + ext);
      if (fs.existsSync(candidate)) {
        if (folder === folders[0]) {
          return `/api/sound/file?projectPath=${encodeURIComponent(projectPath)}&rel=${encodeURIComponent('sound-effects/' + safe + ext)}`;
        }
        return `/api/sound/asset?name=${encodeURIComponent(safe + ext)}`;
      }
      // Library files may carry hashed suffixes, e.g. dribble-1a2b3c4d.mp3
      try {
        const match = fs.readdirSync(folder)
          .find(file => file.startsWith(safe + '-') && ext === path.extname(file).toLowerCase());
        if (match) {
          if (folder === folders[0]) {
            return `/api/sound/file?projectPath=${encodeURIComponent(projectPath)}&rel=${encodeURIComponent('sound-effects/' + match)}`;
          }
          return `/api/sound/asset?name=${encodeURIComponent(match)}`;
        }
      } catch {
        // Ignore unreadable folders.
      }
    }
  }
  return null;
}

function projectState(projectPath) {
  const manifest = readJsonSafe(path.join(projectPath, 'project.json')) || {};
  const plan = readJsonSafe(path.join(projectPath, 'sound-plan.json'));

  const events = Array.isArray(plan?.sound_events) ? plan.sound_events : [];
  const trackOf = event => {
    if (['ambience', 'music', 'narration'].includes(event.track)) return event.track;
    const type = String(event.type || event.category || 'sfx').toLowerCase();
    if (type.includes('ambient') || type.includes('ambien')) return 'ambience';
    if (type.includes('music')) return 'music';
    if (type.includes('narrat') || type.includes('voice')) return 'narration';
    return 'sfx';
  };

  const sfxDir = path.join(projectPath, 'sound-effects');
  const assets = listDirFiles(sfxDir).map(file => {
    if (!/\.(mp3|wav|m4a|aac)$/i.test(file.name)) return null;
    return {
      name: file.name,
      url: `/api/sound/file?projectPath=${encodeURIComponent(projectPath)}&rel=${encodeURIComponent('sound-effects/' + file.name)}`,
      size: file.size
    };
  }).filter(Boolean);

  const preview = manifest.preview_output
    ? path.join(projectPath, manifest.preview_output)
    : null;
  const final = manifest.final_output
    ? path.join(projectPath, manifest.final_output)
    : null;

  return {
    projectPath,
    manifest,
    plan: plan ? {
      title: plan.title,
      video_properties: plan.video_properties,
      audio_policy: plan.audio_policy,
      sound_design_concept: plan.sound_design_concept,
      visual_analysis: plan.visual_analysis,
      events: events.map(event => ({
        id: event.id,
        track: trackOf(event),
        start: Number(event.start ?? event.time_s ?? event.time_seconds ?? event.at_s ?? 0),
        duration: Number(event.duration ?? event.duration_s ?? event.length_s ??
          (Number.isFinite(Number(event.end_time_seconds)) && Number.isFinite(Number(event.start ?? event.time_s ?? event.time_seconds))
            ? Number(event.end_time_seconds) - Number(event.start ?? event.time_s ?? event.time_seconds)
            : 0)),
        volume: Number(event.volume ?? event.gain ?? event.level ?? 1),
        pan: Number(event.pan ?? 0),
        reuse: event.reuse || null,
        prompt: (event.prompt || '').slice(0, 200) || null,
        description: (event.description || '').slice(0, 200) || null,
        fade_in: Number(event.fade_in ?? 0) || 0,
        fade_out: Number(event.fade_out ?? 0) || 0,
        assetUrl: resolveEventAsset(projectPath, event)
      }))
    } : null,
    planError: plan ? null : 'sound-plan.json does not exist yet',
    assets,
    assetNames: assets.map(asset => asset.name.replace(/\.[^.]+$/, '')),
    outputs: {
      preview: manifest.preview_output || null,
      previewExists: preview ? fs.existsSync(preview) : false,
      final: manifest.final_output || null,
      finalExists: final ? fs.existsSync(final) : false
    },
    approval: {
      approved: Boolean(manifest.approval?.approved),
      approvedAt: manifest.approval?.approved_at || null,
      approvedPreview: manifest.approval?.preview_file || null,
      stale: Boolean(manifest.approval?.approved &&
        manifest.approval.preview_file &&
        manifest.approval.preview_file !== manifest.preview_output)
    },
    history: readHistory(projectPath, 12),
    media: {
      source: `/api/sound/file?projectPath=${encodeURIComponent(projectPath)}&rel=${encodeURIComponent(manifest.source_video || 'input/source-video.mp4')}`,
      preview: manifest.preview_output
        ? `/api/sound/file?projectPath=${encodeURIComponent(projectPath)}&rel=${encodeURIComponent(manifest.preview_output)}`
        : null
    }
  };
}

function buildProjectContext(projectPath) {
  const state = projectState(projectPath);
  const lines = [];
  const manifest = state.manifest;

  lines.push(`project_id: ${manifest.project_id || path.basename(projectPath)}`);
  lines.push(`title: ${manifest.title || 'Untitled'}`);
  lines.push(`project_directory: ${projectPath}`);
  lines.push(`status: ${manifest.status || 'unknown'}`);
  lines.push(`source_video: ${manifest.source_video || 'input/source-video.mp4'} (NEVER modify)`);
  if (manifest.source_tsx) lines.push(`source_tsx: ${manifest.source_tsx} (NEVER modify)`);
  lines.push(`video_duration_seconds: ${manifest.duration_seconds || 'unknown'}`);

  if (state.plan) {
    const vp = state.plan.video_properties;
    if (vp) {
      lines.push(`video_properties: ${JSON.stringify({
        duration_seconds: vp.duration_seconds,
        fps: vp.fps,
        resolution: vp.resolution,
        existing_audio: vp.existing_audio_stream?.present
          ? `${vp.existing_audio_stream.codec} (${vp.existing_audio_stream.content || ''})`.trim()
          : 'none'
      })}`);
    }
    if (state.plan.visual_analysis) {
      lines.push(`visual_analysis: ${JSON.stringify(state.plan.visual_analysis).slice(0, 1200)}`);
    }
    if (state.plan.sound_design_concept) {
      lines.push(`sound_design_concept: ${String(state.plan.sound_design_concept).slice(0, 800)}`);
    }
    lines.push(`sound_events (${state.plan.events.length}):`);
    for (const event of state.plan.events) {
      lines.push([
        `- id=${event.id}`,
        `track=${event.track}`,
        `start=${event.start}s`,
        `dur=${event.duration}s`,
        `vol=${event.volume}`,
        `pan=${event.pan}`,
        event.reuse ? `reuse=${event.reuse}` : null,
        event.prompt ? `prompt="${event.prompt}"` : null,
        event.description ? `desc="${event.description.slice(0, 120)}"` : null
      ].filter(Boolean).join(' | '));
    }
  } else {
    lines.push('sound_plan: MISSING - sound-plan.json does not exist yet.');
  }

  lines.push(`generated_assets: ${state.assetNames.length ? state.assetNames.join(', ') : 'none yet'}`);

  const libraryNames = [];
  for (const dir of LIBRARY_DIRS) {
    try {
      for (const file of fs.readdirSync(dir)) {
        if (/\.(mp3|wav|m4a|aac)$/i.test(file.name)) libraryNames.push(file.name);
      }
    } catch {
      // Skip unreadable library folders.
    }
  }
  lines.push(`local_library_sounds (${libraryNames.length}, reuse by filename stem, e.g. "dribble"): ${libraryNames.slice(0, 80).join(', ') || 'empty'}`);
  lines.push(`preview_output: ${state.outputs.preview || 'none'} (exists: ${state.outputs.previewExists})`);
  lines.push(`final_output: ${state.outputs.final || 'none'} (exists: ${state.outputs.finalExists})`);
  lines.push(`final_approval: ${state.approval.approved
    ? `APPROVED at ${state.approval.approvedAt}${state.approval.stale ? ' (stale: preview changed since approval)' : ''}`
    : 'not approved yet - export is blocked'}`);

  if (state.history.length) {
    lines.push('recent_production_history:');
    for (const entry of state.history.slice(-5)) {
      lines.push(`- ${entry.ts} ${entry.action}: ${entry.detail || ''}`);
    }
  }

  return lines.join('\n');
}

function appendHistoryFromEndpoint(projectPath, action, detail) {
  appendHistory(projectPath, action, detail);
}

const busy = new Map();

function withLock(key, fn) {
  if (busy.has(key)) {
    return Promise.reject(new Error(
      'An operation is already running for this project. Wait for it to finish.'
    ));
  }
  busy.set(key, true);
  return fn().finally(() => busy.delete(key));
}

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.tsx': 'text/plain; charset=utf-8',
  '.json': 'application/json'
};

function streamFile(res, filePath, req) {
  const stat = fs.statSync(filePath);
  const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? Math.min(parseInt(match[2], 10), stat.size - 1) : stat.size - 1;
      if (start >= stat.size || start > end) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        return res.end();
      }
      res.statusCode = 206;
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', end - start + 1);
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(filePath).pipe(res);
}

export function soundApi() {
  return {
    name: 'what-if-sound-api',

    configureServer(server) {
      server.middlewares.use('/api/sound/status', async (req, res) => {
        if (req.method !== 'GET') return send(res, 405, { error: 'GET required' });

        send(res, 200, {
          available: fs.existsSync(SOUND_HOME),
          projectManager: fs.existsSync(path.join(SOUND_HOME, 'scripts/project_manager.py')),
          generator: fs.existsSync(path.join(SOUND_HOME, 'scripts/generate_sfx_v2.py')),
          mixer: fs.existsSync(path.join(SOUND_HOME, 'scripts/build_mix_v2.py')),
          controller: fs.existsSync(path.join(SOUND_HOME, 'scripts/studio_ctl.py')),
          projectsDirectory: fs.existsSync(PROJECTS),
          aiModel: 'opencode/glm-5.3-flash-free#high'
        });
      });

      server.middlewares.use('/api/sound/projects', async (req, res) => {
        if (req.method !== 'GET') return send(res, 405, { error: 'GET required' });

        try {
          const projects = fs.readdirSync(PROJECTS)
            .map(name => path.join(PROJECTS, name))
            .filter(dir => fs.existsSync(path.join(dir, 'project.json')))
            .map(dir => {
              const manifest = readJsonSafe(path.join(dir, 'project.json')) || {};
              return {
                projectPath: dir,
                id: manifest.project_id || path.basename(dir),
                title: manifest.title || path.basename(dir),
                status: manifest.status || 'unknown',
                updatedAt: manifest.updated_at || null,
                duration: manifest.duration_seconds || null,
                hasPreview: Boolean(manifest.preview_output &&
                  fs.existsSync(path.join(dir, manifest.preview_output)))
              };
            })
            .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

          send(res, 200, { projects });
        } catch (error) {
          send(res, 500, { error: error.message });
        }
      });

      server.middlewares.use('/api/sound/project-state', async (req, res) => {
        if (req.method !== 'GET') return send(res, 405, { error: 'GET required' });

        const projectPath = path.resolve(
          String(new URL(req.url, 'http://localhost').searchParams.get('projectPath') || '')
        );

        if (!isValidProjectPath(projectPath)) {
          return send(res, 400, { error: 'Invalid sound project path' });
        }

        send(res, 200, projectState(projectPath));
      });

      server.middlewares.use('/api/sound/file', async (req, res) => {
        if (req.method !== 'GET') return send(res, 405, { error: 'GET required' });

        const params = new URL(req.url, 'http://localhost').searchParams;
        const projectPath = path.resolve(String(params.get('projectPath') || ''));
        const rel = String(params.get('rel') || '');

        if (!isValidProjectPath(projectPath)) {
          return send(res, 400, { error: 'Invalid sound project path' });
        }

        const filePath = path.resolve(projectPath, rel);
        if (!filePath.startsWith(projectPath + path.sep) || !fs.existsSync(filePath) ||
            !fs.statSync(filePath).isFile()) {
          return send(res, 404, { error: 'File not found in project' });
        }

        streamFile(res, filePath, req);
      });

      server.middlewares.use('/api/sound/asset', async (req, res) => {
        if (req.method !== 'GET') return send(res, 405, { error: 'GET required' });

        const name = path.basename(
          String(new URL(req.url, 'http://localhost').searchParams.get('name') || '')
        );

        for (const dir of LIBRARY_DIRS) {
          const candidate = path.join(dir, name);
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile() &&
              path.dirname(candidate) === dir) {
            return streamFile(res, candidate, req);
          }
        }

        send(res, 404, { error: 'Library asset not found' });
      });

      server.middlewares.use('/api/sound/create-project', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });

        try {
          const data = await readBody(req, 40 * 1024 * 1024);
          if (!data.videoBase64 || typeof data.videoBase64 !== 'string') {
            return send(res, 400, { error: 'Rendered MP4 is required' });
          }

          const video = Buffer.from(data.videoBase64, 'base64');
          if (video.length < 16 || video.length > 30 * 1024 * 1024) {
            return send(res, 400, { error: 'MP4 must be between 16 bytes and 30 MB for this upload endpoint' });
          }

          const title = String(data.title || 'What If Studio Project').slice(0, 80);
          const inbox = path.join(SOUND_HOME, 'incoming');
          fs.mkdirSync(inbox, { recursive: true });

          const id = crypto.randomUUID();
          const safeName = `source-${id}.mp4`;
          const videoPath = path.join(inbox, safeName);

          fs.writeFileSync(videoPath, video, { flag: 'wx' });

          let tsxPath;
          if (typeof data.tsxBase64 === 'string' && data.tsxBase64.length) {
            const tsx = Buffer.from(data.tsxBase64, 'base64');
            if (tsx.length > 2 * 1024 * 1024) {
              fs.unlinkSync(videoPath);
              return send(res, 400, { error: 'TSX file is too large' });
            }

            tsxPath = path.join(inbox, `source-${id}.tsx`);
            fs.writeFileSync(tsxPath, tsx, { flag: 'wx' });
          }

          const args = [
            'scripts/project_manager.py',
            '--video', videoPath,
            '--title', title
          ];
          if (tsxPath) args.push('--tsx', tsxPath);

          const result = await run('python3', args, SOUND_HOME, 120000);

          const match = result.stdout.match(/projects[\\/][^\s]+/);
          const projectPath = match
            ? path.resolve(SOUND_HOME, match[0])
            : null;

          send(res, 200, {
            success: true,
            message: 'Sound project created. Original upload retained.',
            projectPath,
            output: result.stdout.slice(-4000)
          });
        } catch (error) {
          send(res, 500, { error: error.message });
        }
      });

      server.middlewares.use('/api/sound/analyze', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });

        try {
          const data = await readBody(req, 64 * 1024);
          const projectPath = path.resolve(String(data.projectPath || ''));

          if (!isValidProjectPath(projectPath)) {
            return send(res, 400, { error: 'Invalid sound project path' });
          }

          const prompt = `
You are the What If Studio Video Sound Designer.
Read the video-sound-designer skill and inspect this project.
Project directory: ${projectPath}

Analyse the existing rendered MP4 and optional TSX.
Inspect actual video frames using available local tools.
Create or update ONLY this project's sound-plan.json.
Do not modify the source MP4 or TSX.
Default to sound effects only. No narration or music.
Do not call ElevenLabs, generate audio, run the mixer, or export video.
Return a concise report and identify any visual-analysis limitations.
User instructions: ${String(data.instructions || 'Create a suitable synchronized sound-effects plan.').slice(0, 3000)}
`;

          const result = await run('opencode', [
            'run',
            '--format', 'json',
            '--model', 'opencode/glm-5.3-flash-free#high',
            '--agent', 'build',
            '--title', 'What If Studio Sound Analysis',
            prompt
          ], SOUND_HOME, 10 * 60 * 1000);

          appendHistoryFromEndpoint(projectPath, 'analyze',
            'Video/TSX analysis completed by GLM.');

          send(res, 200, {
            success: true,
            report: result.stdout.slice(-12000),
            warnings: result.stderr.slice(-3000)
          });
        } catch (error) {
          send(res, 500, { error: error.message });
        }
      });

      const runStudioCtl = async (res, projectPath, args, action, timeout = 900000) => {
        try {
          const result = await run('python3',
            ['scripts/studio_ctl.py', ...args], SOUND_HOME, timeout);
          send(res, 200, {
            success: true,
            output: result.stdout.slice(-8000),
            state: projectState(projectPath)
          });
        } catch (error) {
          appendHistoryFromEndpoint(projectPath, action,
            'FAILED: ' + error.message.slice(0, 300));
          send(res, 500, { error: error.message.slice(0, 4000) });
        }
      };

      server.middlewares.use('/api/sound/normalize', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });

        try {
          const data = await readBody(req, 16 * 1024);
          const projectPath = path.resolve(String(data.projectPath || ''));

          if (!isValidProjectPath(projectPath)) {
            return send(res, 400, { error: 'Invalid sound project path' });
          }

          await run('python3',
            ['scripts/studio_ctl.py', 'normalize', path.relative(SOUND_HOME, projectPath)],
            SOUND_HOME, 60000);

          appendHistoryFromEndpoint(projectPath, 'normalize', 'Plan normalized.');
          send(res, 200, { success: true, state: projectState(projectPath) });
        } catch (error) {
          send(res, 500, { error: error.message });
        }
      });

      server.middlewares.use('/api/sound/generate', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });

        try {
          const data = await readBody(req, 16 * 1024);
          const projectPath = path.resolve(String(data.projectPath || ''));
          const dryRun = Boolean(data.dryRun);

          if (!isValidProjectPath(projectPath)) {
            return send(res, 400, { error: 'Invalid sound project path' });
          }

          const rel = path.relative(SOUND_HOME, projectPath);
          await withLock(`generate:${rel}`, async () => {
            await run('python3',
              ['scripts/studio_ctl.py', 'normalize', rel], SOUND_HOME, 60000);
            await runStudioCtlPromise(res, projectPath,
              ['generate', rel, ...(dryRun ? ['--dry-run'] : [])], 'generate', 900000);
          });
        } catch (error) {
          send(res, 500, { error: error.message });
        }
      });

      server.middlewares.use('/api/sound/mix', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });

        try {
          const data = await readBody(req, 16 * 1024);
          const projectPath = path.resolve(String(data.projectPath || ''));
          const dryRun = Boolean(data.dryRun);

          if (!isValidProjectPath(projectPath)) {
            return send(res, 400, { error: 'Invalid sound project path' });
          }

          const rel = path.relative(SOUND_HOME, projectPath);
          await withLock(`mix:${rel}`, async () => {
            await run('python3',
              ['scripts/studio_ctl.py', 'normalize', rel], SOUND_HOME, 60000);

            // A new preview invalidates a previous approval.
            const state = projectState(projectPath);
            if (state.manifest.approval?.approved) {
              const manifest = state.manifest;
              manifest.approval = {
                approved: false,
                revoked_reason: 'new preview produced after approval'
              };
              fs.writeFileSync(path.join(projectPath, 'project.json'),
                JSON.stringify(manifest, null, 2) + '\n');
            }

            await runStudioCtlPromise(res, projectPath,
              ['mix', rel, ...(dryRun ? ['--dry-run'] : [])], 'mix', 600000);
          });
        } catch (error) {
          send(res, 500, { error: error.message });
        }
      });

      server.middlewares.use('/api/sound/plan-events', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });

        try {
          const data = await readBody(req, 256 * 1024);
          const projectPath = path.resolve(String(data.projectPath || ''));
          const events = data.events;

          if (!isValidProjectPath(projectPath)) {
            return send(res, 400, { error: 'Invalid sound project path' });
          }
          if (!Array.isArray(events)) {
            return send(res, 400, { error: '"events" must be an array of plan events' });
          }

          const rel = path.relative(SOUND_HOME, projectPath);
          await withLock(`plan:${rel}`, async () => {
            await runStudioCtlPromise(res, projectPath,
              ['plan-events', rel, JSON.stringify(events)], 'plan-events', 120000);
          });
        } catch (error) {
          send(res, 500, { error: error.message });
        }
      });

      server.middlewares.use('/api/sound/approve', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });

        try {
          const data = await readBody(req, 16 * 1024);
          const projectPath = path.resolve(String(data.projectPath || ''));

          if (!isValidProjectPath(projectPath)) {
            return send(res, 400, { error: 'Invalid sound project path' });
          }

          const manifest = readJsonSafe(path.join(projectPath, 'project.json'));
          if (!manifest) return send(res, 500, { error: 'project.json unreadable' });

          const preview = manifest.preview_output
            ? path.join(projectPath, manifest.preview_output)
            : null;

          if (!preview || !fs.existsSync(preview)) {
            return send(res, 400, {
              error: 'No preview exists yet. Build a preview before approving.'
            });
          }

          if (data.approved === false) {
            manifest.approval = { approved: false, revoked_reason: 'user revoked approval' };
            manifest.status = 'revising';
          } else {
            manifest.approval = {
              approved: true,
              approved_at: new Date().toISOString(),
              preview_file: manifest.preview_output
            };
            manifest.status = 'approved';
            appendHistoryFromEndpoint(projectPath, 'approve',
              `User approved preview: ${manifest.preview_output}`);
          }

          manifest.updated_at = new Date().toISOString();
          fs.writeFileSync(path.join(projectPath, 'project.json'),
            JSON.stringify(manifest, null, 2) + '\n');

          send(res, 200, { success: true, state: projectState(projectPath) });
        } catch (error) {
          send(res, 500, { error: error.message });
        }
      });

      server.middlewares.use('/api/sound/export', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });

        try {
          const data = await readBody(req, 16 * 1024);
          const projectPath = path.resolve(String(data.projectPath || ''));
          const confirmation = String(data.confirm || '');

          if (!isValidProjectPath(projectPath)) {
            return send(res, 400, { error: 'Invalid sound project path' });
          }

          if (confirmation !== 'EXPORT FINAL VIDEO') {
            return send(res, 400, {
              error: 'Final export requires explicit confirmation ("confirm": "EXPORT FINAL VIDEO").'
            });
          }

          const manifest = readJsonSafe(path.join(projectPath, 'project.json'));
          const approval = manifest.approval || {};

          if (!approval.approved) {
            return send(res, 403, {
              error: 'Final export is blocked until the user approves the preview.'
            });
          }

          if (approval.preview_file !== manifest.preview_output) {
            return send(res, 409, {
              error: 'The preview changed after approval. Review and approve again before export.'
            });
          }

          const sourcePreview = path.join(projectPath, manifest.preview_output);
          const finalPath = path.join(projectPath, manifest.final_output);

          let target = finalPath;
          if (fs.existsSync(target)) {
            let version = 2;
            while (fs.existsSync(
              path.join(projectPath, `output/${manifest.project_id}_SoundDesigned_v${version}.mp4`)
            )) version++;
            target = path.join(projectPath, `output/${manifest.project_id}_SoundDesigned_v${version}.mp4`);
          }

          fs.copyFileSync(sourcePreview, target);

          // Also save a copy where the phone's Files/Gallery apps can see it.
          const phoneCopy = copyToPhoneDownloads(target);

          manifest.final_output = path.relative(projectPath, target);
          manifest.status = 'final-exported';
          manifest.updated_at = new Date().toISOString();
          fs.writeFileSync(path.join(projectPath, 'project.json'),
            JSON.stringify(manifest, null, 2) + '\n');

          appendHistoryFromEndpoint(projectPath, 'export',
            `Final video exported: ${path.basename(target)}` +
            (phoneCopy.saved ? ` | phone copy: ${phoneCopy.phonePath}` : ''));

          send(res, 200, {
            success: true,
            finalOutput: path.basename(target),
            phoneCopy: phoneCopy.saved ? phoneCopy.phonePath : null,
            phoneCopyError: phoneCopy.error || null,
            state: projectState(projectPath)
          });
        } catch (error) {
          send(res, 500, { error: error.message });
        }
      });

      server.middlewares.use('/api/sound/chat', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });

        try {
          const data = await readBody(req, 128 * 1024);
          const projectPath = path.resolve(String(data.projectPath || ''));
          const message = String(data.message || '').trim();

          if (!isValidProjectPath(projectPath)) {
            return send(res, 400, { error: 'Invalid sound project path' });
          }

          if (!message || message.length > 6000) {
            return send(res, 400, { error: 'Message must contain between 1 and 6000 characters' });
          }

          const sessionFile = path.join(projectPath, 'glm-session.json');
          let sessionId = null;

          if (fs.existsSync(sessionFile)) {
            try {
              const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
              if (typeof saved.sessionId === 'string' &&
                  /^ses_[A-Za-z0-9]+$/.test(saved.sessionId)) {
                sessionId = saved.sessionId;
              }
            } catch {
              return send(res, 500, { error: 'This project chat session file is invalid' });
            }
          }

          const context = buildProjectContext(projectPath);
          const rel = path.relative(SOUND_HOME, projectPath);

          const prompt = `
You are GLM, the Chief AI Production Agent for ONE What If Studio project.
The application has loaded the project state for you. Trust it; never ask the
user for information it already contains.

=== PROJECT CONTEXT (auto-loaded from the project directory) ===
${context}
=== END PROJECT CONTEXT ===

PRODUCTION TOOL (the only shell command your permissions allow):
python3 scripts/studio_ctl.py <command> <project> [args]
Project argument for every command: ${rel}

WHEN TO ACT:
- If the user asks for production work (create/revise the sound plan, choose
  or generate sounds, change timing, volume, pan, track assignment, ambience,
  build the preview, fix problems), DO IT NOW with studio_ctl:
  1. Read the context; plan the exact changes.
  2. Apply plan changes with: plan-apply ${rel} '<full plan JSON>'.
     Every event needs id, start, duration, volume, and either "reuse"
     (library sound) or "prompt" (generation prompt). Optional: pan, track,
     fade_in, fade_out.
  3. Check the library first (library-search) and reuse matching sounds
     before spending generation credits.
  4. Generate missing sounds with: generate ${rel} (add --dry-run when the
     user only wants to see what would happen; never generate twice for
     sounds that already exist as assets).
  5. Verify with: assets ${rel} or validate ${rel}.
  6. Build the preview with: mix ${rel}. Then verify in status that the
     preview file exists.
- If the user only wants information or discussion, answer directly without
  running tools.
- There is no approve/export tool. If asked to finalize, tell the user to use
  the Approve / Export controls in the review workspace.

RULES:
- Work only on this project. Never modify the source MP4/TSX.
- Never expose API keys or credentials.
- Only report operations the tool output actually confirms. Never paste or
  paraphrase tool output that you did not actually receive in this session.
- End your reply with a short "Next step:" suggestion for the user.

User's message:
${message}
`;

          const args = [
            'run',
            '--standalone',
            '--format', 'json',
            '--model', 'opencode/glm-5.3-flash-free#high',
            '--agent', 'glm-chat',
            '--title', 'What If Studio Project Chat'
          ];

          if (sessionId) args.push('--session', sessionId);
          args.push(prompt);

          const result = await run('opencode', args, SOUND_HOME, 15 * 60 * 1000);

          let reply = '';
          let returnedSessionId = sessionId;
          const toolsUsed = [];

          for (const line of result.stdout.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              if (typeof event.sessionID === 'string') {
                returnedSessionId = event.sessionID;
              }
              if (event.type === 'text' && event.part?.type === 'text' && typeof event.part.text === 'string') {
                reply += event.part.text;
              }
              if (event.type === 'tool_use' && event.part?.type === 'tool') {
                const command = event.part.state?.input?.command ||
                  event.part.state?.input?.filePath || '';
                const status = event.part.state?.status || '';
                toolsUsed.push(
                  `${event.part.tool}: ${String(command).slice(0, 110)}${status ? ` [${status}]` : ''}`
                );
              }
            } catch {
              // Ignore non-JSON output lines.
            }
          }

          if (!returnedSessionId || !reply.trim()) {
            return send(res, 502, { error: 'GLM Chat did not return a usable reply' });
          }

          const tempSessionFile = sessionFile + '.tmp';
          fs.writeFileSync(tempSessionFile, JSON.stringify({
            sessionId: returnedSessionId
          }), { mode: 0o600 });
          fs.renameSync(tempSessionFile, sessionFile);

          send(res, 200, {
            success: true,
            sessionId: returnedSessionId,
            reply: reply.trim().slice(0, 12000),
            toolsUsed: toolsUsed.slice(0, 20),
            state: projectState(projectPath)
          });
        } catch (error) {
          console.error('GLM Chat request failed:', error.message);
          send(res, 500, { error: 'GLM Chat request failed. Check the local OpenCode service.' });
        }
      });
    }
  };
}

async function runStudioCtlPromise(res, projectPath, args, action, timeout) {
  try {
    const result = await run('python3', ['scripts/studio_ctl.py', ...args],
      SOUND_HOME, timeout);
    send(res, 200, {
      success: true,
      output: result.stdout.slice(-8000),
      state: projectState(projectPath)
    });
  } catch (error) {
    appendHistoryFromEndpoint(projectPath, action,
      'FAILED: ' + error.message.slice(0, 300));
    send(res, 500, {
      error: error.message.slice(0, 4000),
      state: projectState(projectPath)
    });
  }
}
