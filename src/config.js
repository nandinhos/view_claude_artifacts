import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const HOME = os.homedir();

/** UID real do processo. Windows não tem getuid; ali o caminho abaixo não vale mesmo. */
export const UID = typeof process.getuid === 'function' ? process.getuid() : 1000;

/**
 * Raiz volátil dos scratchpads de sessão. Observado como <tmpdir>/claude-<uid>
 * em todas as sessões desta máquina, mas isso é um padrão observado, não um
 * contrato documentado — em outra instalação (uid diferente, TMPDIR diferente)
 * pode mudar. ARTEFATOS_SCRATCH_ROOT é a saída de emergência.
 */
export const SCRATCH_ROOT =
  process.env.ARTEFATOS_SCRATCH_ROOT || path.join(os.tmpdir(), `claude-${UID}`);

/**
 * Raízes de transcripts, em ordem de confiança:
 *
 * 1. CLAUDE_CONFIG_DIR — variável oficial do Claude Code para mover a config
 *    de lugar. Sem isto, quem a usa veria um catálogo vazio e nenhum erro.
 * 2. ~/.claude — o padrão de uma instalação limpa.
 * 3. ~/.claude-profiles/<nome> — convenção do projeto claude-profiles, que
 *    cria um harness isolado por perfil e o ativa via CLAUDE_CONFIG_DIR.
 *    Não é padrão do Claude Code; só entra se a pasta existir.
 *
 * ARTEFATOS_CONFIG_DIRS (separado por vírgula) acrescenta raízes arbitrárias.
 */
export function transcriptRoots() {
  const roots = [];
  const vistos = new Set();

  const push = (dir, profile) => {
    const projects = path.resolve(dir, 'projects');
    if (vistos.has(projects) || !isDir(projects)) return;
    vistos.add(projects);
    roots.push({ profile, dir: projects });
  };

  if (process.env.CLAUDE_CONFIG_DIR) {
    push(process.env.CLAUDE_CONFIG_DIR, path.basename(process.env.CLAUDE_CONFIG_DIR));
  }

  for (const extra of (process.env.ARTEFATOS_CONFIG_DIRS || '').split(',')) {
    if (extra.trim()) push(extra.trim(), path.basename(extra.trim()));
  }

  push(path.join(HOME, '.claude'), 'default');

  const profilesDir = path.join(HOME, '.claude-profiles');
  if (isDir(profilesDir)) {
    for (const name of safeReaddir(profilesDir)) {
      push(path.join(profilesDir, name), name);
    }
  }

  return roots;
}

/** Pasta durável para "salvar cópia" — /tmp é limpo no reboot. */
export const SAVE_DIR =
  process.env.ARTEFATOS_SAVE_DIR || path.join(HOME, 'artefatos-salvos');

/**
 * Banco do catálogo: metadados + conteúdo arquivado + cache de varredura.
 * Fica em caminho do host (não em volume nomeado) para que o CLI e o
 * container abram exatamente o mesmo arquivo.
 */
export const DB_FILE =
  process.env.ARTEFATOS_DB ||
  path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'artefatos', 'artefatos.db');

/** Acima disso o arquivo é grande demais para virar snapshot no banco. */
export const MAX_ARCHIVE_BYTES = Number(process.env.ARTEFATOS_MAX_ARCHIVE_BYTES || 8 * 1024 * 1024);

/**
 * Varredura+arquivamento periódicos, independentes de haver navegador aberto.
 * Sem isso, um artefato criado e perdido entre duas visitas nunca é arquivado.
 */
export const ARCHIVE_INTERVAL_MS = Number(process.env.ARTEFATOS_ARCHIVE_INTERVAL || 5 * 60 * 1000);

export const DEFAULT_PORT = Number(process.env.ARTEFATOS_PORT || 7788);

/** 127.0.0.1 no host; o container sobe em 0.0.0.0 e publica só em localhost. */
export const DEFAULT_HOST = process.env.ARTEFATOS_HOST || '127.0.0.1';

/** Janela em que um índice recém-gerado é reaproveitado sem reescanear. */
export const RESCAN_TTL_MS = Number(process.env.ARTEFATOS_TTL || 4000);

/**
 * Nomes de arquivo no scratchpad que são material de trabalho, não artefato.
 * Só se aplica aos HTMLs "locais"; nada que passou pela ferramenta Artifact é filtrado.
 */
export const NOISE_PATTERNS = [
  /^_/, // _css.html, _test.html
  /\.src\.html$/i, // fonte pré-processada
  /\.candidate\./i, // AGENTS.candidate.md
  /^tmp[-_.]/i,
];

export const MIN_LOCAL_BYTES = 512;

/**
 * Subpastas do scratchpad que nunca contêm artefatos — só dependências,
 * build output e material de apoio.
 */
export const SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  'assets',
  'static',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'out',
]);

/** Quantos níveis abaixo de .../scratchpad/ ainda procuramos HTMLs locais. */
export const SCRATCH_MAX_DEPTH = Number(process.env.ARTEFATOS_MAX_DEPTH || 3);

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeReaddir(p) {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

export { HOME, isDir, safeReaddir };
