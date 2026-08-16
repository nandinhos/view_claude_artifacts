import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

import {
  SCRATCH_ROOT,
  NOISE_PATTERNS,
  MIN_LOCAL_BYTES,
  SKIP_DIRS,
  SCRATCH_MAX_DEPTH,
  transcriptRoots,
  safeReaddir,
  isDir,
} from './config.js';
import {
  lerScanCache,
  gravarScanCache,
  limparScanCache,
  sincronizarArtefatos,
  arquivarConteudo,
  listarArtefatos,
} from './store.js';

const CONCURRENCY = 8;

/**
 * Replica a regra de slug do Claude Code: todo caractere fora de [A-Za-z0-9] vira '-'.
 * É como ~/.claude/projects/<slug> e /tmp/claude-<uid>/<slug> são nomeados.
 */
export function slugify(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

export function idFor(filePath) {
  return crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16);
}

const ACENTOS = {
  acute: { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú', Y: 'Ý' },
  grave: { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È', I: 'Ì', O: 'Ò', U: 'Ù' },
  circ: { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û', A: 'Â', E: 'Ê', I: 'Î', O: 'Ô', U: 'Û' },
  tilde: { a: 'ã', n: 'ñ', o: 'õ', A: 'Ã', N: 'Ñ', O: 'Õ' },
  uml: { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü' },
  cedil: { c: 'ç', C: 'Ç' },
  ring: { a: 'å', A: 'Å' },
  slash: { o: 'ø', O: 'Ø' },
};

const NOMEADAS = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»',
  times: '×', divide: '÷', deg: '°', euro: '€', pound: '£', copy: '©', reg: '®', trade: '™',
};

/**
 * O título de um artefato publicado é lido do <title> do arquivo, então chega
 * aqui com entidades HTML cruas ("decis&otilde;es"). Uma passada só — assim
 * "&amp;otilde;" não vira "õ" por decodificação dupla.
 */
export function decodeEntities(str) {
  if (!str || !str.includes('&')) return str;
  return String(str).replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (todo, corpo) => {
    if (corpo[0] === '#') {
      const cod = corpo[1] === 'x' || corpo[1] === 'X'
        ? parseInt(corpo.slice(2), 16)
        : parseInt(corpo.slice(1), 10);
      return Number.isFinite(cod) && cod > 0 && cod <= 0x10ffff ? String.fromCodePoint(cod) : todo;
    }
    if (NOMEADAS[corpo] !== undefined) return NOMEADAS[corpo];
    const m = corpo.match(/^([a-zA-Z])(acute|grave|circ|tilde|uml|cedil|ring|slash)$/);
    if (m && ACENTOS[m[2]]?.[m[1]]) return ACENTOS[m[2]][m[1]];
    return todo;
  });
}

// ---------------------------------------------------------------- transcripts

function listTranscripts() {
  const out = [];
  for (const { profile, dir } of transcriptRoots()) {
    for (const slug of safeReaddir(dir)) {
      const projectDir = path.join(dir, slug);
      if (!isDir(projectDir)) continue;
      for (const name of safeReaddir(projectDir)) {
        if (!name.endsWith('.jsonl')) continue;
        out.push({ file: path.join(projectDir, name), slug, profile });
      }
    }
  }
  return out;
}

/**
 * Lê um transcript e extrai só o que interessa: chamadas da ferramenta Artifact,
 * os resultados que carregam a URL publicada, e o cwd real da sessão.
 *
 * O pré-filtro por substring evita JSON.parse em ~99,9% das linhas — sem ele,
 * varrer 1 GB de transcript custaria minutos em vez de segundos.
 */
async function scanTranscript({ file, slug, profile }) {
  const uses = [];
  const results = [];
  const cwds = [];
  let cwdSettled = false;

  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const hasUse = line.includes('"name":"Artifact"');
      const hasResult = line.includes('/code/artifact/');

      if (!cwdSettled && line.includes('"cwd":"')) {
        const m = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
        if (m) {
          const cwd = m[1].replace(/\\(.)/g, '$1');
          if (!cwds.includes(cwd)) cwds.push(cwd);
          // Um cwd que slugifica de volta para o nome do diretório é o cwd canônico
          // da sessão — a partir daí não precisamos de mais candidatos.
          if (slugify(cwd) === slug) cwdSettled = true;
          else if (cwds.length >= 8) cwdSettled = true;
        }
      }

      if (!hasUse && !hasResult) continue;

      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      const content = entry?.message?.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block?.type === 'tool_use' && block?.name === 'Artifact') {
          const input = block.input || {};
          if (!input.file_path) continue; // action:"list" e afins não publicam nada
          uses.push({
            toolUseId: block.id,
            filePath: input.file_path,
            title: input.title || null,
            description: input.description || null,
            favicon: input.favicon || null,
            label: input.label || null,
            urlInput: input.url || null,
            timestamp: entry.timestamp || null,
            sessionId: entry.sessionId || entry.session_id || null,
            gitBranch: entry.gitBranch || null,
          });
        }

        if (block?.type === 'tool_result' && entry.toolUseResult?.url) {
          const r = entry.toolUseResult;
          results.push({
            toolUseId: block.tool_use_id || null,
            url: r.url,
            filePath: r.path || null,
            title: r.title || null,
            version: r.version || null,
            timestamp: entry.timestamp || null,
          });
        }
      }
    }
  } catch {
    // transcript truncado ou ilegível — o que já foi lido continua válido
  } finally {
    rl.close();
    stream.destroy();
  }

  return { uses, results, cwds, slug, profile };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ------------------------------------------------------------------ scratchpad

