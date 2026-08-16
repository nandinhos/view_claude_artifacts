import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { buildIndex } from './scanner.js';
import { lerSnapshot, listarSnapshots, esquecerArtefato, estatisticas } from './store.js';
import { SAVE_DIR, RESCAN_TTL_MS, ARCHIVE_INTERVAL_MS } from './config.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/** Índice em memória com TTL curto: o "monitoramento" é reescanear sob demanda. */
let cached = null;
let inflight = null;

async function getIndex({ force = false, ignoreTtl = false } = {}) {
  if (!force && !ignoreTtl && cached && Date.now() - cached.at < RESCAN_TTL_MS) return cached.index;
  if (inflight) return inflight;

  inflight = buildIndex({ force })
    .then((index) => {
      index.etag = crypto
        .createHash('sha1')
        .update(
          index.projects
            .map((p) => `${p.slug}:${p.count}:${p.lastActivity}`)
            .join('|')
        )
        .digest('hex')
        .slice(0, 16);
      cached = { at: Date.now(), index };
      return index;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** id → registro. O cliente nunca envia caminho; isso elimina path traversal. */
async function findArtifact(id) {
  const index = await getIndex();
  for (const p of index.projects) {
    for (const a of p.artifacts) {
      if (a.id === id) return { artifact: a, project: p };
    }
  }
  return null;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
}

async function serveStatic(res, name) {
  const file = path.join(PUBLIC_DIR, name);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  try {
    const body = await fsp.readFile(file);
    send(res, 200, body, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  } catch {
    send(res, 404, 'não encontrado');
  }
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('corpo grande demais');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Nome de arquivo seguro e legível para a cópia durável. */
function safeName(str) {
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._ -]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
    .replace(/^[-.]+|[-.]+$/g, '');
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;

    try {
      if (route === '/' || route === '/index.html') return serveStatic(res, 'index.html');
      if (route === '/app.js') return serveStatic(res, 'app.js');
      if (route === '/style.css') return serveStatic(res, 'style.css');

      if (route === '/api/index') {
        const index = await getIndex({ force: url.searchParams.get('force') === '1' });
        if (req.headers['if-none-match'] === index.etag) {
          return send(res, 304, '', { ETag: index.etag });
        }
        return sendJson(res, 200, index, { ETag: index.etag });
      }

      if (route.startsWith('/view/')) {
        const id = route.slice('/view/'.length);
        const hit = await findArtifact(id);
        if (!hit) return send(res, 404, 'artefato não encontrado no índice');

        const { artifact } = hit;
        const type = MIME[path.extname(artifact.path)] || 'text/plain; charset=utf-8';

        if (artifact.exists) {
          const stream = fs.createReadStream(artifact.path);
          stream.on('error', () => send(res, 500, 'falha ao ler o arquivo'));
          res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
          return stream.pipe(res);
        }

        // Arquivo sumiu do /tmp: serve o conteúdo arquivado no banco.
        const snap = artifact.snapshotCount > 0 ? lerSnapshot(id) : null;
        if (snap) {
          return send(res, 200, snap.conteudo, {
            'Content-Type': type,
            'X-Artefato-Origem': 'arquivo-sqlite',
            'X-Artefato-Capturado-Em': snap.capturedAt,
          });
        }

        return send(res, 410, renderGone(artifact), { 'Content-Type': 'text/html; charset=utf-8' });
      }

      if (route.startsWith('/api/snapshots/')) {
        const id = route.slice('/api/snapshots/'.length);
        const hit = await findArtifact(id);
        if (!hit) return sendJson(res, 404, { error: 'artefato não encontrado' });
        return sendJson(res, 200, { snapshots: listarSnapshots(id) });
      }

      if (route === '/api/forget' && req.method === 'POST') {
        const { id } = JSON.parse(await readBody(req));
        const removido = esquecerArtefato(id);
        cached = null; // o índice mudou; força releitura no próximo request
        return sendJson(res, removido ? 200 : 404, removido ? { forgotten: id } : { error: 'não estava no banco' });
      }

      if (route === '/api/stats') return sendJson(res, 200, estatisticas());

      if (route === '/api/health') {
        // Só responde ok se o banco abre — um container "up" com banco
        // inacessível não estaria arquivando nada.
        const s = estatisticas();
        return sendJson(res, 200, { ok: true, artefatos: s.artefatos, snapshots: s.snapshots });
      }

      if (route === '/api/save' && req.method === 'POST') {
        const { id } = JSON.parse(await readBody(req));
        const hit = await findArtifact(id);
        if (!hit) return sendJson(res, 404, { error: 'artefato não encontrado' });

        const { artifact } = hit;
        const snap = artifact.exists ? null : artifact.snapshotCount > 0 ? lerSnapshot(id) : null;
        if (!artifact.exists && !snap) {
          return sendJson(res, 410, { error: 'sem arquivo no disco e sem cópia arquivada' });
        }

        const dir = path.join(SAVE_DIR, safeName(hit.project.name || hit.project.slug));
        await fsp.mkdir(dir, { recursive: true });

        const stamp = (artifact.createdAt || new Date().toISOString()).slice(0, 10);
        const base = safeName(artifact.displayTitle) || safeName(artifact.fileName);
        const ext = path.extname(artifact.path) || '.html';
        let dest = path.join(dir, `${stamp}-${base}${ext}`);
        let n = 2;
        while (fs.existsSync(dest)) {
          dest = path.join(dir, `${stamp}-${base}-${n++}${ext}`);
        }

        if (artifact.exists) await fsp.copyFile(artifact.path, dest);
        else await fsp.writeFile(dest, snap.conteudo);

        return sendJson(res, 200, { saved: dest, origem: artifact.exists ? 'disco' : 'arquivo' });
      }

      return send(res, 404, 'rota desconhecida');
    } catch (err) {
      return sendJson(res, 500, { error: String(err?.message || err) });
    }
  });
}

function renderGone(artifact) {
  const url = artifact.url
    ? `<p>O artefato ainda existe publicado: <a href="${escapeHtml(artifact.url)}">abrir no claude.ai</a></p>`
    : '<p>Não há cópia publicada — este artefato se perdeu.</p>';
  return `<!doctype html><meta charset="utf-8"><title>Arquivo removido</title>
<body style="font:16px system-ui;max-width:44rem;margin:4rem auto;padding:0 1.5rem;line-height:1.6">
<h1>Arquivo não está mais no disco</h1>
<p><code>${escapeHtml(artifact.path)}</code></p>
<p>Scratchpads ficam em <code>/tmp</code> e são apagados no reboot ou na limpeza do Claude Code.</p>
${url}</body>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Arquivamento por push. A varredura sob demanda só acontece quando alguém
 * abre a interface — e um artefato criado e perdido entre duas visitas nunca
 * seria arquivado. Este timer é o que realmente resolve a volatilidade do /tmp.
 */
export function iniciarArquivador({ onCycle } = {}) {
  const rodar = async () => {
    try {
      const index = await getIndex({ force: false, ignoreTtl: true });
      onCycle?.(index);
    } catch {
      /* uma falha de ciclo não derruba o servidor */
    }
  };
  const timer = setInterval(rodar, ARCHIVE_INTERVAL_MS);
  timer.unref?.();
  return { parar: () => clearInterval(timer), rodarAgora: rodar };
}

export { getIndex };
