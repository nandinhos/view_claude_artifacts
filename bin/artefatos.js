#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer, getIndex, iniciarArquivador } from '../src/server.js';
import { buildIndex } from '../src/scanner.js';
import { estatisticas, podarSnapshots } from '../src/store.js';
import {
  DEFAULT_PORT,
  DEFAULT_HOST,
  SCRATCH_ROOT,
  SAVE_DIR,
  DB_FILE,
  ARCHIVE_INTERVAL_MS,
} from '../src/config.js';

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith('-')) || 'serve';

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

const has = (name) => argv.includes(`--${name}`);

/**
 * Cores só quando há terminal de verdade. Sem isso, a saída chamada por um
 * slash command ou redirecionada para arquivo vem cheia de escapes ANSI.
 */
const COR = !process.env.NO_COLOR && process.stdout.isTTY && !has('plain');
const c = (codigo) => (COR ? `\x1b[${codigo}m` : '');
const NEG = c(1);
const FRACO = c(2);
const CIANO = c(36);
const AMARELO = c(33);
const VERMELHO = c(31);
const R = c(0);

if (has('help') || command === 'help') {
  console.log(`
  artefatos — catálogo dos artefatos do Claude Code, por projeto

  artefatos                sobe a interface web e abre no navegador
  artefatos --port 7788    escolhe a porta
  artefatos --host 0.0.0.0 escolhe a interface de rede (padrão 127.0.0.1)
  artefatos --no-open      não abre o navegador
  artefatos aqui           artefatos do projeto do diretório atual
  artefatos list           lista projetos e artefatos no terminal
  artefatos list <termo>   filtra projetos por nome
  artefatos … --limit N    quantos artefatos mostrar por projeto
  artefatos … --plain      sem cores (automático fora do terminal)
  artefatos scan           reescaneia do zero, arquiva e mostra estatísticas
  artefatos stats          o que há no banco
  artefatos prune --days N descarta versões antigas, nunca a mais recente
                           de cada artefato — não apaga nenhum artefato

  Scratchpad monitorado: ${SCRATCH_ROOT}
  Banco do catálogo:     ${DB_FILE}
  Cópias duráveis em:    ${SAVE_DIR}
`);
  process.exit(0);
}

if (command === 'scan') {
  const index = await buildIndex({ force: true });
  console.log(
    `${index.scan.transcripts} transcripts (${mb(index.scan.bytes)}) em ${index.scan.ms} ms`
  );
  const arq = index.scan.archive;
  if (arq?.erro) console.log(`${VERMELHO}falha ao arquivar: ${arq.erro}${R}`);
  else if (arq) console.log(`arquivados: ${arq.novos} novos · ${arq.inalterados} inalterados · ${arq.pulados} grandes demais`);
  console.log(
    `${index.totals.artifacts} artefatos · ${index.totals.published} publicados · ` +
      `${index.totals.local} locais · ${index.totals.projects} projetos`
  );
  console.log(
    `estado: ${index.totals.onDisk} no disco · ${index.totals.archived} só no banco · ${index.totals.lost} perdidos`
  );
  process.exit(0);
}

if (command === 'stats') {
  const s = estatisticas();
  const razao = s.bytesComprimidos ? (s.bytesOriginais / s.bytesComprimidos).toFixed(1) : '—';
  console.log(`
  banco          ${s.arquivoDoBanco}
  tamanho        ${mb(s.tamanhoDoBanco)}
  artefatos      ${s.artefatos}
  com conteúdo   ${s.arquivados}
  snapshots      ${s.snapshots}
  conteúdo       ${mb(s.bytesOriginais)} → ${mb(s.bytesComprimidos)} (${razao}x)
  transcripts    ${s.transcriptsEmCache} em cache
`);
  process.exit(0);
}

if (command === 'prune') {
  const dias = Number(flag('days', 90));
  if (!Number.isFinite(dias) || dias < 0) {
    console.error('use --days com um número, ex.: artefatos prune --days 30');
    process.exit(1);
  }
  const removidos = podarSnapshots(dias);
  console.log(`${removidos} snapshots com mais de ${dias} dias removidos (o mais recente de cada artefato foi mantido).`);
  process.exit(0);
}