function isNoise(fileName) {
  return NOISE_PATTERNS.some((re) => re.test(fileName));
}

/**
 * HTMLs de scratchpad que nunca passaram pela ferramenta Artifact.
 * Layout: /tmp/claude-<uid>/<slug-do-projeto>/<session-id>/scratchpad/*.html
 */
function scanScratchpads() {
  const found = [];
  if (!isDir(SCRATCH_ROOT)) return found;

  for (const slug of safeReaddir(SCRATCH_ROOT)) {
    const projectDir = path.join(SCRATCH_ROOT, slug);
    if (!isDir(projectDir)) continue;

    for (const sessionId of safeReaddir(projectDir)) {
      const scratch = path.join(projectDir, sessionId, 'scratchpad');
      if (!isDir(scratch)) continue;
      walkScratch(scratch, scratch, 0, slug, sessionId, found);
    }
  }
  return found;
}

function walkScratch(dir, root, depth, slug, sessionId, found) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const e of entries) {
    const full = path.join(dir, e.name);

    if (e.isDirectory()) {
      if (depth >= SCRATCH_MAX_DEPTH) continue;
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walkScratch(full, root, depth + 1, slug, sessionId, found);
      continue;
    }

    if (!e.isFile()) continue;
    if (!e.name.toLowerCase().endsWith('.html')) continue;
    if (isNoise(e.name)) continue;

    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (st.size < MIN_LOCAL_BYTES) continue;

    found.push({
      filePath: full,
      slug,
      sessionId,
      relPath: path.relative(root, full),
      size: st.size,
      createdAt: new Date(st.birthtimeMs || st.mtimeMs).toISOString(),
      updatedAt: new Date(st.mtimeMs).toISOString(),
      birthtimeReliable: st.birthtimeMs > 0 && st.birthtimeMs <= st.mtimeMs + 1000,
    });
  }
}

// ------------------------------------------------------------------ montagem

function projectPathFromSlug(slug, cwdCandidates) {
  for (const cwd of cwdCandidates) {
    if (slugify(cwd) === slug) return cwd;
  }
  // Sem cwd que confirme: devolve o slug cru em vez de adivinhar onde ficam as
  // barras (`catalogar-v2` e `catalogar/v2` produzem o mesmo slug).
  return null;
}

