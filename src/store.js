import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

import { DB_FILE, MAX_ARCHIVE_BYTES } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS artifacts (
  id            TEXT PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  file_name     TEXT NOT NULL,
  source        TEXT NOT NULL,
  project_slug  TEXT NOT NULL,
  project_path  TEXT,
  project_name  TEXT,
  profile       TEXT,
  title         TEXT,
  description   TEXT,
  favicon       TEXT,
  label         TEXT,
  url           TEXT,
  version       TEXT,
  publish_count INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT,
  updated_at    TEXT,
  date_source   TEXT,
  sub_path      TEXT,
  session_id    TEXT,
  git_branch    TEXT,
  size          INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  -- nulo = conhecido pelo transcript, mas o arquivo nunca foi visto no disco
  last_seen_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_artifacts_projeto ON artifacts(project_slug);
CREATE INDEX IF NOT EXISTS idx_artifacts_criado  ON artifacts(created_at DESC);

CREATE TABLE IF NOT EXISTS snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  gz          BLOB NOT NULL,
  captured_at TEXT NOT NULL,
  file_mtime  REAL,
  UNIQUE(artifact_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_artefato ON snapshots(artifact_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS scan_cache (
  file     TEXT PRIMARY KEY,
  size     INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  data     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  chave TEXT PRIMARY KEY,
  valor TEXT
);
`;

let db = null;

export function abrirBanco() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = new DatabaseSync(DB_FILE);
  // WAL para que o CLI no host leia enquanto o servidor (ou o container) escreve.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}

export function fecharBanco() {
  if (db) {
    db.close();
    db = null;
  }
}

// -------------------------------------------------------------- scan_cache

export function lerScanCache() {
  const linhas = abrirBanco().prepare('SELECT file, size, mtime_ms, data FROM scan_cache').all();
  const mapa = new Map();
  for (const l of linhas) {
    try {
      mapa.set(l.file, { size: l.size, mtimeMs: l.mtime_ms, data: JSON.parse(l.data) });
    } catch {
      /* linha corrompida: será reescrita na varredura */
    }
  }
  return mapa;
}

export function gravarScanCache(entradas) {
  const d = abrirBanco();
  const upsert = d.prepare(
    `INSERT INTO scan_cache (file, size, mtime_ms, data) VALUES (?, ?, ?, ?)
     ON CONFLICT(file) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, data = excluded.data`
  );
  const vistos = new Set();

  d.exec('BEGIN');
  try {
    for (const [file, v] of entradas) {
      upsert.run(file, v.size, v.mtimeMs, JSON.stringify(v.data));
      vistos.add(file);
    }
    // transcripts apagados não devem envelhecer no cache
    for (const { file } of d.prepare('SELECT file FROM scan_cache').all()) {
      if (!vistos.has(file)) d.prepare('DELETE FROM scan_cache WHERE file = ?').run(file);
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

export function limparScanCache() {
  abrirBanco().exec('DELETE FROM scan_cache');
}

// --------------------------------------------------------------- artefatos

const COLUNAS = [
  'id', 'path', 'file_name', 'source', 'project_slug', 'project_path', 'project_name',
  'profile', 'title', 'description', 'favicon', 'label', 'url', 'version',
  'publish_count', 'created_at', 'updated_at', 'date_source', 'sub_path',
  'session_id', 'git_branch', 'size', 'first_seen_at', 'last_seen_at',
];

function paraLinha(rec, agora, projeto) {
  return {
    id: rec.id,
    path: rec.path,
    file_name: rec.fileName,
    source: rec.source,
    project_slug: rec.projectSlug,
    project_path: projeto?.path ?? null,
    project_name: projeto?.name ?? null,
    profile: rec.profile ?? null,
    title: rec.title ?? null,
    description: rec.description ?? null,
    favicon: rec.favicon ?? null,
    label: rec.label ?? null,
    url: rec.url ?? null,
    version: rec.version ?? null,
    publish_count: rec.publishCount ?? 0,
    created_at: rec.createdAt ?? null,
    updated_at: rec.updatedAt ?? null,
    date_source: rec.dateSource ?? null,
    sub_path: rec.subPath ?? null,
    session_id: rec.sessionId ?? null,
    git_branch: rec.gitBranch ?? null,
    size: rec.size ?? 0,
    first_seen_at: agora,
    last_seen_at: rec.exists ? agora : null,
  };
}

/**
 * Grava/atualiza os artefatos vistos nesta varredura. Campos que só o
 * transcript conhece (título, url) nunca são sobrescritos por null — um
 * artefato local que perdeu o transcript mantém o que já sabíamos dele.
 */
export function sincronizarArtefatos(registros, projetoPorSlug) {
  const d = abrirBanco();
  const agora = new Date().toISOString();

  const insert = d.prepare(
    `INSERT INTO artifacts (${COLUNAS.join(', ')})
     VALUES (${COLUNAS.map((c) => `$${c}`).join(', ')})
     ON CONFLICT(id) DO UPDATE SET
       path         = excluded.path,
       file_name    = excluded.file_name,
       source       = excluded.source,
       project_slug = excluded.project_slug,
       project_path = COALESCE(excluded.project_path, artifacts.project_path),
       project_name = COALESCE(excluded.project_name, artifacts.project_name),
       profile      = COALESCE(excluded.profile, artifacts.profile),
       title        = COALESCE(excluded.title, artifacts.title),
       description  = COALESCE(excluded.description, artifacts.description),
       favicon      = COALESCE(excluded.favicon, artifacts.favicon),
       label        = COALESCE(excluded.label, artifacts.label),
       url          = COALESCE(excluded.url, artifacts.url),
       version      = COALESCE(excluded.version, artifacts.version),
       publish_count= MAX(excluded.publish_count, artifacts.publish_count),
       created_at   = COALESCE(artifacts.created_at, excluded.created_at),
       updated_at   = COALESCE(excluded.updated_at, artifacts.updated_at),
       date_source  = COALESCE(excluded.date_source, artifacts.date_source),
       sub_path     = COALESCE(excluded.sub_path, artifacts.sub_path),
       session_id   = COALESCE(excluded.session_id, artifacts.session_id),
       git_branch   = COALESCE(excluded.git_branch, artifacts.git_branch),
       size         = CASE WHEN excluded.size > 0 THEN excluded.size ELSE artifacts.size END,
       last_seen_at = COALESCE(excluded.last_seen_at, artifacts.last_seen_at)`
  );

  d.exec('BEGIN');
  try {
    for (const rec of registros) {
      insert.run(paraLinha(rec, agora, projetoPorSlug.get(rec.projectSlug)));
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/** Todos os artefatos já conhecidos, com o estado do arquivamento. */
export function listarArtefatos() {
  return abrirBanco()
    .prepare(
      `SELECT a.*,
              (SELECT COUNT(*) FROM snapshots s WHERE s.artifact_id = a.id)      AS snapshot_count,
              (SELECT MAX(s.captured_at) FROM snapshots s WHERE s.artifact_id = a.id) AS archived_at,
              (SELECT SUM(LENGTH(s.gz)) FROM snapshots s WHERE s.artifact_id = a.id)  AS archive_bytes
         FROM artifacts a`
    )
    .all();
}

export function esquecerArtefato(id) {
  const d = abrirBanco();
  d.prepare('DELETE FROM snapshots WHERE artifact_id = ?').run(id);
  const r = d.prepare('DELETE FROM artifacts WHERE id = ?').run(id);
  return r.changes > 0;
}

// --------------------------------------------------------------- snapshots

/** Assinatura (mtime + tamanho) do último snapshot, para não reler arquivo intocado. */
function ultimasAssinaturas() {
  const linhas = abrirBanco()
    .prepare(
      `SELECT artifact_id, file_mtime, bytes
         FROM snapshots
        WHERE id IN (SELECT MAX(id) FROM snapshots GROUP BY artifact_id)`
    )
    .all();
  const mapa = new Map();
  for (const l of linhas) mapa.set(l.artifact_id, { mtime: l.file_mtime, bytes: l.bytes });
  return mapa;
}

/**
 * Arquiva o conteúdo dos artefatos que estão no disco. Só lê o arquivo quando
 * mtime ou tamanho mudaram desde o último snapshot; conteúdo idêntico (mesmo
 * sha256) não gera linha nova, então republicar sem editar não duplica nada.
 */
export function arquivarConteudo(registros) {
  const d = abrirBanco();
  const assinaturas = ultimasAssinaturas();
  const insert = d.prepare(
    `INSERT INTO snapshots (artifact_id, sha256, bytes, gz, captured_at, file_mtime)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(artifact_id, sha256) DO NOTHING`
  );

  const agora = new Date().toISOString();
  let novos = 0;
  let inalterados = 0;
  let pulados = 0;

  d.exec('BEGIN');
  try {
    for (const rec of registros) {
      if (!rec.exists) continue;
      if (rec.size > MAX_ARCHIVE_BYTES) {
        pulados++;
        continue;
      }

      let st;
      try {
        st = fs.statSync(rec.path);
      } catch {
        continue;
      }

      const anterior = assinaturas.get(rec.id);
      if (anterior && anterior.mtime === st.mtimeMs && anterior.bytes === st.size) {
        inalterados++;
        continue;
      }

      let conteudo;
      try {
        conteudo = fs.readFileSync(rec.path);
      } catch {
        continue;
      }

      const sha = crypto.createHash('sha256').update(conteudo).digest('hex');
      const gz = zlib.gzipSync(conteudo, { level: 9 });
      const r = insert.run(rec.id, sha, conteudo.length, gz, agora, st.mtimeMs);
      if (r.changes > 0) novos++;
      else inalterados++;
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }

  return { novos, inalterados, pulados };
}

/** Conteúdo arquivado mais recente, já descomprimido. */
export function lerSnapshot(artifactId) {
  const linha = abrirBanco()
    .prepare(
      `SELECT gz, bytes, sha256, captured_at FROM snapshots
        WHERE artifact_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1`
    )
    .get(artifactId);
  if (!linha) return null;
  return {
    conteudo: zlib.gunzipSync(Buffer.from(linha.gz)),
    bytes: linha.bytes,
    sha256: linha.sha256,
    capturedAt: linha.captured_at,
  };
}

export function listarSnapshots(artifactId) {
  return abrirBanco()
    .prepare(
      `SELECT id, sha256, bytes, captured_at, LENGTH(gz) AS gz_bytes
         FROM snapshots WHERE artifact_id = ? ORDER BY captured_at DESC, id DESC`
    )
    .all(artifactId);
}

// ------------------------------------------------------------ manutenção

export function estatisticas() {
  const d = abrirBanco();
  const um = (sql) => d.prepare(sql).get();
  return {
    artefatos: um('SELECT COUNT(*) AS n FROM artifacts').n,
    arquivados: um('SELECT COUNT(DISTINCT artifact_id) AS n FROM snapshots').n,
    snapshots: um('SELECT COUNT(*) AS n FROM snapshots').n,
    bytesOriginais: um('SELECT COALESCE(SUM(bytes), 0) AS n FROM snapshots').n,
    bytesComprimidos: um('SELECT COALESCE(SUM(LENGTH(gz)), 0) AS n FROM snapshots').n,
    transcriptsEmCache: um('SELECT COUNT(*) AS n FROM scan_cache').n,
    arquivoDoBanco: DB_FILE,
    tamanhoDoBanco: tamanhoArquivo(DB_FILE),
  };
}

/** Descarta snapshots antigos, sempre preservando o mais recente de cada artefato. */
export function podarSnapshots(dias) {
  const d = abrirBanco();
  const limite = new Date(Date.now() - dias * 86400000).toISOString();
  const r = d
    .prepare(
      `DELETE FROM snapshots
        WHERE captured_at < ?
          AND id NOT IN (SELECT MAX(id) FROM snapshots GROUP BY artifact_id)`
    )
    .run(limite);
  d.exec('VACUUM');
  return r.changes;
}

function tamanhoArquivo(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}