if (command === 'list' || command === 'aqui') {
  const aqui = command === 'aqui';
  const termo = argv.filter((a) => !a.startsWith('--') && a !== command)[0];
  const index = await buildIndex();

  let projects;
  if (aqui) {
    // O cwd pode ser uma subpasta do projeto; vence o caminho mais longo que o prefixa.
    const cwd = process.cwd();
    const candidatos = index.projects
      .filter((p) => p.path && (cwd === p.path || cwd.startsWith(`${p.path}/`)))
      .sort((a, b) => b.path.length - a.path.length);
    projects = candidatos.slice(0, 1);

    if (!projects.length) {
      console.log(`\nNenhum artefato registrado para ${cwd}`);
      console.log(`${FRACO}Use \`artefatos list\` para ver todos os projetos.${R}\n`);
      process.exit(0);
    }
  } else {
    projects = termo
      ? index.projects.filter((p) => `${p.name} ${p.slug}`.toLowerCase().includes(termo.toLowerCase()))
      : index.projects;
  }

  if (!projects.length) {
    console.log('\nNenhum projeto encontrado. Procurei em:');
    for (const r of index.scan.roots) console.log(`  ${r}`);
    console.log(`  ${index.scratchRoot} (scratchpads)`);
    console.log(
      '\nSe sua config do Claude Code está em outro lugar, aponte com\n' +
        '  CLAUDE_CONFIG_DIR=... ou ARTEFATOS_CONFIG_DIRS=dir1,dir2\n'
    );
    process.exit(0);
  }

  for (const p of projects) {
    console.log(`\n${NEG}${p.name}${R}  ${FRACO}${p.path || p.slug}${R}`);
    const extra = [
      p.archivedCount ? `${p.archivedCount} só no banco` : '',
      p.lostCount ? `${p.lostCount} perdidos` : '',
    ].filter(Boolean);
    console.log(
      `${FRACO}  ${p.count} artefatos · ${p.publishedCount} publicados · ${p.localCount} locais` +
        `${extra.length ? ` · ${extra.join(' · ')}` : ''}${R}`
    );
    const limite = Number(flag('limit', 0)) || 0;
    const rows = limite ? p.artifacts.slice(0, limite) : termo || aqui ? p.artifacts : p.artifacts.slice(0, 8);
    for (const a of rows) {
      const marca = a.url ? `${CIANO}☁${R}` : `${FRACO}·${R}`;
      const estado =
        a.state === 'arquivado'
          ? ` ${AMARELO}(arquivado)${R}`
          : a.state === 'perdido'
            ? ` ${VERMELHO}(perdido)${R}`
            : '';
      console.log(`  ${marca} ${data(a.createdAt)}  ${a.favicon || ' '} ${a.displayTitle}${estado}`);
    }
    if (rows.length < p.artifacts.length) {
      console.log(`${FRACO}  … mais ${p.artifacts.length - rows.length}${R}`);
    }
  }
  console.log('');
  process.exit(0);
}

// ------------------------------------------------------------------- servidor

const port = Number(flag('port', DEFAULT_PORT));
const host = String(flag('host', DEFAULT_HOST));
const server = createServer();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPorta ${port} ocupada. Use: artefatos --port ${port + 1}\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, host, async () => {
  const visivel = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${visivel}:${port}`;
  console.log(`\n  ${NEG}Artefatos do Claude Code${R}`);
  console.log(`  ${url}`);
  console.log(`  ${FRACO}monitorando ${SCRATCH_ROOT} + transcripts · ctrl-c para sair${R}`);
  console.log(`  ${FRACO}banco: ${DB_FILE}${R}\n`);

  const index = await getIndex({ force: false });
  const arq = index.scan.archive;
  console.log(
    `  ${FRACO}${index.totals.artifacts} artefatos em ${index.totals.projects} projetos ` +
      `(${index.scan.ms} ms, ${index.scan.cached} transcripts em cache)${R}`
  );
  console.log(
    `  ${FRACO}${index.totals.onDisk} no disco · ${index.totals.archived} só no banco · ` +
      `${index.totals.lost} perdidos${arq?.novos ? ` · ${arq.novos} arquivados agora` : ''}${R}\n`
  );

  // Arquiva mesmo com o navegador fechado.
  iniciarArquivador({
    onCycle: (i) => {
      const n = i.scan.archive?.novos || 0;
      if (n > 0) console.log(`  ${FRACO}[${hora()}] ${n} artefato(s) arquivado(s)${R}`);
    },
  });
  console.log(`  ${FRACO}arquivando a cada ${Math.round(ARCHIVE_INTERVAL_MS / 1000)}s${R}\n`);

  if (!has('no-open')) abrir(url);
});

function hora() {
  return new Date().toLocaleTimeString('pt-BR');
}

function abrir(url) {
  // WSL primeiro: wslview e explorer.exe alcançam o navegador do Windows.
  const candidatos = [
    ['wslview', [url]],
    ['explorer.exe', [url]],
    ['xdg-open', [url]],
    ['open', [url]],
  ];
  let i = 0;
  const tentar = () => {
    if (i >= candidatos.length) return;
    const [cmd, args] = candidatos[i++];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', tentar);
    child.unref();
  };
  tentar();
}

function data(iso) {
  if (!iso) return '          ';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}