export async function buildIndex({ force = false, archive = true, onProgress } = {}) {
  const startedAt = Date.now();
  const transcripts = listTranscripts();
  if (force) limparScanCache();
  const cache = force ? new Map() : lerScanCache();
  const nextCache = new Map();

  let reused = 0;
  let scanned = 0;
  let bytes = 0;

  const perFile = await mapLimit(transcripts, CONCURRENCY, async (t) => {
    let st;
    try {
      st = await fsp.stat(t.file);
    } catch {
      return null;
    }
    bytes += st.size;

    const cached = cache.get(t.file);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      reused++;
      nextCache.set(t.file, cached);
      onProgress?.({ done: reused + scanned, total: transcripts.length });
      return { ...cached.data, slug: t.slug, profile: t.profile };
    }

    const data = await scanTranscript(t);
    scanned++;
    nextCache.set(t.file, {
      size: st.size,
      mtimeMs: st.mtimeMs,
      data: { uses: data.uses, results: data.results, cwds: data.cwds },
    });
    onProgress?.({ done: reused + scanned, total: transcripts.length });
    return data;
  });

  gravarScanCache(nextCache);

  // Resultados são casados por tool_use_id globalmente: uma sessão retomada pode
  // gravar a chamada e o resultado em arquivos diferentes.
  const resultsById = new Map();
  const resultsByPath = new Map();
  const cwdsBySlug = new Map();
  const profileBySlug = new Map();

  for (const f of perFile) {
    if (!f) continue;
    const list = cwdsBySlug.get(f.slug) || [];
    for (const c of f.cwds || []) if (!list.includes(c)) list.push(c);
    cwdsBySlug.set(f.slug, list);
    if (!profileBySlug.has(f.slug)) profileBySlug.set(f.slug, f.profile);

    for (const r of f.results || []) {
      if (r.toolUseId) resultsById.set(r.toolUseId, r);
      if (r.filePath) {
        const prev = resultsByPath.get(r.filePath);
        if (!prev || (r.timestamp || '') > (prev.timestamp || '')) resultsByPath.set(r.filePath, r);
      }
    }
  }

  /** @type {Map<string, any>} chave = caminho do arquivo (republicar o mesmo path é o mesmo artefato) */
  const byPath = new Map();

  const allUses = [];
  for (const f of perFile) {
    if (!f) continue;
    for (const u of f.uses || []) allUses.push({ ...u, slug: f.slug, profile: f.profile });
  }
  allUses.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

  for (const u of allUses) {
    const result = (u.toolUseId && resultsById.get(u.toolUseId)) || resultsByPath.get(u.filePath) || null;
    const rec = byPath.get(u.filePath) || {
      id: idFor(u.filePath),
      path: u.filePath,
      fileName: path.basename(u.filePath),
      source: 'artifact',
      projectSlug: u.slug,
      profile: u.profile,
      title: null,
      description: null,
      favicon: null,
      label: null,
      url: null,
      version: null,
      publishCount: 0,
      createdAt: u.timestamp,
      updatedAt: u.timestamp,
      sessionId: u.sessionId,
      gitBranch: u.gitBranch,
    };

    rec.publishCount += 1;
    rec.title = result?.title || u.title || rec.title;
    rec.description = u.description || rec.description;
    rec.favicon = u.favicon || rec.favicon;
    rec.label = u.label || rec.label;
    rec.url = result?.url || u.urlInput || rec.url;
    rec.version = result?.version || rec.version;
    rec.sessionId = u.sessionId || rec.sessionId;
    rec.gitBranch = u.gitBranch || rec.gitBranch;
    if (u.timestamp) {
      if (!rec.createdAt || u.timestamp < rec.createdAt) rec.createdAt = u.timestamp;
      if (!rec.updatedAt || u.timestamp > rec.updatedAt) rec.updatedAt = u.timestamp;
    }
    // Uma sessão que fez `cd` para o scratchpad ainda pertence ao projeto do transcript;
    // o slug do diretório do transcript é a chave canônica.
    byPath.set(u.filePath, rec);
  }

  // Publicações órfãs (resultado sem a chamada correspondente no transcript).
  for (const [filePath, r] of resultsByPath) {
    if (byPath.has(filePath)) continue;
    const slug = slugFromScratchPath(filePath);
    if (!slug) continue;
    byPath.set(filePath, {
      id: idFor(filePath),
      path: filePath,
      fileName: path.basename(filePath),
      source: 'artifact',
      projectSlug: slug,
      profile: profileBySlug.get(slug) || 'default',
      title: r.title || null,
      description: null,
      favicon: null,
      label: null,
      url: r.url,
      version: r.version || null,
      publishCount: 1,
      createdAt: r.timestamp,
      updatedAt: r.timestamp,
      sessionId: null,
      gitBranch: null,
    });
  }

  // HTMLs locais nunca publicados.
  for (const s of scanScratchpads()) {
    if (byPath.has(s.filePath)) continue;
    byPath.set(s.filePath, {
      id: idFor(s.filePath),
      path: s.filePath,
      fileName: path.basename(s.filePath),
      source: 'scratchpad',
      projectSlug: s.slug,
      profile: profileBySlug.get(s.slug) || null,
      title: null,
      description: null,
      favicon: null,
      label: null,
      url: null,
      version: null,
      publishCount: 0,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      dateSource: s.birthtimeReliable ? 'birthtime' : 'mtime',
      subPath: s.relPath.includes('/') ? path.dirname(s.relPath) : null,
      sessionId: s.sessionId,
      gitBranch: null,
    });
  }

  // Carimba existência/tamanho no disco — /tmp é volátil, então um registro do
  // transcript pode apontar para um arquivo que já foi limpo.
  const artifacts = [];
  for (const rec of byPath.values()) {
    let st = null;
    try {
      st = fs.statSync(rec.path);
    } catch {
      /* removido */
    }
    rec.exists = Boolean(st);
    rec.size = st ? st.size : 0;
    if (rec.source === 'artifact') {
      rec.dateSource = 'transcript';
      if (!rec.createdAt && st) rec.createdAt = new Date(st.birthtimeMs || st.mtimeMs).toISOString();
      if (!rec.updatedAt && st) rec.updatedAt = new Date(st.mtimeMs).toISOString();
    }
    rec.ext = path.extname(rec.path).replace('.', '').toLowerCase() || 'html';
    rec.title = decodeEntities(rec.title);
    rec.displayTitle = rec.title || humanize(rec.fileName);
    rec.volatile = rec.path.startsWith(`${SCRATCH_ROOT}/`);
    artifacts.push(rec);
  }

  // Metadados de projeto derivados desta varredura — precisam existir antes do
  // sync, porque é o que persiste o nome do projeto para quando o /tmp sumir.
  const metaProjeto = new Map();
  for (const slug of new Set([...artifacts.map((a) => a.projectSlug), ...cwdsBySlug.keys()])) {
    const realPath = projectPathFromSlug(slug, cwdsBySlug.get(slug) || []);
    metaProjeto.set(slug, {
      slug,
      path: realPath,
      name: realPath ? path.basename(realPath) : nomeDoSlug(slug),
      resolved: Boolean(realPath),
      profile: profileBySlug.get(slug) || null,
    });
  }

  // Persistência: grava o que foi visto e arquiva o conteúdo de quem está no disco.
  let arquivamento = null;
  try {
    sincronizarArtefatos(artifacts, metaProjeto);
    if (archive) arquivamento = arquivarConteudo(artifacts);
  } catch (err) {
    arquivamento = { erro: String(err?.message || err) };
  }

  // União do que está vivo com o que o banco já conhece. Depois de uma limpeza
  // do /tmp é este ramo que mantém o catálogo de pé.
  const vivosPorId = new Map(artifacts.map((a) => [a.id, a]));
  let doBanco = [];
  try {
    doBanco = listarArtefatos();
  } catch {
    /* banco indisponível: seguimos só com o que está vivo */
  }

  const arquivadosPorId = new Map();
  for (const linha of doBanco) {
    arquivadosPorId.set(linha.id, linha);
    if (vivosPorId.has(linha.id)) continue;
    const rec = daLinhaDoBanco(linha);
    artifacts.push(rec);
    if (!metaProjeto.has(rec.projectSlug)) {
      metaProjeto.set(rec.projectSlug, {
        slug: rec.projectSlug,
        path: linha.project_path || null,
        name: linha.project_name || nomeDoSlug(rec.projectSlug),
        resolved: Boolean(linha.project_path),
        profile: linha.profile || null,
      });
    }
  }

  // Estado final de cada artefato: no disco, arquivado no banco, ou perdido.
  for (const rec of artifacts) {
    const linha = arquivadosPorId.get(rec.id);
    rec.snapshotCount = linha?.snapshot_count || 0;
    rec.archivedAt = linha?.archived_at || null;
    rec.archiveBytes = linha?.archive_bytes || 0;
    rec.state = rec.exists ? 'disco' : rec.snapshotCount > 0 ? 'arquivado' : 'perdido';
    rec.readable = rec.state !== 'perdido';
  }

  // Agrupamento por projeto.
  const projects = new Map();
  for (const rec of artifacts) {
    const slug = rec.projectSlug;
    let p = projects.get(slug);
    if (!p) {
      const meta = metaProjeto.get(slug) || { slug, path: null, name: nomeDoSlug(slug), resolved: false };
      p = {
        ...meta,
        count: 0,
        publishedCount: 0,
        localCount: 0,
        diskCount: 0,
        archivedCount: 0,
        lostCount: 0,
        lastActivity: null,
        artifacts: [],
      };
      projects.set(slug, p);
    }
    p.count++;
    if (rec.url) p.publishedCount++;
    else p.localCount++;
    if (rec.state === 'disco') p.diskCount++;
    else if (rec.state === 'arquivado') p.archivedCount++;
    else p.lostCount++;
    const stamp = rec.updatedAt || rec.createdAt;
    if (stamp && (!p.lastActivity || stamp > p.lastActivity)) p.lastActivity = stamp;
    p.artifacts.push(rec);
  }

  for (const p of projects.values()) {
    p.artifacts.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  const list = [...projects.values()]
    .filter((p) => p.count > 0)
    .sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));

  return {
    generatedAt: new Date().toISOString(),
    scan: {
      transcripts: transcripts.length,
      rescanned: scanned,
      cached: reused,
      bytes,
      ms: Date.now() - startedAt,
      archive: arquivamento,
      // Onde procuramos — um catálogo vazio precisa dizer onde olhou.
      roots: transcriptRoots().map((r) => r.dir),
    },
    scratchRoot: SCRATCH_ROOT,
    totals: {
      projects: list.length,
      artifacts: artifacts.length,
      published: artifacts.filter((a) => a.url).length,
      local: artifacts.filter((a) => !a.url).length,
      onDisk: artifacts.filter((a) => a.state === 'disco').length,
      archived: artifacts.filter((a) => a.state === 'arquivado').length,
      lost: artifacts.filter((a) => a.state === 'perdido').length,
    },
    projects: list,
  };
}

/** Registro reconstruído a partir do banco, para artefatos que sumiram do disco. */
function daLinhaDoBanco(l) {
  return {
    id: l.id,
    path: l.path,
    fileName: l.file_name,
    source: l.source,
    projectSlug: l.project_slug,
    profile: l.profile,
    title: l.title,
    description: l.description,
    favicon: l.favicon,
    label: l.label,
    url: l.url,
    version: l.version,
    publishCount: l.publish_count,
    createdAt: l.created_at,
    updatedAt: l.updated_at,
    dateSource: l.date_source,
    subPath: l.sub_path,
    sessionId: l.session_id,
    gitBranch: l.git_branch,
    size: l.size,
    exists: false,
    ext: path.extname(l.path).replace('.', '').toLowerCase() || 'html',
    displayTitle: decodeEntities(l.title) || humanize(l.file_name),
    volatile: l.path.startsWith(`${SCRATCH_ROOT}/`),
    lastSeenAt: l.last_seen_at,
  };
}

function nomeDoSlug(slug) {
  return slug.replace(/^-+/, '').replace(/-/g, ' ').trim() || slug;
}

function slugFromScratchPath(filePath) {
  if (!filePath.startsWith(`${SCRATCH_ROOT}/`)) return null;
  return filePath.slice(SCRATCH_ROOT.length + 1).split('/')[0] || null;
}

function humanize(fileName) {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}
